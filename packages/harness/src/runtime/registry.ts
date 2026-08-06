import { randomUUID } from "node:crypto";
import type { AgentStatus } from "../types";
import type { HarnessConfig, ResolvedConfig } from "../config";
import { resolveConfig } from "../config";
import type { SessionStore } from "../session/session-store";
import { MemoryVFS } from "../vfs/memory";
import type { VFS } from "../vfs/types";
import { AgentSession } from "./agent-session";

// Global registry of running agents, keyed by session id. On a server you create ONE
// registry; every session's agent lives here. New tabs / reconnects attach() to the live
// session; isRunning() lets you reject double-input to a busy agent.
export type RegistryOptions = {
  config?: HarnessConfig; // static config shared by every session
  configFor?: (id: string) => HarnessConfig; // per-session config (e.g. per-project prompt/tools) — takes precedence
  store?: SessionStore; // progressive save / load across restarts
  vfsFactory?: (sessionId: string) => VFS; // VFS per session (e.g. FsVFS folder per id); default MemoryVFS
  persistEachStep?: boolean;
};

export class AgentRegistry {
  private sessions = new Map<string, AgentSession>();
  private cfg?: ResolvedConfig;

  constructor(private opts: RegistryOptions) {
    if (opts.config) this.cfg = resolveConfig(opts.config);
    if (!opts.config && !opts.configFor) throw new Error("AgentRegistry needs `config` or `configFor`");
  }

  // Resolve the config for a given session id: per-session `configFor` wins, else the static config.
  private resolved(id: string): ResolvedConfig {
    if (this.opts.configFor) return resolveConfig(this.opts.configFor(id));
    return this.cfg!;
  }

  /**
   * Create a new session (auto-generates an id when omitted). An explicit `config` (e.g. a
   * per-project prompt built from async data) wins over `configFor`/static config.
   */
  create(id?: string, config?: HarnessConfig): AgentSession {
    const sid = id ?? randomUUID();
    const s = new AgentSession({
      id: sid,
      config: config ? resolveConfig(config) : this.resolved(sid),
      store: this.opts.store,
      vfs: this.opts.vfsFactory?.(sid),
      persistEachStep: this.opts.persistEachStep,
    });
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  // Push a freshly-derived config (e.g. built from the project's current title/description) onto
  // an already-cached session. Without this, a session created once (by any entry point) would
  // keep serving whatever systemPrompt/model it started with for its whole in-memory lifetime —
  // stale after a project rename, or plain wrong if the first touch didn't have the real config.
  private refresh(s: AgentSession, config?: HarnessConfig): void {
    if (!config) return;
    const rc = resolveConfig(config);
    s.reconfigure({
      model: rc.model,
      systemPrompt: rc.systemPrompt,
      maxSteps: rc.maxSteps,
      costCapTokens: rc.costCapTokens,
      summarizeAt: rc.compaction.summarizeAt,
      providerOptions: rc.providerOptions,
    });
  }

  getOrCreate(id: string, config?: HarnessConfig): AgentSession {
    const existing = this.sessions.get(id);
    if (existing) {
      this.refresh(existing, config);
      return existing;
    }
    return this.create(id, config);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  isRunning(id: string): boolean {
    return this.sessions.get(id)?.isRunning() ?? false;
  }

  list(): { id: string; status: AgentStatus }[] {
    return [...this.sessions.values()].map((s) => ({ id: s.id, status: s.status }));
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  /**
   * Load a session from the store into memory (resume after a server restart). An explicit
   * `config` (e.g. a per-project prompt built from async data) wins over `configFor`/static —
   * same contract as `create`/`getOrCreate` — and also refreshes an already-cached session.
   */
  async load(id: string, config?: HarnessConfig): Promise<AgentSession | null> {
    const existing = this.sessions.get(id);
    if (existing) {
      this.refresh(existing, config);
      return existing;
    }
    if (!this.opts.store) return null;
    const snap = await this.opts.store.load(id);
    if (!snap) return null;
    // Persistent drivers (fs/json) are their own source of truth — re-point to them.
    // Ephemeral MemoryVFS is restored from the snapshot dump.
    const vfs = this.opts.vfsFactory ? this.opts.vfsFactory(id) : new MemoryVFS(snap.vfs);
    const s = new AgentSession({
      id,
      config: config ? resolveConfig(config) : this.resolved(id),
      store: this.opts.store,
      vfs,
      persistEachStep: this.opts.persistEachStep,
      snapshot: snap,
    });
    this.sessions.set(id, s);
    return s;
  }
}
