// Adaptive step budget / loop-guard auditor (plan 10 §3b / PA2). Exercises the three pure pieces
// that make up the checkpoint policy WITHOUT running a model:
//   • summarizeStep — reduces a step's messages to {tools, mutated}
//   • detectLoop    — deterministic pre-check (identical tool+args repeated)
//   • evaluateCheckpoint — the budget state-machine (continue → extend, backstop → budget-exhausted)
import { test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import type { CheckpointCtx, CheckpointDecision, StepSummary } from "../types";
import { detectLoop, evaluateCheckpoint, summarizeStep } from "./agent-core";

// A synthetic assistant step that calls one tool with the given args.
const step = (name: string, input: unknown): ModelMessage[] => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "x", toolName: name, input } as never] },
];

test("summarizeStep extracts tool names + arg hashes and flags mutation", () => {
  const write = summarizeStep(step("write_file", { path: "a.q8", content: "x" }));
  expect(write.tools).toHaveLength(1);
  expect(write.tools[0]!.name).toBe("write_file");
  expect(write.mutated).toBe(true);

  const read = summarizeStep(step("read_file", { path: "a.q8" }));
  expect(read.mutated).toBe(false);

  // Identical args → identical hash; different args → different hash.
  const h1 = summarizeStep(step("read_file", { path: "a.q8" })).tools[0]!.argsHash;
  const h2 = summarizeStep(step("read_file", { path: "a.q8" })).tools[0]!.argsHash;
  const h3 = summarizeStep(step("read_file", { path: "b.q8" })).tools[0]!.argsHash;
  expect(h1).toBe(h2);
  expect(h1).not.toBe(h3);
});

test("detectLoop stops on the same tool+args repeated past the threshold", () => {
  const same = summarizeStep(step("read_file", { path: "a.q8" }));
  const loop = detectLoop([same, same, same]);
  expect(loop).not.toBeNull();
  expect(loop!.action).toBe("stop");
  expect(loop!.stopReason).toBe("loop-detected");
});

test("detectLoop returns null for varied, productive work (→ let the LLM auditor judge)", () => {
  const varied: StepSummary[] = [
    summarizeStep(step("read_file", { path: "a.q8" })),
    summarizeStep(step("write_file", { path: "a.q8", content: "1" })),
    summarizeStep(step("read_file", { path: "b.q8" })),
  ];
  expect(detectLoop(varied)).toBeNull();
});

test("evaluateCheckpoint: auditor says continue N times, then the hard backstop fires", async () => {
  const stepCheckpoint = 2;
  const maxExtensions = 2;
  const alwaysContinue: (ctx: CheckpointCtx) => Promise<CheckpointDecision> = async () => ({
    action: "continue",
    reason: "productive",
  });

  // Simulate the runAgentLoop stepping: a checkpoint fires each time iterations reaches the ceiling.
  let state = { ceiling: stepCheckpoint, extensionsUsed: 0 };
  let iterations = 0;
  let stop = "";
  let checkpointCalls = 0;
  const countingContinue: (ctx: CheckpointCtx) => Promise<CheckpointDecision> = async (ctx) => {
    checkpointCalls++;
    return alwaysContinue(ctx);
  };
  for (let guard = 0; guard < 100; guard++) {
    iterations++;
    if (iterations >= state.ceiling) {
      const res = await evaluateCheckpoint({
        iterations,
        state,
        stepCheckpoint,
        maxExtensions,
        recentSteps: [],
        onCheckpoint: countingContinue,
      });
      if (res.done) {
        stop = res.stop;
        break;
      }
      state = res.state;
    }
  }
  // ceiling 2 → extend to 4 → extend to 6 → at step 6 extensions exhausted → budget-exhausted.
  expect(stop).toBe("budget-exhausted");
  expect(iterations).toBe(stepCheckpoint * (maxExtensions + 1)); // 6
  expect(checkpointCalls).toBe(maxExtensions); // auditor consulted only while extensions remained
});

test("evaluateCheckpoint maps auditor verdicts to the right stop reasons", async () => {
  const base = { iterations: 50, state: { ceiling: 50, extensionsUsed: 0 }, stepCheckpoint: 50, maxExtensions: 4, recentSteps: [] };

  const loop = await evaluateCheckpoint({ ...base, onCheckpoint: async () => ({ action: "stop", stopReason: "loop-detected", reason: "loop" }) });
  expect(loop).toEqual({ done: true, stop: "loop-detected" });

  const halt = await evaluateCheckpoint({ ...base, onCheckpoint: async () => ({ action: "stop", reason: "no progress" }) });
  expect(halt).toEqual({ done: true, stop: "halted-by-auditor" });

  const ask = await evaluateCheckpoint({ ...base, onCheckpoint: async () => ({ action: "ask", reason: "unsure" }) });
  expect(ask).toEqual({ done: true, stop: "paused-checkpoint" });

  const cont = await evaluateCheckpoint({ ...base, onCheckpoint: async () => ({ action: "continue", reason: "ok" }) });
  expect(cont).toEqual({ done: false, state: { ceiling: 100, extensionsUsed: 1 } });
});
