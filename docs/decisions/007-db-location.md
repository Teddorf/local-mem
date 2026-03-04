# ADR-007: Database Location — ~/.local-mem/data/local-mem.db

## Status: Accepted
## Date: 2026-03-04

## Context

The SQLite database must be stored somewhere on disk. Candidate locations include: inside
the project repository, in a user-level config directory (~/.config/), in a user-level
data directory (~/.local-mem/), or in a system-level location. The database contains
context from all projects, not just one.

## Decision

Store the database at `~/.local-mem/data/local-mem.db` by default. The path can be
overridden via the `LOCAL_MEM_DB` environment variable or the `--db` CLI argument
(priority: CLI arg > env var > default).

## Consequences

**Positive:**
- Survives `git clean -fdx` in any project directory.
- Never accidentally committed to version control.
- Not included in default cloud sync paths (Dropbox, iCloud, OneDrive sync ~/Documents,
  not ~/.local-mem unless explicitly configured).
- Single database serves all projects, enabling cross-project context queries.
- Location is predictable and documented; users know where their data lives.

**Negative:**
- Not portable: the database does not travel with the project repository.
- Multi-user scenarios on shared machines would collide (each user gets their own DB,
  which is the intended behavior, but teams cannot share a DB without manual setup).
- Manual backup required; not covered by project-level backup strategies.
