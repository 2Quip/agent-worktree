import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe as suite, test } from 'node:test'
import { release, take } from '../src/merge-slot.mjs'
import { DEFAULT_CLAIMS, dequeue, enqueue, isNext, ordered, priority, prune } from '../src/queue.mjs'

const OPTS = { claims: DEFAULT_CLAIMS, agingPerMinute: 2 }
const STALE = 15
const ago = (m) => new Date(Date.now() - m * 60000).toISOString()
const w = (holder, claim, atMin, seenMin = 0) => ({
  holder,
  id: holder,
  claim,
  at: ago(atMin),
  seen: ago(seenMin),
})

suite('queue — ordering by claim', () => {
  test('a stronger claim goes first even though it arrived LAST', () => {
    // The behaviour this whole design came from: a migration that turns up after a docs change
    // still merges first, because waiting costs it far more.
    const q = ordered([w('docs', 'chore', 5), w('schema', 'migration', 0)], OPTS)
    assert.equal(q[0].holder, 'schema')
  })

  test('equal claims fall back to who waited longer — FIFO within a class', () => {
    const q = ordered([w('later', 'fix', 2), w('earlier', 'fix', 9)], OPTS)
    assert.equal(q[0].holder, 'earlier')
  })

  test('an unknown claim is treated as default, not as an error', () => {
    assert.equal(priority(w('x', 'nonsense', 0), OPTS), 0)
  })
})

suite('queue — aging prevents starvation', () => {
  // Starvation is the entire problem this package exists to solve, so a priority queue that can
  // starve anything would be self-defeating.
  test('a chore eventually overtakes a fresh migration', () => {
    const q = ordered([w('patient', 'chore', 40), w('fresh', 'migration', 0)], OPTS)
    assert.equal(q[0].holder, 'patient', '40m of waiting must beat a brand-new migration')
  })

  test('but not immediately — claims still decide the normal case', () => {
    const q = ordered([w('patient', 'chore', 5), w('fresh', 'migration', 0)], OPTS)
    assert.equal(q[0].holder, 'fresh')
  })

  test('agingPerMinute: 0 gives strict priority, and can starve — documented, not accidental', () => {
    const strict = { ...OPTS, agingPerMinute: 0 }
    const q = ordered([w('patient', 'chore', 600), w('fresh', 'migration', 0)], strict)
    assert.equal(q[0].holder, 'fresh')
  })
})

suite('queue — pruning drops the ABSENT, never the PATIENT', () => {
  // THE BUG THIS FILE SHIPPED. Pruning on `at` deleted anything waiting longer than the stale
  // window, so the longer you waited the likelier you were silently removed — and the symptom was
  // a change that simply sat there while everyone assumed it was queued. `at` is when you joined
  // and drives aging; `seen` is your last check-in and drives pruning. Different facts.
  test('a LONG-WAITING but recently-seen waiter is KEPT', () => {
    const kept = prune([w('patient', 'chore', 120, 0)], STALE)
    assert.equal(kept.length, 1, 'waiting two hours must not remove you from the queue')
  })

  test('a waiter that has gone quiet is dropped', () => {
    const kept = prune([w('gone', 'fix', 120, 99)], STALE)
    assert.equal(kept.length, 0)
  })

  test('a waiter with no `seen` at all falls back to `at`', () => {
    assert.equal(prune([{ holder: 'old', at: ago(99) }], STALE).length, 0)
    assert.equal(prune([{ holder: 'new', at: ago(1) }], STALE).length, 1)
  })
})

suite('queue — enqueue keeps earned position', () => {
  test('re-enqueueing refreshes `seen` but NOT `at`', () => {
    // Otherwise an agent polling to ask "am I next yet?" would reset its own priority to zero
    // every time it checked — punished for being patient.
    const start = ago(30)
    const q = enqueue([{ holder: 'a', id: '1', at: start, seen: ago(5), claim: 'chore' }], {
      holder: 'a',
      id: '1',
      at: ago(0),
      claim: 'chore',
    })
    assert.equal(q[0].at, start, '`at` must survive a refresh')
    assert.ok(Date.parse(q[0].seen) > Date.parse(ago(1)), '`seen` must be refreshed')
  })

  test('a new waiter gets a `seen` even if none was supplied', () => {
    const q = enqueue([], { holder: 'a', id: '1', at: ago(0) })
    assert.ok(q[0].seen)
  })

  test('the same agent is not queued twice', () => {
    let q = enqueue([], { holder: 'a', id: '1', at: ago(0) })
    q = enqueue(q, { holder: 'a', id: '1', at: ago(0) })
    assert.equal(q.length, 1)
  })

  test('dequeue removes by id', () => {
    const q = dequeue([w('a', 'fix', 1), w('b', 'fix', 1)], { holder: 'a', id: 'a' })
    assert.deepEqual(q.map((x) => x.holder), ['b'])
  })

  test('isNext is true for an empty queue', () => {
    assert.equal(isNext([], { holder: 'a', id: '1' }, OPTS), true)
  })
})

suite('merge slot — queue integration', () => {
  let dir, file
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'awq-'))
    file = join(dir, 'slot.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const read = () => JSON.parse(readFileSync(file, 'utf8'))

  test('a refused take ENQUEUES rather than just failing', () => {
    take(file, { who: 'a', id: '1', claim: 'migration', staleMinutes: STALE, queueOpts: OPTS })
    const r = take(file, { who: 'b', id: '2', claim: 'chore', staleMinutes: STALE, queueOpts: OPTS })
    assert.equal(r.ok, false)
    assert.equal(r.queue.length, 1)
    assert.equal(read().waiting[0].holder, 'b')
  })

  test('a FREE slot is still refused if someone waiting outranks you', () => {
    // Otherwise the queue is decorative: whoever happens to poll at the right moment wins,
    // which is the race this replaces.
    take(file, { who: 'a', id: '1', staleMinutes: STALE, queueOpts: OPTS })
    take(file, { who: 'big', id: '2', claim: 'migration', staleMinutes: STALE, queueOpts: OPTS })
    release(file, { who: 'a', id: '1', staleMinutes: STALE })

    const small = take(file, { who: 'small', id: '3', claim: 'chore', staleMinutes: STALE, queueOpts: OPTS })
    assert.equal(small.ok, false, 'a chore must not jump a waiting migration')

    const big = take(file, { who: 'big', id: '2', claim: 'migration', staleMinutes: STALE, queueOpts: OPTS })
    assert.equal(big.ok, true, 'the highest claim may take the free slot')
  })

  test('release KEEPS the queue and names who is next', () => {
    take(file, { who: 'a', id: '1', staleMinutes: STALE, queueOpts: OPTS })
    take(file, { who: 'b', id: '2', claim: 'fix', staleMinutes: STALE, queueOpts: OPTS })
    const r = release(file, { who: 'a', id: '1', staleMinutes: STALE })
    assert.equal(r.ok, true)
    assert.equal(r.next.holder, 'b')
    assert.equal(read().waiting.length, 1, 'releasing must not disband the queue')
  })

  test('release with nobody waiting removes the file entirely', () => {
    take(file, { who: 'a', id: '1', staleMinutes: STALE, queueOpts: OPTS })
    release(file, { who: 'a', id: '1', staleMinutes: STALE })
    assert.equal(existsSync(file), false)
  })

  test('--force jumps the queue', () => {
    take(file, { who: 'a', id: '1', staleMinutes: STALE, queueOpts: OPTS })
    take(file, { who: 'big', id: '2', claim: 'migration', staleMinutes: STALE, queueOpts: OPTS })
    release(file, { who: 'a', id: '1', staleMinutes: STALE })
    const r = take(file, { who: 'rude', id: '9', claim: 'chore', staleMinutes: STALE, queueOpts: OPTS, force: true })
    assert.equal(r.ok, true)
  })

  test('polling `take` does not reset your own aging', () => {
    take(file, { who: 'a', id: '1', staleMinutes: STALE, queueOpts: OPTS })
    take(file, { who: 'b', id: '2', claim: 'chore', staleMinutes: STALE, queueOpts: OPTS })
    const first = read().waiting[0].at
    take(file, { who: 'b', id: '2', claim: 'chore', staleMinutes: STALE, queueOpts: OPTS })
    assert.equal(read().waiting[0].at, first, 'checking your position must not cost you your place')
  })
})
