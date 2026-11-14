"use strict";

const fs = require("node:fs");

const available = fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB$/m);
const availableKiB = available ? Number(available[1]) : 0;
if (availableKiB < 6 * 1024 * 1024) {
  process.stderr.write(`Local sync skipped: MemAvailable is ${availableKiB} KiB; need at least 6291456 KiB.\n`);
  process.exit(0);
}

const { cmdSync } = require("../src/commands/sync");
cmdSync([], { scanSources: ["claude", "codex", "muse", "antigravity", "opencode"] })
  .catch((error) => {
    process.stderr.write(`Local sync failed: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
