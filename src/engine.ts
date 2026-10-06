import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type ConflictStrategy = "last-writer-wins" | "writer-priority" | "manual";

export interface ContextEntry {
  key: string;
  value: string;
  version: number;
  writer: string;
  updatedAt: string;
  checksum: string;
}

export interface HistoryRecord {
  version: number;
  value: string;
  writer: string;
  at: string;
  checksum: string;
}

export interface ConflictRecord {
  key: string;
  strategy: ConflictStrategy;
  local: { version: number; writer: string; updatedAt: string; checksum: string };
  remote: { version: number; writer: string; updatedAt: string; checksum: string };
  winner: "local" | "remote" | "unresolved";
  reason: string;
}

export interface StoreFile {
  format: "agent-context-engine/store";
  version: 1;
  entries: Record<string, ContextEntry>;
  history: Record<string, HistoryRecord[]>;
  conflicts: ConflictRecord[];
}

export interface VerifyReport {
  ok: boolean;
  checked: number;
  errors: string[];
}

export interface MergeResult {
  conflicts: ConflictRecord[];
  adopted: number;
  updated: number;
  untouched: number;
}

export class ContextError extends Error {}

function checksumOf(key: string, version: number, writer: string, value: string, at: string): string {
  return createHash("sha256").update(`${key}\u0000${version}\u0000${writer}\u0000${at}\u0000${value}`).digest("hex");
}

function isValidTimestamp(at: string): boolean {
  return !Number.isNaN(Date.parse(at));
}

export class ContextEngine {
  private entries: Map<string, ContextEntry>;
  private history: Map<string, HistoryRecord[]>;
  private conflicts: ConflictRecord[];

  constructor(store?: Partial<StoreFile>) {
    this.entries = new Map(Object.entries(store?.entries ?? {}));
    this.history = new Map(Object.entries(store?.history ?? {}));
    this.conflicts = store?.conflicts ? [...store.conflicts] : [];
  }

  static empty(): ContextEngine {
    return new ContextEngine();
  }

  static load(path: string): ContextEngine {
    if (!existsSync(path)) {
      throw new ContextError(`store file not found: ${path}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf-8"));
    } catch (err) {
      throw new ContextError(`store file is not valid JSON: ${path} (${(err as Error).message})`);
    }
    const store = raw as StoreFile;
    if (store?.format !== "agent-context-engine/store" || store?.version !== 1) {
      throw new ContextError(`not an agent-context-engine store (bad format/version): ${path}`);
    }
    return new ContextEngine(store);
  }

  toStore(): StoreFile {
    return {
      format: "agent-context-engine/store",
      version: 1,
      entries: Object.fromEntries(this.entries),
      history: Object.fromEntries(this.history),
      conflicts: this.conflicts,
    };
  }

  save(path: string): void {
    writeFileSync(path, `${JSON.stringify(this.toStore(), null, 2)}\n`, "utf-8");
  }

  set(key: string, value: string, writer: string, at: string = new Date().toISOString()): ContextEntry {
    if (!key.trim()) throw new ContextError("key must be a non-empty string");
    if (!writer.trim()) throw new ContextError("writer (agent id) must be a non-empty string");
    if (!isValidTimestamp(at)) throw new ContextError(`invalid timestamp: ${at}`);

    const current = this.entries.get(key);
    const version = (current?.version ?? 0) + 1;
    const entry: ContextEntry = {
      key,
      value,
      version,
      writer,
      updatedAt: at,
      checksum: checksumOf(key, version, writer, value, at),
    };
    this.entries.set(key, entry);

    const log = this.history.get(key) ?? [];
    log.push({ version, value, writer, at, checksum: entry.checksum });
    this.history.set(key, log);
    return entry;
  }

  get(key: string): ContextEntry {
    const entry = this.entries.get(key);
    if (!entry) throw new ContextError(`key not found: ${key}`);
    return entry;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  list(): ContextEntry[] {
    return [...this.entries.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  historyFor(key: string): HistoryRecord[] {
    if (!this.has(key)) throw new ContextError(`key not found: ${key}`);
    return [...(this.history.get(key) ?? [])].sort((a, b) => b.version - a.version);
  }

  rollback(key: string, toVersion: number, writer: string, at: string = new Date().toISOString()): ContextEntry {
    const log = this.historyFor(key);
    const target = log.find((r) => r.version === toVersion);
    if (!target) {
      const known = log.map((r) => r.version).join(", ") || "none";
      throw new ContextError(`version ${toVersion} not found for key ${key} (known versions: ${known})`);
    }
    return this.set(key, target.value, writer, at);
  }

  verify(): VerifyReport {
    const errors: string[] = [];
    let checked = 0;
    for (const entry of this.entries.values()) {
      checked += 1;
      const expected = checksumOf(entry.key, entry.version, entry.writer, entry.value, entry.updatedAt);
      if (expected !== entry.checksum) {
        errors.push(`entry ${entry.key}: checksum mismatch (expected ${expected}, stored ${entry.checksum})`);
      }
      const log = this.history.get(entry.key) ?? [];
      const latest = log.reduce((max, r) => Math.max(max, r.version), 0);
      if (latest !== entry.version) {
        errors.push(`entry ${entry.key}: version ${entry.version} does not match history head ${latest}`);
      }
      for (const record of log) {
        checked += 1;
        const recordChecksum = checksumOf(entry.key, record.version, record.writer, record.value, record.at);
        if (recordChecksum !== record.checksum) {
          errors.push(`history ${entry.key}@${record.version}: checksum mismatch`);
        }
      }
    }
    return { ok: errors.length === 0, checked, errors };
  }

  stats(): { keys: number; historyRecords: number; conflicts: number; writers: string[] } {
    const writers = new Set<string>();
    for (const entry of this.entries.values()) writers.add(entry.writer);
    for (const log of this.history.values()) for (const record of log) writers.add(record.writer);
    const historyRecords = [...this.history.values()].reduce((sum, log) => sum + log.length, 0);
    return {
      keys: this.entries.size,
      historyRecords,
      conflicts: this.conflicts.length,
      writers: [...writers].sort(),
    };
  }

  conflictLog(): ConflictRecord[] {
    return [...this.conflicts];
  }

  private static rank(entry: ContextEntry): [string, string, string, string] {
    // Direction-independent ranking: only content properties, so that
    // A merging B picks the same winner as B merging A.
    return [entry.updatedAt, entry.writer, entry.value, entry.checksum];
  }

  private static prefer(local: ContextEntry, remote: ContextEntry): "local" | "remote" {
    const l = ContextEngine.rank(local);
    const r = ContextEngine.rank(remote);
    for (let i = 0; i < l.length; i += 1) {
      if (l[i] > r[i]) return "local";
      if (l[i] < r[i]) return "remote";
    }
    return "local";
  }

  private static describe(local: ContextEntry, remote: ContextEntry, winner: "local" | "remote"): string {
    if (local.updatedAt !== remote.updatedAt) {
      return `last-writer-wins by updatedAt (${(winner === "local" ? local : remote).updatedAt})`;
    }
    if (local.writer !== remote.writer) {
      return `tie on updatedAt, lexicographic writer wins (${(winner === "local" ? local : remote).writer})`;
    }
    if (local.value !== remote.value) {
      return "tie on updatedAt+writer, lexicographic value wins";
    }
    return "full tie, checksum tiebreak";
  }

  merge(remote: ContextEngine, strategy: ConflictStrategy = "last-writer-wins", at?: string): MergeResult {
    if (at !== undefined && !isValidTimestamp(at)) throw new ContextError(`invalid timestamp: ${at}`);
    const result: MergeResult = { conflicts: [], adopted: 0, updated: 0, untouched: 0 };

    const keys = new Set<string>([...this.entries.keys(), ...remote.entries.keys()]);

    for (const key of [...keys].sort()) {
      const local = this.entries.get(key);
      const peer = remote.entries.get(key);

      if (!peer) {
        result.untouched += 1;
        continue;
      }
      if (!local) {
        this.adoptKey(key, peer, remote);
        result.adopted += 1;
        continue;
      }
      if (local.checksum === peer.checksum) {
        this.unionHistory(key, remote);
        result.untouched += 1;
        continue;
      }      if (
        local.writer === peer.writer &&
        local.updatedAt === peer.updatedAt &&
        local.value === peer.value
      ) {
        // Both lineages carry the same content for this key (the entry
        // checksums differ only because one side was canonically re-versioned
        // by an earlier merge): the stores have already converged, so there is
        // no conflict to record. Re-running sync stays idempotent.
        this.unionHistory(key, remote, true);
        this.alignToHead(key);
        result.untouched += 1;
        continue;
      }

      let winner: "local" | "remote";
      let reason: string;
      if (strategy === "writer-priority") {
        winner = local.writer >= peer.writer ? "local" : "remote";
        reason = `writer-priority (${(winner === "local" ? local : peer).writer} > ${(winner === "local" ? peer : local).writer})`;
      } else if (strategy === "manual") {
        winner = "local";
        reason = "manual strategy: conflict left unresolved, local kept";
      } else {
        winner = ContextEngine.prefer(local, peer);
        reason = ContextEngine.describe(local, peer, winner);
      }

      const record: ConflictRecord = {
        key,
        strategy,
        local: { version: local.version, writer: local.writer, updatedAt: local.updatedAt, checksum: local.checksum },
        remote: { version: peer.version, writer: peer.writer, updatedAt: peer.updatedAt, checksum: peer.checksum },
        winner: strategy === "manual" ? "unresolved" : winner,
        reason,
      };
      this.conflicts.push(record);
      result.conflicts.push(record);

      if (strategy !== "manual" && winner === "remote") {
        this.entries.set(key, { ...peer });
        result.updated += 1;
      } else if (winner === "local") {
        result.untouched += 1;
      }

      this.unionHistory(key, remote, true);
      this.alignToHead(key);
    }

    void at;
    return result;
  }

  private adoptKey(key: string, entry: ContextEntry, remote: ContextEngine): void {
    this.entries.set(key, { ...entry });
    const remoteLog = remote.history.get(key) ?? [];
    this.history.set(
      key,
      remoteLog.map((r) => ({ ...r })).sort((a, b) => a.version - b.version),
    );
  }

  /**
   * Union both sides' history for a key.
   *
   * canonical=false (non-divergent keys): keep every record, renumbering only
   * same-version collisions, with checksums recomputed for moved records.
   *
   * canonical=true (divergent keys): the two lineages share no trustworthy
   * version numbering, so the union is re-versioned deterministically —
   * sorted by (at, writer, value) and numbered 1..n. This makes merges
   * converge: A merging B produces exactly the same history as B merging A.
   */
  private unionHistory(key: string, remote: ContextEngine, canonical: boolean = false): void {
    if (canonical) {
      const byIdentity = new Map<string, HistoryRecord>();
      const collect = (log: HistoryRecord[]): void => {
        for (const record of log) {
          const id = `${record.at}\u0000${record.writer}\u0000${record.value}`;
          if (!byIdentity.has(id)) byIdentity.set(id, { ...record });
        }
      };
      collect(this.history.get(key) ?? []);
      collect(remote.history.get(key) ?? []);
      const ordered = [...byIdentity.values()].sort((a, b) =>
        a.at < b.at ? -1 : a.at > b.at ? 1 : a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0,
      );
      this.history.set(
        key,
        ordered.map((record, i) => {
          const version = i + 1;
          return { version, value: record.value, writer: record.writer, at: record.at, checksum: checksumOf(key, version, record.writer, record.value, record.at) };
        }),
      );
      return;
    }

    const merged = new Map<number, HistoryRecord>();
    for (const record of this.history.get(key) ?? []) merged.set(record.version, { ...record });
    const head = (): number => Math.max(0, ...[...merged.keys()]);
    for (const record of remote.history.get(key) ?? []) {
      const existing = merged.get(record.version);
      if (!existing) {
        merged.set(record.version, { ...record });
      } else if (existing.checksum !== record.checksum) {
        const version = head() + 1;
        merged.set(version, { version, value: record.value, writer: record.writer, at: record.at, checksum: checksumOf(key, version, record.writer, record.value, record.at) });
      }
    }
    this.history.set(
      key,
      [...merged.values()].sort((a, b) => a.version - b.version),
    );
  }

  private alignToHead(key: string): void {
    const log = this.history.get(key) ?? [];
    const head = log.reduce((max, r) => Math.max(max, r.version), 0);
    const entry = this.entries.get(key);
    if (!entry || entry.version === head) return;
    this.entries.set(key, {
      key,
      value: entry.value,
      version: head,
      writer: entry.writer,
      updatedAt: entry.updatedAt,
      checksum: checksumOf(key, head, entry.writer, entry.value, entry.updatedAt),
    });
  }
}
