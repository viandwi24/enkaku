import { z } from 'zod'
import { ConnectorKindSchema } from './agent'
import { WhisperModelNameSchema } from './settings'

/**
 * Plan 317 — the farm-side foundation for AI auto-captions. Two capability
 * pairs: `ai.status`/`ai.generate` reach the farm's existing connectors
 * (`agent/connector-store.ts`, `agent/provider/*`) for text generation;
 * `media.transcribe.status`/`media.transcribe` run whisper.cpp locally over
 * an already-extracted WAV artifact. Neither plugin ever sees an API key or
 * a model path — both are capabilities, gated by permission, exactly like
 * every other farm door (`capability/notify.ts` is the template).
 */

// ---------------------------------------------------------------------------
// `ai.status` / `ai.generate`
// ---------------------------------------------------------------------------

export const AiStatusInputSchema = z.object({})
export type AiStatusInput = z.infer<typeof AiStatusInputSchema>

export const AiStatusOutputSchema = z.object({
  configured: z.boolean(),
  connectorId: z.string().nullable(),
  connectorName: z.string().nullable(),
  kind: ConnectorKindSchema.nullable(),
  model: z.string().nullable(),
  /** One sentence saying what to do when `configured` is false. Null when configured. */
  reason: z.string().nullable(),
})
export type AiStatusOutput = z.infer<typeof AiStatusOutputSchema>

export const AiGenerateInputSchema = z.object({
  prompt: z.string().min(1).max(20_000),
  system: z.string().max(8_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(4_000).default(400),
  temperature: z.number().min(0).max(2).optional(),
})
export type AiGenerateInput = z.infer<typeof AiGenerateInputSchema>

export const AiGenerateOutputSchema = z.object({
  text: z.string(),
  connectorId: z.string(),
  connectorName: z.string(),
  model: z.string(),
})
export type AiGenerateOutput = z.infer<typeof AiGenerateOutputSchema>

// ---------------------------------------------------------------------------
// `media.transcribe.status` / `media.transcribe`
// ---------------------------------------------------------------------------

export const MediaTranscribeStatusInputSchema = z.object({})
export type MediaTranscribeStatusInput = z.infer<typeof MediaTranscribeStatusInputSchema>

/** Plan 318 — where the whisper-cli in use came from, in resolution order. `missing` means none of the three. */
export const WhisperCliSourceSchema = z.enum(['setting', 'env', 'managed', 'missing'])
export type WhisperCliSource = z.infer<typeof WhisperCliSourceSchema>

export const WhisperModelEntrySchema = z.object({
  /** The toolchain tool id, `whisper-model-<name>`. */
  id: z.string(),
  name: WhisperModelNameSchema,
  sizeBytes: z.number().int().nonnegative(),
  installed: z.boolean(),
  /** The model `farm_settings.ai.whisperModel` selects. Exactly one entry is active. */
  active: z.boolean(),
})
export type WhisperModelEntry = z.infer<typeof WhisperModelEntrySchema>

export const MediaTranscribeStatusOutputSchema = z.object({
  available: z.boolean(),
  model: z.string().nullable(),
  /** Names the missing tool/model and the env override or the Tools page. Null when available. */
  reason: z.string().nullable(),
  // Plan 318 — additive; the three fields above keep their exact plan 317 meaning.
  cli: z.object({
    path: z.string().nullable(),
    source: WhisperCliSourceSchema,
    /** Why the CLI is unusable, or null when it resolved. */
    detail: z.string().nullable(),
  }),
  /** The selected model's tool id. */
  modelId: z.string(),
  models: z.array(WhisperModelEntrySchema),
  /** A background install of the CLI or the selected model is running. */
  provisioning: z.boolean(),
})
export type MediaTranscribeStatusOutput = z.infer<typeof MediaTranscribeStatusOutputSchema>

// ---------------------------------------------------------------------------
// `media.transcribe.check` (plan 318) — the doctor for local transcription.
// ---------------------------------------------------------------------------

export const MediaTranscribeCheckInputSchema = z.object({})
export type MediaTranscribeCheckInput = z.infer<typeof MediaTranscribeCheckInputSchema>

export const TranscribeCheckStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['ok', 'fail', 'skip']),
  detail: z.string(),
})
export type TranscribeCheckStep = z.infer<typeof TranscribeCheckStepSchema>

export const MediaTranscribeCheckOutputSchema = z.object({
  /** True only when no step failed. A skipped step never counts as a pass on its own: it is skipped because an earlier one failed. */
  ok: z.boolean(),
  steps: z.array(TranscribeCheckStepSchema),
})
export type MediaTranscribeCheckOutput = z.infer<typeof MediaTranscribeCheckOutputSchema>

export const MediaTranscribeInputSchema = z.object({
  artifactId: z.string().min(1),
  /** `'auto'` (default) or an ISO-639-1 code, e.g. `'id'`. */
  language: z.string().min(1).max(10).default('auto'),
})
export type MediaTranscribeInput = z.infer<typeof MediaTranscribeInputSchema>

export const TranscribeSegmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
})
export type TranscribeSegment = z.infer<typeof TranscribeSegmentSchema>

export const MediaTranscribeOutputSchema = z.object({
  text: z.string(),
  language: z.string().nullable(),
  /** False when whisper produced only non-speech markers ('[BLANK_AUDIO]', '(music)', '♪', ...) or nothing at all — `text` is `''` in that case. */
  speech: z.boolean(),
  durationMs: z.number().int().nonnegative().nullable(),
  segments: z.array(TranscribeSegmentSchema),
})
export type MediaTranscribeOutput = z.infer<typeof MediaTranscribeOutputSchema>
