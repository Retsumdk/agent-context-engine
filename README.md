# agent-context-engine

A versioned, file-backed context store for distributed agents — conflict resolution, versioning, synchronization, and checksum integrity in a single zero-config CLI and library.

## The problem

When multiple agents share working context, three failure modes show up immediately:

1. **Silent overwrites** — agent B writes `plan` and clobbers agent A's version. Nobody notices until the plan is wrong.
2. **No history** — once clobbered, the old value is gone. You can't audit what an agent believed and when.
3. **Unmergeable state** — two agents that worked offline (or on replicas) hold divergent copies of the same keys, and reconciling them means one side's work is thrown away.

General-purpose stores (Redis, SQLite, a shared JSON file) solve storage but none of the semantics: they have no notion of *writer*, no per-key version lineage, and no deterministic way to merge divergent replicas.

## The solution

`agent-context-engine` is a single-purpose store where every write is a **versioned record** attributed to a **writer** (agent id), timestamped, and protected by a **SHA-256 checksum**. Divergent replicas are reconciled by a deterministic merge with selectable conflict strategies, and the merge is **convergent**: `A ⊕ B` produces exactly the same store as `B ⊕ A`, so replicas only need to sync pairwise — no coordinator, no clock, no network.

State lives in one human-readable JSON file per replica, so it diffs in git, ships in artifacts, and needs no running infrastructure.

## How it works

```
src/
  engine.ts   ContextEngine — entries, per-key version history, conflict log,
              merge (3 strategies), canonical re-versioning, verify()
  index.ts    Commander CLI — set / get / list / history / rollback /
              sync / verify / stats / conflicts
```

- **Every write** appends a `HistoryRecord` (version, value, writer, timestamp, checksum) and updates the current `ContextEntry`. The checksum covers `(key, version, writer, timestamp, value)`, so tampering with any field is detectable by `verify`.
- **Rollback** restores an older version's *content* as a *new* version — history is never rewritten or deleted.
- **Sync** merges a peer store into the local one. Keys only in the peer are adopted; keys whose content checksums agree are left untouched; divergent keys are resolved by the chosen strategy. Both sides' history records are preserved — a merge never destroys the losing side's lineage.
- **Convergence** — after a divergence, the key's history is re-versioned canonically (union of both lineages sorted by `(timestamp, writer, value)`, numbered `1..n`) and the entry is re-aligned to the new head. Because the procedure depends only on record *content*, not on which side did the merging, both replicas converge to byte-identical stores. Re-syncing converged stores is idempotent (0 conflicts).
- **Integrity** — `verify` recomputes every checksum (current entries + history records) and cross-checks each entry against its history head; any mismatch is reported and the process exits `1`, so it drops straight into CI.

## Getting started

```bash
git clone https://github.com/Retsumdk/agent-context-engine.git
cd agent-context-engine
bun install
```

Requires [Bun](https://bun.sh) (or Node ≥ 20 after `bun run build`).

## CLI usage

All commands take a global `--store <path>` (default `context-store.json`) and `--json` for machine-readable output. Writes take `-w/--writer <agent-id>`.

```bash
$ bun run src/index.ts --store demo.json set plan "build the bridge" -w agent-1
[agent-1] plan = "build the bridge" (v1)

$ bun run src/index.ts --store demo.json set plan "build the bridge -- phase 1" -w agent-1
[agent-1] plan = "build the bridge -- phase 1" (v2)

$ bun run src/index.ts --store demo.json --json get plan
{
  "key": "plan",
  "value": "build the bridge -- phase 1",
  "version": 2,
  "writer": "agent-1",
  "updatedAt": "2026-10-06T15:23:31.417Z",
  "checksum": "3f521bd5f3ea03eb91e3cc2938bf4fb32af99e15f16623f9080ad3ab2b87b842"
}

$ bun run src/index.ts --store demo.json history plan
v2  2026-10-06T15:23:31.417Z  agent-1  "build the bridge -- phase 1"
v1  2026-10-06T15:23:31.374Z  agent-1  "build the bridge"

$ bun run src/index.ts --store demo.json rollback plan --to 1 -w agent-1
[agent-1] plan rolled back to v1 content -> now v3

$ bun run src/index.ts --store demo.json verify
OK — 7 record(s) verified

$ bun run src/index.ts --store demo.json stats
keys: 2 | history records: 5 | conflicts on record: 0 | writers: agent-1
```

`verify` exits `1` on any integrity failure, so `verify && deploy` is a valid CI gate. Tamper with a value in the store file and see:

```
FAILED — 1 error(s):
  entry plan: checksum mismatch (expected 3f521b…, stored fefc2d…)
```

### Synchronizing two replicas

Two agents wrote different values for `plan` while partitioned:

```bash
$ bun run src/index.ts --store a.json sync b.json
Synced b.json (strategy: last-writer-wins)
  adopted:  0 key(s) taken from peer
  updated:  1 key(s) overwritten by peer
  conflict: 1 divergence(s) resolved
  unchanged:0 key(s)

$ bun run src/index.ts --store a.json conflicts
plan [last-writer-wins] winner=remote — last-writer-wins by updatedAt (2026-10-06T15:23:35.048Z)
```

The losing side's record stays in history (`history plan` shows both), and syncing the other direction converges with zero further conflicts:

```bash
$ bun run src/index.ts --store b.json sync a.json
Synced a.json (strategy: last-writer-wins)
  adopted:  0 key(s) taken from peer
  updated:  0 key(s) overwritten by peer
  conflict: 0 divergence(s) resolved
  unchanged:1 key(s)
```

`sync` exits `2` when the `manual` strategy leaves divergences unresolved — list them, fix them with explicit `set`s, then re-sync.

### Conflict strategies

| Strategy            | Behavior                                                                 |
|---------------------|--------------------------------------------------------------------------|
| `last-writer-wins`  | Deterministic rank: `(updatedAt, writer, value)` — fully convergent.      |
| `writer-priority`   | Lexicographically greatest writer id wins — useful when agent ids encode trust tiers. |
| `manual`            | Local value kept, divergence logged as `unresolved`, exit code `2`.      |

## Library usage

The engine is importable; the CLI is a thin wrapper over the same API.

```ts
import { ContextEngine } from "agent-context-engine";

const a = ContextEngine.empty();
a.set("plan", "A plan", "agent-A");
a.set("plan", "A plan v2", "agent-A");

const b = ContextEngine.empty();
b.set("plan", "B plan", "agent-B");

const result = a.merge(b, "last-writer-wins");
console.log(result.conflicts.length); // 1 — divergence resolved

const report = a.verify();
console.log(report.ok); // true — all checksums valid

a.save("a.json");           // persist replica A
const loaded = ContextEngine.load("a.json");  // reload, integrity-checked on structure
```

Persistence files have the shape `{ format: "agent-context-engine/store", version: 1, entries, history, conflicts }`; `load` rejects files that don't match.

## Development

```bash
bun install          # install dependencies
bun test             # run the test suite (27 tests)
bun run build        # compile with tsc
bunx tsc --noEmit    # typecheck without emitting
```

## License

MIT — see [LICENSE](LICENSE).
