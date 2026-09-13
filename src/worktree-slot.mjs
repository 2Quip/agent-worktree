/**
 * Which "slot" this worktree owns — one deterministic offset, derived once, shared by everything
 * that needs a per-worktree port, container or lock.
 *
 * SINGLE SOURCE ON PURPOSE. Anything that needs "which offset am I" must agree. Two
 * implementations of that eventually disagree, and the symptom is an agent whose database is on
 * slot 3 and whose API is on slot 7 — everything running, nothing talking.
 *
 * DETERMINISTIC, not "next free port". A hash of the worktree path means the same directory always
 * gets the same slot, so URLs written into a `.env` keep working across restarts and reboots, and
 * two worktrees only collide if their paths hash to the same slot. "Next free port" hands you a
 * different port every morning and makes a stale `.env` point at whatever started first — which is
 * the failure this exists to prevent.
 *
 * THE MAIN CHECKOUT IS SLOT 0. Its ports are exactly the configured defaults, so anyone who
 * ignores all of this sees no change at all.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'

/** Default number of worktree slots. Slot 0 is reserved for the main checkout. */
export const DEFAULT_SPREAD = 40

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe' }).trim()

/**
 * @param {{ spread?: number, cwd?: string }} [opts]
 * @returns {{ root: string, slug: string, offset: number, isMain: boolean }}
 * @throws if not inside a git worktree — callers should let this surface rather than guess a slot,
 *         because a guessed slot silently points at someone else's resources.
 */
export function worktreeSlot({ spread = DEFAULT_SPREAD, cwd } = {}) {
  const opts = cwd ? ['-C', cwd] : []
  const root = sh('git', [...opts, 'rev-parse', '--show-toplevel'])

  // `git worktree list` prints the MAIN worktree first, whatever you run it from.
  let isMain = false
  try {
    isMain = sh('git', [...opts, 'worktree', 'list']).split('\n')[0].split(' ')[0] === root
  } catch {
    isMain = false
  }

  const slug = isMain
    ? 'main'
    : basename(root)
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || 'wt'

  const offset = isMain
    ? 0
    : (Number.parseInt(createHash('sha256').update(root).digest('hex').slice(0, 8), 16) % spread) +
      1

  return { root, slug, offset, isMain }
}
