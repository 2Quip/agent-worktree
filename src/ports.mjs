/**
 * Run dev servers on ports that belong to THIS worktree, and make them point at each other.
 *
 * THE FAILURE THIS PREVENTS. Several agents work one repo at once and every app has a fixed port.
 * Two dev servers both want 5174, and the common default is the dangerous one: without
 * `strictPort`, the second SILENTLY takes 5175 — which is another app's port. You then open 5174,
 * see the app you expected, and it is somebody else's branch.
 *
 * That is not hypothetical. It cost an hour of verifying a change against another worktree's
 * server, and nearly a "fix" to code that was already working. A tool reporting "server started"
 * is not proof the server is yours.
 *
 * Set `strictPort: true` (or your framework's equivalent) in your dev server config as well, so a
 * collision FAILS LOUDLY instead of drifting onto a neighbour's port. That failure is the feature.
 */
import { execFileSync } from 'node:child_process'
import { interpolate } from './config.mjs'
import { worktreeSlot } from './worktree-slot.mjs'

/**
 * Brute-force proof that no two (slot, service) pairs ever want the same port, including bands
 * owned by something else.
 *
 * THIS EXISTS BECAUSE A COMMENT ASSERTING IT WAS WRONG. The original used a stride that put slot
 * 26's app server on slot 1's database port — the bands overlapped and the comment said they did
 * not. Run it in CI; it is milliseconds.
 *
 * @returns {{ ok: true, checked: number } | { ok: false, port: number, a: string, b: string }}
 */
export function verify({ services, reserved, stride, spread }) {
  const taken = new Map()
  for (let slot = 0; slot <= spread; slot++) {
    for (const [name, base] of Object.entries(services)) {
      const p = base + slot * stride
      if (taken.has(p)) return { ok: false, port: p, a: taken.get(p), b: `${name}@slot${slot}` }
      taken.set(p, `${name}@slot${slot}`)
    }
    // Reserved bands advance by 1 per slot, matching the usual docker-compose pattern.
    for (const [name, base] of Object.entries(reserved)) {
      const p = base + slot
      if (taken.has(p)) return { ok: false, port: p, a: taken.get(p), b: `${name}@slot${slot}` }
      taken.set(p, `${name}@slot${slot}`)
    }
  }
  return { ok: true, checked: taken.size }
}

/** The env this worktree's servers should run under. */
export function portEnv(config, { offset }) {
  /**
   * Resolves BOTH maps, because the most valuable env var most projects write is a DATABASE_URL
   * pointing at this worktree's own database — and that lives in `reserved`, not `services`.
   * Reserved bands advance by 1 per slot (the docker-compose convention); services advance by the
   * stride. Getting this wrong is invisible: you get a URL for a neighbour's database.
   */
  const port = (name) => {
    if (config.services[name] != null) return config.services[name] + offset * config.stride
    if (config.reserved?.[name] != null) return config.reserved[name] + offset
    return null
  }

  const env = {}
  // Only `services` get a PORT_* var — a reserved band is owned by something else, which is
  // already deciding how it is addressed.
  for (const name of Object.keys(config.services)) {
    env[`PORT_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = String(port(name))
  }
  for (const [key, value] of Object.entries(config.env)) {
    env[key] = interpolate(value, { port, slot: offset })
  }
  return { env, port }
}

export function runPorts(config, argv) {
  if (argv.includes('--verify')) {
    const r = verify(config)
    if (!r.ok) {
      console.error(`\n✖ port ${r.port} is claimed by BOTH ${r.a} and ${r.b}\n`)
      console.error(`  Adjust "stride" or your base ports in agent-worktree.config.json.\n`)
      process.exit(1)
    }
    console.log(`\n✔ ports are collision-free — ${r.checked} distinct ports\n`)
    return
  }

  if (Object.keys(config.services).length === 0) {
    console.error(`\n✖ no services configured.\n`)
    console.error(`  Add a "services" map to agent-worktree.config.json, for example:\n`)
    console.error(`      { "services": { "api": 3001, "web": 5174 } }\n`)
    process.exit(2)
  }

  const { root, slug, offset, isMain } = worktreeSlot({ spread: config.spread })
  const { env, port } = portEnv(config, { offset })

  const sep = argv.indexOf('--')
  const command = sep === -1 ? [] : argv.slice(sep + 1)

  if (argv.includes('--print') || command.length === 0) {
    const names = Object.keys(config.services)
    const w = Math.max(...names.map((n) => n.length))
    console.log(`
  worktree   ${root}${isMain ? '  (main checkout — base ports, unchanged)' : ''}
  slot       ${offset}${isMain ? '' : `  (${slug})`}

${names
  .map(
    (n) =>
      `    ${n.padEnd(w)}  ${String(port(n)).padEnd(6)}${isMain ? '' : `(base ${config.services[n]})`}`,
  )
  .join('\n')}
${
  Object.keys(config.env).length
    ? `\n${Object.entries(env)
        .filter(([k]) => !k.startsWith('PORT_'))
        .map(([k, v]) => `    ${k}=${v}`)
        .join('\n')}\n`
    : ''
}
  Run anything under these:

    npx agent-worktree ports -- <your dev command>
`)
    if (command.length === 0) return
  }

  execFileSync(command[0], command.slice(1), {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, ...env },
  })
}
