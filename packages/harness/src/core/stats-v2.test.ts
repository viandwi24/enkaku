// Plan 13 P3 — stats v2. DoD: the per-tool fractions must sum EXACTLY to the old aggregates
// (system/tools/history keep their meaning): toolDefs Σ === estimateToolsTokens, and the v2
// fields ride the data-context part / tokenBreakdown() additively (v1 fields untouched).
import { expect, test } from "bun:test";
import { tool, type ModelMessage } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { estimateTokens, estimateToolTokens, estimateToolsTokens, historyRoleStats, toolRuntimeStats } from "./compaction";
import { AgentSession } from "../runtime/agent-session";
import { agentStream } from "../runtime/ui-stream";

const sampleTools = {
  read_file: tool({ description: "Read a file from the workspace by path.", inputSchema: z.object({ path: z.string() }), execute: () => "ok" }),
  write_file: tool({ description: "Write content to a file.", inputSchema: z.object({ path: z.string(), content: z.string() }), execute: () => "ok" }),
  run_backtest: tool({ description: "", inputSchema: z.object({}), execute: () => "ok" }), // empty description edge
};

test("DoD: per-tool definition tokens sum EXACTLY to the tools aggregate", () => {
  const perTool = Object.entries(sampleTools).map(([name, t]) => estimateToolTokens(name, t));
  expect(perTool.reduce((a, b) => a + b, 0)).toBe(estimateToolsTokens(sampleTools));
  for (const t of perTool) expect(t).toBeGreaterThan(0);
});

// A synthetic wire: 2 calls to read_file (one result big), 1 call to write_file, plain text turns.
const wire: ModelMessage[] = [
  { role: "user", content: "go" },
  {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.q8" } },
      { type: "tool-call", toolCallId: "c2", toolName: "write_file", input: { path: "b.q8", content: "x" } },
    ],
  },
  {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "c1", toolName: "read_file", output: { type: "text", value: "x".repeat(400) } },
      { type: "tool-result", toolCallId: "c2", toolName: "write_file", output: { type: "text", value: "ok" } },
    ],
  },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "c3", toolName: "read_file", input: { path: "b.q8" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "c3", toolName: "read_file", output: { type: "text", value: "small" } }] },
  { role: "assistant", content: "done" },
];

test("toolRuntimeStats: calls counted per tool-call, tokens per live tool-result", () => {
  const stats = toolRuntimeStats(wire);
  const read = stats.find((s) => s.name === "read_file")!;
  const write = stats.find((s) => s.name === "write_file")!;
  expect(read.calls).toBe(2);
  expect(write.calls).toBe(1);
  expect(read.tokens).toBeGreaterThan(100); // the 400-char result dominates
  expect(write.tokens).toBeGreaterThan(0);
  expect(read.tokens).toBeGreaterThan(write.tokens);
  // Attribution stays INSIDE the history aggregate (never exceeds it).
  const sum = stats.reduce((a, s) => a + s.tokens, 0);
  expect(sum).toBeLessThanOrEqual(estimateTokens(wire));
});

test("toolRuntimeStats: post-compaction history (summary only) yields no tool rows — 'since last checkpoint'", () => {
  const compacted: ModelMessage[] = [{ role: "user", content: "<conversation-summary>…</conversation-summary>" }];
  expect(toolRuntimeStats(compacted)).toEqual([]);
});

test("historyRoleStats: one row per role, ≈ history total", () => {
  const roles = historyRoleStats(wire);
  const names = roles.map((r) => r.role).sort();
  expect(names).toEqual(["assistant", "tool", "user"]);
  const sum = roles.reduce((a, r) => a + r.tokens, 0);
  const total = estimateTokens(wire);
  expect(Math.abs(sum - total)).toBeLessThanOrEqual(wire.length + 1); // JSON separators only
});

// ─── Live stream: the data-context part carries the v2 breakdown ──────────────────────────────
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const twoStepModel = () =>
  new MockLanguageModelV3({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "call-1", toolName: "ping", input: "{}" },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "done" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
        }),
      },
    ],
  });

const pingTool = tool({ description: "test ping tool", inputSchema: z.object({}), execute: () => "pong" });

type CtxData = {
  wire: number;
  tools?: number;
  toolDefs?: { name: string; tokens: number }[];
  toolRuntime?: { name: string; calls: number; tokens: number }[];
  historyRoles?: { role: string; tokens: number }[];
};

test("agentStream: data-context v2 — toolDefs sum to `tools`, toolRuntime tracks the ping call", async () => {
  const tools = { ping: pingTool };
  const stream = agentStream({
    model: twoStepModel(),
    system: "sys",
    tools,
    messages: [{ role: "user", content: "go" }],
  });

  // data-context is TRANSIENT (never persisted into the message), so read the raw chunk stream.
  const ctxParts: CtxData[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<{ type: string; data?: unknown }>) {
    if (chunk.type === "data-context") ctxParts.push(chunk.data as CtxData);
  }
  expect(ctxParts.length).toBeGreaterThanOrEqual(2); // ≥1 tick per step

  for (const c of ctxParts) {
    // v1 fields intact + DoD: fractions sum to the aggregate.
    expect(c.tools).toBe(estimateToolsTokens(tools));
    expect(c.toolDefs!.reduce((a, d) => a + d.tokens, 0)).toBe(c.tools!);
  }
  // After step 1 settles, the wire contains ping's call+result → runtime stats show it.
  const last = ctxParts[ctxParts.length - 1]!;
  const ping = (last.toolRuntime ?? []).find((s) => s.name === "ping");
  expect(ping).toBeDefined();
  expect(ping!.calls).toBe(1);
  expect(ping!.tokens).toBeGreaterThan(0);
  expect((last.historyRoles ?? []).some((r) => r.role === "tool")).toBe(true);
});

test("AgentSession.tokenBreakdown v2: additive fields, toolDefs Σ === tools, runtime from workingHistory", async () => {
  const session = new AgentSession({
    config: { model: twoStepModel(), systemPrompt: "sys", tools: { ping: pingTool } },
  });
  await session.send("go");
  const bd = session.tokenBreakdown();
  // v1 invariants unchanged.
  expect(bd.total).toBe(bd.system + bd.tools + bd.history);
  expect(bd.history).toBe(estimateTokens(session.workingHistory));
  // v2: fractions sum to the aggregate; the ping call is attributed.
  expect(bd.toolDefs.reduce((a, d) => a + d.tokens, 0)).toBe(bd.tools);
  const ping = bd.toolRuntime.find((s) => s.name === "ping");
  expect(ping?.calls).toBe(1);
});
