import { MediaTranscribeInputSchema, MediaTranscribeOutputSchema, MediaTranscribeStatusInputSchema, MediaTranscribeStatusOutputSchema } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import { defineCapability } from './types'

/**
 * `media.transcribe.status` / `media.transcribe` (plan 317) — local
 * whisper.cpp transcription of an already-uploaded WAV artifact. No ffmpeg
 * anywhere in this path (`media/probe.ts`'s comment explains why): the
 * browser extracts the audio and uploads the WAV; this capability only ever
 * reads that file, through `media/transcribe.ts`'s service.
 */

export const mediaTranscribeStatus = defineCapability({
  id: 'media.transcribe.status',
  input: MediaTranscribeStatusInputSchema,
  output: MediaTranscribeStatusOutputSchema,
  permission: 'media.transcribe',
  deadline: 10_000,
  effect: 'read',
  description: 'Whether local whisper.cpp transcription is provisioned on this farm. Names the missing tool/model and how to fix it when it is not.',
  handler: (ctx) => {
    if (!ctx.media) throw new EnkakuError('E_NOT_SUPPORTED', 'media.transcribe is not available on this host')
    return ctx.media.status()
  },
})

export const mediaTranscribe = defineCapability({
  id: 'media.transcribe',
  input: MediaTranscribeInputSchema,
  output: MediaTranscribeOutputSchema,
  permission: 'media.transcribe',
  deadline: 30 * 60_000,
  effect: 'read',
  description:
    "Transcribe an already-uploaded 16 kHz mono WAV artifact with local whisper.cpp — never uploads or sends the audio anywhere else. Refuses with E_BAD_INPUT for anything that is not a RIFF/WAVE file, and E_TRANSCRIBE_UNAVAILABLE when whisper.cpp or its model is not provisioned.",
  handler: (ctx, input) => {
    if (!ctx.media) throw new EnkakuError('E_NOT_SUPPORTED', 'media.transcribe is not available on this host')
    return ctx.media.transcribe(input)
  },
})

export const MEDIA_CAPABILITIES = [mediaTranscribeStatus, mediaTranscribe]
