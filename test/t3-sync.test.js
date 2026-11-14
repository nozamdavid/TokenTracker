"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_error) {
  // Node 20 supports the package, but not the built-in SQLite fixture writer.
}

const sqliteTest = DatabaseSync ? test : test.skip;
const { cmdSync } = require("../src/commands/sync");

const ENV_KEYS = [
  "HOME", "USERPROFILE", "CODEX_HOME", "CODE_HOME", "GEMINI_HOME",
  "OPENCODE_HOME", "OPENCODE_DATA_DIR", "XDG_DATA_HOME", "TOKENTRACKER_T3_STATE_DIR",
  "TOKENTRACKER_LOCAL_SYNC_DEVICE_TOKEN", "TOKENTRACKER_NO_TELEMETRY",
  "DO_NOT_TRACK", "TOKENTRACKER_INSFORGE_BASE_URL", "TOKENTRACKER_DEVICE_TOKEN",
];

function encodeVarint(value) {
  let n = BigInt(value);
  const bytes = [];
  while (n > 0x7fn) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function protobufField(number, value) {
  return Buffer.concat([encodeVarint((number << 3) | 0), encodeVarint(value)]);
}

function protobufBytesField(number, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return Buffer.concat([
    encodeVarint((number << 3) | 2),
    encodeVarint(data.length),
    data,
  ]);
}

function protobufTimestamp(value = Date.now()) {
  const seconds = Math.floor(value / 1000);
  const nanos = (value % 1000) * 1_000_000;
  return Buffer.concat([protobufField(1, seconds), protobufField(2, nanos)]);
}

// T3 stores GenMetadata.usage in protobuf field 4 and step metadata usage in
// field 9. Usage channel field numbers follow the installed T3 reader's map.
function usageMetadata({ input, output, cacheWrite = 0, cacheRead = 0, reasoning = 0 }) {
  return Buffer.concat([
    protobufField(2, input),
    protobufField(3, output),
    protobufField(4, cacheWrite),
    protobufField(5, cacheRead),
    protobufField(9, reasoning),
  ]);
}

function writeConversationDb(dbPath, generations, steps) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type TEXT, status TEXT, metadata BLOB, step_payload BLOB);
      CREATE TABLE trajectory_metadata_blob (id INTEGER PRIMARY KEY, data BLOB);
    `);
    const insertGeneration = db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)");
    for (const [idx, usage] of generations) {
      // GenMetadata is wrapped by generation root field 1.
      const inner = Buffer.concat([
        protobufField(3, 246),
        protobufBytesField(9, protobufBytesField(4, protobufTimestamp())),
        protobufBytesField(19, "gemini-2.5-pro"),
        protobufBytesField(4, usage),
      ]);
      const data = protobufBytesField(1, inner);
      insertGeneration.run(idx, data, data.length);
    }
    const insertStep = db.prepare("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)");
    for (const [idx, usage] of steps) {
      // Step metadata is the root and its model is nested at field 24.
      const data = Buffer.concat([
        protobufBytesField(24, Buffer.concat([
          protobufField(1, 246),
          protobufBytesField(12, "gemini-2.5-pro"),
        ])),
        protobufBytesField(8, protobufTimestamp()),
        protobufBytesField(9, usage),
      ]);
      insertStep.run(idx, "model", "complete", data);
    }
  } finally {
    db.close();
  }
}

async function readQueue(queuePath) {
  const raw = await fs.readFile(queuePath, "utf8").catch(() => "");
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function latestSourceTotals(rows, source) {
  const latest = new Map();
  for (const row of rows) {
    if (row.source === source) latest.set(`${row.model}|${row.hour_start}`, row);
  }
  return [...latest.values()].reduce((sum, row) => sum + Number(row.total_tokens || 0), 0);
}

sqliteTest("cmdSync reads T3 Antigravity databases without .gemini and honors source scope", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-t3-sync-home-"));
  const trackerDataDir = path.join(home, "tracker-data");
  const queuePath = path.join(trackerDataDir, "queue.jsonl");
  const t3Root = path.join(home, ".t3", "userdata", "providers", "antigravity", "a".repeat(64), "antigravity-acp", "conversations");
  await fs.mkdir(t3Root, { recursive: true });
  const dbPath = path.join(t3Root, "11111111-2222-4333-8444-555555555555.db");
  writeConversationDb(dbPath, [[1, usageMetadata({ input: 100, output: 30, cacheWrite: 4, cacheRead: 5, reasoning: 10 })]], [
    [1, usageMetadata({ input: 50, output: 20 })],
  ]);

  const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalFetch = global.fetch;
  const context = { home, trackerDataDir, scanSources: ["antigravity"] };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEX_HOME = path.join(home, ".codex");
    process.env.CODE_HOME = path.join(home, ".code");
    process.env.GEMINI_HOME = path.join(home, ".gemini");
    process.env.OPENCODE_HOME = path.join(home, ".opencode");
    process.env.OPENCODE_DATA_DIR = path.join(home, ".opencode-data");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.TOKENTRACKER_T3_STATE_DIR = path.join(home, ".t3", "userdata");
    process.env.TOKENTRACKER_LOCAL_SYNC_DEVICE_TOKEN = "";
    process.env.TOKENTRACKER_NO_TELEMETRY = "1";
    process.env.DO_NOT_TRACK = "1";
    delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    global.fetch = async () => { throw new Error("network access is disabled in t3-sync.test.js"); };

    await cmdSync(["--auto"], context);
    await assert.rejects(fs.stat(path.join(home, ".gemini")), { code: "ENOENT" },
      "T3 scanning must not depend on creating a Gemini installation");
    let rows = await readQueue(queuePath);
    assert.equal(latestSourceTotals(rows, "antigravity"), 209,
      "generation and step protobuf usage should be normalized into Antigravity buckets");
    assert.ok(rows.some((row) => row.source === "antigravity"), "expected a normalized Antigravity queue row");
    assert.ok(rows.some((row) => row.source === "antigravity" && row.model === "gemini-2.5-pro"),
      "model attribution should come from the T3 metadata");

    const firstSize = (await fs.stat(queuePath)).size;
    await cmdSync(["--auto"], context);
    rows = await readQueue(queuePath);
    assert.equal(latestSourceTotals(rows, "antigravity"), 209, "an unchanged T3 database must not increase totals");
    assert.equal((await fs.stat(queuePath)).size, firstSize, "an unchanged T3 database must not append queue rows");

    const db = new DatabaseSync(dbPath);
    try {
      const metadata = Buffer.concat([
        protobufField(1, Date.now()),
        protobufBytesField(2, "gemini-2.5-pro"),
        protobufBytesField(4, usageMetadata({ input: 70, output: 11 })),
      ]);
      db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)").run(2, metadata, metadata.length);
    } finally {
      db.close();
    }
    await cmdSync(["--auto"], { ...context, scanSources: ["gemini"] });
    rows = await readQueue(queuePath);
    assert.equal(latestSourceTotals(rows, "antigravity"), 209,
      "an excluded source must not ingest new T3 Antigravity events");
    assert.equal((await fs.stat(queuePath)).size, firstSize,
      "an excluded source must not append Antigravity queue rows");
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
});
