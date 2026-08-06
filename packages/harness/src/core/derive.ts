import type { FileChange, Part, StopReason, Turn } from "../types";
import { looksLikeError } from "../tools/file-tools";

// Derive the UI/audit projections from the single message log. The message rows are the source of
// truth; per-turn extras (stop, duration, tokens) ride along in each row's `meta` JSONB. This is
// the reverse of what the agent loop builds, so one `messages` table reconstructs everything.

type StoredMsg = {
  role: string;
  content: unknown;
  meta?: { stop?: StopReason; duration_ms?: number; model?: string; tok_in?: number; tok_out?: number };
};
type CPart = { type?: string; text?: string; toolName?: string; toolCallId?: string; input?: unknown; output?: unknown };

const partText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? (c as CPart[]).filter((p) => p.type === "text").map((p) => p.text ?? "").join("") : "";
const resultText = (out: unknown): string =>
  typeof out === "string" ? out : ((out as { value?: string })?.value ?? JSON.stringify(out ?? ""));

// Reconstruct the rendered conversation (Turn[]) from the message rows.
export function messagesToTurns(msgs: StoredMsg[]): Turn[] {
  const turns: Turn[] = [];
  let steps: Part[][] | null = null;
  let meta: StoredMsg["meta"];
  const flush = () => {
    if (steps) turns.push({ role: "assistant", steps, stop: meta?.stop, durationMs: meta?.duration_ms });
    steps = null;
  };
  for (const m of msgs) {
    if (m.role === "user") {
      flush();
      turns.push({ role: "user", text: partText(m.content) });
      meta = m.meta; // the upcoming assistant turn's outcome rides on the user row
    } else if (m.role === "assistant") {
      steps ??= [];
      const step: Part[] = [];
      const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : ((m.content as CPart[]) ?? []);
      for (const p of parts) {
        if (p.type === "text" && p.text) step.push({ kind: "text", text: p.text });
        else if (p.type === "reasoning" && p.text) step.push({ kind: "thinking", text: p.text });
        else if (p.type === "tool-call") step.push({ kind: "tool", id: p.toolCallId ?? "", name: p.toolName ?? "", done: false, ok: true, args: p.input });
      }
      steps.push(step);
    } else if (m.role === "tool") {
      const parts = Array.isArray(m.content) ? (m.content as CPart[]) : [];
      for (const p of parts) {
        if (p.type !== "tool-result") continue;
        const out = resultText(p.output);
        if (steps)
          for (const st of steps)
            for (const it of st)
              if (it.kind === "tool" && it.id === p.toolCallId) {
                it.done = true;
                it.ok = !looksLikeError(out);
                it.result = out;
              }
      }
    }
  }
  flush();
  return turns;
}

// Derive the file-change index from write/edit/delete tool calls in the message rows.
export function messagesToFileChanges(msgs: StoredMsg[]): FileChange[] {
  const out: FileChange[] = [];
  let turn = 0;
  for (const m of msgs) {
    if (m.role === "user") turn++;
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content as CPart[]) {
      if (p.type !== "tool-call") continue;
      const path = (p.input as { path?: string })?.path;
      if (!path) continue;
      const action = p.toolName === "write_file" ? "write" : p.toolName === "edit_file" ? "edit" : p.toolName === "delete_file" ? "delete" : null;
      if (action) out.push({ path, action, turn, at: "" });
    }
  }
  return out;
}
