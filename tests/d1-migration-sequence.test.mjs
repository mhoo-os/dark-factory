import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const repository = join(root, "..");
const migrationNames = [
  "0001_factory.sql",
  "0002_ingress-retry-state.sql",
  "0003-state-history-and-active-issue.sql",
  "0004-trusted-factory-registry.sql",
  "0004_chat_lane_registry.sql",
  "0005-runtime-capacity-leases.sql",
  "0005_chat_lane_transition_guards.sql",
  "0006_chat_lane_activation_guard.sql",
  "0007_chat_lane_rollback_compatibility.sql",
  "0008_native_candidate_receipts.sql",
  "0009_review_result_receipts.sql",
  "0010_repair_attempt_receipts.sql",
];
const observedPartialLedger = migrationNames.slice(0, 4);
const triggerMigrations = [
  "0004_chat_lane_registry.sql",
  "0005_chat_lane_transition_guards.sql",
  "0006_chat_lane_activation_guard.sql",
  "0007_chat_lane_rollback_compatibility.sql",
];
const wrangler = join(repository, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");

function runWrangler(cwd, ...args) {
  const result = spawnSync(wrangler, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1", NO_UPDATE_NOTIFIER: "1" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function writeConfig(directory) {
  await writeFile(join(directory, "wrangler.jsonc"), JSON.stringify({
    name: "mho219-d1-migration-regression",
    compatibility_date: "2026-09-01",
    d1_databases: [{
      binding: "DB",
      database_name: "mhoo-dark-factory-ledger",
      database_id: "e76d5f65-a33c-41cf-9f82-622c1d53cf43",
      migrations_dir: "migrations",
    }],
  }));
}

async function copyMigrations(directory, names) {
  const destination = join(directory, "migrations");
  await mkdir(destination, { recursive: true });
  for (const name of names) {
    await cp(join(repository, "migrations", name), join(destination, name));
  }
}

function apply(directory, persistTo) {
  return runWrangler(
    directory,
    "d1", "migrations", "apply", "DB",
    "--local", "--persist-to", persistTo, "--config", "wrangler.jsonc",
  );
}

function schemaReceipt(directory, persistTo) {
  return runWrangler(
    directory,
    "d1", "execute", "DB",
    "--local", "--persist-to", persistTo, "--config", "wrangler.jsonc", "--json",
    "--command", "SELECT name FROM d1_migrations ORDER BY id; SELECT schema_version FROM factory_schema_meta WHERE schema_name='factory-ledger';",
  );
}

test("Wrangler 4.128.0 applies the complete lane sequence from fresh and observed partial D1 state", { timeout: 120_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "mho219-d1-migration-"));
  const fresh = join(scratch, "fresh");
  const partial = join(scratch, "partial");
  const freshPersist = join(scratch, "fresh-state");
  const partialPersist = join(scratch, "partial-state");

  try {
    assert.match(runWrangler(repository, "--version"), /4\.128\.0/);
    for (const laneMigration of triggerMigrations) {
      const sql = await readFile(join(repository, "migrations", laneMigration), "utf8");
      assert.doesNotMatch(sql, /SELECT\s+CASE\b/, `${laneMigration} must parenthesize CASE expressions inside triggers for Cloudflare D1 remote parsing`);
      assert.match(sql, /SELECT\s+\(CASE\b/, `${laneMigration} must retain the parenthesized D1-safe CASE form`);
      assert.equal(sql.includes("\r"), false, `${laneMigration} must remain LF-only`);
    }

    await mkdir(fresh, { recursive: true });
    await writeConfig(fresh);
    await copyMigrations(fresh, migrationNames);
    apply(fresh, freshPersist);
    const freshReceipt = schemaReceipt(fresh, freshPersist);
    for (const name of migrationNames) assert.match(freshReceipt, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(freshReceipt, /"schema_version"\s*:\s*7/);

    await mkdir(partial, { recursive: true });
    await writeConfig(partial);
    await copyMigrations(partial, observedPartialLedger);
    apply(partial, partialPersist);
    await copyMigrations(partial, migrationNames.slice(4));
    apply(partial, partialPersist);
    const partialReceipt = schemaReceipt(partial, partialPersist);
    for (const name of migrationNames) assert.match(partialReceipt, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(partialReceipt, /"schema_version"\s*:\s*7/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
