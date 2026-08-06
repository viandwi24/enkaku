import { z } from 'zod'

/**
 * Notifications and webhooks (plan 68 §3.4, §4.1, §4.3, §4.4) — two
 * channels, and no more. In-app is a row in `notifications`, always written
 * first; webhook is a signed POST to a farm-configured endpoint. Email and
 * per-service chat integrations are explicit non-goals (§2).
 */

export const NotificationLevelSchema = z.enum(['info', 'warn', 'error'])
export type NotificationLevel = z.infer<typeof NotificationLevelSchema>

/** Makes a notification clickable (plan 68 §4.1) — every field optional, but a notification produced
 * by an agent run always carries at least `runId` (criterion 14: "every notification links to the
 * run that produced it"). */
export const NotificationContextSchema = z
  .object({
    runId: z.string().optional(),
    threadId: z.string().optional(),
    agentId: z.string().optional(),
    deviceId: z.string().optional(),
    jobId: z.string().optional(),
    scheduleId: z.string().optional(),
  })
  .nullable()
export type NotificationContext = z.infer<typeof NotificationContextSchema>

export const NotificationSchema = z.object({
  id: z.string(),
  level: NotificationLevelSchema,
  title: z.string(),
  body: z.string().nullable(),
  context: NotificationContextSchema,
  /** `'agent:<id>'` or `'system'`. */
  source: z.string(),
  readAt: z.number().int().nullable(),
  createdAt: z.number().int(),
})
export type Notification = z.infer<typeof NotificationSchema>

/** `notify.send`'s input (plan 68 §4.3) — a capability, so it is registry-listed, allowlistable per agent, permission-checked, and audited like every other capability. */
export const NotifySendInputSchema = z.object({
  level: NotificationLevelSchema,
  title: z.string().min(1).max(200),
  body: z.string().max(4000).optional(),
  /** Webhook endpoint names; omitted ⇒ in-app only. */
  channels: z.array(z.string()).optional(),
})
export type NotifySendInput = z.infer<typeof NotifySendInputSchema>

/** Distinguishes DELIVERED from FAILED channels (plan 68 §4.3, §3.4) — never a blind `ok`. */
export const NotifySendOutputSchema = z.object({
  notificationId: z.string(),
  delivered: z.array(z.string()),
  failed: z.array(z.string()),
})
export type NotifySendOutput = z.infer<typeof NotifySendOutputSchema>

export const WebhookDeliveryStatusSchema = z.enum(['ok', 'failed'])
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>

/** The public shape of a webhook endpoint (plan 68 §4.1) — NEVER carries the secret itself, same rule `ConnectorSchema` already follows for a credential. */
export const WebhookEndpointSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  url: z.string(),
  enabled: z.boolean(),
  /** Whether a secret is stored — never the secret itself. */
  configured: z.boolean(),
  /** Rolling delivery health (plan 68 §4.1) — so a dead endpoint is visible before someone needs it. */
  lastStatus: WebhookDeliveryStatusSchema.nullable(),
  lastAttemptAt: z.number().int().nullable(),
  failureCount: z.number().int(),
  createdAt: z.number().int(),
})
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>

/** `POST /api/webhooks` — `secret` is write-only and never echoed back. */
export const WebhookEndpointWriteInputSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  secret: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
})
export type WebhookEndpointWriteInput = z.infer<typeof WebhookEndpointWriteInputSchema>

export const WebhookEndpointUpdateInputSchema = WebhookEndpointWriteInputSchema.omit({ name: true }).partial()
export type WebhookEndpointUpdateInput = z.infer<typeof WebhookEndpointUpdateInputSchema>

/** Broadcast whenever a notification is created, so the bell updates without polling (plan 68 §4.5). */
export const NotificationCreatedMessage = z.object({
  type: z.literal('notification.created'),
  payload: NotificationSchema,
})
export type NotificationCreatedEvent = z.infer<typeof NotificationCreatedMessage>
