import type { ScriptContext } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { flatten } from './tree'

/* ── Jittered tap (inlined — cross-pack imports forbidden) ─────────────── */

function jitterPoint(node: UiNode): { x: number; y: number } {
  const { left, top, right, bottom } = node.bounds
  const w = right - left, h = bottom - top
  if (w <= 0 || h <= 0) return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) }
  const fx = w < 24 ? 0 : 0.15, fy = h < 24 ? 0 : 0.15
  return {
    x: Math.round(left + w * (fx + Math.random() * (1 - 2 * fx))),
    y: Math.round(top + h * (fy + Math.random() * (1 - 2 * fy))),
  }
}

export async function tapNodeJittered(ctx: ScriptContext<unknown>, node: UiNode): Promise<void> {
  await ctx.device.tap({ point: jitterPoint(node) })
}

/**
 * Shared behaviour primitives for the Instagram pack.
 * Mirrors `youtube-automation-pack`'s `behavior.ts` + `tiktok-automation-pack`'s
 * `gesture.ts` + `human.ts` so every pack gets the same human-shaped randomness
 * and keyword tilt without cross-pack imports.
 */

/* ── RNG ─────────────────────────────────────────────────────────────────── */

export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x2f6e2b1
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000 }
}

export function between(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ── Human dwell (heavy-tailed, same buckets YouTube & TikTok use) ──────── */

const DWELL = [
  { weight: 0.14, lo: 1_200, hi: 3_000, label: 'skip' },
  { weight: 0.52, lo: 3_500, hi: 10_000, label: 'watch' },
  { weight: 0.24, lo: 10_000, hi: 25_000, label: 'engaged' },
  { weight: 0.10, lo: 25_000, hi: 55_000, label: 'hooked' },
] as const

export function pickDwell(rng: () => number): { ms: number; label: string } {
  const total = DWELL.reduce((s, b) => s + b.weight, 0)
  let r = rng() * total
  for (const b of DWELL) { r -= b.weight; if (r <= 0) return { ms: Math.round(between(rng, b.lo, b.hi)), label: b.label } }
  const last = DWELL[DWELL.length - 1] as (typeof DWELL)[number]
  return { ms: Math.round(between(rng, last.lo, last.hi)), label: last.label }
}

/* ── Byte-equal + frame ─────────────────────────────────────────────────── */

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0) !== 0x89504e47) return null
  const w = dv.getUint32(16), h = dv.getUint32(20)
  return w > 0 && h > 0 ? { width: w, height: h } : null
}

export interface Frame { width: number; height: number }

export async function frameOf(ctx: ScriptContext<unknown>): Promise<Frame> {
  const sz = pngSize(await ctx.device.screenshot())
  if (!sz) throw new Error('could not read frame size from screenshot')
  return sz
}

/* ── Verified random up-swipe (same corridor rule as TikTok & YouTube) ─── */

export async function verifiedSwipeUp(ctx: ScriptContext<unknown>, frame: Frame, rng: () => number): Promise<boolean> {
  for (const dist of [between(rng, 0.55, 0.75), 0.88]) {
    const before = await ctx.device.screenshot()
    const x = Math.round(between(rng, 0.14, 0.55) * frame.width)
    const sy = Math.round(between(rng, 0.68, 0.80) * frame.height)
    const ey = Math.max(Math.round(0.06 * frame.height), sy - Math.round(dist * frame.height))
    const ms = Math.round(between(rng, 140, 260))
    await ctx.device.swipe({ x, y: sy }, { x: Math.round(x + between(rng, -12, 12)), y: ey }, ms, {
      easing: 'linear', curvature: Number(between(rng, 0, 0.06).toFixed(3)),
    })
    await sleep(between(rng, 900, 1_600))
    if (!bytesEqual(before, await ctx.device.screenshot())) return true
  }
  return false
}

/* ── Keyword tilt (shared across IG / YouTube / TikTok) ─────────────────── */

/**
 * If any keyword appears in `text` (case-insensitive), the effective
 * probability is boosted.  No penalty on non-match — the operator's base
 * chance stays untouched, and only matched content gets the lift.
 */
export function keywordBoost(text: string, keywords: string[], base: number, factor: number): number {
  if (!keywords.length || base <= 0) return base
  const lower = text.toLowerCase()
  const hit = keywords.some((k) => k.trim() !== '' && lower.includes(k.toLowerCase()))
  return hit ? Math.min(1, base * factor) : base
}

/** Read every non-empty desc/text under `minTop` out of the tree — the caption,
 *  author, and other readable signals this pack's keyword match needs. */
export function readableStrings(tree: UiNode, minTop = 0): string[] {
  const seen = new Set<string>(), out: string[] = []
  for (const n of flatten(tree)) {
    for (const raw of [n.desc, n.text]) {
      const v = raw.trim()
      if (v && n.bounds.top >= minTop && !seen.has(v)) { seen.add(v); out.push(v) }
    }
  }
  return out
}

export const IG = 'com.instagram.android'

/* ── Sign-in / consent sweep (ACK_SELECTORS from TikTok, reused) ────────── */

export const ACK_TEXT = ['Mengerti','Saya mengerti','Got it','I understand','OK','Oke','Nanti saja','Lewati','Skip','Not now','Tutup','Close','Tidak sekarang']

export async function sweepAck(ctx: ScriptContext<unknown>): Promise<boolean> {
  const tree = await ctx.device.dump()
  for (const t of ACK_TEXT) {
    const hit = flatten(tree).find((n) => n.clickable && n.text.trim().toLowerCase() === t.toLowerCase())
    if (hit) { await tapNodeJittered(ctx, hit); await sleep(800); return true }
  }
  return false
}
