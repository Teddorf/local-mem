# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-03-06

### Added
- **Progressive Disclosure**: 3 levels of context injection adapted to the event source
  - Level 1 (Index Card, ~150 tok): on `/clear` — summary 1-liner + task/step + 1 prompt
  - Level 2 (Full Startup, ~1000 tok): on new session — full summary + cross-session curated + thinking + actions + top scored
  - Level 3 (Full Recovery, ~1400 tok): on compact/resume — everything + 5 thinking blocks + 10 actions + top 10 + transcript thinking
- **Cross-session curated context**: structured data from previous session injected on startup — pending work, open decisions, blockers, technical state, confidence, high-impact actions (Edit/Write/Bash by score), last reasoning, last user request
- **Schema migration v3→v4**: new columns `technical_state TEXT` and `confidence INTEGER` in `execution_snapshots`
- `queryCuratedPrevSession()` — single CTE query joining sessions + execution_snapshots + user_prompts + turn_log (includes `technical_state` and `confidence`)
- `queryPrevHighImpactActions()` — top 5 Edit/Write/Bash observations from previous session by composite_score
- `getDisclosureLevel(source)` — selects level 1/2/3 based on source event (no heuristics)
- `getRecentContext()` accepts `opts.level` for conditional queries per level
- `buildHistoricalContext()` receives `level` for conditional rendering
- `captureTechnicalState(cwd)` — captures TS errors and test summary in auto-snapshots (every 25 obs)
- `confidence` parameter (integer 1-5) in `save_state` MCP tool — stored in `execution_snapshots.confidence`
- `checkContextValidity(snapshot, cwd)` — detects files modified outside Claude Code via `git log` since last snapshot
- Compact thinking capture from transcript (Phase 2)
- Auto-snapshot extracts plan/execution from thinking (Phase 3)

### Changed
- Thinking query LIMIT 1 → LIMIT 5 in `getRecentContext()`
- `buildHistoricalContext()` renders 5 thinking blocks (500 chars each)
- `insertTurnLog()` truncation: thinking 2KB→4KB, response 1KB→2KB
- Prompts: 3→5, truncation 80→120 chars
- Table format → compact bullets (-30% tokens)
- Actions: 5 in level 2, 10 in level 3
- Top scored: 7 in level 2, 10 in level 3

### Fixed
- SessionEnd timeout settings.json 15s → 20s

## [0.6.4] - 2026-03-05

### Fixed
- Score display: `composite_score` showed raw float (e.g., `0.7999999999999999`), now uses `.toFixed(2)` in `session-start.mjs` and `server.mjs`
- Agent detail `[object Object]`: `extractResponseText()` in `observation.mjs` now handles MCP arrays (`[{type:"text", text:"..."}]`)
- Ghost sessions: `session-end.mjs` early returns if 0 observations + 0 prompts
- `session_detail` empty observations: `db.mjs` filtered by `session_id AND cwd` but CD changes cwd mid-session; now filters only by `session_id`
- Thinking capture: `block.thinking` vs `block.text` key mismatch in transcript parsing
- Thinking capture: 200KB cap → 20MB for complete coverage on long sessions (9MB+)

## [0.6.3] - 2026-03-05

### Fixed
- SQL performance: `RECENCY_SQL` evaluated 3 times per row; now uses CTE (`WITH scored AS`)
- Session summaries duplication: `INSERT` with `ON CONFLICT(session_id) DO UPDATE SET`
- Sync session-start ↔ server: missing `thinking_search, top_priority` in tools list, missing `blocking_issues` from snapshot, missing "Archivos clave" column
- `formatTime()` inconsistency: now uses 24h format consistently
- Dead code cleanup: `computeScore()` dead arg, `created_at` fallback, `formatFiles()` dead function, install.mjs duplicate step numbering

## [0.6.2] - 2026-03-04

### Fixed
- Query-time recency: `computeScore()` now calculates base_score WITHOUT recency; `RECENCY_SQL` applies recency band at query time

## [0.6.0] - 2026-03-04

### Added
- Rich detail capture: `distill()` receives `tool_response` as 3rd param, extracts useful detail per tool type (Bash: exit code + output, Grep: matches, WebSearch: titles + URLs, etc.)
- Thinking capture in SessionEnd: parses full transcript for thinking blocks, stores in `turn_log` table
- Auto-snapshots: every 25 observations, captures last 10 actions + last 3 prompts, retains only last 3 per session
- Priority scoring: `composite_score = 0.4*impact + 0.3*recency_band + 0.2*error_flag + 0.1*tool_weight` with dynamic threshold
- Curated context with index: redesigned `buildHistoricalContext()` with sections for thinking, prompts, top scored, session index
- Schema migration v1 → v2: `turn_log` + FTS5, `observation_scores`, `execution_snapshots` additions
- MCP tools: `thinking_search`, `top_priority`
- Extended cleanup: `turn_log` and `observation_scores` retention

### Changed
- Token budget ≤ 800 tokens for injected context (reduced from ~2500)

## [0.1.0] - 2026-03-04

### Added

- SQLite database with schema versioning, WAL mode, and FTS5 full-text search
- 6 tables: `sessions`, `observations`, `user_prompts`, `session_summaries`, `execution_snapshots`, `schema_version`
- Incremental counters via SQL triggers (`observation_count`, `prompt_count` on `sessions`)
- `normalizeCwd()` — Windows-aware path normalization (backslash, trailing slash, lowercase for NTFS)
- `SessionStart` hook — injects recent context, last summary, and last snapshot at session start
- `UserPromptSubmit` hook — records redacted user prompts
- `PostToolUse` hook — distills and records tool uses with 11 tool-specific distillers
- `SessionEnd` hook — generates hybrid session summary (transcript + metadata), closes session
- MCP server (`mcp/server.mjs`) — long-running stdio server, JSON-RPC 2.0, protocol version `2025-03-26`
- 10 MCP tools: `search`, `recent`, `session_detail`, `cleanup`, `export`, `forget`, `context`, `save_state`, `get_state`, `status`
- Secret redaction module (`scripts/redact.mjs`) with 22 regex patterns covering OpenAI, AWS, GitHub, GitLab, Google Cloud, Stripe, SendGrid, Slack, npm, Supabase, Vercel, JWT, PEM keys, Bearer tokens, and generic assignments
- `isSensitiveFile()` — blocks detail recording for `.env*`, `*.pem`, `*.key`, credential files
- `sanitizeXml()` — escapes `&`, `<`, `>` in all injected context text to prevent XML injection
- `sanitizeFtsQuery()` — sanitizes FTS5 queries to prevent syntax errors
- Multi-project isolation — all queries filter strictly by `cwd`; FTS5 search uses JOIN (not post-filter)
- `install.mjs` — installs hooks and MCP server into `~/.claude/settings.json` with backup, merge, and atomic write
- `uninstall.mjs` — removes hooks and MCP server cleanly; preserves database
- `scripts/status.mjs` — health check: DB size, session counts, hook registration, cloud sync warning
- Welcome message on first session for a project
- Orphan session cleanup in `SessionStart` (sessions active > 4 hours → abandoned, scoped to current `cwd`)
- Graceful shutdown for MCP server: `SIGINT`, `stdin.on('end')`, `uncaughtException` handler; Windows-compatible (`SIGTERM` guard)
- Input limits: 1MB stdin cap, 3s absolute timeout, 1MB MCP line buffer, 10KB per JSON field in snapshots
- `transcript_path` validation against path traversal in `SessionEnd`
- `forget` cross-project validation — rejects operation if any ID belongs to a different `cwd`
- Audit logging for `forget` operations (stderr with IDs and timestamp)
- `cleanup` preview mode (default `true`) and minimum 7-day retention
- Conditional `VACUUM` after cleanup (only if > 100 records deleted)
- Required tests for redaction module (`tests/redact.test.mjs`)
- Architecture Decision Records: ADR-001 through ADR-010
