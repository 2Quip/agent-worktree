/**
 * One agent merges at a time. Take the slot, merge, release it.
 *
 * THE PROBLEM. Merging STARVES when several agents share a repo and CI is slow. "Not behind the
 * base branch AND green" is only satisfiable in the gaps between other merges: you push, CI runs
 * for minutes, someone merges during it, and your green result no longer proves anything about
 * the branch you are merging into. Four agents once burned three to four rebase cycles each in an
 * evening, and NONE of them resolved a real conflict — the commits touched different files.
 *
 * Two properties make it worth a mechanism rather than care:
 *
 *   - It presents as BAD LUCK rather than contention, so the instinct is to retry — which is
 *     exactly the behaviour that sustains it.
 *   - The cost is not evenly spread. A bigger diff and a slower CI mean a wider window for
 *     someone to slip in, so the change that most needs careful review is the one most likely to
 *     be starved.
 *
 * WHY A FILE OUTSIDE THE REPO, and not a committed claim file. The obvious design — every PR edits
 * a shared file, so two concurrent ones always conflict — works when the thing being serialised is
 * RARE. Merges are universal: a committed claim file would have every pair of PRs conflict, which
 * is gridlock rather than serialisation. It is circular besides, because landing your claim would
 * itself be a merge that could be refused for being behind.
 *
 * IT DEGRADES RATHER THAN STOPPING THE LINE. A slot auto-expires, because an agent that crashed
 * mid-merge must not wedge everyone until a human notices. An unreadable slot file warns and
 * PROCEEDS: failing to coordinate costs a rebase, while failing to merge costs the work. Holding
 * the slot is not load-bearing for correctness — your own pre-merge checks are. This only decides
 * who goes first.
 *
 * HONEST LIMIT: this coordinates agents that share a filesystem. It does not see anyone pushing
 * from another machine. That is usually the right trade, because co-located agents are what
 * collide many times an hour; humans on their own machines rarely do. If you need cross-machine
 * serialisation, you need a real merge queue.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dequeue, enqueue, isNext, ordered, priority, prune } from './queue.mjs'

export const slotPath = (project) => join(homedir(), `.agent-worktree-merge-slot-${project}.json`)

const ageMinutes = (iso) => Math.round((Date.now() - Date.parse(iso)) / 60000)

/** null when free. NEVER throws: a slot we cannot read must not block a merge. */
export function readSlot(file, { quiet = false } = {}) {
  try {
    const held = JSON.parse(readFileSync(file, 'utf8'))
    // VALID IF IT HAS A HOLDER **OR** A QUEUE. The original demanded a holder, which was right
    // when this file only ever recorded one — but once releasing leaves the waiters behind, a
    // queue-only state read as "nothing here" and the entire queue silently vanished the instant
    // the slot was handed over. The next agent to ask would be told it was free and jump everyone.
    const hasHolder = held?.holder && held?.at
    const hasQueue = Array.isArray(held?.waiting) && held.waiting.length > 0
    if (!hasHolder && !hasQueue) return null
    return held
  } catch (err) {
    if (err.code !== 'ENOENT' && !quiet) {
      console.error(`⚠ merge slot unreadable (${err.message.split('\n')[0]}) — treating as free.`)
      console.error(`  Coordination is advisory; your own pre-merge checks still gate the merge.\n`)
    }
    return null
  }
}

/**
 * Is this slot mine?
 *
 * THE TASK ID IS THE RELIABLE ANSWER; the holder name is only a fallback. One change has one
 * author working it — nobody else is merging your pull request — so a slot recording the id you
 * are acting on is yours by construction, whatever name happens to be written in it.
 *
 * That matters because THE NAME IS NOT STABLE. Callers that do not pass one fall back to a
 * per-process id, so a tool invoked twice cannot recognise a slot its own session took a minute
 * earlier. The first version of this shipped exactly that bug and refused with "MERGE SLOT IS
 * TAKEN — <your own name>", which reads precisely like a colleague blocking you while being you
 * blocking yourself.
 *
 * It survived review because every test passed an explicit name, so the fallback never once ran.
 * The feature was tested and the DEFAULT was not.
 */
export const isMine = (held, who, id) =>
  held.holder === who || (id != null && String(held.id) === String(id))

export const describe = (h) => `${h.holder} — ${h.id ?? '?'} — ${ageMinutes(h.at)}m ago`

const write = (file, state) => writeFileSync(file, JSON.stringify(state))

/**
 * Claim the slot, or join the queue.
 *
 * THREE WAYS THIS CAN GO, and the second is the one that makes it a queue rather than a lock:
 *
 *   1. free and you are next  → you hold it
 *   2. held, or someone with a stronger claim is waiting → you are ENQUEUED, with your position
 *   3. stale holder → you take it, loudly
 *
 * Case 2 matters even when the slot is FREE: if a migration is waiting and you are a docs change
 * that just showed up, taking it would be jumping the line the queue exists to order.
 */
export function take(file, { who, id, claim, note, staleMinutes, queueOpts, force }) {
  const state = readSlot(file) ?? {}
  const me = { holder: who, id: id ?? null, at: new Date().toISOString(), claim, note }
  let waiting = prune(state.waiting, staleMinutes)

  const heldByOther = state.holder && !isMine(state, who, id)
  const stale = heldByOther && ageMinutes(state.at) > staleMinutes

  if (heldByOther && !stale && !force) {
    waiting = enqueue(waiting, me)
    write(file, { ...state, waiting })
    return { ok: false, held: state, age: ageMinutes(state.at), queue: ordered(waiting, queueOpts) }
  }

  if (stale) {
    console.error(
      `\n⚠ Taking a STALE merge slot from ${state.holder} (${ageMinutes(state.at)}m > ${staleMinutes}m).`,
    )
    console.error(`  If they are still alive this will collide — tell them.\n`)
  }

  // Slot is available — but is it yours? Someone already waiting may outrank you.
  if (!force && !isNext(waiting, me, queueOpts)) {
    waiting = enqueue(waiting, me)
    write(file, { ...state, holder: null, waiting })
    return { ok: false, held: null, queue: ordered(waiting, queueOpts) }
  }

  write(file, { holder: who, id: id ?? null, at: me.at, claim, note, waiting: dequeue(waiting, me) })
  return { ok: true }
}

export function release(file, { who, id, staleMinutes = 15, force }) {
  const state = readSlot(file)
  if (state?.holder && !isMine(state, who, id) && !force) return { ok: false, held: state }

  // KEEP THE QUEUE. Releasing hands the slot on; it does not disband the people waiting for it.
  const waiting = prune(state?.waiting, staleMinutes)
  if (waiting.length === 0) {
    rmSync(file, { force: true })
    return { ok: true, next: null }
  }
  write(file, { waiting })
  return { ok: true, next: ordered(waiting)[0] }
}
