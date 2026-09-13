import assert from 'node:assert/strict'
import { describe as suite, test } from 'node:test'
import { interpolate } from '../src/config.mjs'
import { portEnv, verify } from '../src/ports.mjs'

const cfg = {
  services: { api: 3001, web: 5174, admin: 5175 },
  reserved: { postgres: 5433, redis: 6381 },
  stride: 6,
  spread: 40,
  env: { API_URL: 'http://localhost:${port:api}', SLOT: '${slot}' },
}

suite('ports', () => {
  test('slot 0 is exactly the configured base ports', () => {
    const { env } = portEnv(cfg, { offset: 0 })
    assert.equal(env.PORT_API, '3001')
    assert.equal(env.PORT_WEB, '5174')
  })

  test('each slot shifts every service by the stride', () => {
    const { env } = portEnv(cfg, { offset: 3 })
    assert.equal(env.PORT_API, String(3001 + 18))
    assert.equal(env.PORT_WEB, String(5174 + 18))
  })

  test('cross-references interpolate to THIS worktree, not a neighbour', () => {
    const { env } = portEnv(cfg, { offset: 2 })
    assert.equal(env.API_URL, `http://localhost:${3001 + 12}`)
    assert.equal(env.SLOT, '2')
  })

  test('verify passes for a sane layout', () => {
    assert.equal(verify(cfg).ok, true)
  })

  // THE COLLISION THAT ACTUALLY HAPPENED. A stride of 10 with these bases puts a high slot's app
  // server onto a low slot's database port — the bands overlap, and the comment claiming they did
  // not was simply wrong. This is why the check is brute force rather than an assertion in prose.
  test('verify CATCHES a stride that overruns a reserved band', () => {
    const bad = { ...cfg, stride: 10 }
    const r = verify(bad)
    assert.equal(r.ok, false, 'stride 10 must be reported as colliding')
    assert.ok(r.port >= 5433, `expected a collision in the reserved band, got ${r.port}`)
  })

  // Within a band: for bases b1 < b2, slot k+1's b1 must not equal slot k's b2 — i.e. no two
  // bases may differ by exactly the stride.
  test('verify CATCHES two services exactly one stride apart', () => {
    const bad = { services: { a: 3000, b: 3006 }, reserved: {}, stride: 6, spread: 10 }
    assert.equal(verify(bad).ok, false)
  })

  test('stride 1 with adjacent bases collides and is caught', () => {
    const bad = { services: { a: 3000, b: 3001 }, reserved: {}, stride: 1, spread: 5 }
    assert.equal(verify(bad).ok, false)
  })

  test('interpolate rejects an unknown service rather than emitting undefined', () => {
    assert.throws(
      () => interpolate('${port:nope}', { port: () => null, slot: 0 }),
      /unknown service "nope"/,
    )
  })

  test('service names become valid env var names', () => {
    const { env } = portEnv(
      { ...cfg, services: { 'my-app': 4000 }, env: {} },
      { offset: 0 },
    )
    assert.equal(env.PORT_MY_APP, '4000')
  })
})

// FOUND BY RUNNING THE SHIPPED EXAMPLE CONFIG, which crashed: `${port:postgres}` names a RESERVED
// band, not a service, and the resolver only looked at `services`. The most valuable env var most
// projects write is a DATABASE_URL pointing at their own worktree's database — so the very first
// thing a new user copies hit the one unhandled case. The default path again.
suite('ports — reserved bands', () => {
  test('interpolation resolves a RESERVED band, advancing by 1 per slot', () => {
    const { env } = portEnv(
      { ...cfg, env: { DATABASE_URL: 'postgres://localhost:${port:postgres}/app' } },
      { offset: 4 },
    )
    assert.equal(env.DATABASE_URL, `postgres://localhost:${5433 + 4}/app`)
  })

  test('reserved bands get NO PORT_* var — something else owns them', () => {
    const { env } = portEnv(cfg, { offset: 1 })
    assert.equal(env.PORT_POSTGRES, undefined)
    assert.equal(env.PORT_API, String(3001 + 6))
  })

  test('a genuinely unknown name still throws rather than emitting undefined', () => {
    assert.throws(
      () => portEnv({ ...cfg, env: { X: '${port:nope}' } }, { offset: 0 }),
      /unknown service "nope"/,
    )
  })
})
