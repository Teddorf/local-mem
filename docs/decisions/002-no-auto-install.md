# ADR-002: No Automatic Software Installation

## Status: Accepted
## Date: 2026-03-04

## Context

Some tools auto-install dependencies, runtimes, or companion services on first run (e.g.,
downloading binaries, running npm install, pulling Docker images). This reduces setup
friction but introduces trust and control issues.

local-mem targets developers who are security-conscious and who use tools like Claude Code
precisely because they want visibility into what runs on their machine.

## Decision

local-mem never downloads, installs, or modifies software automatically. The only
prerequisite is Bun, which the user installs explicitly before use.

Installation is one command (`bun install`) run manually by the user. No postinstall
scripts that fetch remote resources. No runtime downloads.

## Consequences

**Positive:**
- User retains full control over what runs on their machine.
- No surprise network traffic at startup.
- Works in air-gapped environments once Bun is installed.
- Audit-friendly: exactly what you install is what runs.

**Negative:**
- Requires the user to have Bun installed manually.
- Slightly higher setup friction compared to fully automated installers.
