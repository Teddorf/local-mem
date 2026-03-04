# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
