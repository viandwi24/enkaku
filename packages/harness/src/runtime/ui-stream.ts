import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  getToolName,
  isToolUIPart,
  toUIMessageStream,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from "ai";
import { type LoopResult, runAgentLoop } from "../core/agent-core";
import { estimateSystemTokens, estimateToolTokens, estimateToolsTokens, toolRuntimeStats, historyRoleStats } from "../core/compaction";
import { looksLikeError } from "../tools/file-tools";
import type { BuildToolsContext, EmitFn, OnCheckpoint, Part, Turn, Usage } from "../types";

// THE single agent stream. The shared loop (runAgentLoop) wrapped in createUIMessageStream, so each
// step's stream is forwarded into a UIMessageStream (+ data parts). This ONE function feeds BOTH:
//   • web  — createUIMessageStreamResponse(...) → HTTP/SSE → useChat
//   • TUI  — readUIMessageStream(...) in-process → uiMessageToParts → render
// No second loop, no divergence.

export type AgentDataParts = {
  status: { label: string };
  fileChange: { path: string; action: "write" | "edit" | "delete" };
  usage: { inputTokens: number; outputTokens: number }; // cumulative this turn
  // Context size + compaction threshold. system/tools are constant per turn (cheap to recompute);
  // wire is the live working-history size — mirrors AgentSession.tokenBreakdown()'s shape so the
  // live stream and the restore-on-reload endpoint agree on what each number means.
  // v2 (plan 13 P3, ADDITIVE — v1 fields untouched): per-tool definition cost (Σ tokens === the
  // `tools` field, by construction of estimateToolsTokens), per-tool runtime cost/calls inside the
  // CURRENT wire (resets at compaction — "since last checkpoint"), and history size per role.
  context: {
    wire: number;
    system?: number;
    tools?: number;
    summarizeAt?: number;
    window?: number;
    toolDefs?: { name: string; tokens: number }[];
    toolRuntime?: { name: string; calls: number; tokens: number }[];
    historyRoles?: { role: string; tokens: number }[];
  };
  // A compaction just happened (history summarized into one checkpoint). Non-transient — it's
  // attached to the message like data-fileChange, so it survives in the turn's rendered parts.
  compaction: { before: number; after: number; summary?: string };
};
export type AgentUIMessage = UIMessage<{ totalTokens?: number }, AgentDataParts>;

export type AgentStreamConfig = {
  model: LanguageModel;
  system: string;
  tools: ToolSet;
  messages: ModelMessage[] | (() => Promise<ModelMessage[]>); // wire (resolver for the web path)
  maxSteps?: number;
  costCapTokens?: number;
  compaction?: { limit?: number; reserve?: number };
  summarizeAt?: number;
  compactWire?: (messages: ModelMessage[]) => Promise<ModelMessage[]>;
  signal?: AbortSignal;
  providerOptions?: Record<string, Record<string, unknown>>;
  // Per-turn tool runtime ctx (plan 13 P0): called once per turn with `emit` bound to THIS turn's
  // writer; the returned object is streamText's toolsContext (keyed by tool name → options.context).
  buildToolsContext?: BuildToolsContext;
  onUsage?: (u: Usage) => void;
  onWire?: (tokens: number) => void;
  onCompact?: (info: { before: number; after: number }) => void;
  // Called right when a compaction fires, to pull the summary text the app already computed (e.g.
  // AgentSession stashes it from summarize()) — kept out of onCompact's signature since agent-core
  // doesn't know what a "summary" is, only that compaction happened.
  consumeCompactionSummary?: () => string | undefined;
  onComplete?: (result: LoopResult) => void; // model-side result (history, stop) for a stateful caller
  onError?: (error: unknown) => void; // provider/stream error (createUIMessageStream swallows it otherwise)
  originalMessages?: AgentUIMessage[]; // for client-side persistence/ids (web)
  contextWindow?: number; // model context window — surfaced to the client stats bar
  stepCheckpoint?: number; // §3b adaptive budget: audit cadence
  maxStepExtensions?: number; // §3b hard backstop on extensions
  onCheckpoint?: OnCheckpoint; // §3b auditor policy hook
};

// Pull a human, ACTIONABLE message out of a provider/stream error. The AI SDK wraps the real
// provider failure ("No output generated…") around the underlying APICallError, which carries the
// provider text in `.data.error.message` and the HTTP `.statusCode` — so walk the `.cause` chain to
// the API-level error rather than reporting the opaque wrapper. Account-level cases (out of credit /
// rate limited) get a plain prefix so the user knows it's their provider account, not a code bug.
type ErrLike = { message?: string; statusCode?: number; data?: { error?: { message?: string } }; responseBody?: string; cause?: unknown };
export function describeError(e: unknown): string {
  const chain: ErrLike[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    chain.push(cur as ErrLike);
    cur = (cur as ErrLike).cause;
  }
  const api = chain.find((c) => c.statusCode !== undefined || c.data?.error?.message !== undefined) ?? chain[0];
  const raw = api?.data?.error?.message ?? api?.message ?? (typeof e === "string" ? e : "Unknown error");
  const status = api?.statusCode;
  if (status === 402 || status === 403 || /key limit|insufficient|quota|credit|out of|payment/i.test(raw)) return `Provider rejected the request — ${raw}`;
  if (status === 429 || /rate.?limit|too many/i.test(raw)) return `Rate limited by the provider — ${raw}`;
  return raw;
}

export function agentStream(cfg: AgentStreamConfig) {
  return createUIMessageStream<AgentUIMessage>({
    originalMessages: cfg.originalMessages,
    // createUIMessageStream swallows a throwing execute (writes a generic error part, ends the
    // stream cleanly). Capture the REAL provider error here so the caller can surface it.
    onError: (error) => {
      cfg.onError?.(error);
      return describeError(error);
    },
    execute: async ({ writer }) => {
      const messages = typeof cfg.messages === "function" ? await cfg.messages() : cfg.messages;
      writer.write({ type: "data-status", data: { label: "thinking" }, transient: true });

      // Per-tool definition cost (plan 13 P3) — the tools don't change within a turn, so compute
      // this once; every data-context tick reuses it. Σ tokens === estimateToolsTokens(cfg.tools).
      const toolDefs = Object.entries(cfg.tools).map(([name, tool]) => ({ name, tokens: estimateToolTokens(name, tool) }));

      // Tool-side emit, bound to THIS turn's writer. Custom `data-*` parts pass through untyped
      // (AgentDataParts stays a closed map of the harness's own parts — §7.3 decision), hence the
      // cast. `id` enables part reconciliation (same id = update in place), `transient` skips
      // message persistence — same semantics as the harness's own data parts above/below.
      const emit: EmitFn = (type, data, opts) =>
        writer.write({ type, data, ...(opts?.id !== undefined ? { id: opts.id } : {}), ...(opts?.transient ? { transient: true } : {}) } as never);

      const result = await runAgentLoop(
        {
          model: cfg.model,
          system: cfg.system,
          tools: cfg.tools,
          messages,
          toolsContext: cfg.buildToolsContext?.({ emit }),
          maxSteps: cfg.maxSteps,
          costCapTokens: cfg.costCapTokens,
          compaction: cfg.compaction,
          summarizeAt: cfg.summarizeAt,
          compactWire: cfg.compactWire,
          signal: cfg.signal,
          providerOptions: cfg.providerOptions,
          stepCheckpoint: cfg.stepCheckpoint,
          maxStepExtensions: cfg.maxStepExtensions,
          onCheckpoint: cfg.onCheckpoint,
          onUsage: (u) => {
            writer.write({ type: "data-usage", data: { inputTokens: u.inp, outputTokens: u.out }, transient: true });
            cfg.onUsage?.(u);
          },
          onWire: (t, wireMessages) => {
            writer.write({
              type: "data-context",
              data: {
                wire: t,
                system: estimateSystemTokens(cfg.system),
                tools: estimateToolsTokens(cfg.tools),
                summarizeAt: cfg.summarizeAt,
                window: cfg.contextWindow,
                toolDefs, // per-tool definition cost — constant per turn, computed once above
                toolRuntime: toolRuntimeStats(wireMessages),
                historyRoles: historyRoleStats(wireMessages),
              },
              transient: true,
            });
            cfg.onWire?.(t);
          },
          onCompact: (info) => {
            const summary = cfg.consumeCompactionSummary?.();
            writer.write({ type: "data-compaction", data: { ...info, summary } });
            cfg.onCompact?.(info);
          },
          onStepComplete: ({ stepMessages }) => {
            for (const fc of fileChangesOf(stepMessages)) writer.write({ type: "data-fileChange", id: fc.path, data: fc });
          },
        },
        async (stepResult) => {
          writer.merge(toUIMessageStream({ stream: stepResult.fullStream })); // forward this step
          return { aborted: cfg.signal?.aborted ?? false };
        },
      );

      writer.write({ type: "data-status", data: { label: "done" }, transient: true });
      cfg.onComplete?.(result);
    },
  });
}

// Rebuild the rendered Part[][] from a consumed UIMessage (the TUI's display source). step-start
// parts split steps; tool parts map to our tool Parts (ok also respects tools that return an error
// STRING with a success state).
export function uiMessageToParts(msg: { parts: readonly unknown[] }): Part[][] {
  const steps: Part[][] = [];
  let cur: Part[] | null = null;
  const into = (): Part[] => {
    if (!cur) {
      cur = [];
      steps.push(cur);
    }
    return cur;
  };
  for (const raw of msg.parts) {
    const p = raw as { type: string; text?: string; toolCallId?: string; input?: unknown; output?: unknown; errorText?: string; state?: string };
    if (p.type === "step-start") {
      cur = [];
      steps.push(cur);
    } else if (p.type === "text") {
      if (p.text) into().push({ kind: "text", text: p.text });
    } else if (p.type === "reasoning") {
      if (p.text) into().push({ kind: "thinking", text: p.text });
    } else if (p.type.startsWith("tool-") || p.type === "dynamic-tool") {
      const result = p.output != null ? (typeof p.output === "string" ? p.output : JSON.stringify(p.output)) : (p.errorText ?? undefined);
      const done = p.state === "output-available" || p.state === "output-error";
      const ok = p.state !== "output-error" && !(result != null && looksLikeError(result));
      into().push({ kind: "tool", id: p.toolCallId ?? "", name: getToolName(p as never), done, ok, args: p.input, result });
    }
  }
  return steps.length ? steps : [[]];
}

// Reconstruct UIMessages from stored turns — lets a web client restore the conversation on reload
// (inverse of uiMessageToParts). Compaction markers become a standalone message with ONE
// data-compaction part, so the client can render it as a divider — history above is never dropped.
export function turnsToUIMessages(turns: Turn[]): AgentUIMessage[] {
  const out: AgentUIMessage[] = [];
  let n = 0;
  for (const t of turns) {
    if (t.role === "user") {
      // Restore attachment chips/thumbnails: file parts FIRST (matches the live optimistic render),
      // then the text. `url` is the app's attachment reference — the client resolves/serves it.
      const fileParts = (t.attachments ?? []).map((a) => ({ type: "file" as const, url: a.url, mediaType: a.mediaType, filename: a.filename }));
      out.push({ id: `u-${n++}`, role: "user", parts: [...fileParts, { type: "text", text: t.text }] });
    } else if (t.role === "compaction") {
      out.push({
        id: `c-${n++}`,
        role: "assistant",
        parts: [{ type: "data-compaction", data: { before: t.before, after: t.after, summary: t.summary } } as never],
      });
    } else if (t.role === "checkpoint") {
      out.push({
        id: `k-${n++}`,
        role: "assistant",
        parts: [{ type: "data-checkpoint", data: { step: t.step, verdict: t.verdict, reason: t.reason } } as never],
      });
    } else if (t.role === "assistant") {
      const parts: AgentUIMessage["parts"] = [];
      for (const step of t.steps) {
        for (const p of step) {
          if (p.kind === "text") parts.push({ type: "text", text: p.text, state: "done" } as never);
          else if (p.kind === "thinking") parts.push({ type: "reasoning", text: p.text, state: "done" } as never);
          else if (p.kind === "tool")
            parts.push({
              type: `tool-${p.name}`,
              toolCallId: p.id,
              state: p.done ? (p.ok ? "output-available" : "output-error") : "input-available",
              input: p.args,
              ...(p.ok ? { output: p.result } : { errorText: p.result }),
            } as never);
        }
      }
      if (parts.length) out.push({ id: `a-${n++}`, role: "assistant", parts });
    }
  }
  return out;
}

// Is the model currently producing reasoning (for a live "thinking" timer)?
export function uiMessageIsThinking(msg: { parts: readonly unknown[] }): boolean {
  const last = msg.parts[msg.parts.length - 1] as { type?: string; state?: string } | undefined;
  return last?.type === "reasoning" && last.state === "streaming";
}

// ─── web wrappers (thin) ──────────────────────────────────────────────────────────────────────
export type AgentUIStreamInput = {
  model: LanguageModel;
  systemPrompt: string;
  tools: ToolSet;
  incoming: AgentUIMessage[];
  maxSteps?: number;
  costCapTokens?: number;
  compaction?: { limit?: number; reserve?: number };
  signal?: AbortSignal;
};

export function agentUIStream(opts: AgentUIStreamInput) {
  return agentStream({
    model: opts.model,
    system: opts.systemPrompt,
    tools: opts.tools,
    messages: () => convertToModelMessages(opts.incoming),
    maxSteps: opts.maxSteps,
    costCapTokens: opts.costCapTokens,
    compaction: opts.compaction,
    signal: opts.signal,
    originalMessages: opts.incoming,
  });
}

export function agentUIResponse(opts: AgentUIStreamInput): Response {
  return createUIMessageStreamResponse({ stream: agentUIStream(opts) });
}

// File changes (write/edit/delete) from a step's response messages → data parts.
function fileChangesOf(messages: ModelMessage[]): { path: string; action: "write" | "edit" | "delete" }[] {
  const out: { path: string; action: "write" | "edit" | "delete" }[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const part of m.content as { type?: string; toolName?: string; input?: { path?: string } }[]) {
      if (part.type !== "tool-call" || !part.input?.path) continue;
      if (part.toolName === "write_file") out.push({ path: part.input.path, action: "write" });
      else if (part.toolName === "edit_file") out.push({ path: part.input.path, action: "edit" });
      else if (part.toolName === "delete_file") out.push({ path: part.input.path, action: "delete" });
    }
  }
  return out;
}
