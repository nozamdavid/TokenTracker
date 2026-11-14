# TokenTracker project usage reconciliation

Read-only assessment on 2026-11-14. Live endpoint responses were received at 2026-11-13 23:26–23:27 UTC for the inclusive range `2020-01-01` through `2026-11-14`, with default UTC hour-start date grouping and `scope=all`.

## Reconciled totals

The live usage summary reports **57,682,867,686 billable tokens**. The complete deduplicated project queue reports **12,184,470,919**, leaving **45,498,396,767 unassigned to a project** (21.12% project coverage). Both summary metrics are equal in this range: global `total_tokens` equals `billable_total_tokens`; project aggregate `total_tokens` equals `billable_total_tokens`.

| Provider | Global billable | Project-assigned billable | Difference | Project coverage |
|---|---:|---:|---:|---:|
| Antigravity | 31,073,841,761 | 0 | 31,073,841,761 | 0.000% |
| Claude | 1,727,467,006 | 0 | 1,727,467,006 | 0.000% |
| Codex | 16,298,903,620 | 11,250,104,699 | 5,048,798,921 | 69.024% |
| Grok | 81,272,845 | 656,437 | 80,616,408 | 0.808% |
| Hermes | 80,405,823 | 0 | 80,405,823 | 0.000% |
| Muse | 30,594,348 | 0 | 30,594,348 | 0.000% |
| OpenCode | 8,390,382,283 | 933,709,783 | 7,456,672,500 | 11.128% |

There is no negative provider difference in this snapshot. Antigravity accounts for 68.30% of the overall gap. Codex and OpenCode account for 12,505,471,421 of the gap combined; Claude, Grok, Hermes, and Muse account for the remaining 1,919,083,585.

## Completeness and method

The server queue snapshot contained 3,296 deduplicated global rows and 1,025 deduplicated project rows. File signatures (device, inode, size, mtime, ctime) were unchanged before and after the read. Aggregation used the production keys: `(source, model, hour_start)` for the global queue and `(project_key, source, hour_start)` for the project queue, with later rows replacing earlier rows. The global deduped total matched the live summary exactly; project billable totals matched exactly too.

The project API caps its response at ten entries. This snapshot has ten distinct project keys after the production `claude-mem` pseudo-project exclusion, and the queue-derived top ten matched all ten API entries by key and totals. The endpoint response therefore covers the full current project list; pagination/cap omission does not explain this gap.

## Attribution limits

The result establishes **usage with no project assignment in the project ledger**, not usage proved to have happened outside projects. Queue rows do not retain the working directory or remote metadata needed to distinguish general usage from missing cwd, a missing/private/unsupported remote, or an unavailable project directory.

The T3 Antigravity adapter constructs messages without `path.cwd`; its shared DB project resolver returns no project context when that field is absent. A read-only check of three session IDs from the most recently modified nonempty T3 Antigravity conversation databases found no matching session in the `statev2.sqlite` thread-session projections; no project names or paths were read. This small sample does not identify which Antigravity rows came from T3 or establish that the full Antigravity total is outside projects. Its 31,073,841,761-token amount should be treated as unassigned/unknown.

The other provider differences likewise remain unattributed by this queue-only assessment. In particular, the Codex, OpenCode, and Claude gaps may include projects that cannot be resolved or retained by current attribution metadata; the queue totals alone cannot identify which cause applies.

## Evidence locations

- Global and project queue keys, normalization, and project result cap: [`src/lib/local-api.js`](/home/david/.t3/projects/tokentracker/src/lib/local-api.js:298), [`src/lib/local-api.js`](/home/david/.t3/projects/tokentracker/src/lib/local-api.js:355), and [`src/lib/async-queue-reader.js`](/home/david/.t3/projects/tokentracker/src/lib/async-queue-reader.js:68)
- Provider breakdown billable aggregation and project response aggregation: [`src/lib/local-api.js`](/home/david/.t3/projects/tokentracker/src/lib/local-api.js:3050) and [`src/lib/local-api.js`](/home/david/.t3/projects/tokentracker/src/lib/local-api.js:3214)
- T3 Antigravity message construction and `cwd`-required DB project resolution: [`src/lib/t3-antigravity.js`](/home/david/.t3/projects/tokentracker/src/lib/t3-antigravity.js:674) and [`src/lib/rollout.js`](/home/david/.t3/projects/tokentracker/src/lib/rollout.js:7813)
