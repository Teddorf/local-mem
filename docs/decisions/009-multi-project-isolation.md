# ADR-009: Multi-Project Isolation via cwd Filtering

## Status: Accepted
## Date: 2026-03-04

## Context

Developers work across multiple projects. Context from project A should not appear in
project B's results by default. Isolation options considered: one database file per
project, separate tables per project, or a single shared database with per-row project
identification filtered at query time.

The MCP server inherits the `cwd` of its spawner (Claude Code), giving us a natural
project identifier without any user configuration.

## Decision

Use a single shared database. Every observation, session, and summary row includes a
`cwd` column storing the normalized absolute path of the project at write time. All
read queries filter by `cwd` unless explicitly requesting cross-project data.

`normalizeCwd()` lowercases the path on Windows (NTFS is case-insensitive) to prevent
silent data fragmentation from path casing inconsistencies.

## Consequences

**Positive:**
- Zero configuration: project isolation is automatic based on working directory.
- Single database is simpler to back up, inspect, and manage.
- Cross-project queries are possible when explicitly requested (e.g., `search` tool
  without cwd filter).
- No file system overhead from managing multiple database files.

**Negative:**
- All projects share a single SQLite WAL and lock. High write concurrency across
  simultaneous Claude Code sessions on different projects could cause brief lock waits
  (mitigated by WAL mode and short transaction windows).
- Renaming or moving a project directory orphans its historical data under the old path.
- No hard enforcement: a query that omits the cwd filter sees all projects' data.
