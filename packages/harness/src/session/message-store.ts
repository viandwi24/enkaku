// ENKAKU NOTE (plan 75 §3.5): unreferenced in this codebase. Only `core/resilient.ts` — itself
// unreferenced, see that file's own note — imports this module; nothing reachable from
// packages/harness/src/index.ts uses it. Copied verbatim anyway, deliberately not deleted, so a
// diff against upstream (bitorex-algo@9eab029) shows the same file list. Candidate for deletion
// once plans 76-78 confirm it stays unused across the whole harness series — see
// docs/plans/75-m40-harness-adoption.md §9 open question 2.
import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";

// §8 — message-level storage form vs wire form. Stores rich rows; projects lean wire form.
// Used by the §7 resilient loop for crash-safe resume.

export type MsgStatus = "pending" | "completed" | "failed";

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  status: MsgStatus;
  step: number;
  createdAt: string;
}

export interface MessageStore {
  append(convId: string, messages: ModelMessage[], meta?: { step?: number; status?: MsgStatus }): Promise<StoredMessage[]>;
  load(convId: string): Promise<ModelMessage[]>;
  loadStored(convId: string): Promise<StoredMessage[]>;
  tx<T>(fn: () => Promise<T>): Promise<T>;
}

export class MemoryMessageStore implements MessageStore {
  private rows = new Map<string, StoredMessage[]>();
  private seqs = new Map<string, number>();

  async append(convId: string, messages: ModelMessage[], meta?: { step?: number; status?: MsgStatus }): Promise<StoredMessage[]> {
    const list = this.rows.get(convId) ?? [];
    const created: StoredMessage[] = [];
    for (const m of messages) {
      const seq = (this.seqs.get(convId) ?? 0) + 1;
      this.seqs.set(convId, seq);
      const row: StoredMessage = {
        id: randomUUID(),
        conversationId: convId,
        seq,
        role: m.role,
        content: m.content,
        status: meta?.status ?? "completed",
        step: meta?.step ?? 0,
        createdAt: new Date().toISOString(),
      };
      list.push(row);
      created.push(row);
    }
    this.rows.set(convId, list);
    return created;
  }

  async load(convId: string): Promise<ModelMessage[]> {
    return (this.rows.get(convId) ?? []).map((r) => ({ role: r.role, content: r.content }) as ModelMessage);
  }

  async loadStored(convId: string): Promise<StoredMessage[]> {
    return [...(this.rows.get(convId) ?? [])];
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

// ── Pure helpers for resilient resume (§7) ──
type AnyPart = { type?: string; toolCallId?: string; toolName?: string; input?: unknown };
function parts(m: ModelMessage): AnyPart[] {
  return Array.isArray(m.content) ? (m.content as AnyPart[]) : [];
}

export function answeredToolCallIds(messages: ModelMessage[]): Set<string> {
  const s = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const p of parts(m)) if (p.type === "tool-result" && p.toolCallId) s.add(p.toolCallId);
  }
  return s;
}

export function orphanToolCalls(messages: ModelMessage[]): { toolCallId: string; toolName: string; input: unknown }[] {
  const answered = answeredToolCallIds(messages);
  const out: { toolCallId: string; toolName: string; input: unknown }[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of parts(m)) {
      if (p.type === "tool-call" && p.toolCallId && !answered.has(p.toolCallId)) {
        out.push({ toolCallId: p.toolCallId, toolName: p.toolName ?? "", input: p.input });
      }
    }
  }
  return out;
}
