#!/usr/bin/env node
import { Command } from "commander";
import { existsSync } from "node:fs";
import { ContextEngine, ContextError, type ConflictStrategy } from "./engine.js";

const VERSION = "1.0.0";

const program = new Command();
program
  .name("agent-context-engine")
  .description("Versioned, file-backed context store for distributed agents: conflict resolution, versioning, synchronization, checksum integrity")
  .version(VERSION)
  .option("-s, --store <path>", "Store file path", "context-store.json")
  .option("--json", "Machine-readable JSON output", false);

function engine(path: string): ContextEngine {
  return ContextEngine.load(path);
}

function engineForWrite(path: string): ContextEngine {
  if (!existsSync(path)) return ContextEngine.empty();
  return ContextEngine.load(path);
}

function emit(data: unknown, asJson: boolean, text: string): void {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(text);
  }
}

program
  .command("set")
  .description("Write a value to a key, creating the next version")
  .argument("<key>", "Context key")
  .argument("<value>", "Value to store")
  .requiredOption("-w, --writer <agent>", "Agent id performing the write")
  .action((key: string, value: string, opts: { writer: string }, cmd: Command) => {
    const { store, json } = cmd.parent!.opts();
    const e = engineForWrite(store);
    const entry = e.set(key, value, opts.writer);
    e.save(store);
    emit(entry, json, `[${opts.writer}] ${key} = ${JSON.stringify(value)} (v${entry.version})`);
  });

program
  .command("get")
  .description("Read a key")
  .argument("<key>", "Context key")
  .action((key: string, _opts: unknown, cmd: Command) => {
    const { store, json } = cmd.parent!.opts();
    const e = engine(store);
    const entry = e.get(key);
    emit(entry, json, `${key} = ${JSON.stringify(entry.value)}\n  v${entry.version} by ${entry.writer} at ${entry.updatedAt}`);
  });

program
  .command("list")
  .description("List all keys")
  .action((_opts: unknown, cmd: Command) => {
    const { store, json } = cmd.parent!.opts();
    const e = engine(store);
    const entries = e.list();
    if (json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    if (entries.length === 0) {
      console.log("(store is empty)");
      return;
    }
    for (const entry of entries) {
      console.log(`${entry.key.padEnd(24)} v${String(entry.version).padEnd(4)} ${JSON.stringify(entry.value)}`);
    }
  });

program
  .command("history")
  .description("Show the version log for a key")
  .argument("<key>", "Context key")
  .action((key: string, _opts: unknown, cmd: Command) => {
    const { store, json } = cmd.parent!.opts();
    const e = engine(store);
    const records = e.historyFor(key);
    if (json) {
      console.log(JSON.stringify(records, null, 2));
      return;
    }
    for (const r of records) {
      console.log(`v${r.version}  ${r.at}  ${r.writer}  ${JSON.stringify(r.value)}`);
    }
  });

program
  .command("rollback")
  .description("Restore an older version as a new write")
  .argument("<key>", "Context key")
  .requiredOption("--to <version>", "Version to restore", Number)
  .requiredOption("-w, --writer <agent>", "Agent id performing the rollback")
  .action((key: string, opts: { to: number; writer: string }, cmd: Command) => {
    const { store, json } = cmd.parent!.opts();
    const e = engine(store);
    const entry = e.rollback(key, opts.to, opts.writer);
    e.save(store);
    emit(entry, json, `[${opts.writer}] ${key} rolled back to v${opts.to} content -> now v${entry.version}`);
  });

program
  .command("sync")
  .description("Merge a peer store into this store (both stores converge to the same result)")
  .argument("<peer>", "Peer store file path")
  .option("--strategy <name>", "Conflict strategy: last-writer-wins | writer-priority | manual", "last-writer-wins")
  .action((peer: string, opts: { strategy: string }, cmd: Command) => {
    const { store, json } = cmd.parent!.opts();
    const strategies: ConflictStrategy[] = ["last-writer-wins", "writer-priority", "manual"];
    if (!strategies.includes(opts.strategy as ConflictStrategy)) {
      throw new ContextError(`unknown strategy: ${opts.strategy} (expected one of ${strategies.join(", ")})`);
    }
    const e = engineForWrite(store);
    const remote = ContextEngine.load(peer);
    const result = e.merge(remote, opts.strategy as ConflictStrategy);
    e.save(store);
    const report = { peer: peer, strategy: opts.strategy, ...result, unresolved: opts.strategy === "manual" ? result.conflicts.length : 0 };
    emit(
      report,
      json,
      `Synced ${peer} (strategy: ${opts.strategy})\n` +
        `  adopted:  ${report.adopted} key(s) taken from peer\n` +
        `  updated:  ${report.updated} key(s) overwritten by peer\n` +
        `  conflict: ${report.conflicts.length} divergence(s) resolved\n` +
        `  unchanged:${report.untouched} key(s)`,
    );
    if (opts.strategy === "manual" && result.conflicts.length > 0) {
      for (const c of result.conflicts) {
        console.error(`  unresolved: ${c.key} (local v${c.local.version} by ${c.local.writer} vs remote v${c.remote.version} by ${c.remote.writer})`);
      }
      process.exitCode = 2;
    }
  });

program
  .command("verify")
  .description("Recompute and validate every checksum in the store")
  .action((_opts: unknown, cmd: Command) => {
    const { store, json } = cmd.parent!.opts();
    const e = engine(store);
    const report = e.verify();
    emit(report, json, report.ok ? `OK — ${report.checked} record(s) verified` : `FAILED — ${report.errors.length} error(s):\n  ${report.errors.join("\n  ")}`);
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("stats")
  .description("Store summary")
  .action((_opts: unknown, cmd: Command) => {
    const { store, json } = cmd.parent!.opts();
    const e = engine(store);
    const s = e.stats();
    emit(s, json, `keys: ${s.keys} | history records: ${s.historyRecords} | conflicts on record: ${s.conflicts} | writers: ${s.writers.join(", ") || "none"}`);
  });

program
  .command("conflicts")
  .description("Show the conflict log")
  .action((_opts: unknown, cmd: Command) => {
    const { store, json } = cmd.parent!.opts();
    const e = engine(store);
    const records = e.conflictLog();
    if (json) {
      console.log(JSON.stringify(records, null, 2));
      return;
    }
    if (records.length === 0) {
      console.log("(no conflicts on record)");
      return;
    }
    for (const c of records) {
      console.log(`${c.key} [${c.strategy}] winner=${c.winner} — ${c.reason}`);
    }
  });

function run(): void {
  try {
    program.parse(process.argv);
  } catch (err) {
    if (err instanceof ContextError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

if (import.meta.main) {
  run();
}