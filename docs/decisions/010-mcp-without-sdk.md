# ADR-010: Manual MCP Protocol Implementation over SDK

## Status: Accepted
## Date: 2026-03-04

## Context

The Model Context Protocol defines a JSON-RPC 2.0 message exchange over stdio. Anthropic
publishes an official TypeScript SDK (`@modelcontextprotocol/sdk`) that abstracts the
protocol. Using the SDK would simplify implementation but introduce an npm dependency
(and its transitive closure).

local-mem's core constraint is 0 npm dependencies. The MCP stdio protocol is
well-documented and the message surface for a tool server is small.

## Decision

Implement the MCP protocol manually. Parse newline-delimited JSON from stdin, dispatch
on `method`, write JSON responses to stdout. Handle `initialize`, `tools/list`, and
`tools/call` methods. Respond to unknown methods with standard JSON-RPC error codes.

The full implementation fits in a single file (`src/mcp.mjs`).

## Consequences

**Positive:**
- Zero npm dependencies maintained.
- Complete visibility into what is sent and received on the wire.
- No SDK version lag: the implementation tracks exactly the MCP spec version needed.
- Smaller attack surface: no transitive dependencies with unknown behavior.
- Easier to audit: the entire protocol handling is in one readable file.

**Negative:**
- If the MCP spec changes (new required handshake fields, new lifecycle methods), the
  implementation must be updated manually. The SDK would handle this automatically.
- Edge cases in JSON-RPC framing (partial reads, large messages) must be handled
  explicitly rather than delegated to the SDK.
- Higher initial development cost compared to using the SDK.
