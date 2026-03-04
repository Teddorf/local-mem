# ADR-001: MCP Transport — stdio over HTTP

## Status: Accepted
## Date: 2026-03-04

## Context

MCP supports two transport mechanisms: stdio (JSON-RPC over stdin/stdout) and HTTP (SSE or
streamable HTTP). local-mem is a tool designed exclusively for Claude Code running on the
local machine. No external clients, no remote access, no multi-user scenarios.

The question was whether to implement an HTTP server to expose MCP endpoints, or to use
the simpler stdio transport.

## Decision

Use stdio transport exclusively. local-mem does not run an HTTP server.

Claude Code spawns the MCP server as a child process and communicates via stdin/stdout.
This is the standard pattern for local MCP servers.

## Consequences

**Positive:**
- No HTTP server means no open ports, no attack surface.
- No authentication layer needed.
- No CORS configuration.
- Simpler process lifecycle: server lives exactly as long as the Claude Code session.
- Works in any network environment (offline, firewall-restricted, corporate proxies).

**Negative:**
- Not accessible from remote clients or other tools that expect an HTTP endpoint.
- Cannot be shared across machines or users.
- Debugging requires MCP Inspector or log inspection instead of a browser/curl.
