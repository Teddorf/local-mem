# ADR-005: bun:sqlite Built-in over better-sqlite3 / node:sqlite

## Status: Accepted
## Date: 2026-03-04

## Context

SQLite can be accessed from JavaScript via several packages: `better-sqlite3` (native
addon, requires compilation), `node:sqlite` (Node.js 22+ experimental built-in), or
`bun:sqlite` (Bun's built-in, implemented in native C, zero install). local-mem targets
developers already using Claude Code, which ships with Bun support.

The core constraint is 0 npm dependencies. Any package requiring `npm install` is
disqualifying.

## Decision

Use `bun:sqlite` exclusively. Import via `import { Database } from 'bun:sqlite'`.

This module is part of Bun's runtime — no installation, no compilation, no native addon
linking. It exposes a synchronous API backed by a native C implementation.

## Consequences

**Positive:**
- Zero install: available the moment Bun is installed.
- No native addon compilation (no `node-gyp`, no platform-specific build issues).
- Synchronous API simplifies code (no async/await around every query).
- Performance is native C, not a JS wrapper.

**Negative:**
- Bun is a hard runtime requirement. The codebase does not run on Node.js.
- `bun:sqlite` API differs from `better-sqlite3`; migration would require API changes.
- Tied to Bun's release cadence for SQLite bug fixes and version upgrades.
