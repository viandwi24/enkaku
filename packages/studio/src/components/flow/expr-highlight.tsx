'use client'

import { Fragment } from 'react'
import { FUNCTION_NAMES } from '@enkaku/expr'

/**
 * Syntax highlighting for an expression, coloured as JavaScript.
 *
 * The owner's objection was not about the evaluator, it was about the
 * screen: "orang kan taunya script js … biar bisa di highlight" (2026-09-05).
 * They are right on both halves. The expression grammar IS a JavaScript
 * subset — the same operators, the same call syntax, the same property
 * access, the same string and number literals — so highlighting it as JS is
 * accurate, not a costume. And until now it rendered as undifferentiated
 * monospace in a bare textarea, which is what made it feel like a private
 * notation rather than code.
 *
 * A tokeniser rather than a library: the grammar is small and already parsed
 * elsewhere, the whole thing is under a hundred lines, and a highlighter that
 * knows THIS language can colour a function name by whether it actually
 * exists — something a generic JS highlighter cannot do, and the fastest way
 * to notice a typo before running anything.
 */
type Tok = { text: string; cls: string }

const KEYWORDS = new Set(['true', 'false', 'null'])
const ROOTS = new Set(['$params', '$nodes', '$input', '$run', '$now', '$random'])

const CLS = {
  root: 'text-accent',
  fn: 'text-warn',
  unknownFn: 'text-danger underline decoration-danger/60 decoration-wavy',
  str: 'text-ok',
  num: 'text-ok',
  kw: 'text-warn',
  op: 'text-dim',
  field: 'text-text',
  plain: 'text-text',
}

/** One pass, left to right. Anything unrecognised falls through as plain text, so a half-typed expression never disappears. */
export function tokenizeExpr(source: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const push = (text: string, cls: string) => {
    if (text.length === 0) return
    const last = out[out.length - 1]
    if (last && last.cls === cls) last.text += text
    else out.push({ text, cls })
  }
  while (i < source.length) {
    const c = source[i] as string
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1
      push(source.slice(i, Math.min(j + 1, source.length)), CLS.str)
      i = j + 1
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < source.length && /[0-9._]/.test(source[j] as string)) j++
      push(source.slice(i, j), CLS.num)
      i = j
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < source.length && /[A-Za-z0-9_$]/.test(source[j] as string)) j++
      const word = source.slice(i, j)
      let k = j
      while (k < source.length && source[k] === ' ') k++
      const isCall = source[k] === '('
      if (isCall) push(word, FUNCTION_NAMES.has(word) ? CLS.fn : CLS.unknownFn)
      else if (ROOTS.has(word)) push(word, CLS.root)
      else if (KEYWORDS.has(word)) push(word, CLS.kw)
      else push(word, CLS.field)
      i = j
      continue
    }
    if (/[+\-*/%<>=!&|?:,().[\]]/.test(c)) {
      push(c, CLS.op)
      i += 1
      continue
    }
    push(c, CLS.plain)
    i += 1
  }
  return out
}

/** The coloured copy drawn behind the textarea. Must render the SAME glyphs at the SAME metrics, or the caret drifts from the text. */
export function ExprHighlight({ source }: { source: string }) {
  return (
    <>
      {tokenizeExpr(source).map((t, i) => (
        <Fragment key={i}>
          <span className={t.cls}>{t.text}</span>
        </Fragment>
      ))}
      {/* A trailing newline needs a character after it or the last line has no height. */}
      {source.endsWith('\n') ? '​' : null}
    </>
  )
}
