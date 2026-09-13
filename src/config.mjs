/**
 * Configuration, loaded from `agent-worktree.config.json` at the repo root.
 *
 * EVERY PROJECT-SPECIFIC FACT LIVES HERE and nowhere else — service names, base ports, stride,
 * the env vars your dev servers read. The tools themselves know nothing about any particular
 * repository, which is the whole difference between this and the internal scripts it came from.
 *
 * MISSING CONFIG IS NOT AN ERROR for the tools that do not need it. `slot` and `merge` work with
 * no config at all; only `ports` requires a `services` map, because there is no sensible default
 * for "what are your apps called".
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CLAIMS } from './queue.mjs'

export const CONFIG_FILE = 'agent-worktree.config.json'

const DEFAULTS = {
  /** Worktree slots available. Slot 0 is the main checkout. */
  spread: 40,
  /**
   * Spacing between slots. MUST be greater than the largest gap between two of your base ports,
   * or slot k+1's first service lands on slot k's second. `ports --verify` proves this by brute
   * force rather than trusting this comment.
   */
  stride: 10,
  /** name -> base port. No default: only you know what your services are called. */
  services: {},
  /**
   * Bands owned by something else (a docker-compose Postgres, say) that use stride 1. Not offset,
   * but `--verify` checks nothing ever lands on them.
   */
  reserved: {},
  /**
   * Extra env vars to set, with `${port:name}` and `${slot}` interpolated. This is how dev servers
   * are pointed at THIS worktree's siblings rather than a neighbour's — the single most valuable
   * thing here, and the one most specific to your setup.
   */
  env: {},
  /** Namespace for the merge lock file. Defaults to the repo directory name. */
  project: null,
  /** Minutes before a held merge slot is presumed abandoned. */
  staleMinutes: 15,
  /** Claim weights for the merge queue. Higher goes first. */
  claims: null,
  /** Priority a waiter gains per minute. 0 = strict priority (and possible starvation). */
  agingPerMinute: 2,
}

/**
 * @param {string} root repo root
 * @returns {typeof DEFAULTS & { _found: boolean }}
 */
export function loadConfig(root) {
  let raw = {}
  let found = false
  try {
    raw = JSON.parse(readFileSync(join(root, CONFIG_FILE), 'utf8'))
    found = true
  } catch (err) {
    // A missing config is ordinary — the tools that need one say so themselves, with a better
    // message than a parse error. A MALFORMED config is not ordinary and must not be silently
    // treated as absent, or you get defaults you never asked for and no idea why.
    if (err.code !== 'ENOENT') {
      throw new Error(`${CONFIG_FILE} exists but could not be read: ${err.message}`)
    }
  }
  const merged = { ...DEFAULTS, ...raw, _found: found }
  merged.claims = merged.claims ?? DEFAULT_CLAIMS
  return merged
}

/** Interpolate `${port:name}` and `${slot}` in a config env value. */
export function interpolate(value, { port, slot }) {
  return String(value)
    .replace(/\$\{port:([a-zA-Z0-9_-]+)\}/g, (_, name) => {
      const p = port(name)
      if (p == null) throw new Error(`env references unknown service "${name}"`)
      return String(p)
    })
    .replace(/\$\{slot\}/g, String(slot))
}
