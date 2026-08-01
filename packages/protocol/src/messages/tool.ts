import { z } from 'zod'

/** Message WS toolchain (plan 02 §4.7). */

export const ToolInstallProgressMessage = z.object({
  type: z.literal('tool.install.progress'),
  payload: z.object({
    toolId: z.string(),
    version: z.string(),
    phase: z.enum(['download', 'verify', 'extract', 'done', 'error']),
    bytesReceived: z.number().optional(),
    totalBytes: z.number().nullable().optional(),
    percent: z.number().min(0).max(100).nullable().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
})
export type ToolInstallProgress = z.infer<typeof ToolInstallProgressMessage>

/** Khusus first-run auto-provision. */
export const ToolProvisionProgressMessage = z.object({
  type: z.literal('tool.provision.progress'),
  payload: z.object({
    step: z.enum(['start', 'tool', 'done', 'error']),
    toolId: z.string().optional(),
    version: z.string().optional(),
    phase: z.enum(['download', 'verify', 'extract', 'activate']).optional(),
    percent: z.number().nullable().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
})
export type ToolProvisionProgress = z.infer<typeof ToolProvisionProgressMessage>

/** Trigger Studio re-fetch GET /api/tools. */
export const ToolChangedMessage = z.object({
  type: z.literal('tool.changed'),
  payload: z.object({
    toolId: z.string(),
    change: z.enum(['installed', 'activated', 'deleted', 'manifest-refreshed']),
  }),
})
export type ToolChanged = z.infer<typeof ToolChangedMessage>
