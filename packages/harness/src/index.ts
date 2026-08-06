// @bitorex/harness — reusable agent-coding harness. Provider-agnostic.
//
// Quick start:
//   import { AgentRegistry, MemoryVFS, createFileTools } from "@bitorex/harness";
//   const registry = new AgentRegistry({
//     config: {
//       model: deepseek("deepseek-chat"),
//       systemPrompt: MY_PROMPT,
//       toolsFactory: (vfs, session) => createFileTools(vfs, session, { allowedExtensions: ["pine","md"] }),
//     },
//     vfsFactory: () => new MemoryVFS(),
//   });
//   const agent = registry.create();        // or getOrCreate(id) / load(id)
//   await agent.send("build an EMA indicator");
//   for await (const ev of agent.attach()) { /* stream to a browser tab */ }

export * from "./types";
export * from "./config";
export * from "./skills";
export * from "./vfs";
export * from "./tools";
export * from "./core";
export * from "./session";
export * from "./runtime";
