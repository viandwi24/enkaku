// Shared data types. The agent loop produces Part[][]; the runtime emits AgentEvents.
// Presentation layers (TUI, web) render these — same source data everywhere.

export type Part =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string } // model reasoning — stored as raw data; UI shows it dim (collapsible)
  | { kind: "tool"; id: string; name: string; done: boolean; ok: boolean; args?: unknown; result?: string };

// Why a turn ended: the model finished, a guard cut it off, the user aborted, or it errored.
// The last four are the adaptive step-budget / loop-guard outcomes (§3b): a hard budget ran out,
// the auditor stopped a loop (deterministic pre-check) or judged no progress (LLM), or it asked to
// pause for the user. `max-steps` remains for the legacy hard-stop path (no onCheckpoint hook set).
export type StopReason =
  | "complete"
  | "max-steps"
  | "cost-cap"
  | "length"
  | "aborted"
  | "error"
  | "loop-detected"
  | "halted-by-auditor"
  | "paused-checkpoint"
  | "budget-exhausted";

// ─── Adaptive step budget / loop-guard auditor (§3b) ──────────────────────────────────────────
// A cheap per-step summary the auditor reasons over instead of the full transcript: which tools
// ran (name + a hash of the args) and whether the step mutated files/state. `mutated` = the step
// contained a write/edit/delete tool call.
export type StepSummary = { tools: { name: string; argsHash: string }[]; mutated: boolean };

export type CheckpointVerdict = "continue" | "ask" | "stop";

// The auditor's decision at a checkpoint. `stopReason` (only meaningful when action==="stop")
// distinguishes a deterministic loop from an LLM judgment so the turn surfaces the right reason.
export type CheckpointDecision = {
  action: CheckpointVerdict;
  reason: string;
  stopReason?: "loop-detected" | "halted-by-auditor";
};

// What the auditor hook receives at each checkpoint: the absolute step count, a summary of the
// steps in this block (since the last checkpoint), and how many extensions were already granted.
export type CheckpointCtx = { step: number; recentSteps: StepSummary[]; extensionsUsed: number };

export type OnCheckpoint = (ctx: CheckpointCtx) => Promise<CheckpointDecision>;

/** Display metadata of a file the user attached to a turn (bytes live behind `url`, never here). */
export type TurnAttachment = { url: string; mediaType: string; filename: string };

// `at` (epoch ms) = when the turn was recorded (user: sent; assistant: ended). OPTIONAL and
// additive — turns persisted before this field exists simply have no timestamp (render nothing).
export type Turn =
  | { role: "user"; text: string; attachments?: TurnAttachment[]; at?: number }
  | { role: "assistant"; steps: Part[][]; stop?: StopReason; durationMs?: number; at?: number }
  | { role: "compaction"; before: number; after: number; summary?: string } // §6 inline marker
  // §3b PERSISTED checkpoint marker (Cursor-style "step limit reached — extended"): pushed the
  // moment the auditor rules, so the mark survives reload/other tabs — not just the live event.
  | { role: "checkpoint"; step: number; verdict: CheckpointVerdict; reason: string; at?: number };

export type Usage = { inp: number; out: number };

// Per-turn record for billing + audit (model used, tokens, when).
export type TurnMeta = { turn: number; model: string; inp: number; out: number; at: string };

// File change index — derived from successful write/edit/delete tool calls each turn.
// Lightweight pointers (no file content); useful for the AI ("what changed recently") and
// for other tools/agents (review, deploy).
export type FileChange = { path: string; action: "write" | "edit" | "delete"; turn: number; at: string };

export type AgentStatus = "idle" | "running" | "error";

// ─── Tools runtime context (plan 13 P0) ───────────────────────────────────────────────────────
// Push a custom `data-*` part into the CURRENT turn's UIMessageStream from inside a tool's
// execute (via the SDK-native `toolsContext` → `options.context`). Bound to the live writer on
// the web/agentStream path; a NO-OP on headless paths without a writer (runAgentTurn).
// Custom part payloads are untyped at this layer by design (§7.3): AgentDataParts stays a closed
// map of the harness's own parts, and plugin parts pass through as-is — an app that wants typed
// custom parts narrows them on its own UIMessage type.
export type EmitFn = (type: `data-${string}`, data: unknown, opts?: { id?: string; transient?: boolean }) => void;

// Built ONCE per turn by the transport (agentStream binds emit to the turn's writer; runAgentTurn
// binds a no-op) and passed as streamText's `toolsContext` — an object keyed by TOOL NAME whose
// values reach that tool's `execute(input, options)` as `options.context`. The harness stays
// generic: WHAT goes into each tool's context (and for which tools) is the app's decision.
export type BuildToolsContext = (rt: { emit: EmitFn }) => Record<string, unknown>;

// Streaming events a client (TUI / web SSE) consumes. `snapshot` is sent first on attach
// so a late client (new tab / reconnect) gets the full in-progress state, then live deltas.
export type AgentEvent =
  | { type: "snapshot"; status: AgentStatus; turns: Turn[]; live: Part[][] | null; usage: Usage }
  | { type: "user"; text: string }
  | { type: "step"; steps: Part[][] }
  | { type: "usage"; usage: Usage }
  | { type: "turn-end"; turn: Turn }
  | { type: "compaction"; kept: number; before?: number; after?: number; summary?: string } // working history summarized into a checkpoint
  | { type: "compacting"; active: boolean } // compaction in progress (show a spinner)
  | { type: "thinking"; active: boolean } // model is reasoning (thinking) — show a timer
  | { type: "checkpoint"; step: number; verdict: CheckpointVerdict; reason: string } // §3b auditor verdict at a step checkpoint
  | { type: "status"; status: AgentStatus }
  | { type: "error"; message: string };
