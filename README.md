# agent-worktree

**Coordination primitives for running several coding agents on one repository.**

Zero dependencies. Node ≥ 20. Three tools, ~350 lines. Nothing runs in the cloud, nothing phones home, nothing touches your code.

```bash
npx agent-worktree slot            # which slot this worktree owns
npx agent-worktree ports --print   # this worktree's dev-server ports
npx agent-worktree merge status    # who is merging right now
```

---

## Why this exists

We ran six or seven Claude Code sessions against one repository for a day. They were productive. They also collided in ways that were individually small, collectively expensive, and — this is the part worth your attention — **almost all invisible at the moment they happened.**

Everything below actually happened. The tools are the fixes.

### 1. The dev server that wasn't yours

Two agents start the same app. Both want port 5174. Vite's default is the dangerous one: no `strictPort`, so the second **silently** takes 5175 — which is another app's port.

An agent then spent an hour verifying a change against a server that belonged to a different worktree, on a different branch, and nearly "fixed" code that was already working. The component it was looking for was correctly absent.

The tool reporting *"server started"* is not evidence the server is yours.

> **`agent-worktree ports`** — derives a deterministic slot from the worktree path and offsets every service by it. Same directory, same ports, every time, so a URL written into a `.env` keeps working. Set `strictPort` too: a collision should fail loudly rather than drift onto a neighbour's port.

### 2. The stride that ate the database

The first version of that port allocator used a stride of 10. With our base ports, slot 26's app server landed on slot 1's **Postgres**. The comment above the constant asserted the bands were disjoint. The comment was wrong.

> **`ports --verify`** — brute-forces every (slot × service) pair, including bands owned by docker-compose, and fails if any two want the same port. It runs in CI. *A comment asserting non-collision is worth nothing; a loop proving it is worth something.*

### 3. Merging starves, and it looks like bad luck

With seven agents and a five-minute CI, **"not behind the base branch AND green" is only satisfiable in the gaps between other merges.** You push, CI runs, someone lands during it, and your green result no longer proves anything about the branch you're merging into. Rebase, repeat.

Four agents burned three to four cycles each in one evening. **Most resolved no real conflict** — the commits touched different files entirely.

The exception is the one that proves the cost. Two migrations rebasing past each other conflict in the journal, in the lane file, and — invisibly — in the schema snapshot chain, where a *green* rebase can still leave two snapshots claiming the same parent. No conflict marker, no failing test, and the rebase does not fix it. So: rebasing behind another agent is usually pure waste, and occasionally the only thing standing between you and a corrupted schema history. **Do the post-rebase check anyway.**

Two properties make this worth a mechanism rather than discipline:

- **It presents as bad luck, not contention.** So the instinct is to retry, which is precisely the behaviour that sustains it.
- **The cost is not evenly spread.** A bigger diff and a slower CI mean a wider window for someone to slip in — so *the change that most needs careful review is the one most likely to be starved.*

> **`agent-worktree merge take <id>`** — one agent merges at a time. Take it **before the CI run you don't want to lose**, not before the merge. That's where the race is actually lost.

Before we had the tool, simply *asking* — "I'm merging, hold off six minutes" — went five for five in one evening, each after multiple failed attempts.

### 4. A prompt is a hang, when nobody is at the keyboard

A schema tool in our pipeline asks an interactive question in one specific case — whether two column changes are really a rename. It has no non-interactive flag, doesn't take an answer on stdin, and can't be driven through a pty. For a person that is a two-second keystroke. For an unattended agent it is **a hang with no error**: the process simply stops, holding whatever it was holding, reporting nothing, until something else times out or a human wanders past.

This is worth separating from the other failures here because it is not a collision at all — one agent alone hits it. But it belongs on the same list, because *the consequences are multiplied by running unattended*, and because the fix is the same shape as `merge wait`:

> **The hang is not the problem. The absence of any signal that you are waiting is the problem.**

That reframing is the useful part, and it generalises well past schema tools. Anything an agent shells out to can block forever; what makes it survivable is emitting *something* — a position, an elapsed time, a reason — on a regular tick. Which is exactly why `merge wait` prints its position rather than sitting silent, and why a guard that cannot evaluate its subject should say so loudly rather than stall.

**When you write a tool agents will call, assume nobody is watching it.** A prompt, a confirmation, a "press any key" is a deadlock in that world. If you must ask something, fail with the question in the error text instead.

Be precise about what that evidence shows, though, because it is easy to overclaim. Those were **negotiations, not rankings**: someone explained why their change should go first and someone else agreed to wait. What it demonstrates is that the judgement was consistent and that yielding worked — not that a rule was being applied mechanically. The queue automates a judgement humans were making by talking, which is why claims carry a note, why `status` shows it, and why `--force` always wins.

---

## What it does not do

**It coordinates agents that share a filesystem. It cannot see anyone pushing from another machine.**

That's usually the right trade: co-located agents collide many times an hour, humans on their own machines rarely do. If you need cross-machine serialisation you need a real merge queue — GitHub's, Mergify, Graphite, Trunk. Note that GitHub's own merge queue requires Enterprise Cloud for *private* repositories, which is what pushed us to build this instead.

**The cheapest partial answer, which needs no tooling at all: push your branch at the first commit, not when the work is finished.** A pushed branch is visible to everyone via `git ls-remote --heads origin` whether or not a pull request exists; unpushed work is invisible to every check anyone can run, on any machine. It also buys you *review* before you land rather than merely avoiding a collision.

It does **not** close the gap — a branch pushed after someone looks is still invisible, and this tool still cannot see another machine's merge. Treat it as narrowing the window, not shutting it.

**It is not a safety mechanism.** Holding the merge slot says nothing about whether your change is correct, your CI actually ran, or a deploy is in flight. Keep your own pre-merge checks. This only decides who goes first.

---

## Install

```bash
npm install --save-dev agent-worktree
```

`slot` and `merge` need no configuration. `ports` needs to know what your services are called — copy `agent-worktree.config.example.json` to `agent-worktree.config.json` at your repo root:

```json
{
  "services": { "api": 3001, "web": 5174, "admin": 5175 },
  "reserved": { "postgres": 5433, "redis": 6381 },
  "stride": 6,
  "env": { "VITE_API_URL": "http://localhost:${port:api}" }
}
```

- **`services`** — name → base port. Slot 0 (your main checkout) gets exactly these, so anyone ignoring all of this sees no change.
- **`reserved`** — bands something else owns (a compose Postgres) that advance by 1 per slot. Not offset, but `--verify` ensures nothing lands on them.
- **`stride`** — spacing between slots. Must exceed the largest gap between two base ports. Run `--verify` rather than reasoning about it.
- **`env`** — the valuable part. Cross-references so your apps find **this** worktree's siblings rather than a neighbour's. `${port:name}` and `${slot}` interpolate.

Then:

```bash
npx agent-worktree ports -- npm run dev
npx agent-worktree ports --verify     # in CI
```

## Merge queue — ordered by claim, not arrival

```bash
npx agent-worktree merge take 543 --claim migration --note "holds the lane"
npx agent-worktree merge wait 546 --claim chore && ./merge.sh    # blocks until your turn
npx agent-worktree merge status --watch
npx agent-worktree merge release 543
```

```
  MERGE SLOT — your-repo

  ●  agent-a        543      holding   6m
     holds the migration lane

     ├─ agent-b      546      chore     40m  ← next
        README fix
     ├─ agent-c      550      fix       8m
        prod: payment retry
     └─ agent-d      552      migration 0m
        geofence rule events
```

**Why not FIFO.** This is the design the behaviour taught us, not the one that seemed obvious.
Watching agents negotiate merge windows by hand for a day, priority was never arrival order — it
was the strength of the claim. A change carrying a migration goes first, because every forced
rebase re-parents its schema snapshot and anything needing that lane is blocked behind it. A docs
change goes last, because waiting costs it nothing. FIFO would put a README tweak ahead of a
migration purely because it asked first, which is exactly backwards.

**Aging is not optional.** A plain priority queue starves low-priority work — and starvation is the
entire problem this package exists to solve, so reintroducing it in the fix would be absurd. Every
waiter gains priority as it waits and will eventually outrank anything. With the defaults a
`chore` overtakes a fresh `migration` after about 25 minutes; `merge status --why` shows the
arithmetic. Set `agingPerMinute: 0` for strict priority only if you want that and understand it.

**It orders a conversation, it does not replace one.** The hand negotiation worked partly because
agents could explain themselves — "mine holds the lane, yours is docs" is an argument someone can
disagree with. So claims carry a free-text note, `status` shows it, and `--force` always wins.

**Use `merge wait`, not a poll loop.** Agents reliably join a queue and then never check it again;
the change sits there, the slot frees, nobody notices. Polling is something you have to *remember*,
and a coordination step that depends on remembering loses to whatever the agent does next.
`merge wait` blocks and returns when it is your turn, refreshing your place the whole time.

Wrap it around whatever you already use to merge. The slot is a JSON file in `$HOME`, namespaced per project.

**It degrades rather than stopping the line.** A slot auto-expires after `staleMinutes` (default 15), because an agent that crashed mid-merge must not wedge everyone until a human notices — and a stale steal announces itself loudly rather than silently. An unreadable slot file **warns and proceeds**: failing to coordinate costs a rebase, while failing to merge costs the work.

**A guard that is quietly wrong gets ignored; one that is loudly wrong gets obeyed.** Worth holding onto when you write the confident refusals a tool like this is made of. We had a checker report *"215 migrations have no row and can never apply here"* — categorical, specific, and wrong, because it compared a live database against a stale working tree. Its author acted on it and nearly blocked a colleague's correct repair. The underlying mistake was ordinary, reading the wrong index; what made it expensive was the register it spoke in. **Every message here that refuses something is also an instruction someone will follow, so say what was actually checked, and be loudest about what you could not see.**

**Identity is by task id first, name second.** One change has one author working it, so a slot recording the id you're acting on is yours by construction. This matters because names aren't stable — see below.

---

## The bug this shipped with, and what it taught us

The first version identified slot holders by name, falling back to a per-process id when none was given. That fallback meant a tool invoked twice couldn't recognise a slot **its own session** had taken a minute earlier. It refused with:

```
✖ MERGE SLOT IS TAKEN — agent-a — 6m ago
```

You, blocking yourself, with a message that reads exactly like a colleague blocking you.

It survived review because **all ten tests passed an explicit name, so the fallback never executed once.** The feature was tested; the default was not.

That is the same shape as three other defects we found the same day — in a snapshot checker, a deploy-detection routine, and a CI guard. In every case someone verified the mechanism they were *thinking about* rather than the path the code actually takes. The general form, which we now say out loud:

> **A lookup answers its own question correctly and your question wrongly, and nothing complains.**

`test/merge-slot.test.mjs` therefore tests the no-name path explicitly, *and* the counter-case — because a "fix" that treated every slot as yours would pass the regression test while rendering the whole thing useless.

**Writing the queue found two more of exactly the same shape**, both of which made changes silently sit there — the symptom that prompted the queue in the first place:

- **Pruning dropped the patient, not the absent.** Waiters older than the stale window were deleted, so *the longer you waited the likelier you were removed*, with nothing reporting it. `at` (when you joined, drives aging) and `seen` (last check-in, drives pruning) are different facts, and conflating them inverted the entire point.
- **A queue-only state read as empty.** `readSlot` required a `holder`, which was right when the file only ever recorded one. Once releasing leaves waiters behind, the whole queue vanished the instant the slot was handed over — and the next agent was told it was free and jumped everyone.

The second was caught by a test asserting a chore cannot jump a waiting migration. Neither would have been visible in normal use until someone noticed their work had quietly stopped being in line.

---

## Contributing

Issues and PRs welcome, particularly:

- **Does this match your collisions?** The failure list above is from one team's setup. If yours differ we'd rather know than guess.
- Cross-machine coordination that isn't a full merge queue.
- Adapters for agent runners other than Claude Code.

## Licence

MIT — see [LICENSE](LICENSE). Provided as is, with no warranty. Built by [2QuipAI](https://github.com/2Quip).
