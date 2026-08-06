import { randomUUID } from "node:crypto";
import { readUIMessageStream, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { AgentEvent, AgentStatus, FileChange, Part, Turn, TurnMeta, Usage , TurnAttachment } from "../types";
import { resolveConfig, type HarnessConfig, type ResolvedConfig } from "../config";
import type { LoopResult } from "../core/agent-core";
import {
  compact,
  estimateSystemTokens,
  estimateTokens,
  estimateToolTokens,
  estimateToolsTokens,
  extractSummary,
  historyRoleStats,
  toolRuntimeStats,
  type ToolRuntimeStat,
} from "../core/compaction";
import { agentStream, describeError, uiMessageIsThinking, uiMessageToParts } from "./ui-stream";
import { newSession, type Session } from "../tools/file-tools";
import { dumpVfs, type VFS } from "../vfs/types";
import { MemoryVFS } from "../vfs/memory";
import type { SessionSnapshot, SessionStore } from "../session/session-store";

export class AgentBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`Agent for session '${sessionId}' is already running`);
    this.name = "AgentBusyError";
  }
}

export type AgentSessionInit = {
  id?: string;
  config: HarnessConfig | ResolvedConfig;
  vfs?: VFS;
  store?: SessionStore;
  persistEachStep?: boolean;
  snapshot?: SessionSnapshot; // restore prior state
};

// A stateful, subscribable agent bound to one conversation. Holds TWO histories:
//   - workingHistory : what's loaded to the model (from the last summary checkpoint) — §6/§8 wire
//   - fullLog        : append-only durable record of EVERY message from the start — §8 storage
// Plus the workspace (VFS) + read-state (lastRead). Broadcasts events so multiple clients
// (tabs / reconnects) can follow the SAME running turn via attach().
export class AgentSession {
  readonly id: string;
  title?: string;
  status: AgentStatus = "idle";
  turns: Turn[] = [];
  live: Part[][] | null = null;
  usage: Usage = { inp: 0, out: 0 };

  workingHistory: ModelMessage[] = [];
  fullLog: ModelMessage[] = [];
  turnMeta: TurnMeta[] = []; // billing + audit, per turn
  fileChanges: FileChange[] = []; // file change index
  readonly vfs: VFS;

  private cfg: ResolvedConfig;
  private store?: SessionStore;
  private persistEachStep: boolean;
  private toolSession: Session = newSession();
  private tools: ToolSet;
  private subs = new Set<(e: AgentEvent) => void>();
  private ac: AbortController | null = null;
  private _wire = 0; // live wire size (tokens actually sent to the model) during a turn; 0 when idle
  private _lastStreamError?: unknown; // captured provider/stream error for the current turn (see _startTurn)
  private _thinkingSince: number | null = null; // timestamp the current reasoning burst started; null = not thinking
  private _compactingSince: number | null = null; // timestamp compaction started; null = not compacting
  private _pendingCompactionSummary?: string; // set by summarize(), consumed once by the UI stream's onCompact

  constructor(init: AgentSessionInit) {
    this.id = init.id ?? randomUUID();
    this.cfg = resolveConfig(init.config);
    this.store = init.store;
    this.persistEachStep = init.persistEachStep ?? false;
    this.vfs = init.vfs ?? new MemoryVFS(init.snapshot?.vfs);

    if (init.snapshot) {
      this.title = init.snapshot.title;
      this.workingHistory = init.snapshot.workingHistory;
      this.fullLog = init.snapshot.fullLog;
      this.turns = init.snapshot.turns;
      this.usage = init.snapshot.usage;
      this.turnMeta = init.snapshot.turnMeta ?? [];
      this.fileChanges = init.snapshot.fileChanges ?? [];
      for (const [p, h] of Object.entries(init.snapshot.lastRead ?? {})) this.toolSession.lastRead.set(p, h);
    }

    this.tools = { ...this.cfg.tools, ...(this.cfg.toolsFactory?.(this.vfs, this.toolSession) ?? {}) };
  }

  isRunning(): boolean {
    return this.status === "running";
  }

  /** Live wire size in tokens (what's actually sent to the model this step). 0 when idle. */
  get liveWire(): number {
    return this._wire;
  }

  /** Timestamp (ms) the current reasoning burst started, or null when not thinking. */
  get thinkingSince(): number | null {
    return this._thinkingSince;
  }

  /** Timestamp (ms) compaction started, or null when not compacting. */
  get compactingSince(): number | null {
    return this._compactingSince;
  }

  /** Abort the running turn. Partial output is kept (saved as a turn with stop: "aborted"). */
  abort(): void {
    this.ac?.abort();
  }

  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  private emit(e: AgentEvent): void {
    for (const fn of [...this.subs]) fn(e);
  }

  snapshotState(): { id: string; status: AgentStatus; turns: Turn[]; live: Part[][] | null; usage: Usage } {
    return { id: this.id, status: this.status, turns: this.turns, live: this.live, usage: this.usage };
  }

  // Follow this session: a full snapshot first (late clients catch up), then live events.
  async *attach(): AsyncGenerator<AgentEvent> {
    yield { type: "snapshot", status: this.status, turns: this.turns, live: this.live, usage: this.usage };
    const queue: AgentEvent[] = [];
    let wake: (() => void) | null = null;
    const unsub = this.subscribe((e) => {
      queue.push(e);
      wake?.();
      wake = null;
    });
    try {
      while (true) {
        if (queue.length === 0) await new Promise<void>((r) => (wake = r));
        while (queue.length) yield queue.shift()!;
      }
    } finally {
      unsub();
    }
  }

  /** TUI/headless: run one turn and resolve with the rendered Turn. */
  async send(text: string, opts?: { attachments?: TurnAttachment[] }): Promise<Turn> {
    if (this.status === "running") throw new AgentBusyError(this.id);
    const t = this._begin(text, opts);
    return this._drive(t.stream, t.userMsg, t.startedAt, t.base, t.getResult);
  }

  /**
   * Web: start a turn and return the client-facing UIMessageStream immediately (for SSE), while a
   * teed branch drives THIS session's state + persistence in the background. Same loop as send().
   */
  sendUIStream(text: string, opts?: { attachments?: TurnAttachment[] }): ReturnType<typeof agentStream> {
    if (this.status === "running") throw new AgentBusyError(this.id);
    const t = this._begin(text, opts);
    const [client, internal] = t.stream.tee();
    void this._drive(internal, t.userMsg, t.startedAt, t.base, t.getResult);
    return client;
  }

  // Record the user message + build the turn's agentStream (shared by send + sendUIStream).
  private _begin(text: string, opts?: { attachments?: TurnAttachment[] }): {
    stream: ReturnType<typeof agentStream>;
    userMsg: ModelMessage;
    startedAt: number;
    base: Usage;
    getResult: () => LoopResult | undefined;
  } {
    this.status = "running";
    this.emit({ type: "status", status: "running" });
    // Attachment META rides on the turn (display/restore only — the model sees the fenced blocks
    // already inlined into `text`; bytes stay in the attachment store, never in the session log).
    this.turns.push({ role: "user", text, at: Date.now(), ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}) }); // push BEFORE emit so subscribers see it
    if (!this.title) this.title = text.slice(0, 60);
    this.emit({ type: "user", text });

    const startedAt = Date.now();
    const base = { ...this.usage };
    this.ac = new AbortController();
    const userMsg: ModelMessage = { role: "user", content: text };
    let result: LoopResult | undefined;
    this._lastStreamError = undefined; // cleared per turn; set by the stream's onError below
    const stream = agentStream({
      onError: (e) => {
        this._lastStreamError = e;
      },
      model: this.cfg.model,
      system: this.cfg.systemPrompt,
      tools: this.tools,
      buildToolsContext: this.cfg.buildToolsContext, // per-turn tool runtime ctx (plan 13 P0)
      messages: [...this.workingHistory, userMsg], // §6/§8 — model sees the compacted working set
      maxSteps: this.cfg.maxSteps,
      costCapTokens: this.cfg.costCapTokens,
      compaction: this.cfg.compaction,
      summarizeAt: this.cfg.compaction.summarizeAt, // mid-turn auto-compact at this size
      compactWire: (msgs) => this.summarize(msgs),
      providerOptions: this.cfg.providerOptions,
      contextWindow: this.cfg.contextWindow,
      signal: this.ac.signal,
      // §3b adaptive step budget / loop-guard. The POLICY (pre-check + LLM auditor) lives in the
      // app's config.onCheckpoint; the session wraps it to broadcast the verdict as a checkpoint
      // event so any attached client can render the inline "Checkpoint N — …" marker.
      stepCheckpoint: this.cfg.stepCheckpoint,
      maxStepExtensions: this.cfg.maxStepExtensions,
      onCheckpoint: this.cfg.onCheckpoint
        ? async (ctx) => {
            const decision = await this.cfg.onCheckpoint!(ctx);
            // Persist the marker as a TURN (like compaction) so history restore shows it, then
            // broadcast live for clients already attached.
            this.turns.push({ role: "checkpoint", step: ctx.step, verdict: decision.action, reason: decision.reason, at: Date.now() });
            this.emit({ type: "checkpoint", step: ctx.step, verdict: decision.action, reason: decision.reason });
            return decision;
          }
        : undefined,
      onUsage: (u) => {
        this.usage = { inp: base.inp + u.inp, out: base.out + u.out };
        this.emit({ type: "usage", usage: this.usage });
      },
      onWire: (t) => {
        this._wire = t;
        this.emit({ type: "usage", usage: this.usage }); // cheap re-render so the footer tracks the wire
      },
      onCompact: ({ after }) => {
        this._wire = after; // the Turn + "compaction" event are pushed by summarize() itself
      },
      consumeCompactionSummary: () => {
        const s = this._pendingCompactionSummary;
        this._pendingCompactionSummary = undefined;
        return s;
      },
      onComplete: (r) => {
        result = r; // model-side outcome (history, stop) — captured after the loop
      },
    });
    return { stream, userMsg, startedAt, base, getResult: () => result };
  }

  // Consume the UIMessageStream IN-PROCESS → render Part[][], drive thinking, persist, emit turn-end.
  private async _drive(
    stream: ReturnType<typeof agentStream>,
    userMsg: ModelMessage,
    startedAt: number,
    base: Usage,
    getResult: () => LoopResult | undefined,
  ): Promise<Turn> {
    try {
      let steps: Part[][] = [];
      let thinking = false;
      for await (const msg of readUIMessageStream({ stream })) {
        steps = uiMessageToParts(msg);
        this.live = steps;
        this.emit({ type: "step", steps });
        if (this.persistEachStep) void this.persist();
        const t = uiMessageIsThinking(msg);
        if (t !== thinking) {
          thinking = t;
          this._thinkingSince = t ? Date.now() : null;
          this.emit({ type: "thinking", active: t });
        }
      }

      const result = getResult();
      // A null result means the stream ended abnormally — almost always a provider error the
      // createUIMessageStream swallowed. Surface the REAL message (captured via onError) instead of
      // the opaque "ended without a result".
      if (!result) throw new Error(this._lastStreamError !== undefined ? describeError(this._lastStreamError) : "agent stream ended without a result");
      this.workingHistory = result.finalMessages; // final wire (mid-turn compacted) IS the working set
      this.fullLog.push(userMsg, ...result.response); // durable: never compacted
      this.usage = { inp: base.inp + result.usage.inp, out: base.out + result.usage.out };

      const turn: Turn = { role: "assistant", steps, stop: result.stop, durationMs: Date.now() - startedAt, at: Date.now() };
      this.turns.push(turn);
      this.recordTurn(steps, result.usage); // billing + file-change index
      this.live = null;
      this._wire = 0;
      this._thinkingSince = null;
      this.emit({ type: "thinking", active: false }); // clear the timer if the turn ended mid-thought
      this.status = "idle";
      this.emit({ type: "turn-end", turn });
      this.emit({ type: "status", status: "idle" });

      try {
        await this.compactIfNeeded(); // §6 session-level: summarize working history into a checkpoint
      } catch {
        // best-effort maintenance — a compaction failure must NOT turn a completed turn into an error
      }
      await this.persist();
      this.ac = null;
      return turn;
    } catch (e) {
      // Surface the error AS a turn (stop: "error") so the conversation shows what happened.
      const msg = (e as Error).message;
      const steps = this.live ? this.live.map((s) => s.slice()) : [];
      steps.push([{ kind: "text", text: `⚠ ${msg}` }]);
      const turn: Turn = { role: "assistant", steps, stop: "error", durationMs: Date.now() - startedAt, at: Date.now() };
      this.turns.push(turn);
      this.live = null;
      this._wire = 0;
      this._thinkingSince = null;
      this.emit({ type: "thinking", active: false });
      this.status = "idle";
      this.emit({ type: "error", message: msg });
      this.emit({ type: "turn-end", turn });
      this.emit({ type: "status", status: "idle" });
      this.ac = null;
      return turn;
    }
  }

  // Billing per turn + file-change index, derived from the turn's render data.
  private recordTurn(steps: Part[][], turnUsage: Usage): void {
    const turn = this.turnMeta.length + 1;
    const at = new Date().toISOString();
    const model = this.cfg.modelId ?? (this.cfg.model as { modelId?: string }).modelId ?? "model";
    this.turnMeta.push({ turn, model, inp: turnUsage.inp, out: turnUsage.out, at });
    for (const s of steps)
      for (const p of s) {
        if (p.kind !== "tool" || !p.done || !p.ok) continue;
        const path = ((p.args ?? {}) as { path?: string }).path;
        if (!path) continue;
        if (p.name === "write_file") this.fileChanges.push({ path, action: "write", turn, at });
        else if (p.name === "edit_file") this.fileChanges.push({ path, action: "edit", turn, at });
        else if (p.name === "delete_file") this.fileChanges.push({ path, action: "delete", turn, at });
      }
  }

  // Context token breakdown (for a stats UI): how the model's input budget is spent and how
  // much room is left before §6 auto-compaction kicks in. summarizeAt counts the working
  // history only (system + tools are always present).
  // v2 (plan 13 P3, ADDITIVE — every v1 field keeps its exact meaning/value): `toolDefs` splits
  // the `tools` line per tool (Σ tokens === tools, by construction), `toolRuntime` attributes the
  // CURRENT working history per tool (calls + live result tokens — resets at compaction, i.e.
  // "since the last checkpoint", §7.5), `historyRoles` splits history per role (informational).
  tokenBreakdown(): {
    system: number;
    tools: number;
    history: number;
    total: number;
    window: number;
    summarizeAt: number;
    untilCompact: number | null;
    toolDefs: { name: string; tokens: number }[];
    toolRuntime: ToolRuntimeStat[];
    historyRoles: { role: string; tokens: number }[];
  } {
    const system = estimateSystemTokens(this.cfg.systemPrompt);
    const tools = estimateToolsTokens(this.tools);
    const history = estimateTokens(this.workingHistory);
    const summarizeAt = this.cfg.compaction.summarizeAt ?? 0;
    return {
      system,
      tools,
      history,
      total: system + tools + history,
      window: this.cfg.contextWindow ?? 0,
      summarizeAt,
      untilCompact: summarizeAt > 0 ? Math.max(0, summarizeAt - history) : null,
      toolDefs: Object.entries(this.tools).map(([name, tool]) => ({ name, tokens: estimateToolTokens(name, tool) })),
      toolRuntime: toolRuntimeStats(this.workingHistory),
      historyRoles: historyRoleStats(this.workingHistory),
    };
  }

  // Runtime config view + live reconfiguration (for a settings UI).
  toolNames(): string[] {
    return Object.keys(this.tools);
  }
  get settings(): { model: string; maxSteps: number; costCapTokens: number; summarizeAt: number } {
    return {
      model: (this.cfg.model as { modelId?: string }).modelId ?? "model",
      maxSteps: this.cfg.maxSteps,
      costCapTokens: this.cfg.costCapTokens,
      summarizeAt: this.cfg.compaction.summarizeAt ?? 0,
    };
  }
  reconfigure(p: {
    model?: LanguageModel;
    systemPrompt?: string; // e.g. re-derived per-project prompt (title/description can change after session creation)
    maxSteps?: number;
    costCapTokens?: number;
    summarizeAt?: number;
    providerOptions?: Record<string, Record<string, unknown>>;
  }): void {
    this.cfg = {
      ...this.cfg,
      model: p.model ?? this.cfg.model,
      systemPrompt: p.systemPrompt ?? this.cfg.systemPrompt,
      maxSteps: p.maxSteps ?? this.cfg.maxSteps,
      costCapTokens: p.costCapTokens ?? this.cfg.costCapTokens,
      compaction:
        p.summarizeAt !== undefined ? { ...this.cfg.compaction, summarizeAt: p.summarizeAt } : this.cfg.compaction,
      providerOptions: p.providerOptions ?? this.cfg.providerOptions,
    };
  }

  // §6 — summarize a message list into ONE summary message (no head/tail, no file contents — the
  // VFS holds those). Emits a "compacting" progress signal + pushes an inline marker. Shared by
  // mid-turn auto-compaction (compactWire) and the between-turns checkpoint (compactIfNeeded).
  private async summarize(messages: ModelMessage[]): Promise<ModelMessage[]> {
    const before = estimateTokens(messages);
    this._compactingSince = Date.now();
    this.emit({ type: "compacting", active: true });
    try {
      const next = await compact(this.cfg.model, messages, { system: this.cfg.compaction.summaryPrompt });
      const turn: Turn = { role: "compaction", before, after: estimateTokens(next), summary: extractSummary(next) };
      this.turns.push(turn);
      this._pendingCompactionSummary = turn.summary;
      // Carry the marker's before/after/summary so an attached client can render the compaction
      // divider LIVE (the Turn itself is pushed to this.turns, but attach() only re-snapshots on
      // (re)connect — the event is the client's only mid-turn channel).
      this.emit({ type: "compaction", kept: next.length, before: turn.before, after: turn.after, summary: turn.summary });
      return next;
    } finally {
      this._compactingSince = null;
      this.emit({ type: "compacting", active: false });
    }
  }

  // Between-turns safety: if the final working set is still over the threshold, summarize it.
  private async compactIfNeeded(): Promise<void> {
    const at = this.cfg.compaction.summarizeAt;
    if (!at || estimateTokens(this.workingHistory) <= at) return;
    this.workingHistory = await this.summarize(this.workingHistory);
  }

  /**
   * User-triggered compaction (e.g. a "/compact" command), regardless of the summarizeAt
   * threshold. Throws AgentBusyError if a turn is currently streaming — compacting mid-turn would
   * race with it. Persists immediately (this doesn't run inside a normal turn's persist path).
   */
  async forceCompact(): Promise<{ before: number; after: number }> {
    if (this.status === "running") throw new AgentBusyError(this.id);
    const before = estimateTokens(this.workingHistory);
    this.workingHistory = await this.summarize(this.workingHistory);
    const after = estimateTokens(this.workingHistory);
    await this.persist();
    return { before, after };
  }

  private baseSnapshot(): Omit<SessionSnapshot, "vfs"> {
    return {
      id: this.id,
      title: this.title,
      workingHistory: this.workingHistory,
      fullLog: this.fullLog,
      turns: this.turns,
      lastRead: Object.fromEntries(this.toolSession.lastRead),
      usage: this.usage,
      turnMeta: this.turnMeta,
      fileChanges: this.fileChanges,
      updatedAt: new Date().toISOString(),
    };
  }

  // Full portable snapshot (includes a workspace dump) — for explicit export/import.
  async export(): Promise<SessionSnapshot> {
    return { ...this.baseSnapshot(), vfs: await dumpVfs(this.vfs) };
  }

  // Replace this session's CHAT state from a snapshot (load) — conversation, history, usage, audit.
  // The workspace VFS is intentionally left as-is (the saved session carries no files). Emits a
  // snapshot event so any attached UI re-renders to the loaded state.
  restore(snap: SessionSnapshot): void {
    this.title = snap.title;
    this.workingHistory = snap.workingHistory;
    this.fullLog = snap.fullLog;
    this.turns = snap.turns;
    this.usage = snap.usage;
    this.turnMeta = snap.turnMeta ?? [];
    this.fileChanges = snap.fileChanges ?? [];
    this.toolSession.lastRead.clear();
    for (const [p, h] of Object.entries(snap.lastRead ?? {})) this.toolSession.lastRead.set(p, h);
    this.live = null;
    this.emit({ type: "snapshot", status: this.status, turns: this.turns, live: this.live, usage: this.usage });
  }

  // Progressive save. Dumps the workspace only for ephemeral MemoryVFS; persistent drivers
  // (fs/db) are their own source of truth, so we don't re-dump them.
  async persist(): Promise<void> {
    if (!this.store) return;
    const isMemory = this.vfs instanceof MemoryVFS;
    await this.store.save({ ...this.baseSnapshot(), vfs: isMemory ? this.vfs.dump() : undefined });
  }
}
