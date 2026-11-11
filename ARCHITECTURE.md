# Architecture

Developer notes for how the two meters read local data and turn it into the numbers on screen. The price tables below match the `PRICES` objects in code. If this file and the code disagree, the code is right and this file should be updated.

Both tools are local. Neither uploads transcripts. The only network call is the one Codex already makes for its own per-chat quota; this repo triggers that call from the Codex page.

## Layout

```
.claude-plugin/marketplace.json          marketplace name: ai-usage-meter
plugins/claude-usage-meter/
  .claude-plugin/plugin.json             userConfig schema and defaults
  hooks/hooks.json                       loads hooks/register.tsx
  hooks/register.tsx                     strip, /usage-meter pane, quota share
  scan.cjs                               transcript scan and Anthropic prices
  types/index.d.ts                       Session, Overview, AccountUsage
  test/scan.test.cjs
codex/
  apply.cjs                              patch and restore Codex Usage Badge 0.10.1
  per-chat-metadata.cjs                  SQLite, token snapshot, OpenAI prices
  per-chat-usage.cjs                     in-page header; re-exports the readers
  test/token-breakdown.test.cjs
```

`package.json` requires Node.js 22.5 or newer because Codex and its tests use `node:sqlite`. `scan.cjs` only uses `node:fs`. There is no install step and no build. `npm test` runs both test files. `npm run codex:apply` and `npm run codex:uninstall` call `codex/apply.cjs`.

## Claude Code plugin

```
session.start / turn.complete / /usage-meter
        │
        ▼
register.tsx  reads account limits, then spawns scan.cjs --all
        │
        ▼
~/.claude/projects/<project>/<session>.jsonl
        and <session>/subagents/*.jsonl
        │
        ▼
plugin state: overview, live, sessionId, isCollapsed, scanError
        │
        ▼
AbovePrompt strip and the usage-meter pane
```

`CLAUDE_CONFIG_DIR` replaces `~/.claude` when it is set. The projects folder is `<that>/projects`. A missing folder throws `Claude session folder not found: …` and the pane shows that text. A later successful scan clears `scanError`. A failed rescan keeps the previous overview and adds a line that the latest read failed.

### When a scan runs

- `session.start` registers `/usage-meter`, restores the collapsed flag, and scans.
- `turn.complete` scans only when `agentId` is undefined, so a subagent turn does not scan by itself. Subagent transcripts are still included the next time the main session scans.
- Opening `/usage-meter` scans again.
- One transcript walk at a time. If a scan is already running, the new account limits are still stored and the second walk is skipped.
- Account limits come from `session.usage().rateLimits`, kinds `five_hour` and `seven_day` (`percentUsed`, `resetsAt`). A new reading replaces the stored one when its weekly percent is present. A null weekly percent leaves the previous reading in place. The first reading is kept even if that percent is null. A thrown read leaves the previous reading in place.

The scanner is a subprocess: `node <plugin root>/scan.cjs --all <weekStartMs> <fiveStartMs>`. `null` means that window is unknown. Results are cached in `USAGE_METER_CACHE`, or `$TMPDIR/claude-usage-meter-cache-v1.json`, keyed by file path, size, and `mtimeMs`. A cache write failure is logged and does not fail the scan.

### Transcript rows

`scan.cjs` walks each `*.jsonl`:

- A `custom-title` row sets the title. Otherwise the title is the first user text, collapsed to 40 characters, skipping text that starts with `<`. If neither exists, the title is the project directory name.
- Assistant rows with `message.usage` and a real model are kept. `<synthetic>` is dropped, not counted as unpriced.
- Rows that share `message.id`, then `requestId`, then `uuid`, collapse to the last one.

`priceResponse(model, usage)` returns token counts even when it cannot price the model (`usd: null`). Those requests increment `unpriced`. The strip does not show `unpriced`.

Cache writes:

- `cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` are priced separately.
- If `cache_creation` is missing, `cache_creation_input_tokens` is priced entirely as a 5-minute write.
- The displayed cache-write token count is the sum. The displayed cache-write dollars are not.

Model lookup is exact, then the first listed id such that the model starts with `id-` or `id@`. Longer ids are listed before the shorter ids they prefix (`claude-opus-5-5` before `claude-opus-5`, and the same for Fable, Sonnet, and Haiku 5.5). A value that is not a string is unpriced and does not throw.

### Anthropic list prices

USD per 1M tokens: input, 5-minute cache write, 1-hour cache write, cache read, output.

| Model id | Input | 5-minute write | 1-hour write | Cache read | Output |
|---|---:|---:|---:|---:|---:|
| `claude-fable-5-1`, `claude-mythos-5-1` | 10 | 12.5 | 20 | 0.25 | 50 |
| `claude-fable-5` | 10 | 12.5 | 20 | 1 | 50 |
| `claude-opus-5-5` | 4 | 5 | 8 | 0.2 | 20 |
| `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5` | 5 | 6.25 | 10 | 0.5 | 25 |
| `claude-sonnet-5-5`, `claude-sonnet-5` | 2 | 2.5 | 4 | 0.2 | 10 |
| `claude-sonnet-4-6`, `claude-sonnet-4-5` | 3 | 3.75 | 6 | 0.3 | 15 |
| `claude-haiku-5-5` | 0.1 | 0.125 | 0.2 | 0.01 | 0.5 |
| `claude-haiku-4-5` | 1 | 1.25 | 2 | 0.1 | 5 |

Haiku 5.5 multiplies the whole request by 5 when `input + cache read + both cache writes` is greater than 100,000. `usage.speed === "fast"` then multiplies by 2 for any model. The two factors stack (10× on a long fast Haiku 5.5 request).

Hit rate is `cacheRead / (cacheRead + cacheWrite + uncachedInput)`, or null when that denominator is 0. Output is not part of it.

### Windows and the session share

`AccountUsage.fiveHourResetsAt` and `weeklyResetsAt` are the window ends. The scanner receives `end - 5 hours` and `end - 7 days`. An unparseable timestamp becomes `null`, which means "no window", not "zero dollars".

A priced response counts toward a window when its timestamp is greater than or equal to that start. `scanAll` returns:

- `sessions`: sessions with at least one request, newest `mtime` first. Each session includes `inWindow: [weekDollars, fiveHourDollars]`.
- `weekUsd` / `fiveUsd`: the sum of those window dollars across every session file, including sessions that are then hidden for having zero requests. `null` when that window start was `null`.

`scan(sessionId)` uses no windows, so `inWindow` is `[]`.

The share on the strip and in the pane is **not** `inWindow`. It is:

```
usdTotal × accountPercentUsed / windowUsd
```

`usdTotal` is the session's lifetime priced cost. The share is hidden when the account percent is under 1, or when `windowUsd` is missing or not positive. Web and mobile usage increases the account percent without increasing `windowUsd`, so local sessions are estimated high. The number may exceed 100.

Subscription value of that share is `share / 100 × (monthlyPrice / weeksPerMonth)`, in `currency`. API dollars stay in USD. In CNY mode the strip also shows `usd × usdToCny`.

`checkedAt` on the overview is the plugin clock when the scan was stored. It is not produced by `scan.cjs`. The status line shows `本会话` plus that session's lifetime API dollars.

### Plugin surface

| Piece | Name |
|---|---|
| Command | `/usage-meter` |
| State keys | `overview`, `live`, `sessionId`, `isCollapsed`, `scanError` |
| Store key | `isCollapsed` (shared across sessions) |
| Exports of `scan.cjs` | `scan`, `scanAll`, `priceResponse`, `saveCache`, `PRICES` |
| CLI | `node scan.cjs <sessionId>` or `node scan.cjs --all <weekStartMs\|null> <fiveStartMs\|null>` |

`Live` was renamed to `AccountUsage`. The old `engineUsd` field was stored and never read. `requestCost` was an unused scanner export; callers use `priceResponse`.

Settings come from `plugin.json` `userConfig` into `register(on, options)`. Non-positive numbers fall back to 140, 4, and 6.8. Currency is `USD` only when the uppercased value is `USD`; every other value is `CNY`.

The pane lists at most `max(3, viewport rows - 6)` sessions.

## Codex patch

Codex Usage Badge 0.10.1 for Windows owns the install. This repo does not vendor it. `apply.cjs` checks that `.codex-usage-badge-owner` contains `local.codexusagebadge.windows`, then patches two files in place.

```
apply.cjs
  reads agent.cjs and bridge.cjs (or their .before-per-chat.bak)
  builds both patches in memory
  writes the backups, copies the two cjs files, then writes the patched sources
        │
        ▼
badge Node process
  readMetadata / readConfig from per-chat-usage.cjs
  pushes rows into the page
        │
        ▼
per-chat-usage.cjs  installPerChatUsage()
  header + sidebar hover text
  safePost('/wham/usage/thread_usage/query_v2') for official percents
```

Default directory: `%LOCALAPPDATA%\CodexUsageBadge`. `--dir` overrides it. `--no-reload` skips `manage-windows.ps1`. Without `--no-reload` the process must be Windows, and this is checked before any write. `--uninstall` restores `agent.cjs` and `bridge.cjs` from the backups, deletes the backups and the copied scripts, and leaves `per-chat-usage.config.json`.

Backups are created only after both patches have been built. A missing anchor, an anchor that matches twice, a missing `agent.cjs`, or a file that is already patched and has no backup throws, and the install is unchanged. Applying again rebuilds the patch from the backup, so the require line is not duplicated.

The patch does not read a version field. It looks for the 0.10.1 source anchors (`installThreadTokens`, the sidebar style, the thread-token snapshot, and `window.__codexUsageBadge?.destroy`). The error names that layout.

What the patch changes in the badge:

- Sidebar token widget shows the total instead of an empty dot, and its hover text includes subagents.
- After the badge reads its own totals, metadata replaces `snapshot.totals[thread]` with `tokens + descendant_tokens` when the parent token count is non-null.
- The page receives `updateMetadata(rows, settings)` for the visible threads.
- Bridge teardown also calls `__codexPerChatUsage.destroy()`.

`installPerChatUsage` is self-contained. It must not close over Node exports: the badge runs that function where `window` and `document` exist. Its fallback settings literal matches `DEFAULT_CONFIG`. The page object is `window.__codexPerChatUsage` at version 7, with `refresh`, `updateMetadata`, `status`, `refreshUsage`, and `destroy`.

### Local Codex data

`CODEX_HOME` or `~/.codex` holds `state_<n>.sqlite`. The highest `n` wins. `readMetadata` keeps UUID thread ids and loads the thread plus recursive rows from `thread_spawn_edges`.

Token breakdown (`readTokenBreakdown`) reads the rollout JSONL from the end and uses the latest `token_count` event whose cumulative `total_token_usage` is internally consistent: safe integers, `cached <= input`, and `total === input + output`. Reasoning tokens sit inside output and are not added again. Repeated cumulative snapshots are not summed. A missing or inconsistent counter is null, not zero. Parent and descendants are added only when every part has a breakdown; otherwise the combined breakdown is null and the UI shows "—". Token totals then fall back to the `tokens_used` column for the parent and for each child that lacks a breakdown. An unusable child value counts as 0. An unusable parent total stays null.

Hit rate is `cachedInput / input`. That denominator does **not** match Claude's hit rate: Claude also puts cache writes in the denominator, and Codex does not show cache writes as a token cell.

### OpenAI list prices

USD per 1M tokens. Exact model id only; there is no prefix match. A snapshot suffix that is not in the table makes the whole rollout's API cost unknown.

| Model id | Input | Cached input | Output |
|---|---:|---:|---:|
| `gpt-6-astra` | 10 | 1 | 50 |
| `gpt-6.1-sol` | 2 | 0.1 | 10 |
| `gpt-6.1-terra` | 1 | 0.05 | 5 |
| `gpt-6-luna` | 0.1 | 0.01 | 0.5 |

`readApiCost` walks the rollout from the start and continues from the last byte on the next read. `turn_context` updates the model; before the first one, the thread's `model` column is the fallback (null if that column does not exist).

Each `token_count` contributes the delta from the previous cumulative counters. If input or output moved backwards, the previous baseline is dropped and the current cumulative totals are priced as one request. Identical repeats add nothing.

Cache-write tokens are `min(write delta, uncached input delta)` and cost `1.25 × input price`. They are part of the dollar total only.

Long context is `last_token_usage.input_tokens` when present, otherwise the input delta, and it applies when that value is **greater than** 272,000. The whole input side, including cache reads and cache writes, is multiplied by 2, and output by 1.5.

If any request's model is missing from the table, that rollout's cost becomes null even if other requests were priced. `combineCosts` then nulls the chat when the parent or any descendant is null. The header shows "—", not `$0.00`.

### Official quota versus subscription value

The header's 5-hour percent, weekly percent, and credits come from `safePost('/wham/usage/thread_usage/query_v2')` on the Codex app client. The client is whichever export has `safePost`. On 0.10.1 the bundle also exposes a minified initializer, `sRr`, which is called if present. Threads are posted in batches of at most 100 threads and 1000 ids. A thread with 1000 or more ids is skipped. Results are kept only when `data_status === "available"`. These percentages can exceed 100. They are the same source as Codex's chat usage ranking.

A failed fetch clears the quota map, leaves tokens and API cost alone, and puts `error.message` on the panel tooltip (`Codex app bundle not found` and `Usage client unavailable` are the two messages this file throws itself).

Subscription value is `weeklyPercent / 100 × (monthlyPrice / weeksPerMonth)` using those official weekly percents, in `currency`. The cell, the sidebar tooltip, and `data-weekly-cost` all use that currency. `data-api-cost-usd` stays in dollars. The old `data-weekly-cost-cny` attribute was misnamed once USD was a real setting, and it is no longer written.

`readConfig` reads `per-chat-usage.config.json` next to the copied script. A missing file is the defaults. Invalid JSON, or JSON that is not an object, is reported on stderr and the defaults are used. Non-positive numbers are ignored one field at a time. Currency must be `CNY` or `USD` after uppercasing.

Keep these four defaults in sync: `plugin.json` `userConfig`, `DEFAULT_CONFIG` in `per-chat-metadata.cjs`, the fallback object inside `installPerChatUsage`, and the settings table in the README.

### Codex module surface

| Module | Exports |
|---|---|
| `apply.cjs` | `patchAgent`, `patchBridge`, `apply`, `uninstall` |
| `per-chat-metadata.cjs` | `readMetadata`, `readTokenBreakdown`, `readApiCost`, `readConfig`, `DEFAULT_CONFIG`, `PRICES` |
| `per-chat-usage.cjs` | `installPerChatUsage`, plus re-exported `readMetadata` and `readConfig` |

The patched badge imports the re-exports so it can load one file.

## Environment

| Variable | Used by | Effect |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `scan.cjs` | Parent of `projects`. Default `~/.claude` |
| `USAGE_METER_CACHE` | `scan.cjs` | Transcript parse cache path |
| `CODEX_HOME` | `readMetadata` | Directory of `state_<n>.sqlite`. Default `~/.codex` |
| `LOCALAPPDATA` | `apply.cjs` | Parent of the default `CodexUsageBadge` install. Required unless `--dir` is passed |

## What is estimated

| Number | Claude | Codex |
|---|---|---|
| Token counts | Sum of deduped usage rows, subagents included | Latest consistent cumulative snapshot, subagents added |
| API dollars | Sum of priced requests | Sum of rollout deltas; one unknown model blanks the chat |
| 5-hour and weekly share | Estimated from lifetime API dollars and local window dollars | Official per-chat API |
| Money at the subscription price | Estimated share × weekly value | Official weekly percent × weekly value |
| Account remaining | Official `100 − percentUsed` | Left to the original badge |
