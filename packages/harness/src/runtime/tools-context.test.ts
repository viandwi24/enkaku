// Plan 13 P0 — toolsContext plumbing. Verifies the SDK-native per-tool runtime context end-to-end
// WITHOUT a real model:
//   • agentStream: a dummy tool calls ctx.emit(...) from inside execute → the custom data part
//     arrives in the UIMessageStream (resolves §7.1: no contextSchema needed; §7.2: writing to the
//     turn writer from inside a tool while the step stream is merged does not corrupt the stream).
//   • runAgentTurn (headless, no writer): the same tool runs with a NO-OP emit — no crash.
//   • AgentSession.send() (in-process consumption): full turn completes with a ctx.emit tool.
import { expect, test } from "bun:test";
import { readUIMessageStream, tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { runAgentTurn } from "../core/agent-core";
import type { EmitFn } from "../types";
import { AgentSession } from "./agent-session";
import { agentStream } from "./ui-stream";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

// A two-step mock: step 1 calls the `ping` tool, step 2 answers with text and finishes.
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

// The dummy tool reads its runtime ctx from options.context (NO contextSchema declared — §7.1)
// and pushes a custom data part through it.
type PingCtx = { emit: EmitFn };
const pingTool = (onCtx?: (ctx: unknown) => void) =>
  tool({
    description: "test tool that emits a custom data part",
    inputSchema: z.object({}),
    execute: (_input, options) => {
      onCtx?.(options.context);
      const ctx = options.context as PingCtx | undefined;
      ctx?.emit("data-ping", { hello: "world" }, { id: "ping-1" });
      return "pong";
    },
  });

test("agentStream: tool ctx.emit → custom data part lands in the UIMessageStream", async () => {
  const seen: unknown[] = [];
  const stream = agentStream({
    model: twoStepModel(),
    system: "sys",
    tools: { ping: pingTool((c) => seen.push(c)) },
    messages: [{ role: "user", content: "go" }],
    buildToolsContext: (rt) => ({ ping: { emit: rt.emit } }),
  });

  let parts: { type: string; data?: unknown }[] = [];
  for await (const msg of readUIMessageStream({ stream })) {
    parts = msg.parts as never;
  }

  // The tool received the per-turn context (no contextSchema on the tool — §7.1 resolved).
  expect(seen).toHaveLength(1);
  expect((seen[0] as PingCtx).emit).toBeInstanceOf(Function);

  // The custom part arrived, alongside the tool part + final text (stream not corrupted — §7.2).
  const ping = parts.find((p) => p.type === "data-ping");
  expect(ping).toBeDefined();
  expect(ping!.data).toEqual({ hello: "world" });
  expect(parts.some((p) => p.type === "tool-ping")).toBe(true);
  expect(parts.some((p) => p.type === "text")).toBe(true);
});

test("runAgentTurn (headless, no writer): ctx.emit is a no-op — turn completes without crash", async () => {
  const r = await runAgentTurn({
    model: twoStepModel(),
    system: "sys",
    tools: { ping: pingTool() },
    history: [],
    text: "go",
    buildToolsContext: (rt) => ({ ping: { emit: rt.emit } }),
  });
  expect(r.stop).toBe("complete");
  const toolParts = r.steps.flat().filter((p) => p.kind === "tool");
  expect(toolParts).toHaveLength(1);
  expect(toolParts[0]!.result).toBe("pong");
});

test("AgentSession.send() with buildToolsContext: turn completes, emit does not crash", async () => {
  const session = new AgentSession({
    config: {
      model: twoStepModel(),
      systemPrompt: "sys",
      tools: { ping: pingTool() },
      buildToolsContext: (rt) => ({ ping: { emit: rt.emit } }),
    },
  });
  const turn = await session.send("go");
  expect(turn.role).toBe("assistant");
  if (turn.role === "assistant") expect(turn.stop).toBe("complete");
  expect(session.status).toBe("idle");
});

test("agentStream without buildToolsContext: tools see undefined context (backward compatible)", async () => {
  const seen: unknown[] = [];
  const stream = agentStream({
    model: twoStepModel(),
    system: "sys",
    tools: { ping: pingTool((c) => seen.push(c)) },
    messages: [{ role: "user", content: "go" }],
  });
  for await (const _ of readUIMessageStream({ stream })) {
    // drain
  }
  expect(seen).toHaveLength(1);
  expect(seen[0]).toBeUndefined();
});
