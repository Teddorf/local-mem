# ADR-004: Hybrid Session Summaries

## Status: Accepted
## Date: 2026-03-04

## Context

At session end, local-mem needs to store a useful summary for future context retrieval.
Two sources of summary data are available: the conversation transcript (Claude's last
assistant message often contains a natural language summary) and structured metadata
collected during the session (tool call counts, files modified, session duration, etc.).

Relying solely on the transcript is fragile: Claude does not always produce a useful
closing summary. Relying solely on metadata misses the rich natural language description
of what was accomplished.

## Decision

Use a hybrid approach: attempt to extract a summary from the transcript (last assistant
message) and always record structured metadata. Both are stored; retrieval uses whichever
is available.

If the transcript yields a non-empty, non-trivial summary, it is stored as the primary
summary. Structured metadata (duration, tool_calls, files_changed, observations_count)
is stored as a JSON column and is always available as a fallback.

## Consequences

**Positive:**
- Summaries degrade gracefully: metadata is always present even if transcript parsing fails.
- Rich natural language summaries when Claude produces them.
- Structured metadata enables filtering and aggregation (e.g., sessions with >10 file changes).

**Negative:**
- Transcript parsing depends on Claude's message format, which may change.
- Two code paths for summary generation add minor complexity.
