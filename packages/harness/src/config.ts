import type { LanguageModel, ToolSet } from "ai";
import type { Session } from "./tools/file-tools";
import type { VFS } from "./vfs/types";
import type { BuildToolsContext, OnCheckpoint } from "./types";

// Everything dynamic is injected here. Apps build a harness by supplying their own
// model, system prompt, and tools (e.g. file tools bound to a VFS driver).

export type CompactionConfig = {
  limit?: number; // §6 in-turn prune threshold (keeps a single long turn from overflowing)
  reserve?: number;
  summarizeAt?: number; // §6 session-level: above this, replace the working history with one summary
  summaryPrompt?: string; // system prompt for the summarizer (app-customizable; defaults to SUMMARY_PROMPT)
};

// Per-session tools bound to that session's VFS (e.g. createFileTools). Stateful tools
// belong here so each session gets its own VFS + read-version map.
export type ToolsFactory = (vfs: VFS, session: Session) => ToolSet;

export type HarnessConfig = {
  model: LanguageModel; // provider-agnostic — app chooses (@ai-sdk/deepseek, etc.)
  modelId?: string; // app's CANONICAL model id recorded per-turn in turnMeta (for audit / per-model
  // settings resolution). Falls back to the AI-SDK model's bare modelId when unset.
  systemPrompt: string; // app's expertise lives here
  tools?: ToolSet; // static, stateless tools shared across sessions
  toolsFactory?: ToolsFactory; // per-session tools bound to the session VFS (file tools)
  buildToolsContext?: BuildToolsContext; // per-turn tool runtime ctx (streamText toolsContext), keyed by tool name
  contextWindow?: number; // the model's max context tokens — drives auto-compaction defaults
  maxSteps?: number; // step ceiling (default 50) — used ONLY when no onCheckpoint hook is set (legacy hard stop)
  costCapTokens?: number; // stop if cumulative output tokens exceed this (default 100k) — final backstop
  compaction?: CompactionConfig; // §6 — overrides the window-derived defaults
  providerOptions?: Record<string, Record<string, unknown>>; // passed to streamText (e.g. deepseek reasoningEffort)
  // §3b adaptive step budget. When `onCheckpoint` is set the hard `maxSteps` stop is REPLACED by an
  // audited checkpoint every `stepCheckpoint` steps: the auditor may extend the budget (up to
  // `maxStepExtensions` times → stepCheckpoint×(maxStepExtensions+1) steps) or stop with a reason.
  stepCheckpoint?: number; // audit cadence in steps (default 50)
  maxStepExtensions?: number; // hard backstop: max extensions the auditor may grant (default 4)
  onCheckpoint?: OnCheckpoint; // policy hook (loop-guard); unset → legacy max-steps behavior
};

export type ResolvedConfig = {
  model: LanguageModel;
  modelId?: string;
  systemPrompt: string;
  tools: ToolSet;
  toolsFactory?: ToolsFactory;
  buildToolsContext?: BuildToolsContext;
  contextWindow?: number;
  maxSteps: number;
  costCapTokens: number;
  compaction: CompactionConfig;
  providerOptions?: Record<string, Record<string, unknown>>;
  stepCheckpoint?: number;
  maxStepExtensions?: number;
  onCheckpoint?: OnCheckpoint;
};

export const DEFAULTS = { maxSteps: 50, costCapTokens: 100_000 } as const;

// Derive auto-compaction from the model's context window so it's ON by default and won't
// blow past the model's max tokens. Explicit compaction fields override these.
//   summarizeAt = 75% of window  (session-level summary checkpoint)
//   limit       = 90% of window  (in-turn prune safety)
export function resolveConfig(c: HarnessConfig): ResolvedConfig {
  const w = c.contextWindow;
  const cc = c.compaction ?? {};
  const compaction: CompactionConfig = {
    limit: cc.limit ?? (w ? Math.floor(w * 0.9) : 180_000),
    reserve: cc.reserve ?? (w ? Math.floor(w * 0.05) : 20_000),
    summarizeAt: cc.summarizeAt ?? (w ? Math.floor(w * 0.75) : undefined),
    summaryPrompt: cc.summaryPrompt,
  };
  return {
    model: c.model,
    modelId: c.modelId,
    systemPrompt: c.systemPrompt,
    tools: c.tools ?? {},
    toolsFactory: c.toolsFactory,
    buildToolsContext: c.buildToolsContext,
    contextWindow: w,
    maxSteps: c.maxSteps ?? DEFAULTS.maxSteps,
    costCapTokens: c.costCapTokens ?? DEFAULTS.costCapTokens,
    compaction,
    providerOptions: c.providerOptions,
    stepCheckpoint: c.stepCheckpoint,
    maxStepExtensions: c.maxStepExtensions,
    onCheckpoint: c.onCheckpoint,
  };
}
