/**
 * One screen: who is merging, who is next, and why.
 *
 * THE "WHY" IS THE POINT. A bare queue position invites the question this replaces — "why are they
 * ahead of me?" — and the honest answer has to be visible, because the ordering is a judgement
 * call rather than arrival order. So every waiter shows its claim and its note, and anyone who
 * disagrees can say so. This orders a conversation; it does not replace one.
 */
import { readSlot } from './merge-slot.mjs'
import { ordered, priority, prune } from './queue.mjs'

const mins = (iso) => Math.round((Date.now() - Date.parse(iso)) / 60000)
const pad = (s, n) => String(s ?? '').padEnd(n)

export function renderQueue(file, { project, staleMinutes, queueOpts }) {
  const state = readSlot(file, { quiet: true })
  const lines = [`\n  MERGE SLOT — ${project}\n`]

  if (!state?.holder && !(state?.waiting ?? []).length) {
    lines.push('  ✔ free — nobody merging, nobody waiting\n')
    return lines.join('\n')
  }

  if (state?.holder) {
    const age = mins(state.at)
    const flag = age > staleMinutes ? '  ⚠ STALE — free to take' : ''
    lines.push(
      `  ●  ${pad(state.holder, 14)} ${pad(state.id ?? '', 8)} holding   ${age}m${flag}`,
    )
    if (state.note) lines.push(`     ${state.note}`)
  } else {
    lines.push(`  ○  free — next in line may take it`)
  }

  const waiting = ordered(prune(state?.waiting, staleMinutes), queueOpts)
  if (waiting.length) {
    lines.push('')
    waiting.forEach((w, i) => {
      const tee = i === waiting.length - 1 ? '└─' : '├─'
      const next = i === 0 ? '  ← next' : ''
      lines.push(
        `     ${tee} ${pad(w.holder, 12)} ${pad(w.id ?? '', 8)} ${pad(w.claim ?? 'default', 9)} ` +
          `${String(mins(w.at)) + 'm'}${next}`,
      )
      if (w.note) lines.push(`        ${w.note}`)
    })
    lines.push('')
    lines.push(
      `     ordered by claim, not arrival — and every waiter gains priority as it waits, so`,
    )
    lines.push(`     nothing is starved. \`--why\` shows the arithmetic.`)
  }

  lines.push('')
  return lines.join('\n')
}

/** The arithmetic, for when someone reasonably asks why they are third. */
export function renderWhy(file, { staleMinutes, queueOpts }) {
  const state = readSlot(file, { quiet: true })
  const waiting = ordered(prune(state?.waiting, staleMinutes), queueOpts)
  if (!waiting.length) return '\n  nobody waiting\n'
  const claims = queueOpts?.claims ?? {}
  return (
    '\n  PRIORITY = claim weight + minutes waited × aging\n\n' +
    waiting
      .map(
        (w) =>
          `    ${pad(w.holder, 12)} ${pad(w.claim ?? 'default', 9)} ` +
          `${String(claims[w.claim] ?? claims.default ?? 0).padStart(4)} ` +
          `+ ${String(mins(w.at)).padStart(3)}m  =  ${priority(w, queueOpts).toFixed(1)}`,
      )
      .join('\n') +
    '\n'
  )
}
