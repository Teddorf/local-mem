# ADR-006: Open Source Strategy — MIT, No Binaries, Full Transparency

## Status: Accepted
## Date: 2026-03-04

## Context

local-mem runs on a developer's local machine with access to conversation history,
file paths, and potentially sensitive context. Users need to be able to verify exactly
what the tool does with their data. Trust is a first-class requirement.

Additionally, the tool has 0 external dependencies by design, making it a good candidate
for community contribution and auditability.

## Decision

Publish under MIT license on a public GitHub repository. All source files use the `.mjs`
extension (plain ES modules, no compilation step). No binary artifacts are distributed.
Users run the source directly via `bun src/index.mjs`.

## Consequences

**Positive:**
- Any developer can read the entire codebase before running it.
- No compiled artifacts means no possibility of hidden behavior in binaries.
- MIT license maximizes reuse and contribution.
- `.mjs` source is the artifact: what you read is what runs.
- Community can audit the redaction logic, DB schema, and MCP implementation.

**Negative:**
- Source-only distribution means Bun is required (no pre-compiled binary for non-Bun users).
- MIT allows forks and commercial use without attribution requirement.
