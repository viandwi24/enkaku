import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { BuildToolsContext, CheckpointDecision, EmitFn, OnCheckpoint, Part, StepSummary, StopReason, Usage } from "../types";
import { looksLikeError } from "../tools/file-tools";
import { LIMIT, RESERVE, estimateTokens, prune, sanitizeMessages } from "./compaction";

// ─── Loop-guard helpers (§3b) ─────────────────────────────────────────────────────────────────
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "delete_file"]);

// Cheap, stable hash of a tool call's args (djb2) — lets the auditor spot IDENTICAL repeated calls
// without shipping the full argument payload.
function hashArgs(input: unknown): string {
  let s = "";
  try {
    s = JSON.stringify(input) ?? "";
  } catch {
    s = "";
  }
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Reduce a step's response messages to the auditor's signal: tool names + arg hashes + whether it
// mutated files/state. No transcript — this is what feeds CheckpointCtx.recentSteps.
export function summarizeStep(messages: ModelMessage[]): StepSummary {
  const tools: { name: string; argsHash: string }[] = [];
  let mutated = false;
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const part of m.content as { type?: string; toolName?: string; input?: unknown }[]) {
      if (part.type !== "tool-call" || !part.toolName) continue;
      tools.push({ name: part.toolName, argsHash: hashArgs(part.input) });
      if (MUTATING_TOOLS.has(part.toolName)) mutated = true;
    }
  }
  return { tools, mutated };
}

// Deterministic pre-check (free, no LLM): a CLEAR loop is the same tool+args called `repeatThreshold`
// times across the window. Returns a stop decision or null (→ let the LLM auditor judge). Kept
// strict on purpose — "no file changes" alone is NOT a hard stop here (legit read/analysis/backtest
// steps mutate nothing), so that softer signal is left for the LLM auditor to weigh.
export function detectLoop(recent: StepSummary[], opts?: { repeatThreshold?: number }): CheckpointDecision | null {
  const threshold = opts?.repeatThreshold ?? 3;
  const counts = new Map<string, number>();
  for (const s of recent) {
    for (const t of s.tools) {
      const key = `${t.name}#${t.argsHash}`;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (n >= threshold) {
        return {
          action: "stop",
          stopReason: "loop-detected",
          reason: `Loop detected: '${t.name}' called ${n}× with identical arguments — no progress.`,
        };
      }
    }
  }
  return null;
}

export type CheckpointState = { ceiling: number; extensionsUsed: number };

// Pure §3b budget decision at a step boundary. Given the current step count + budget state, decide
// the loop's next move WITHOUT running the model: a terminal stop, or "extend" with the new ceiling.
// The HARD backstop (extensions exhausted) is enforced here BEFORE the auditor runs — the auditor
// can defer the backstop but never remove it. `runAgentLoop` delegates here so the exact budget
// state-machine is unit-testable in isolation from streamText.
export async function evaluateCheckpoint(args: {
  iterations: number;
  state: CheckpointState;
  stepCheckpoint: number;
  maxExtensions: number;
  recentSteps: StepSummary[];
  onCheckpoint: OnCheckpoint;
}): Promise<{ done: true; stop: StopReason } | { done: false; state: CheckpointState }> {
  const { iterations, state, stepCheckpoint, maxExtensions, recentSteps, onCheckpoint } = args;
  if (state.extensionsUsed >= maxExtensions) return { done: true, stop: "budget-exhausted" };
  const decision = await onCheckpoint({ step: iterations, recentSteps, extensionsUsed: state.extensionsUsed });
  if (decision.action === "stop") return { done: true, stop: decision.stopReason ?? "halted-by-auditor" };
  if (decision.action === "ask") return { done: true, stop: "paused-checkpoint" };
  return { done: false, state: { ceiling: state.ceiling + stepCheckpoint, extensionsUsed: state.extensionsUsed + 1 } };
}

// CORE: one agent turn driven by a MANUAL while-loop. Each iteration is a single streamText
// step (stepCountIs(1)) — WE own the loop, so we control compaction, per-step persistence,
// and the exact stop reason. Output still streams continuously via onStep. (harness.md §1/§7)
//
// One streamText call = one model generation (+ any tool executions in that step). If the
// model called tools (finishReason "tool-calls"), we loop with the tool results appended;
// otherwise the model produced its final answer and we stop.

export type RunResult = {
  steps: Part[][];
  response: ModelMessage[]; // new messages this turn (for the durable full log)
  finalMessages: ModelMessage[]; // the final wire state (already mid-turn compacted) → becomes working history
  usage: Usage;
  stepCount: number;
  pruneCount: number;
  stop: StopReason;
};

export type RunTurnInput = {
  model: LanguageModel;
  system: string;
  tools: ToolSet;
  history: ModelMessage[];
  text: string;
  maxSteps?: number;
  costCapTokens?: number;
  compaction?: { limit?: number; reserve?: number }; // mid-turn prune threshold (window safety)
  summarizeAt?: number; // mid-turn: when the wire exceeds this, compact it via compactWire and continue
  compactWire?: (messages: ModelMessage[]) => Promise<ModelMessage[]>; // summarize the wire (returns the new wire)
  signal?: AbortSignal; // abort mid-stream; partial steps are still returned
  providerOptions?: Record<string, Record<string, unknown>>; // e.g. { deepseek: { reasoningEffort: "high" } }
  buildToolsContext?: BuildToolsContext; // per-turn tool runtime ctx; emit is a NO-OP here (no UI writer on this path)
  onReasoning?: (active: boolean) => void; // model entered (true) / left (false) a thinking phase
  onStep?: (steps: Part[][]) => void; // live render snapshot
  onUsage?: (u: Usage) => void;
  onStepComplete?: (info: { step: number; messages: ModelMessage[] }) => void | Promise<void>; // per-step hook (persist…)
  onCompact?: (info: { before: number; after: number }) => void; // mid-run compaction happened
  onWire?: (tokens: number) => void; // current wire size (messages sent to the model this step)
};

// THE shared agent loop. One streamText step per iteration (stepCountIs(1)); we drive the loop and
// handle mid-turn compaction + window prune + guards + abort uniformly. The ONLY thing that differs
// between transports is how each step's stream is consumed — that's `consumeStep`. Both the TUI
// (Part[][]) and the web UIMessageStream go through HERE, so they can never diverge again.
export type LoopConfig = {
  model: LanguageModel;
  system: string;
  tools: ToolSet;
  messages: ModelMessage[]; // the initial wire (history + the new user message)
  maxSteps?: number;
  costCapTokens?: number;
  compaction?: { limit?: number; reserve?: number };
  summarizeAt?: number;
  compactWire?: (messages: ModelMessage[]) => Promise<ModelMessage[]>;
  signal?: AbortSignal;
  providerOptions?: Record<string, Record<string, unknown>>;
  toolsContext?: Record<string, unknown>; // streamText toolsContext (keyed by tool name → options.context per tool)
  // Current wire size + the wire itself (plan 13 P3: lets the UI stream derive per-tool runtime
  // stats from the SAME messages the size was computed from — additive, callers may ignore it).
  onWire?: (tokens: number, messages: ModelMessage[]) => void;
  onUsage?: (u: Usage) => void;
  onCompact?: (info: { before: number; after: number }) => void;
  onStepComplete?: (info: { step: number; stepMessages: ModelMessage[]; messages: ModelMessage[] }) => void | Promise<void>;
  stepCheckpoint?: number; // §3b audit cadence; enables the checkpoint path (with onCheckpoint)
  maxStepExtensions?: number; // §3b hard backstop on granted extensions (default 4)
  onCheckpoint?: OnCheckpoint; // §3b auditor policy; unset → legacy max-steps hard stop
};
export type LoopResult = { response: ModelMessage[]; finalMessages: ModelMessage[]; usage: Usage; stop: StopReason; stepCount: number; pruneCount: number };

export async function runAgentLoop(
  p: LoopConfig,
  consumeStep: (result: ReturnType<typeof streamText>, step: number) => Promise<{ aborted: boolean }>,
): Promise<LoopResult> {
  const maxSteps = p.maxSteps ?? 50;
  const costCap = p.costCapTokens ?? 100_000;
  const limit = p.compaction?.limit ?? LIMIT;
  const reserve = p.compaction?.reserve ?? RESERVE;
  const midThreshold = limit - reserve; // window safety; summarizeAt drives the visible compaction

  // §3b adaptive budget: with an onCheckpoint hook + stepCheckpoint, the hard maxSteps stop is
  // replaced by an audited checkpoint every `stepCheckpoint` steps. The ceiling starts at one block
  // and extends by a block each time the auditor says "continue", capped at maxStepExtensions.
  const stepCheckpoint = p.stepCheckpoint && p.stepCheckpoint > 0 ? p.stepCheckpoint : undefined;
  const maxExtensions = p.maxStepExtensions ?? 4;
  const useCheckpoints = !!p.onCheckpoint && !!stepCheckpoint;
  let ceiling = useCheckpoints ? stepCheckpoint! : maxSteps;
  let extensionsUsed = 0;
  const stepSummaries: StepSummary[] = [];

  let messages = sanitizeMessages(p.messages);
  const response: ModelMessage[] = [];
  const usage: Usage = { inp: 0, out: 0 };
  let stop: StopReason = "complete";
  let pruneCount = 0;
  let iterations = 0;

  while (true) {
    // mid-turn auto-compact (summarize) at summarizeAt, then a hard prune near the window
    if (p.summarizeAt && p.compactWire && estimateTokens(messages) > p.summarizeAt) {
      const before = estimateTokens(messages);
      messages = await p.compactWire(messages);
      p.onCompact?.({ before, after: estimateTokens(messages) });
    }
    if (estimateTokens(messages) > midThreshold) {
      const before = estimateTokens(messages);
      messages = prune(messages);
      pruneCount++;
      p.onCompact?.({ before, after: estimateTokens(messages) });
    }
    p.onWire?.(estimateTokens(messages), messages);

    // streamText surfaces the RAW provider error (e.g. APICallError "Key limit exceeded", 403) here;
    // the settle-awaits below only reject with a generic "No output generated" wrapper. Capture it so
    // the real, actionable message reaches the UI.
    let stepError: unknown;
    const result = streamText({
      model: p.model,
      system: p.system,
      messages,
      tools: p.tools,
      abortSignal: p.signal,
      onError: ({ error }) => {
        stepError = error;
      },
      providerOptions: p.providerOptions as never,
      // SDK-native per-tool runtime context (plan 13 P0): keyed by tool name; each tool reads its
      // entry via execute's `options.context`. Verified against ai@7.0.8: no contextSchema needed —
      // validateToolContext passes the value through untouched when the tool declares no schema.
      // Cast: for the wide `ToolSet` type TS collapses InferToolSetContext to an empty map and
      // narrows the param to `never`; the runtime accepts any name-keyed record (verified 7.0.8).
      toolsContext: p.toolsContext as never,
      stopWhen: stepCountIs(1), // exactly one step — WE drive the loop
    });
    iterations++;

    const { aborted } = await consumeStep(result, iterations - 1);
    const abort = () => ({ response, finalMessages: sanitizeMessages(messages), usage, stop: "aborted" as StopReason, stepCount: iterations, pruneCount });
    if (aborted || p.signal?.aborted) return abort();

    // Settle the step. Either consumer may abort mid-stream → these awaits can reject.
    let u: { inputTokens?: number; outputTokens?: number } | undefined;
    let stepMessages: ModelMessage[];
    let finishReason: string;
    try {
      u = await result.usage;
      stepMessages = (await result.response).messages;
      finishReason = await result.finishReason;
    } catch (e) {
      if (p.signal?.aborted) return abort();
      throw stepError ?? e; // prefer the real provider error over the generic settle-await rejection
    }

    usage.inp += u?.inputTokens ?? 0;
    usage.out += u?.outputTokens ?? 0;
    p.onUsage?.({ ...usage });

    response.push(...stepMessages);
    messages = [...messages, ...stepMessages];
    p.onWire?.(estimateTokens(messages), messages);
    await p.onStepComplete?.({ step: iterations - 1, stepMessages, messages });
    if (useCheckpoints) stepSummaries.push(summarizeStep(stepMessages));

    if (finishReason === "length") { stop = "length"; break; }
    if (finishReason === "error") { stop = "error"; break; }
    if (finishReason !== "tool-calls") { stop = "complete"; break; }
    if (usage.out > costCap) { stop = "cost-cap"; break; } // final token backstop (auditor can't defer this)

    if (iterations >= ceiling) {
      if (!useCheckpoints) { stop = "max-steps"; break; } // legacy hard stop (no auditor)
      const res = await evaluateCheckpoint({
        iterations,
        state: { ceiling, extensionsUsed },
        stepCheckpoint: stepCheckpoint!,
        maxExtensions,
        recentSteps: stepSummaries.slice(-stepCheckpoint!), // this block's steps
        onCheckpoint: p.onCheckpoint!,
      });
      if (res.done) { stop = res.stop; break; }
      ceiling = res.state.ceiling;
      extensionsUsed = res.state.extensionsUsed;
    }
  }

  return { response, finalMessages: messages, usage, stop, stepCount: iterations, pruneCount };
}

// CORE turn → Part[][]. Builds the rendered steps by consuming each step's fullStream; the loop
// control lives in runAgentLoop (shared with the web transport).
export async function runAgentTurn(p: RunTurnInput): Promise<RunResult> {
  const steps: Part[][] = [];
  const emit = () => p.onStep?.(steps.map((s) => s.slice()));

  const consumeStep = async (result: ReturnType<typeof streamText>): Promise<{ aborted: boolean }> => {
    const block: Part[] = [];
    steps.push(block);
    emit();
    let aborted = false;
    try {
      for await (const part of result.fullStream) {
        if (part.type === "abort") {
          aborted = true;
          break;
        } else if (part.type === "reasoning-start") {
          p.onReasoning?.(true);
        } else if (part.type === "reasoning-delta") {
          const last = block[block.length - 1];
          if (last && last.kind === "thinking") last.text += part.text;
          else block.push({ kind: "thinking", text: part.text });
          emit();
        } else if (part.type === "reasoning-end") {
          p.onReasoning?.(false);
        } else if (part.type === "text-delta") {
          const last = block[block.length - 1];
          if (last && last.kind === "text") last.text += part.text;
          else block.push({ kind: "text", text: part.text });
          emit();
        } else if (part.type === "tool-call") {
          block.push({ kind: "tool", id: part.toolCallId, name: part.toolName, done: false, ok: true, args: part.input });
          emit();
        } else if (part.type === "tool-result") {
          const out = typeof part.output === "string" ? part.output : JSON.stringify(part.output);
          const t = block.find((x) => x.kind === "tool" && x.id === part.toolCallId);
          if (t && t.kind === "tool") {
            t.done = true;
            t.ok = !looksLikeError(out);
            t.result = out;
          }
          emit();
        } else if (part.type === "tool-error") {
          const t = block.find((x) => x.kind === "tool" && x.id === part.toolCallId);
          if (t && t.kind === "tool") {
            t.done = true;
            t.ok = false;
          }
          emit();
        } else if (part.type === "error") {
          block.push({ kind: "text", text: "⚠ stream error" });
          emit();
        }
      }
    } catch (e) {
      if (p.signal?.aborted) aborted = true;
      else throw e;
    }
    return { aborted };
  };

  // Headless path: no UIMessageStream writer exists, so a tool's ctx.emit must be a safe NO-OP —
  // tools can call it unconditionally and behave identically on both transports.
  const noopEmit: EmitFn = () => {};

  const r = await runAgentLoop(
    {
      model: p.model,
      system: p.system,
      tools: p.tools,
      messages: [...p.history, { role: "user", content: p.text }],
      toolsContext: p.buildToolsContext?.({ emit: noopEmit }),
      maxSteps: p.maxSteps,
      costCapTokens: p.costCapTokens,
      compaction: p.compaction,
      summarizeAt: p.summarizeAt,
      compactWire: p.compactWire,
      signal: p.signal,
      providerOptions: p.providerOptions,
      onWire: p.onWire,
      onUsage: p.onUsage,
      onCompact: p.onCompact,
      onStepComplete: p.onStepComplete ? ({ step, messages }) => p.onStepComplete?.({ step, messages }) : undefined,
    },
    consumeStep,
  );

  return { steps, response: r.response, finalMessages: r.finalMessages, usage: r.usage, stepCount: steps.length, pruneCount: r.pruneCount, stop: r.stop };
}
