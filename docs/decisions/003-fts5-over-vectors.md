# ADR-003: FTS5 Full-Text Search over Vector Embeddings

## Status: Accepted
## Date: 2026-03-04

## Context

Semantic search over stored observations and summaries can be implemented in two ways:
vector embeddings (e.g., ChromaDB, pgvector, sqlite-vss) or traditional full-text search
(SQLite FTS5). Vector search offers semantic similarity; FTS5 offers keyword and phrase
matching with BM25 ranking.

local-mem stores developer context: file names, function names, error messages, technology
names, decisions. This content is highly keyword-dense and benefits from exact-match
retrieval more than semantic fuzzy matching.

## Decision

Use SQLite FTS5 for all search functionality. No vector store, no embedding model, no
external vector database.

FTS5 is compiled into SQLite and therefore into Bun's built-in sqlite module. It requires
zero additional dependencies.

## Consequences

**Positive:**
- Zero external dependencies for search.
- No AI model required at query time (no latency, no API cost, works offline).
- FTS5 BM25 ranking is well-suited for code-related queries.
- Single database file contains both data and search index.
- Instant availability: no index build time beyond SQLite's own FTS indexing.

**Negative:**
- No semantic similarity: "authentication" will not match "login" unless both terms appear.
- Synonyms and paraphrases are not matched.
- Long-term, vector search may offer better recall for natural language queries.
  Planned as a future optional enhancement.
