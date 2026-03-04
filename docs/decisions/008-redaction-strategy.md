# ADR-008: Secret Redaction via Regex Patterns

## Status: Accepted
## Date: 2026-03-04

## Context

Observations and summaries may contain secrets inadvertently: API keys, tokens, passwords,
connection strings. Storing these in plaintext SQLite would be a security liability.
Redaction must happen before any data is written to the database.

Options considered: regex-based pattern matching, entropy analysis, ML-based secret
detection (e.g., GitGuardian API), or no redaction (user responsibility).

## Decision

Apply 22 regex patterns covering known secret formats before any write to the database.
Patterns cover: AWS keys, GitHub tokens, generic Bearer tokens, JWT tokens, connection
strings with passwords, private key PEM blocks, hex/base64 strings above a length
threshold, and common API key patterns.

A catch-all pattern targets high-entropy strings matching common secret shapes. Matched
content is replaced with `[REDACTED]`.

## Consequences

**Positive:**
- Known secret formats are reliably caught before storage.
- Zero latency: regex matching is synchronous and fast.
- No external API calls, no network dependency for redaction.
- Patterns are visible in source; users can audit and extend them.

**Negative:**
- Custom or non-standard secret formats are not detected.
- Base64-encoded or otherwise obfuscated secrets bypass pattern matching.
- False positives possible: long hex strings that are not secrets may be redacted.
- Entropy-based detection (planned) would catch more cases but requires tuning to
  avoid excessive false positives.
