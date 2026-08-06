// ENKAKU NOTE (plan 75 §3.5): unreferenced in this codebase. Nothing under packages/core or
// packages/harness/src/index.ts imports this file — Enkaku's own agent loop (packages/core/src/agent/loop/)
// is what runs today, and this is a second, never-called loop that the source project itself does not
// wire into anything exported from its own index either. Copied verbatim anyway, deliberately not deleted,
// so a diff against upstream (bitorex-algo@9eab029) shows the same file list. Candidate for deletion once
// plans 76-78 confirm it stays unused across the whole harness series — see docs/plans/75-m40-harness-adoption.md
// §9 open question 2.
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { executeTool, toolSchemas, type FileToolsOptions, type Session } from "../tools/file-tools";
import { orphanToolCalls, type MessageStore } from "../session/message-store";
import type { VFS } from "../vfs/types";

// §7 — resilient manual loop: tools are SCHEMA-ONLY, so the SDK returns calls without
// running them. We persist the decision BEFORE the side-effect, then run side-effect +
// result in ONE store transaction (all-or-nothing) so an interrupted turn can resume.

export type LoopCtx = {
  model: LanguageModel;
  system: string;
  store: MessageStore;
  vfs: VFS;
  session: Session;
  convId: string;
  toolOptions?: FileToolsOptions;
};

function toolResult(toolCallId: string, toolName: string, value: string): ModelMessage {
  return { role: "tool", content: [{ type: "tool-result", toolCallId, toolName, output: { type: "text", value } }] };
}

async function runToolAtomic(ctx: LoopCtx, call: { toolCallId: string; toolName: string; input: unknown }): Promise<ModelMessage> {
  return ctx.store.tx(async () => {
    const out = await executeTool(ctx.vfs, ctx.session, call.toolName, call.input, ctx.toolOptions);
    const msg = toolResult(call.toolCallId, call.toolName, out);
    await ctx.store.append(ctx.convId, [msg]);
    return msg;
  });
}

async function drive(ctx: LoopCtx, messages: ModelMessage[]): Promise<string> {
  const tools = toolSchemas();
  while (true) {
    const result = await generateText({ model: ctx.model, system: ctx.system, messages, tools });
    await ctx.store.append(ctx.convId, result.response.messages);
    messages.push(...result.response.messages);
    if (result.toolCalls.length === 0) return result.text;
    for (const call of result.toolCalls) {
      const msg = await runToolAtomic(ctx, { toolCallId: call.toolCallId, toolName: call.toolName, input: call.input });
      messages.push(msg);
    }
  }
}

export async function runResilientTurn(ctx: LoopCtx, userInput: string): Promise<string> {
  await ctx.store.append(ctx.convId, [{ role: "user", content: userInput }]);
  const messages = await ctx.store.load(ctx.convId);
  return drive(ctx, messages);
}

// §7 resume: re-run interrupted (orphan) tool calls — safe because their side-effects
// never happened — then continue the loop.
export async function resumeOrphans(ctx: LoopCtx): Promise<{ reran: number }> {
  const messages = await ctx.store.load(ctx.convId);
  const orphans = orphanToolCalls(messages);
  for (const call of orphans) await runToolAtomic(ctx, call);
  return { reran: orphans.length };
}

export async function resumeTurn(ctx: LoopCtx): Promise<string> {
  await resumeOrphans(ctx);
  return drive(ctx, await ctx.store.load(ctx.convId));
}
