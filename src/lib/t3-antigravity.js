"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readSqliteJsonRows } = require("./sqlite-reader");
const { expandHome } = require("./scan-roots");
const { parseOpencodeDbIncremental } = require("./rollout");

const MAX_SQLITE_TIMEOUT_MS = 3_000;
const MAX_SQLITE_BUFFER_BYTES = 8 * 1024 * 1024;
// A single hex encoded BLOB must leave room for JSON framing in sqlite3 -json.
const MAX_METADATA_BYTES = Math.floor((MAX_SQLITE_BUFFER_BYTES - 64 * 1024) / 2);
const GENERATION_PAGE_ROWS = 1;
const STEP_PAGE_ROWS = 64;
const UNKNOWN_MODEL = "unknown";

const MODEL_IDS = Object.freeze({
  246: "gemini-2.5-pro",
  312: "gemini-2.5-flash",
  313: "gemini-2.5-flash-thinking",
  329: "gemini-2.5-flash-thinking",
  330: "gemini-2.5-flash-lite",
  281: "claude-sonnet-4",
  282: "claude-sonnet-4",
  290: "claude-opus-4",
  291: "claude-opus-4",
  333: "claude-sonnet-4-5",
  334: "claude-sonnet-4-5",
  340: "claude-haiku-4-5",
  341: "claude-haiku-4-5",
  342: "gpt-oss-120b-medium",
  1026: "claude-opus-4-6",
  1035: "claude-sonnet-4-6",
  1016: "gemini-3.1-pro",
  1036: "gemini-3.1-pro",
  1037: "gemini-3.1-pro",
  1018: "gemini-3-flash-preview",
  1084: "gemini-3-flash-preview",
  1047: "gemini-3-flash-preview",
  1020: "gemini-3.5-flash-medium",
  1021: "gemini-3.1-flash-image",
  1050: "gemini-3.1-flash-lite",
  1071: "gemini-3.6-flash-high",
  1072: "gemini-3.6-flash-medium",
  1073: "gemini-3.6-flash-low",
  1132: "gemini-3.5-flash-high",
  1133: "gemini-3.5-flash-high",
  1187: "gemini-3.5-flash-extra-low",
  1196: "gemini-3.6-flash",
  1266: "gemini-3.6-flash",
  1298: "gemini-3.7-flash-high",
  1299: "gemini-3.7-flash-medium",
  1300: "gemini-3.7-flash-low",
  1301: "gemini-3.7-flash-tiered",
  1318: "gemini-3.8-flash-high",
  1319: "gemini-3.8-flash-medium",
  1320: "gemini-3.8-flash-low",
  1322: "gemini-3.8-flash-tiered",
  1402: "claude-opus-5-5",
  1417: "gemini-4-argon",
  1418: "gemini-4-argon",
  1419: "gemini-4-argon",
});

function resolveT3AntigravityDbPaths({ home = os.homedir(), env = process.env } = {}) {
  const override = typeof env?.TOKENTRACKER_T3_STATE_DIR === "string"
    ? env.TOKENTRACKER_T3_STATE_DIR.trim()
    : "";
  const stateDir = override
    ? expandHome(override, home)
    : path.join(home, ".t3", "userdata");
  const providerDir = path.join(stateDir, "providers", "antigravity");
  let instances;
  try {
    instances = fs.readdirSync(providerDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }

  const realPaths = new Set();
  for (const instance of instances) {
    const instancePath = path.join(providerDir, instance.name);
    try {
      if (!fs.statSync(instancePath).isDirectory()) continue;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const conversationsDir = path.join(instancePath, "antigravity-acp", "conversations");
    let entries;
    try {
      entries = fs.readdirSync(conversationsDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.name.endsWith(".db")) continue;
      const candidate = path.join(conversationsDir, entry.name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        const realPath = fs.realpathSync(candidate);
        const realProviderDir = fs.realpathSync(providerDir);
        const relative = path.relative(realProviderDir, realPath);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
        realPaths.add(realPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return [...realPaths].sort((a, b) => a.localeCompare(b));
}

// Decode protobuf framing only; each metadata record is bounded separately.
function decodeProtoFields(bytes, depth = 0) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (input.length > MAX_METADATA_BYTES || depth > 8) return null;
  const fields = [];
  let offset = 0;

  function readVarint() {
    let value = 0n;
    let shift = 0n;
    for (let count = 0; count < 10 && offset < input.length; count += 1) {
      const byte = input[offset++];
      if (count === 9 && byte > 1) return null;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
      }
      shift += 7n;
    }
    return null;
  }

  while (offset < input.length && fields.length < 4096) {
    const tag = readVarint();
    if (!Number.isSafeInteger(tag) || tag <= 0) return null;
    const number = Math.floor(tag / 8);
    const wire = tag & 7;
    if (number < 1) return null;
    if (wire === 0) {
      const value = readVarint();
      if (value === null) return null;
      fields.push({ number, wire, value });
    } else if (wire === 1) {
      if (offset + 8 > input.length) return null;
      fields.push({ number, wire, value: input.readDoubleLE(offset) });
      offset += 8;
    } else if (wire === 2) {
      const length = readVarint();
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > input.length) return null;
      fields.push({ number, wire, bytes: input.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 5) {
      if (offset + 4 > input.length) return null;
      fields.push({ number, wire, value: input.readFloatLE(offset) });
      offset += 4;
    } else {
      return null;
    }
  }
  return offset === input.length ? fields : null;
}

function decodeHexBlob(value, dbPath, table, rowId) {
  if (typeof value !== "string" || (value.length & 1) !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new Error(`Malformed T3 Antigravity metadata in ${dbPath} (${table} rowid ${rowId})`);
  }
  if (value.length > MAX_METADATA_BYTES * 2) {
    throw new Error(`T3 Antigravity metadata exceeds the 8 MiB query limit in ${dbPath} (${table} rowid ${rowId})`);
  }
  return Buffer.from(value, "hex");
}

function malformed(dbPath, kind, rowId) {
  return new Error(`Malformed T3 Antigravity ${kind} metadata in ${dbPath} (rowid ${rowId})`);
}

function fieldsOrThrow(bytes, dbPath, kind, rowId) {
  const fields = decodeProtoFields(bytes);
  if (!fields) throw malformed(dbPath, kind, rowId);
  return fields;
}

function oneField(fields, number) {
  return fields.find((field) => field.number === number);
}

function bytesField(fields, number, dbPath, kind, rowId, required = false) {
  const field = oneField(fields, number);
  if (!field) {
    if (required) throw malformed(dbPath, kind, rowId);
    return null;
  }
  if (field.wire !== 2) throw malformed(dbPath, kind, rowId);
  return field.bytes;
}

function numberField(fields, number, dbPath, kind, rowId, { required = false } = {}) {
  const field = oneField(fields, number);
  if (!field) {
    if (required) throw malformed(dbPath, kind, rowId);
    return 0;
  }
  if (field.wire !== 0 || !Number.isSafeInteger(field.value)) throw malformed(dbPath, kind, rowId);
  return field.value;
}

function textField(fields, number, dbPath, kind, rowId) {
  const bytes = bytesField(fields, number, dbPath, kind, rowId);
  if (bytes === null) return "";
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw malformed(dbPath, kind, rowId);
  return text.trim();
}

const MODEL_PATTERN = /^(?:gemini-\d|claude-(?:sonnet|opus|haiku)-\d|gpt-)/i;

function normalizeModelName(value) {
  const normalized = String(value || "").toLowerCase()
    .replace(/\s*\(([^)]*)\)\s*$/, "-$1")
    .replace(/\s+/g, "-");
  return normalized.startsWith("claude-")
    ? normalized.replace(/^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1").replaceAll(".", "-")
    : normalized;
}

function concreteModel(value) {
  const model = normalizeModelName(value);
  return MODEL_PATTERN.test(model) && !/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)
    ? model
    : "";
}

function readTimestamp(bytes, dbPath, kind, rowId) {
  if (bytes === null) return null;
  const fields = fieldsOrThrow(bytes, dbPath, kind, rowId);
  const seconds = numberField(fields, 1, dbPath, kind, rowId);
  const nanos = numberField(fields, 2, dbPath, kind, rowId);
  if (!seconds) return null;
  const millis = seconds * 1000 + Math.floor(nanos / 1e6);
  return Number.isSafeInteger(millis) && millis >= Date.UTC(2000, 0, 1) && millis < Date.UTC(2100, 0, 1)
    ? millis
    : null;
}

function decodeUsage(bytes, dbPath, kind, rowId) {
  const fields = fieldsOrThrow(bytes, dbPath, kind, rowId);
  const count = (number) => {
    const field = oneField(fields, number);
    if (!field) return 0;
    if (field.wire !== 0 || !Number.isSafeInteger(field.value)) throw malformed(dbPath, kind, rowId);
    return field.value > 0 ? field.value : 0;
  };
  const input = count(2);
  const directOutput = count(3);
  const reasoning = count(9);
  const text = count(10);
  const output = Math.max(directOutput, reasoning + text);
  const aliases = [];
  for (const number of [11, 12, 7]) {
    const field = oneField(fields, number);
    if (!field) continue;
    if (field.wire !== 2) continue;
    const value = field.bytes.toString("utf8");
    if (!Buffer.from(value, "utf8").equals(field.bytes)) throw malformed(dbPath, kind, rowId);
    const id = value.trim();
    if (id) aliases.push(`${number}:${id}`);
  }
  return {
    input,
    output,
    reasoning: Math.min(reasoning, output),
    cacheWrite: count(4),
    cacheRead: count(5),
    modelId: count(1),
    aliases: [...new Set(aliases)],
  };
}

function decodeMetadataBlob(bytes, { rowKind, rowId, dbPath }) {
  const root = fieldsOrThrow(bytes, dbPath, rowKind, rowId);
  const data = rowKind === "generation"
    ? fieldsOrThrow(bytesField(root, 1, dbPath, rowKind, rowId, true), dbPath, rowKind, rowId)
    : root;

  let modelFields = data;
  let usageNumber;
  let retryNumber;
  let timestampBytes = null;
  let modelId;
  let modelNames;
  if (rowKind === "generation") {
    usageNumber = 4;
    retryNumber = 17;
    modelId = numberField(data, 3, dbPath, rowKind, rowId);
    modelNames = [textField(data, 19, dbPath, rowKind, rowId), textField(data, 21, dbPath, rowKind, rowId)];
    const event = bytesField(data, 9, dbPath, rowKind, rowId);
    if (event !== null) {
      const eventFields = fieldsOrThrow(event, dbPath, rowKind, rowId);
      timestampBytes = bytesField(eventFields, 4, dbPath, rowKind, rowId);
    }
  } else {
    usageNumber = 9;
    retryNumber = 28;
    const modelBytes = bytesField(data, 24, dbPath, rowKind, rowId);
    modelFields = modelBytes !== null ? fieldsOrThrow(modelBytes, dbPath, rowKind, rowId) : [];
    modelId = numberField(modelFields, 1, dbPath, rowKind, rowId);
    modelNames = [textField(modelFields, 12, dbPath, rowKind, rowId), textField(modelFields, 8, dbPath, rowKind, rowId)];
    timestampBytes = bytesField(data, 8, dbPath, rowKind, rowId);
    if (timestampBytes === null) timestampBytes = bytesField(data, 1, dbPath, rowKind, rowId);
  }

  const model = modelNames.map(concreteModel).find(Boolean) || "";
  let timestampMs = readTimestamp(timestampBytes, dbPath, rowKind, rowId);
  const primaryUsageBytes = bytesField(data, usageNumber, dbPath, rowKind, rowId);
  const usages = [];
  if (primaryUsageBytes !== null) usages.push(decodeUsage(primaryUsageBytes, dbPath, rowKind, rowId));
  for (const retry of data.filter((field) => field.number === retryNumber)) {
    if (retry.wire !== 2) throw malformed(dbPath, rowKind, rowId);
    const retryFields = fieldsOrThrow(retry.bytes, dbPath, rowKind, rowId);
    const usageBytes = bytesField(retryFields, 2, dbPath, rowKind, rowId);
    if (usageBytes !== null) usages.push(decodeUsage(usageBytes, dbPath, rowKind, rowId));
  }

  return { model, modelId, timestampMs, usages };
}

function safeSqliteOptions(options = {}) {
  const timeout = Number.isFinite(options.timeout)
    ? Math.max(100, Math.min(MAX_SQLITE_TIMEOUT_MS, Math.trunc(options.timeout)))
    : 1_500;
  return {
    ...options,
    timeout,
    maxBuffer: MAX_SQLITE_BUFFER_BYTES,
    readOnly: true,
    throwOnReadFailure: true,
    label: "T3 Antigravity",
  };
}

function readMetadataRows(dbPath, sql, sqliteOptions) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return readSqliteJsonRows(dbPath, sql, sqliteOptions);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function realDbPaths(dbPaths) {
  const out = new Set();
  for (const value of Array.isArray(dbPaths) ? dbPaths : []) {
    if (typeof value !== "string" || !value.endsWith(".db")) continue;
    try {
      out.add(fs.realpathSync(value));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

function query(dbPath, sql, sqliteOptions) {
  if (typeof sqliteOptions.readRows === "function") return sqliteOptions.readRows(sql);
  return readMetadataRows(dbPath, sql, sqliteOptions);
}

function existingTables(dbPath, sqliteOptions) {
  return new Set(query(
    dbPath,
    "SELECT name FROM sqlite_master WHERE type = 'table'",
    sqliteOptions,
  ).map((row) => row.name));
}

function pageRowIds(dbPath, table, column, after, limit, sqliteOptions) {
  return query(
    dbPath,
    `SELECT rowid AS row_id, idx, length(${column}) AS size FROM ${table} ` +
      `WHERE rowid > ${after}${table === "steps" ? ` AND ${column} IS NOT NULL` : ""} ` +
      `ORDER BY rowid LIMIT ${limit}`,
    sqliteOptions,
  );
}

function readBlob(dbPath, table, column, rowId, size, sqliteOptions) {
  if (!Number.isSafeInteger(size) || size < 0) throw malformed(dbPath, table, rowId);
  if (size > MAX_METADATA_BYTES) {
    throw new Error(`T3 Antigravity metadata exceeds the 8 MiB query limit in ${dbPath} (${table} rowid ${rowId}, ${size} bytes)`);
  }
  const rows = query(
    dbPath,
    `SELECT hex(${column}) AS data FROM ${table} WHERE rowid = ${rowId} LIMIT 1`,
    sqliteOptions,
  );
  if (rows.length !== 1) throw malformed(dbPath, table, rowId);
  return decodeHexBlob(rows[0].data, dbPath, table, rowId);
}

function mergeModelMappings(entries) {
  const mappings = new Map();
  for (const entry of entries) {
    if (!entry.modelId || !entry.model) continue;
    const previous = mappings.get(entry.modelId);
    mappings.set(entry.modelId, previous === undefined || previous === entry.model ? entry.model : null);
  }
  return mappings;
}

function candidateModel(usage, entry, generation, modelMappings) {
  const modelId = usage.modelId || entry.modelId;
  const direct = entry.model && (!modelId || !entry.modelId || modelId === entry.modelId) ? entry.model : "";
  if (direct) return { model: direct, strength: 2 };
  const mapped = modelMappings.get(modelId) || MODEL_IDS[modelId];
  if (mapped) return { model: mapped, strength: 1 };
  if (generation) {
    if (generation.model && (!modelId || !generation.modelId || modelId === generation.modelId)) {
      return { model: generation.model, strength: 2 };
    }
    const generationMapping = modelMappings.get(generation.modelId) || MODEL_IDS[generation.modelId];
    if (generationMapping && (!modelId || !generation.modelId || modelId === generation.modelId)) {
      return { model: generationMapping, strength: 1 };
    }
  }
  return { model: UNKNOWN_MODEL, strength: 0 };
}

function candidateTimestamp(entry, trajectoryTimestamp, fallbackTimestamp) {
  if (entry.timestampMs) return { timestampMs: entry.timestampMs, timestampStrength: 3 };
  if (trajectoryTimestamp) return { timestampMs: trajectoryTimestamp, timestampStrength: 2 };
  return { timestampMs: fallbackTimestamp, timestampStrength: 0 };
}

function collectCandidates({ entries, rowKind, sessionId, generationByIdx, trajectoryTimestamp, fallbackTimestamp, dbPath }) {
  const candidates = [];
  for (const { idx, entry } of entries) {
    for (let usageIndex = 0; usageIndex < entry.usages.length; usageIndex += 1) {
      const usage = entry.usages[usageIndex];
      if (!(usage.input || usage.output || usage.cacheRead || usage.cacheWrite)) continue;
      const matchedGeneration = rowKind === "step" ? generationByIdx.get(idx) : null;
      const model = candidateModel(usage, entry, matchedGeneration, entry.modelMappings);
      const timestamp = candidateTimestamp(entry, trajectoryTimestamp, fallbackTimestamp);
      candidates.push({
        sessionId,
        idx,
        rowKind,
        usageIndex,
        aliases: usage.aliases,
        fallbackIdentity: `${rowKind}:${idx}:${usageIndex}`,
        model: model.model,
        modelStrength: model.strength,
        timestampMs: timestamp.timestampMs,
        timestampStrength: timestamp.timestampStrength,
        input: usage.input,
        output: usage.output,
        reasoning: usage.reasoning,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
      });
    }
  }
  void dbPath;
  return candidates;
}

function findRoot(parent, value) {
  let root = value;
  while (parent[root] !== root) root = parent[root];
  while (parent[value] !== value) {
    const next = parent[value];
    parent[value] = root;
    value = next;
  }
  return root;
}

function mergeCandidates(candidates, fallbackTimestamps) {
  const parent = candidates.map((_candidate, index) => index);
  const aliasOwners = new Map();
  const union = (left, right) => {
    const leftRoot = findRoot(parent, left);
    const rightRoot = findRoot(parent, right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  candidates.forEach((candidate, index) => {
    const identities = candidate.aliases.length ? candidate.aliases : [candidate.fallbackIdentity];
    for (const alias of identities) {
      const key = `${candidate.sessionId}\u0000${alias}`;
      if (aliasOwners.has(key)) union(index, aliasOwners.get(key));
      else aliasOwners.set(key, index);
    }
  });

  const grouped = new Map();
  candidates.forEach((candidate, index) => {
    const root = findRoot(parent, index);
    const group = grouped.get(root) || {
      sessionId: candidate.sessionId,
      aliases: new Set(),
      fallbackIdentities: [],
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      model: UNKNOWN_MODEL,
      modelStrength: -1,
      timestampMs: 0,
      timestampStrength: -1,
    };
    for (const alias of candidate.aliases) group.aliases.add(alias);
    group.fallbackIdentities.push(candidate.fallbackIdentity);
    for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite"]) {
      group[key] = Math.max(group[key], candidate[key]);
    }
    if (candidate.modelStrength > group.modelStrength && candidate.model !== UNKNOWN_MODEL) {
      group.model = candidate.model;
      group.modelStrength = candidate.modelStrength;
    }
    if (
      candidate.timestampMs &&
      (candidate.timestampStrength > group.timestampStrength ||
        (candidate.timestampStrength === group.timestampStrength && candidate.timestampMs < group.timestampMs))
    ) {
      group.timestampMs = candidate.timestampMs;
      group.timestampStrength = candidate.timestampStrength;
    }
    grouped.set(root, group);
  });

  return [...grouped.values()].map((group) => {
    const sortedAliases = [...group.aliases].sort((left, right) => {
      const leftNumber = Number(left.slice(0, left.indexOf(":")));
      const rightNumber = Number(right.slice(0, right.indexOf(":")));
      return leftNumber - rightNumber || left.localeCompare(right);
    });
    const identity = sortedAliases.length ? `usage:${sortedAliases[0]}` : group.fallbackIdentities.sort()[0];
    const fallbackKey = `${group.sessionId}\u0000${identity}`;
    if (group.timestampStrength < 2) {
      group.timestampMs = fallbackTimestamps[fallbackKey] || group.timestampMs || 0;
      if (!group.timestampMs) group.timestampMs = Date.now();
      fallbackTimestamps[fallbackKey] = group.timestampMs;
    }
    return { ...group, identity, fallbackKey };
  });
}

function readDatabase(dbPath, sessionId, fallbackTimestamp, sqliteOptions) {
  // Keep one read-only snapshot open while paging large generation records.
  // Node 20 uses the sqlite3 CLI fallback; injected readers retain that path.
  let DatabaseSync;
  if (!sqliteOptions.execFileSync && !sqliteOptions.requireFn) {
    try {
      ({ DatabaseSync } = require("node:sqlite"));
    } catch (_error) { }
  }
  if (!DatabaseSync) return readDatabaseMetadata(dbPath, sessionId, fallbackTimestamp, sqliteOptions);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 100");
    db.exec("BEGIN");
    const candidates = readDatabaseMetadata(dbPath, sessionId, fallbackTimestamp, {
      ...sqliteOptions,
      readRows: (sql) => db.prepare(sql).all(),
    });
    db.exec("COMMIT");
    return candidates;
  } finally {
    db.close();
  }
}

function readDatabaseMetadata(dbPath, sessionId, fallbackTimestamp, sqliteOptions) {
  const tables = existingTables(dbPath, sqliteOptions);
  // Antigravity leaves zero-byte placeholder databases for unused sessions.
  if (tables.size === 0) return [];
  if (!tables.has("gen_metadata") && !tables.has("steps")) {
    throw new Error(`T3 Antigravity database has no usage tables: ${dbPath}`);
  }
  const generations = [];
  const steps = [];

  const readTable = (table, column, rowKind, pageSize, target) => {
    let after = -1;
    while (true) {
      const rows = pageRowIds(dbPath, table, column, after, pageSize, sqliteOptions);
      for (const row of rows) {
        const rowId = Number(row.row_id);
        const idx = Number(row.idx);
        if (!Number.isSafeInteger(rowId) || !Number.isSafeInteger(idx)) throw malformed(dbPath, table, row.row_id);
        const blob = readBlob(dbPath, table, column, rowId, Number(row.size), sqliteOptions);
        target.push({ idx, entry: decodeMetadataBlob(blob, { rowKind, rowId, dbPath }) });
        after = rowId;
      }
      if (rows.length < pageSize) break;
    }
  };

  if (tables.has("gen_metadata")) readTable("gen_metadata", "data", "generation", GENERATION_PAGE_ROWS, generations);
  if (tables.has("steps")) readTable("steps", "metadata", "step", STEP_PAGE_ROWS, steps);

  let trajectoryTimestamp = null;
  if (tables.has("trajectory_metadata_blob")) {
    let after = -1;
    while (true) {
      const rows = query(
        dbPath,
        `SELECT rowid AS row_id, length(data) AS size FROM trajectory_metadata_blob WHERE rowid > ${after} ORDER BY rowid LIMIT 64`,
        sqliteOptions,
      );
      for (const row of rows) {
        const rowId = Number(row.row_id);
        after = rowId;
        const blob = readBlob(dbPath, "trajectory_metadata_blob", "data", rowId, Number(row.size), sqliteOptions);
        const fields = fieldsOrThrow(blob, dbPath, "trajectory", rowId);
        const timestampBytes = bytesField(fields, 2, dbPath, "trajectory", rowId);
        const found = readTimestamp(timestampBytes, dbPath, "trajectory", rowId);
        if (!trajectoryTimestamp && found) trajectoryTimestamp = found;
      }
      if (rows.length < 64) break;
    }
  }

  const allEntries = [...generations, ...steps].map(({ entry }) => entry);
  const modelMappings = mergeModelMappings(allEntries);
  for (const entry of allEntries) entry.modelMappings = modelMappings;
  const generationByIdx = new Map(generations.map(({ idx, entry }) => [idx, entry]));
  const candidates = [
    ...collectCandidates({ entries: generations, rowKind: "generation", sessionId, generationByIdx, trajectoryTimestamp, fallbackTimestamp, dbPath }),
    ...collectCandidates({ entries: steps, rowKind: "step", sessionId, generationByIdx, trajectoryTimestamp, fallbackTimestamp, dbPath }),
  ];
  return candidates;
}

async function parseT3AntigravityIncremental({
  dbPaths,
  cursors,
  queuePath,
  projectQueuePath,
  onProgress,
  sqliteOptions,
} = {}) {
  if (!cursors || typeof cursors !== "object") throw new TypeError("cursors must be an object");
  if (typeof queuePath !== "string" || !queuePath) throw new TypeError("queuePath is required");

  const paths = realDbPaths(dbPaths);
  const safeOptions = safeSqliteOptions(sqliteOptions);
  const candidates = [];
  for (let fileIndex = 0; fileIndex < paths.length; fileIndex += 1) {
    const dbPath = paths[fileIndex];
    const sessionId = path.basename(dbPath, ".db");
    const fallbackTimestamp = Math.trunc(fs.statSync(dbPath).mtimeMs);
    candidates.push(...readDatabase(dbPath, sessionId, fallbackTimestamp, safeOptions));
    if (typeof onProgress === "function") {
      onProgress({ index: fileIndex + 1, total: paths.length, filesProcessed: fileIndex + 1 });
    }
  }

  const antigravityCursor = cursors.t3Antigravity && typeof cursors.t3Antigravity === "object"
    ? cursors.t3Antigravity
    : {};
  const fallbackTimestamps = antigravityCursor.fallbackTimestamps && typeof antigravityCursor.fallbackTimestamps === "object"
    ? { ...antigravityCursor.fallbackTimestamps }
    : {};
  const events = mergeCandidates(candidates, fallbackTimestamps);
  const messages = events.map((event) => {
    const id = `t3-antigravity:${event.identity}`;
    return {
      id,
      sessionID: event.sessionId,
      timeUpdated: event.timestampMs,
      data: {
        id,
        sessionID: event.sessionId,
        providerID: `${event.sessionId}:${event.identity}`,
        modelID: event.model || UNKNOWN_MODEL,
        // rollout.coerceEpochMs uses Number(value), so keep this as epoch ms.
        time: { created: event.timestampMs },
        tokens: {
          input: event.input,
          output: Math.max(0, event.output - event.reasoning),
          reasoning: event.reasoning,
          cache: { read: event.cacheRead, write: event.cacheWrite },
        },
      },
    };
  });

  // Only these branches are changed by the shared parser. Cloning unrelated
  // provider histories can exhaust the heap on machines with large archives.
  const workingState = { hourly: cursors.hourly, t3Antigravity: cursors.t3Antigravity };
  if (projectQueuePath) workingState.projectHourly = cursors.projectHourly;
  const workingCursors = typeof structuredClone === "function"
    ? structuredClone(workingState)
    : JSON.parse(JSON.stringify(workingState));
  const result = await parseOpencodeDbIncremental({
    dbMessages: messages,
    cursors: workingCursors,
    queuePath,
    projectQueuePath,
    onProgress,
    source: "antigravity",
    cursorKey: "t3Antigravity",
  });

  for (const key of ["hourly", "projectHourly", "t3Antigravity"]) {
    if (Object.prototype.hasOwnProperty.call(workingCursors, key)) cursors[key] = workingCursors[key];
  }
  if (cursors.t3Antigravity && typeof cursors.t3Antigravity === "object") {
    cursors.t3Antigravity.fallbackTimestamps = fallbackTimestamps;
  }
  return {
    filesProcessed: paths.length,
    eventsAggregated: result.eventsAggregated,
    bucketsQueued: result.bucketsQueued,
    projectBucketsQueued: result.projectBucketsQueued,
  };
}

module.exports = {
  resolveT3AntigravityDbPaths,
  parseT3AntigravityIncremental,
};
