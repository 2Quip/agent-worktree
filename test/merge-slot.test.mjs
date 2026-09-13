import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe as suite, test } from 'node:test'
import { isMine, readSlot, release, take } from '../src/merge-slot.mjs'

let dir, file
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aw-'))
  file = join(dir, 'slot.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const STALE = 15
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString()

suite('merge slot', () => {
  test('a free slot reads as null', () => {
    assert.equal(readSlot(file), null)
  })

  test('take then status round-trips', () => {
    assert.deepEqual(take(file, { who: 'a', id: '1', staleMinutes: STALE }), { ok: true })
    assert.equal(readSlot(file).holder, 'a')
    assert.equal(readSlot(file).id, '1')
  })

  test('another agent, another id, is refused', () => {
    take(file, { who: 'a', id: '1', staleMinutes: STALE })
    const r = take(file, { who: 'b', id: '2', staleMinutes: STALE })
    assert.equal(r.ok, false)
    assert.equal(r.held.holder, 'a')
  })

  // THE REGRESSION THIS PACKAGE SHIPPED ONCE. The name falls back to a per-process id, so a tool
  // invoked twice could not recognise a slot its own session took by hand — it refused with
  // "MERGE SLOT IS TAKEN — <your own name>". It survived review because every other test passed
  // an explicit name, so the fallback never ran. The feature was tested and the default was not.
  test('THE SAME ID IS MINE even under a different name', () => {
    take(file, { who: 'agent-78', id: '543', staleMinutes: STALE })
    const r = take(file, { who: 'pid-44513', id: '543', staleMinutes: STALE })
    assert.equal(r.ok, true, 'same id must be recognised as the same owner')
  })

  test('and release works the same way', () => {
    take(file, { who: 'agent-78', id: '543', staleMinutes: STALE })
    assert.equal(release(file, { who: 'pid-999', id: '543' }).ok, true)
    assert.equal(readSlot(file), null)
  })

  // The counter-test that matters more: a fix making the slot recognise everything as "mine"
  // would pass the two above while rendering the whole thing useless.
  test('a DIFFERENT id under an unknown name is still refused', () => {
    take(file, { who: 'agent-78', id: '543', staleMinutes: STALE })
    assert.equal(take(file, { who: 'pid-44513', id: '999', staleMinutes: STALE }).ok, false)
    assert.equal(release(file, { who: 'pid-44513', id: '999' }).ok, false)
  })

  test('--force releases someone else s slot', () => {
    take(file, { who: 'a', id: '1', staleMinutes: STALE })
    assert.equal(release(file, { who: 'b', id: '2', force: true }).ok, true)
  })

  test('a stale slot is takeable — a crashed agent must not wedge everyone', () => {
    writeFileSync(file, JSON.stringify({ holder: 'dead', id: '1', at: minutesAgo(40) }))
    assert.equal(take(file, { who: 'b', id: '2', staleMinutes: STALE }).ok, true)
    assert.equal(readSlot(file).holder, 'b')
  })

  test('a slot just inside the stale window is NOT takeable', () => {
    writeFileSync(file, JSON.stringify({ holder: 'busy', id: '1', at: minutesAgo(STALE - 1) }))
    assert.equal(take(file, { who: 'b', id: '2', staleMinutes: STALE }).ok, false)
  })

  // Degrade, do not stop the line: failing to coordinate costs a rebase, failing to merge costs
  // the work. A corrupt lock file must never be able to block every merge.
  test('a corrupt slot file reads as free rather than throwing', () => {
    writeFileSync(file, 'not json {{{')
    assert.equal(readSlot(file, { quiet: true }), null)
    assert.equal(take(file, { who: 'b', id: '2', staleMinutes: STALE }).ok, true)
  })

  test('a slot missing required fields reads as free', () => {
    writeFileSync(file, JSON.stringify({ holder: 'a' })) // no `at`
    assert.equal(readSlot(file, { quiet: true }), null)
  })

  test('isMine matches on id across types', () => {
    assert.equal(isMine({ holder: 'x', id: 543 }, 'other', '543'), true)
    assert.equal(isMine({ holder: 'x', id: '543' }, 'other', 543), true)
    assert.equal(isMine({ holder: 'x', id: null }, 'other', null), false)
  })
})
