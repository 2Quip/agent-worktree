#!/usr/bin/env node
/**
 * agent-worktree — coordination primitives for running several coding agents on one repository.
 *
 *   agent-worktree slot                    which slot this worktree owns
 *   agent-worktree ports [--print]         this worktree's dev-server ports
 *   agent-worktree ports -- <cmd...>       run a command with those ports in the env
 *   agent-worktree ports --verify          prove no two slots ever want the same port
 *   agent-worktree merge status            who holds the merge slot
 *   agent-worktree merge take <id>         claim it
 *   agent-worktree merge release <id>      give it back
 */
import { basename } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { describe, isMine, readSlot, release, slotPath, take } from '../src/merge-slot.mjs'
import { runPorts } from '../src/ports.mjs'
import { renderQueue, renderWhy } from '../src/status.mjs'
import { worktreeSlot } from '../src/worktree-slot.mjs'

const argv = process.argv.slice(2)
const [cmd, ...rest] = argv

const die = (msg, code = 2) => {
  console.error(msg)
  process.exit(code)
}

let here
try {
  here = worktreeSlot()
} catch {
  die('\n✖ not inside a git repository — agent-worktree derives everything from the worktree.\n')
}

const config = loadConfig(here.root)
const project = config.project ?? basename(here.root)

const argOf = (flag) => {
  const i = rest.indexOf(flag)
  return i === -1 ? undefined : rest[i + 1]
}
// A per-process fallback is deliberately weak: see isMine(). Pass --as, or an id, or both.
const who = argOf('--as') ?? process.env.AGENT_NAME ?? `pid-${process.pid}`

switch (cmd) {
  case 'slot': {
    const { root, slug, offset, isMain } = worktreeSlot({ spread: config.spread })
    console.log(
      `\n  worktree  ${root}\n  slot      ${offset}${isMain ? '  (main checkout)' : `  (${slug})`}\n`,
    )
    break
  }

  case 'ports':
    runPorts(config, rest)
    break

  case 'merge': {
    const [sub, ...mrest] = rest
    const id = mrest.find((a) => !a.startsWith('-'))
    const file = slotPath(project)
    const staleMinutes = config.staleMinutes

    const queueOpts = { claims: config.claims, agingPerMinute: config.agingPerMinute }

    if (sub === 'status') {
      if (mrest.includes('--why')) {
        console.log(renderWhy(file, { staleMinutes, queueOpts }))
        break
      }
      const render = () => renderQueue(file, { project, staleMinutes, queueOpts })
      if (!mrest.includes('--watch')) {
        console.log(render())
        break
      }
      // --watch: the question "can I merge yet" gets asked repeatedly, so answer it in place.
      const draw = () => {
        process.stdout.write('\x1Bc')
        process.stdout.write(render())
        process.stdout.write('\n  watching — ctrl-c to stop\n')
      }
      draw()
      setInterval(draw, 5000)
      break
    }

    if (sub === 'take') {
      const r = take(file, {
        who,
        id,
        claim: argOf('--claim'),
        note: argOf('--note'),
        staleMinutes,
        queueOpts,
        force: mrest.includes('--force'),
      })
      if (!r.ok) {
        const pos = (r.queue ?? []).findIndex((w) => String(w.id) === String(id)) + 1
        if (r.held) {
          console.error(`\n✖ MERGE SLOT IS TAKEN — ${describe(r.held)}`)
        } else {
          console.error(`\n✖ NOT YOUR TURN — the slot is free but someone outranks you.`)
        }
        console.error(
          `\n  You are QUEUED at position ${pos} of ${r.queue.length}` +
            `${pos === 1 ? ' — next up.' : '.'}\n`,
        )
        console.error(renderQueue(file, { project, staleMinutes, queueOpts }))
        console.error(`  Do NOT rebase and retry into it: that is the race this exists to stop.`)
        console.error(`  Waiting raises your priority; you will not be starved.`)
        console.error(`  \`merge status --watch\` to follow, \`--force\` if you must jump.\n`)
        process.exit(1)
      }
      console.log(`✔ merge slot held by ${who}${id ? ` for ${id}` : ''}`)
      break
    }

    /**
     * BLOCK until it is your turn, then exit 0.
     *
     * THE BEHAVIOUR THIS FIXES: agents reliably join a queue and then never check it again. The
     * change sits there, the slot frees, nobody notices, and the queue quietly becomes a list of
     * things nobody is merging. Polling is something you have to REMEMBER, and a coordination
     * step that depends on remembering loses to whatever the agent does next.
     *
     * So do not ask agents to poll. Give them one command that returns when they may proceed:
     *
     *     agent-worktree merge wait 546 --claim chore && <your merge command>
     *
     * It refreshes `seen` on every tick, so waiting keeps you in the queue rather than ageing you
     * out of it, and your earned priority keeps rising the whole time.
     */
    if (sub === 'wait') {
      const timeoutMin = Number(argOf('--timeout') ?? 60)
      const started = Date.now()
      const attempt = () => {
        const r = take(file, {
          who,
          id,
          claim: argOf('--claim'),
          note: argOf('--note'),
          staleMinutes,
          queueOpts,
        })
        if (r.ok) {
          console.log(`\n✔ your turn — merge slot held by ${who}${id ? ` for ${id}` : ''}\n`)
          process.exit(0)
        }
        if ((Date.now() - started) / 60000 > timeoutMin) {
          console.error(`\n✖ still not your turn after ${timeoutMin}m — giving up.`)
          console.error(`  You are STILL QUEUED; run \`merge wait ${id ?? ''}\` again, or --force.\n`)
          process.exit(1)
        }
        const pos = (r.queue ?? []).findIndex((w) => String(w.id) === String(id)) + 1
        process.stdout.write(
          `\r  waiting — position ${pos} of ${r.queue.length}, ` +
            `${Math.round((Date.now() - started) / 60000)}m elapsed   `,
        )
      }
      attempt()
      setInterval(attempt, 10000)
      break
    }

    if (sub === 'release') {
      const r = release(file, { who, id, staleMinutes, force: mrest.includes('--force') })
      if (!r.ok) {
        console.error(`\n✖ Not releasing — the slot belongs to ${describe(r.held)}.`)
        console.error(`  Use --force only if you are certain they are gone.\n`)
        process.exit(1)
      }
      console.log(
        r.next
          ? `✔ merge slot released — ${r.next.holder} (${r.next.id ?? '?'}) is next`
          : '✔ merge slot released',
      )
      break
    }

    die(
      'usage: agent-worktree merge status [--watch|--why] | take <id> [--claim <c>] [--note <s>] | release <id> [--force]',
    )
    break
  }

  default:
    die(`
agent-worktree — coordination primitives for several coding agents on one repository

  agent-worktree slot                 which slot this worktree owns
  agent-worktree ports [--print]      this worktree's dev-server ports
  agent-worktree ports -- <cmd...>    run a command with those ports in the env
  agent-worktree ports --verify       prove no two slots ever want the same port
  agent-worktree merge status         who holds the merge slot
  agent-worktree merge take <id>      claim it
  agent-worktree merge release <id>   give it back

Config: agent-worktree.config.json at the repo root. \`slot\` and \`merge\` need none.
`)
}
