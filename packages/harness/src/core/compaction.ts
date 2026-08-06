import { generateText, pruneMessages, type LanguageModel, type ModelMessage, type ToolSet } from "ai";

// §6 — keep the context window from overflowing. Cheap prune first; if still too big,
// summarize the MIDDLE with one LLM call, keeping head + tail verbatim.

export const LIMIT = 180_000;
export const RESERVE = 20_000;

export function estimateTokens(messages: ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

// Cheap char/4 estimates for the two context pieces that don't change per-message: the system
// prompt and the registered tools' JSON-schema overhead. Shared by AgentSession.tokenBreakdown()
// (idle/restore) and the live data-context stream (ui-stream.ts) so both agree on the same numbers.
export function estimateSystemTokens(system: string): number {
  return Math.ceil(system.length / 4);
}

// Per-tool definition cost (plan 13 P3 / D13.8-1). The AGGREGATE below is defined as the exact
// sum of these — that's what makes the stats-v2 fractions add up to the "tools" line by
// construction (§7.4 resolved: no separate aggregate formula to drift from). Rounding moved from
// one global ceil to per-tool ceil; worst-case drift vs the old formula is < #tools tokens.
export function estimateToolTokens(name: string, tool: unknown): number {
  const desc = (tool as { description?: string }).description ?? "";
  return Math.ceil((name.length + desc.length + 40) / 4);
}

export function estimateToolsTokens(tools: ToolSet): number {
  let total = 0;
  for (const [name, tool] of Object.entries(tools)) total += estimateToolTokens(name, tool);
  return total;
}

// ─── Runtime attribution within a history (plan 13 P3 / D13.8-2) ─────────────────────────────
// How much of the CURRENT working history each tool occupies: `calls` = tool-call parts per name,
// `tokens` = estimated size of that tool's result parts still alive on the wire. Honest by
// construction: after a compaction the history is one summary message with no tool parts, so the
// numbers read "since the last checkpoint" (§7.5). These are attributions INSIDE the history
// aggregate, not a partition of it (user/assistant text isn't counted here).
export type ToolRuntimeStat = { name: string; calls: number; tokens: number };

export function toolRuntimeStats(messages: ModelMessage[]): ToolRuntimeStat[] {
  const byName = new Map<string, ToolRuntimeStat>();
  const get = (name: string): ToolRuntimeStat => {
    let s = byName.get(name);
    if (!s) {
      s = { name, calls: 0, tokens: 0 };
      byName.set(name, s);
    }
    return s;
  };
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as { type?: string; toolName?: string }[]) {
      if (m.role === "assistant" && part.type === "tool-call" && part.toolName) get(part.toolName).calls++;
      else if (m.role === "tool" && part.type === "tool-result" && part.toolName)
        get(part.toolName).tokens += Math.ceil(JSON.stringify(part).length / 4);
    }
  }
  return [...byName.values()];
}

// History size attributed per role (D13.8-3 "breakdown history per role"). Per-message char/4 —
// informational rows for a stats UI; the canonical history TOTAL stays estimateTokens() (whole-
// array stringify), so these rows can differ from it by a few tokens of JSON separators.
export function historyRoleStats(messages: ModelMessage[]): { role: string; tokens: number }[] {
  const byRole = new Map<string, number>();
  for (const m of messages) byRole.set(m.role, (byRole.get(m.role) ?? 0) + Math.ceil(JSON.stringify(m).length / 4));
  return [...byRole.entries()].map(([role, tokens]) => ({ role, tokens }));
}

export function prune(messages: ModelMessage[]): ModelMessage[] {
  return sanitizeMessages(pruneMessages({ messages, reasoning: "all", toolCalls: "before-last-3-messages", emptyMessages: "remove" }));
}

// SMART-COMPACT guarantee: tool calls and tool results must stay paired. Any compaction (prune,
// summarize, boundary slicing) can leave an orphan — an assistant tool-call whose result got
// dropped, or a tool-result whose call got dropped. Providers (DeepSeek, OpenAI) reject those.
// This drops the orphans on BOTH sides, and any message left empty, so the wire is always valid.
export function sanitizeMessages(messages: ModelMessage[]): ModelMessage[] {
  type Part = { type?: string; toolCallId?: string };
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const p of m.content as Part[]) if (p.type === "tool-call" && p.toolCallId) callIds.add(p.toolCallId);
    } else if (m.role === "tool" && Array.isArray(m.content)) {
      for (const p of m.content as Part[]) if (p.type === "tool-result" && p.toolCallId) resultIds.add(p.toolCallId);
    }
  }
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const parts = (m.content as Part[]).filter((p) => p.type !== "tool-call" || (p.toolCallId != null && resultIds.has(p.toolCallId)));
      if (parts.length > 0) out.push({ ...m, content: parts } as ModelMessage);
    } else if (m.role === "tool" && Array.isArray(m.content)) {
      const parts = (m.content as Part[]).filter((p) => p.type !== "tool-result" || (p.toolCallId != null && callIds.has(p.toolCallId)));
      if (parts.length > 0) out.push({ ...m, content: parts } as ModelMessage);
    } else {
      out.push(m);
    }
  }
  return out;
}

function isToolMessage(m: ModelMessage): boolean {
  return m.role === "tool";
}

// GOTCHA §6: the tail must not start with an orphan tool-result.
export function cleanTailBoundary(messages: ModelMessage[], tailStart: number): number {
  let i = Math.max(0, Math.min(tailStart, messages.length));
  while (i < messages.length) {
    const m = messages[i];
    if (m && isToolMessage(m)) i++;
    else break;
  }
  return i;
}

// GOTCHA §6: the MIDDLE we summarize must not START with an orphan tool-result either — its
// parent assistant(tool_calls) was kept in the head. Pull such leading tool messages into the
// head so generateText({messages: middle}) gets a valid conversation (providers like DeepSeek
// reject a request whose first message has role "tool").
export function cleanHeadBoundary(messages: ModelMessage[], head: number, tailStart: number): number {
  let i = Math.max(0, Math.min(head, tailStart, messages.length));
  while (i < tailStart) {
    const m = messages[i];
    if (m && isToolMessage(m)) i++;
    else break;
  }
  return i;
}

// Pull the summary text back out of a compacted history (the injected <conversation-summary>).
export function extractSummary(messages: ModelMessage[]): string | undefined {
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string" && m.content.includes("<conversation-summary>")) {
      return m.content.replace(/<\/?conversation-summary>/g, "").trim();
    }
  }
  return undefined;
}

// Default summarizer prompt — tuned for a coding agent: preserve everything needed to keep going.
export const SUMMARY_PROMPT = [
  "You are compacting an agent coding session to free up context while preserving everything",
  "needed to continue seamlessly. Produce a tight, structured summary — no chit-chat:",
  "- REQUEST: the user's original request and overall goal (why this session started).",
  "- FILES: every file created/edited, its purpose, and current state. Note the ENTRYPOINT / most",
  "  important files explicitly (keep EXACT names).",
  "- DONE: what has been accomplished so far.",
  "- DECISIONS: key technical choices and the reasoning behind each.",
  "- NEXT: the immediate next steps / what's still pending.",
  "- CONSTRAINTS: rules, preferences, and values the agent must not lose.",
  "Keep exact identifiers (file names, function names, parameters). Drop file bodies and chit-chat.",
].join("\n");

// Render messages to a plain-text transcript for the summarizer. Crucially we DON'T hand raw
// tool-call messages to generateText — with no tools registered, providers like DeepSeek try to
// "continue" the tool sequence and leak their tool-call markup as the summary. A flat transcript
// (tool calls/results described as text, contents truncated) avoids that and keeps input small.
function renderTranscript(messages: ModelMessage[]): string {
  const clip = (s: string, n = 200) => (s.length > n ? s.slice(0, n) + "…" : s);
  const lines: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      if (m.content.trim()) lines.push(`${m.role}: ${clip(m.content, 600)}`);
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as { type?: string; text?: string; toolName?: string; input?: unknown; output?: unknown }[]) {
      if (part.type === "text" && part.text) lines.push(`${m.role}: ${clip(part.text, 600)}`);
      else if (part.type === "reasoning" && part.text) lines.push(`${m.role} (thinking): ${clip(part.text)}`);
      else if (part.type === "tool-call") lines.push(`${m.role}: [called ${part.toolName} ${clip(JSON.stringify(part.input ?? {}))}]`);
      else if (part.type === "tool-result")
        lines.push(`tool: [${part.toolName} → ${clip(typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? ""))}]`);
    }
  }
  return lines.join("\n");
}

// Compact a history into a SINGLE summary message. No head/tail kept verbatim — the whole session
// becomes one summary (its size follows the content, like Claude Code). File CONTENTS are dropped
// (the VFS holds them); only paths/references the summary deems important survive. The agent
// re-reads files from the workspace when it needs them.
export async function compact(
  model: LanguageModel,
  messages: ModelMessage[],
  opts?: { system?: string },
): Promise<ModelMessage[]> {
  const transcript = renderTranscript(sanitizeMessages(messages));
  if (!transcript.trim()) return messages;

  const { text } = await generateText({
    model,
    messages: [{ role: "user", content: `Summarize the following agent coding session transcript.\n\n${transcript}` }],
    system: opts?.system ?? SUMMARY_PROMPT,
  });

  return [
    {
      role: "user",
      content: `<conversation-summary>\n${text}\n</conversation-summary>\n\nThe context above was compacted. Continue the task from where it left off, re-reading files as needed.`,
    },
  ];
}

// §6 prepareStep: prune the context when it nears the limit. (We deliberately do NOT force
// a tool-less wrap-up on the last step — stripping tools makes some providers, e.g. DeepSeek,
// leak their raw tool-call markup as text. The step ceiling is enforced by stopWhen instead.)
export function makePrepareStep(
  _maxStep: number,
  opts?: { limit?: number; reserve?: number; onPrune?: (info: { stepNumber: number; before: number; after: number }) => void },
) {
  const limit = opts?.limit ?? LIMIT;
  const reserve = opts?.reserve ?? RESERVE;
  return ({ messages, stepNumber }: { messages: ModelMessage[]; stepNumber: number }) => {
    if (estimateTokens(messages) > limit - reserve) {
      const before = estimateTokens(messages);
      const pruned = prune(messages);
      opts?.onPrune?.({ stepNumber, before, after: estimateTokens(pruned) });
      return { messages: pruned };
    }
    return {};
  };
}
