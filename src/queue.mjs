/**
 * A claim-based merge queue: who goes next is decided by what it COSTS them to wait, not by who
 * asked first.
 *
 * WHY NOT FIFO. This is the design the behaviour taught us rather than the one that seemed
 * obvious. Watching several agents negotiate merge windows by hand for a day, priority was never
 * arrival order — it was the strength of the claim:
 *
 *   - a change carrying a database migration, holding a shared lane behind it, goes first: every
 *     forced rebase re-parents its schema snapshot, and anyone else needing the lane is blocked
 *     behind it. Waiting has a compounding cost.
 *   - a docs or tooling change goes last. Waiting costs it nothing.
 *
 * A FIFO queue would have put a README tweak ahead of a migration purely because it asked first,
 * which is exactly backwards. So a waiter records a CLAIM, and claims are weighted.
 *
 * AGING IS NOT OPTIONAL. A plain priority queue starves low-priority work — and starvation is the
 * entire problem this package exists to solve, so reintroducing it in the fix would be absurd. A
 * waiter therefore gains weight the longer it waits, and will eventually outrank anything. Set
 * `agingPerMinute` to 0 only if you want strict priority and understand what you are choosing.
 *
 * IT DOES NOT ARBITRATE, IT RECORDS. The human negotiation worked partly because agents could
 * explain themselves: "mine holds the lane, yours is docs" is an argument someone can disagree
 * with. So a claim carries a free-text note, `status` shows it, and `--force` always wins. This
 * orders a conversation; it does not replace one.
 */

/** Default claim weights. Override wholesale in agent-worktree.config.json. */
export const DEFAULT_CLAIMS = {
  /** Blocks other work — holds a lane, a shared resource, an environment. */
  blocking: 40,
  /** Carries a schema migration: rebasing is expensive and risky, not just slow. */
  migration: 30,
  /** Production fix. */
  fix: 20,
  /** Anything unspecified. */
  default: 0,
  /** Docs, tooling, chores — waiting costs nothing. */
  chore: -20,
}

export const DEFAULT_AGING_PER_MINUTE = 2

const minutesSince = (iso) => Math.max(0, (Date.now() - Date.parse(iso)) / 60000)

/**
 * Effective priority: the claim's weight plus what it has earned by waiting.
 *
 * With the defaults, a `chore` (-20) overtakes a fresh `migration` (30) after ~25 minutes. That is
 * the intended shape: important work goes first, but nothing waits forever.
 */
export function priority(waiter, { claims = DEFAULT_CLAIMS, agingPerMinute = DEFAULT_AGING_PER_MINUTE } = {}) {
  const base = claims[waiter.claim] ?? claims.default ?? 0
  return base + minutesSince(waiter.at) * agingPerMinute
}

/**
 * The queue in the order it should be served. Stable: equal priority falls back to who waited
 * longer, so agents with identical claims are FIFO among themselves.
 */
export function ordered(waiting, opts) {
  return [...waiting].sort((a, b) => {
    const d = priority(b, opts) - priority(a, opts)
    return d !== 0 ? d : Date.parse(a.at) - Date.parse(b.at)
  })
}

/**
 * Drop waiters that have gone QUIET — not waiters that have waited a long time.
 *
 * THESE ARE DIFFERENT FACTS and conflating them was a real bug in this file: pruning on `at`
 * meant anything waiting longer than the stale window was silently deleted from the queue. The
 * longer you waited, the likelier you were to be dropped — starvation in its worst form, because
 * nothing reported it. The symptom is a change that simply sits there while everyone assumes it
 * is queued.
 *
 *   `at`   — when you JOINED. Drives aging. Never changes while you wait.
 *   `seen` — last time you checked in. Drives pruning. Refreshed every poll.
 *
 * So a patient agent keeps its earned priority indefinitely, and only a genuinely absent one is
 * removed. `merge wait` refreshes `seen` for you; anything polling `take` does too.
 */
export function prune(waiting, staleMinutes) {
  return (waiting ?? []).filter((w) => minutesSince(w.seen ?? w.at) <= staleMinutes)
}

/** Add or refresh this agent's place in the queue, keeping its ORIGINAL wait time. */
export function enqueue(waiting, entry) {
  const existing = (waiting ?? []).find((w) => sameAgent(w, entry))
  if (existing) {
    // Keep `at` — refreshing must not reset the aging that earned its position, or a polling
    // agent would permanently reset itself to the back of the queue by checking whether it is
    // at the front.
    existing.seen = new Date().toISOString()
    existing.claim = entry.claim ?? existing.claim
    existing.note = entry.note ?? existing.note
    return waiting
  }
  return [...(waiting ?? []), { ...entry, seen: entry.seen ?? entry.at }]
}

export const sameAgent = (a, b) =>
  (a.id != null && b.id != null && String(a.id) === String(b.id)) || a.holder === b.holder

export const dequeue = (waiting, entry) => (waiting ?? []).filter((w) => !sameAgent(w, entry))

/** Is it this agent's turn — i.e. is it at the head of the ordered queue? */
export function isNext(waiting, entry, opts) {
  const q = ordered(waiting ?? [], opts)
  return q.length === 0 || sameAgent(q[0], entry)
}
