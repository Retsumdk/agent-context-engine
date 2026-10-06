import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextEngine, ContextError, type StoreFile } from "../src/engine.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ace-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function storePath(name: string): string {
  return join(dir, name);
}

const T1 = "2026-01-01T10:00:00.000Z";
const T2 = "2026-01-02T10:00:00.000Z";
const T3 = "2026-01-03T10:00:00.000Z";

describe("set / get / versioning", () => {
  test("first write creates version 1", () => {
    const e = ContextEngine.empty();
    const entry = e.set("plan", "step A", "agent-1", T1);
    expect(entry.version).toBe(1);
    expect(entry.value).toBe("step A");
    expect(entry.writer).toBe("agent-1");
  });

  test("rewrites increment the version", () => {
    const e = ContextEngine.empty();
    e.set("plan", "step A", "agent-1", T1);
    const second = e.set("plan", "step B", "agent-2", T2);
    expect(second.version).toBe(2);
    expect(e.get("plan").value).toBe("step B");
  });

  test("get throws for missing keys", () => {
    const e = ContextEngine.empty();
    expect(() => e.get("missing")).toThrow(ContextError);
  });

  test("rejects empty key or writer", () => {
    const e = ContextEngine.empty();
    expect(() => e.set("", "v", "agent-1")).toThrow(ContextError);
    expect(() => e.set("k", "v", "  ")).toThrow(ContextError);
  });

  test("rejects invalid timestamps", () => {
    const e = ContextEngine.empty();
    expect(() => e.set("k", "v", "agent-1", "not-a-date")).toThrow(ContextError);
  });
});

describe("history and rollback", () => {
  test("history records every version newest-first", () => {
    const e = ContextEngine.empty();
    e.set("plan", "A", "agent-1", T1);
    e.set("plan", "B", "agent-2", T2);
    const log = e.historyFor("plan");
    expect(log.map((r) => r.version)).toEqual([2, 1]);
    expect(log[0].value).toBe("B");
  });

  test("rollback restores old content as a new version", () => {
    const e = ContextEngine.empty();
    e.set("plan", "A", "agent-1", T1);
    e.set("plan", "B", "agent-1", T2);
    const rolled = e.rollback("plan", 1, "agent-3", T3);
    expect(rolled.value).toBe("A");
    expect(rolled.version).toBe(3);
    expect(e.get("plan").value).toBe("A");
  });

  test("rollback to unknown version fails with known versions listed", () => {
    const e = ContextEngine.empty();
    e.set("k", "A", "agent-1", T1);
    expect(() => e.rollback("k", 9, "agent-1")).toThrow(/known versions: 1/);
  });
});

describe("integrity", () => {
  test("verify passes on a clean store", () => {
    const e = ContextEngine.empty();
    e.set("k", "v", "agent-1", T1);
    e.set("k", "v2", "agent-2", T2);
    e.set("other", "x", "agent-1", T1);
    const report = e.verify();
    expect(report.ok).toBe(true);
    // checked counts every recomputed checksum: 2 entries + 3 history records
    expect(report.checked).toBe(5);
  });

  test("verify detects a tampered value", () => {
    const e = ContextEngine.empty();
    e.set("k", "original", "agent-1", T1);
    const store = e.toStore();
    store.entries["k"].value = "tampered";
    const tampered = new ContextEngine(store);
    const report = tampered.verify();
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/checksum mismatch/);
  });

  test("verify detects a history head mismatch", () => {
    const e = ContextEngine.empty();
    e.set("k", "v", "agent-1", T1);
    const store = e.toStore();
    store.entries["k"].version = 5;
    const bad = new ContextEngine(store);
    expect(bad.verify().ok).toBe(false);
  });
});

describe("persistence", () => {
  test("save + load round-trips without loss", () => {
    const e = ContextEngine.empty();
    e.set("k", "v", "agent-1", T1);
    const path = storePath("store.json");
    e.save(path);
    const loaded = ContextEngine.load(path);
    expect(loaded.get("k").checksum).toBe(e.get("k").checksum);
    expect(loaded.historyFor("k")).toEqual(e.historyFor("k"));
  });

  test("load rejects a file that is not a store", () => {
    const path = storePath("bad.json");
    writeFileSync(path, JSON.stringify({ hello: true }));
    expect(() => ContextEngine.load(path)).toThrow(/bad format/);
  });

  test("load rejects missing and malformed files", () => {
    expect(() => ContextEngine.load(storePath("absent.json"))).toThrow(/not found/);
    const path = storePath("malformed.json");
    writeFileSync(path, "{nope");
    expect(() => ContextEngine.load(path)).toThrow(/not valid JSON/);
  });
});

describe("merge and conflict resolution", () => {
  test("a key present only in the peer store is adopted", () => {
    const local = ContextEngine.empty();
    const remote = ContextEngine.empty();
    remote.set("shared", "from peer", "agent-2", T2);
    const result = local.merge(remote);
    expect(result.adopted).toBe(1);
    expect(local.get("shared").value).toBe("from peer");
  });

  test("identical keys are untouched and recorded as no conflict", () => {
    const local = ContextEngine.empty();
    const remote = ContextEngine.empty();
    local.set("k", "same", "agent-1", T1);
    remote.set("k", "same", "agent-1", T1);
    const result = local.merge(remote);
    expect(result.conflicts).toHaveLength(0);
    expect(result.untouched).toBe(1);
  });

  test("last-writer-wins: newer updatedAt wins regardless of side", () => {
    const a = ContextEngine.empty();
    const b = ContextEngine.empty();
    a.set("k", "older", "agent-1", T1);
    b.set("k", "newer", "agent-2", T2);
    a.merge(b);
    expect(a.get("k").value).toBe("newer");
    expect(a.conflictLog()[0].winner).toBe("remote");
  });

  test("merge converges: A merges B exactly like B merges A", () => {
    const a = ContextEngine.empty();
    const b = ContextEngine.empty();
    a.set("plan", "A-only v1", "agent-1", T1);
    a.set("plan", "A-only v2", "agent-1", T2);
    b.set("plan", "B v1", "agent-2", T1);
    b.set("plan", "B v2", "agent-3", T3);
    b.set("solo-b", "peer-only", "agent-2", T2);
    a.set("solo-a", "local-only", "agent-1", T1);

    const ab = new ContextEngine(a.toStore());
    ab.merge(new ContextEngine(b.toStore()));
    const ba = new ContextEngine(b.toStore());
    ba.merge(new ContextEngine(a.toStore()));

    expect(ab.list()).toEqual(ba.list());
    expect(ab.toStore().history).toEqual(ba.toStore().history);
    expect(ab.get("plan").value).toBe(ba.get("plan").value);
  });
  test("re-syncing converged stores is idempotent (no new conflicts)", () => {
    const a = ContextEngine.empty();
    const b = ContextEngine.empty();
    a.set("k", "A", "agent-1", T1);
    b.set("k", "B", "agent-2", T2);
    const first = a.merge(new ContextEngine(b.toStore()));
    expect(first.conflicts).toHaveLength(1);
    const second = a.merge(new ContextEngine(b.toStore()));
    expect(second.conflicts).toHaveLength(0);
    expect(second.untouched).toBe(1);
    const ba = new ContextEngine(b.toStore());
    ba.merge(new ContextEngine(a.toStore()));
    expect(a.toStore().history).toEqual(ba.toStore().history);
  });

  test("writer-priority: lexicographically greater writer wins", () => {
    const local = ContextEngine.empty();
    const remote = ContextEngine.empty();
    local.set("k", "from zeta", "agent-zeta", T1);
    remote.set("k", "from alpha", "agent-alpha", T1);
    const result = local.merge(remote, "writer-priority");
    expect(result.conflicts[0].winner).toBe("local");
    expect(local.get("k").value).toBe("from zeta");
  });

  test("manual strategy keeps local and flags unresolved", () => {
    const local = ContextEngine.empty();
    const remote = ContextEngine.empty();
    local.set("k", "local value", "agent-1", T1);
    remote.set("k", "remote value", "agent-2", T2);
    const result = local.merge(remote, "manual");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].winner).toBe("unresolved");
    expect(local.get("k").value).toBe("local value");
  });

  test("conflict records capture both sides and the reason", () => {
    const local = ContextEngine.empty();
    const remote = ContextEngine.empty();
    local.set("k", "local", "agent-1", T2);
    remote.set("k", "remote", "agent-2", T1);
    const [record] = local.merge(remote).conflicts;
    expect(record.key).toBe("k");
    expect(record.local.version).toBe(1);
    expect(record.remote.version).toBe(1);
    expect(record.reason).toMatch(/last-writer-wins by updatedAt/);
    expect(record.winner).toBe("local");
  });

  test("merge unions divergent histories without losing either side", () => {
    const a = ContextEngine.empty();
    const b = ContextEngine.empty();
    a.set("k", "A", "agent-1", T1);
    b.set("k", "B", "agent-2", T1);
    a.merge(b);
    const log = a.historyFor("k");
    expect(log.map((r) => r.writer).sort()).toEqual(["agent-1", "agent-2"]);
    expect(log).toHaveLength(2);
  });

  test("unknown strategy is rejected at the CLI boundary type level", () => {
    const e = ContextEngine.empty();
    expect(() => e.set("k", "v", "agent-1", "bad-date")).toThrow(ContextError);
  });
});

describe("stats and conflict log", () => {
  test("stats reports keys, history, conflicts, writers", () => {
    const local = ContextEngine.empty();
    const remote = ContextEngine.empty();
    local.set("k", "v1", "agent-1", T1);
    local.set("k", "v2", "agent-2", T2);
    remote.set("k", "v3", "agent-3", T3);
    local.merge(remote);
    const s = local.stats();
    expect(s.keys).toBe(1);
    expect(s.historyRecords).toBeGreaterThanOrEqual(3);
    expect(s.conflicts).toBe(1);
    expect(s.writers).toContain("agent-1");
  });

  test("empty store reports zero everything", () => {
    const s = ContextEngine.empty().stats();
    expect(s.keys).toBe(0);
    expect(s.historyRecords).toBe(0);
    expect(s.conflicts).toBe(0);
    expect(s.writers).toEqual([]);
  });
});

describe("store file shape", () => {
  test("toStore produces the documented format", () => {
    const e = ContextEngine.empty();
    e.set("k", "v", "agent-1", T1);
    const store: StoreFile = e.toStore();
    expect(store.format).toBe("agent-context-engine/store");
    expect(store.version).toBe(1);
    expect(Object.keys(store.entries)).toEqual(["k"]);
  });
});