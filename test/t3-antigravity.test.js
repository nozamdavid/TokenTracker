"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  resolveT3AntigravityDbPaths,
  parseT3AntigravityIncremental,
} = require("../src/lib/t3-antigravity");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_error) {
  // Node versions without node:sqlite skip the SQLite-backed cases.
}

function varint(value) {
  let number = BigInt(value);
  const bytes = [];
  while (number > 0x7fn) {
    bytes.push(Number((number & 0x7fn) | 0x80n));
    number >>= 7n;
  }
  bytes.push(Number(number));
  return Buffer.from(bytes);
}

function fieldVarint(number, value) {
  return Buffer.concat([varint((number << 3) | 0), varint(value)]);
}

function fieldBytes(number, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
}

function timestamp(value = Date.UTC(2024, 0, 2)) {
  const seconds = Math.floor(value / 1000);
  const nanos = (value % 1000) * 1_000_000;
  return Buffer.concat([fieldVarint(1, seconds), fieldVarint(2, nanos)]);
}

function usage({ input = 0, output = 0, reasoning = 0, text = 0, cacheRead = 0, cacheWrite = 0, identity = "1", aliases = null, modelId = 0, numericIdentity = null } = {}) {
  const fields = [
    fieldVarint(2, input),
    fieldVarint(3, output),
    fieldVarint(4, cacheWrite),
    fieldVarint(5, cacheRead),
    fieldVarint(9, reasoning),
    fieldVarint(10, text),
  ];
  if (modelId) fields.push(fieldVarint(1, modelId));
  if (numericIdentity !== null) fields.push(fieldVarint(11, numericIdentity));
  for (const [number, value] of Object.entries(aliases || (identity === null ? {} : { 11: String(identity) }))) {
    fields.push(fieldBytes(Number(number), value));
  }
  return Buffer.concat(fields);
}

function generation(primary, retry = null, { model = "gemini-2.5-pro", modelId = 246, at = Date.UTC(2024, 0, 2), modelField = 19 } = {}) {
  const metadata = [
    fieldVarint(3, modelId),
    fieldBytes(9, Buffer.concat([
      fieldVarint(2, 9223372036854775807n),
      fieldBytes(4, timestamp(at)),
    ])),
    fieldBytes(modelField, model),
    fieldBytes(4, primary),
  ];
  if (retry) metadata.push(fieldBytes(17, fieldBytes(2, retry)));
  return fieldBytes(1, Buffer.concat(metadata));
}

function stepMetadata(usageBytes, { model = "gemini-2.5-pro", modelId = 246, at = Date.UTC(2024, 0, 2), modelNameField = 12 } = {}) {
  return Buffer.concat([
    fieldBytes(24, Buffer.concat([fieldVarint(1, modelId), fieldBytes(modelNameField, model)])),
    fieldBytes(8, timestamp(at)),
    fieldBytes(9, usageBytes),
  ]);
}

function trajectoryMetadata({ at = Date.UTC(2024, 0, 2) } = {}) {
  return fieldBytes(2, timestamp(at));
}

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-antigravity-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createDb(dbPath, { generations = [], steps = [], trajectory = [], tables = {} } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  const withGeneration = tables.generation !== false;
  const withSteps = tables.steps !== false;
  const withTrajectory = tables.trajectory !== false;
  if (withGeneration) db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);");
  if (withSteps) db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB, step_type TEXT, status TEXT, step_payload BLOB);");
  if (withTrajectory) db.exec("CREATE TABLE trajectory_metadata_blob (id INTEGER PRIMARY KEY, data BLOB);");
  if (withGeneration) {
    const addGeneration = db.prepare("INSERT INTO gen_metadata(idx, data) VALUES (?, ?)");
    generations.forEach((data, index) => addGeneration.run(index, data));
  }
  if (withSteps) {
    const addStep = db.prepare("INSERT INTO steps(idx, metadata) VALUES (?, ?)");
    steps.forEach((data, index) => addStep.run(index, data));
  }
  if (withTrajectory) {
    const addTrajectory = db.prepare("INSERT INTO trajectory_metadata_blob(id, data) VALUES (?, ?)");
    trajectory.forEach((data, index) => addTrajectory.run(index, data));
  }
  db.close();
  return dbPath;
}

function readQueue(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs.readFileSync(queuePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function sqliteTest(name, fn) {
  test(name, { skip: !DatabaseSync && "node:sqlite is unavailable" }, fn);
}

test("resolver scans Antigravity conversation databases and deduplicates real paths", (t) => {
  const home = temporaryDirectory(t);
  const providerRoot = path.join(home, ".t3", "userdata", "providers", "antigravity");
  const first = path.join(providerRoot, "instance-a", "antigravity-acp", "conversations", "same.db");
  const second = path.join(providerRoot, "instance-b", "antigravity-acp", "conversations", "other.db");
  const ignored = path.join(providerRoot, "instance-a", "other", "ignored.db");
  fs.mkdirSync(path.dirname(first), { recursive: true });
  fs.mkdirSync(path.dirname(second), { recursive: true });
  fs.mkdirSync(path.dirname(ignored), { recursive: true });
  fs.writeFileSync(first, "fixture");
  fs.writeFileSync(second, "fixture");
  fs.writeFileSync(ignored, "fixture");
  fs.symlinkSync(first, path.join(path.dirname(second), "alias.db"));

  assert.deepEqual(resolveT3AntigravityDbPaths({ home, env: {} }), [fs.realpathSync(first), fs.realpathSync(second)].sort());

  const override = path.join(home, ".t3", "dev");
  const devDb = path.join(override, "providers", "antigravity", "instance", "antigravity-acp", "conversations", "dev.db");
  fs.mkdirSync(path.dirname(devDb), { recursive: true });
  fs.writeFileSync(devDb, "fixture");
  assert.deepEqual(
    resolveT3AntigravityDbPaths({ home, env: { TOKENTRACKER_T3_STATE_DIR: "~/.t3/dev" } }),
    [fs.realpathSync(devDb)],
  );
});

sqliteTest("parser decodes generation and retry channels and excludes reasoning from output", async (t) => {
  const dir = temporaryDirectory(t);
  const dbPath = createDb(path.join(dir, "session-a.db"), {
    generations: [
      generation(usage({ input: 10, output: 12, reasoning: 3, cacheRead: 7, cacheWrite: 5, identity: "g-1" }),
        usage({ input: 4, output: 5, reasoning: 2, text: 4, identity: "g-2" }), { modelField: 21 }),
    ],
    steps: [stepMetadata(usage({ input: 6, output: 8, reasoning: 1, identity: "s-1" }), {
      model: "", modelId: 0, modelNameField: 8,
    })],
    trajectory: [trajectoryMetadata()],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const projectQueuePath = path.join(dir, "project.queue.jsonl");
  const cursors = {};
  const result = await parseT3AntigravityIncremental({
    dbPaths: [dbPath], cursors, queuePath, projectQueuePath,
    sqliteOptions: { requireFn: require },
  });

  assert.equal(result.filesProcessed, 1);
  assert.equal(result.eventsAggregated, 3);
  assert.equal(result.projectBucketsQueued, 0);
  assert.equal(fs.existsSync(projectQueuePath), false);
  const rows = readQueue(queuePath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "gemini-2.5-pro");
  assert.equal(rows[0].input_tokens, 20);
  assert.equal(rows[0].output_tokens, 20);
  assert.equal(rows[0].reasoning_output_tokens, 6);
  assert.equal(rows[0].cached_input_tokens, 7);
  assert.equal(rows[0].cache_creation_input_tokens, 5);
});

sqliteTest("repeat sync is idempotent and corrected token totals update existing attribution", async (t) => {
  const dir = temporaryDirectory(t);
  const dbPath = createDb(path.join(dir, "session-corrected.db"), {
    generations: [generation(usage({ input: 10, output: 5, identity: 55 }))],
    trajectory: [trajectoryMetadata()],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};
  const sync = () => parseT3AntigravityIncremental({ dbPaths: [dbPath], cursors, queuePath });

  await sync();
  const initialQueue = fs.readFileSync(queuePath, "utf8");
  const repeated = await sync();
  assert.equal(repeated.eventsAggregated, 0);
  assert.equal(fs.readFileSync(queuePath, "utf8"), initialQueue);

  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE gen_metadata SET data = ? WHERE idx = 0")
    .run(generation(usage({ input: 30, output: 5, identity: 55 })));
  db.close();
  const corrected = await sync();
  assert.equal(corrected.eventsAggregated, 1);
  assert.equal(readQueue(queuePath).at(-1).input_tokens, 30);
});

sqliteTest("empty conversation placeholders and steps without model metadata are supported", async (t) => {
  const dir = temporaryDirectory(t);
  const emptyPath = path.join(dir, "unused-session.db");
  fs.writeFileSync(emptyPath, "");
  const dbPath = createDb(path.join(dir, "session-step-model.db"), {
    generations: [generation(usage({ input: 10, output: 4, identity: "shared" }))],
    steps: [Buffer.concat([
      fieldBytes(1, timestamp()),
      fieldBytes(9, usage({ input: 10, output: 4, identity: "shared" })),
    ])],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const result = await parseT3AntigravityIncremental({
    dbPaths: [emptyPath, dbPath], cursors: {}, queuePath,
  });
  assert.equal(result.eventsAggregated, 1);
  assert.equal(readQueue(queuePath)[0].model, "gemini-2.5-pro");
  assert.equal(readQueue(queuePath)[0].total_tokens, 14);
});

sqliteTest("exact metadata projection resolves usage model ids and joins overlapping identity aliases", async (t) => {
  const dir = temporaryDirectory(t);
  const dbPath = createDb(path.join(dir, "session-aliases.db"), {
    generations: [generation(
      usage({ input: 10, output: 4, identity: null, aliases: { 11: "first", 12: "shared" }, modelId: 312 }),
      usage({ input: 12, output: 6, identity: null, aliases: { 12: "shared", 7: "last" }, modelId: 312 }),
      { model: "", modelId: 246 },
    )],
    steps: [stepMetadata(usage({ input: 20, output: 8, identity: null, aliases: { 7: "last" }, modelId: 312 }), {
      model: "", modelId: 0, at: Date.UTC(2024, 0, 3),
    })],
    trajectory: [],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const result = await parseT3AntigravityIncremental({ dbPaths: [dbPath], cursors: {}, queuePath });

  assert.equal(result.eventsAggregated, 1);
  assert.equal(readQueue(queuePath).length, 1);
  assert.equal(readQueue(queuePath)[0].model, "gemini-2.5-flash",
    "usage field 1 overrides the generation model id through the confirmed ID table");
  assert.equal(readQueue(queuePath)[0].input_tokens, 20,
    "records sharing any identity alias merge as one usage event");
});

sqliteTest("numeric values in usage identity fields do not merge records", async (t) => {
  const dir = temporaryDirectory(t);
  const dbPath = createDb(path.join(dir, "session-numeric-identity.db"), {
    generations: [generation(
      usage({ input: 3, identity: null, numericIdentity: 0 }),
      usage({ input: 5, identity: null, numericIdentity: 0 }),
    )],
    tables: { steps: false, trajectory: false },
  });
  const result = await parseT3AntigravityIncremental({
    dbPaths: [dbPath], cursors: {}, queuePath: path.join(dir, "queue.jsonl"),
  });
  assert.equal(result.eventsAggregated, 2);
  assert.equal(readQueue(path.join(dir, "queue.jsonl"))[0].input_tokens, 8);
});

sqliteTest("missing trajectory table is optional and timestamps without metadata remain stable", async (t) => {
  const dir = temporaryDirectory(t);
  const dbPath = createDb(path.join(dir, "session-no-trajectory.db"), {
    generations: [generation(usage({ input: 7, output: 3, identity: "stable" }), null, { at: 0 })],
    tables: { steps: false, trajectory: false },
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};
  await parseT3AntigravityIncremental({ dbPaths: [dbPath], cursors, queuePath });
  const original = fs.readFileSync(queuePath, "utf8");
  const originalBucket = readQueue(queuePath)[0].hour_start;

  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE gen_metadata SET data = ? WHERE idx = 0")
    .run(generation(usage({ input: 7, output: 3, identity: "stable" }), null, { at: 0 }));
  db.close();
  fs.utimesSync(dbPath, new Date(Date.now() + 86_400_000), new Date(Date.now() + 86_400_000));
  const repeated = await parseT3AntigravityIncremental({ dbPaths: [dbPath], cursors, queuePath });
  assert.equal(repeated.eventsAggregated, 0);
  assert.equal(readQueue(queuePath)[0].hour_start, originalBucket);
  assert.equal(fs.readFileSync(queuePath, "utf8"), original);
  assert.ok(cursors.t3Antigravity.fallbackTimestamps, "fallback event times persist in the provider cursor");
});

sqliteTest("malformed existing metadata fails before changing cursors or queue", async (t) => {
  const dir = temporaryDirectory(t);
  const dbPath = createDb(path.join(dir, "session-malformed.db"), {
    generations: [Buffer.from([0x22, 0x08, 0x01])],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = { t3Antigravity: { messages: { prior: { keep: true } } } };
  const before = JSON.stringify(cursors);
  await assert.rejects(
    parseT3AntigravityIncremental({ dbPaths: [dbPath], cursors, queuePath }),
    /Malformed T3 Antigravity generation metadata/,
  );
  assert.equal(JSON.stringify(cursors), before);
  assert.equal(fs.existsSync(queuePath), false);
});

sqliteTest("copies with the same session basename count once", async (t) => {
  const dir = temporaryDirectory(t);
  const blob = generation(usage({ input: 12, output: 4, identity: 77 }));
  const first = createDb(path.join(dir, "root-a", "same-session.db"), {
    generations: [blob], trajectory: [trajectoryMetadata()],
  });
  const second = createDb(path.join(dir, "root-b", "same-session.db"), {
    generations: [blob], trajectory: [trajectoryMetadata()],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const result = await parseT3AntigravityIncremental({ dbPaths: [first, second], cursors: {}, queuePath });
  assert.equal(result.eventsAggregated, 1);
  assert.equal(readQueue(queuePath).length, 1);
});

sqliteTest("database read failures throw and leave caller cursors untouched", async (t) => {
  const dir = temporaryDirectory(t);
  const dbPath = createDb(path.join(dir, "session-error.db"));
  const cursors = { hourly: { sentinel: true }, t3Antigravity: { messages: { prior: { keep: true } } } };
  const before = JSON.stringify(cursors);
  await assert.rejects(
    parseT3AntigravityIncremental({
      dbPaths: [dbPath],
      cursors,
      queuePath: path.join(dir, "queue.jsonl"),
      sqliteOptions: {
        execFileSync() { throw new Error("fixture read failure"); },
        requireFn() { throw new Error("fixture fallback failure"); },
      },
    }),
    /Cannot read T3 Antigravity SQLite database/,
  );
  assert.equal(JSON.stringify(cursors), before);
});
