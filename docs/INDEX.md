# Documentación — local-mem

## Estructura

```
docs/
├── INDEX.md              ← este archivo
├── decisions/            ← ADRs (Architecture Decision Records)
├── design/               ← documentos de diseño de features
├── guides/               ← guías para usuarios
└── internal/             ← documentos internos de desarrollo
```

## Root (/)

| Archivo | Descripción |
|---------|-------------|
| [README.md](../README.md) | Qué es, instalación rápida, uso básico |
| [SPEC.md](../SPEC.md) | Especificación técnica completa (~2200 líneas, con índice) |
| [CHANGELOG.md](../CHANGELOG.md) | Historial de cambios por versión (Keep a Changelog) |
| [SECURITY.md](../SECURITY.md) | Modelo de seguridad, superficie de ataque, redacción |

## Guías (`docs/guides/`)

| Archivo | Descripción | Audiencia |
|---------|-------------|-----------|
| [GETTING_STARTED.md](guides/GETTING_STARTED.md) | Instalación paso a paso, verificación, primer uso | Usuarios nuevos |
| [USAGE_GUIDE.md](guides/USAGE_GUIDE.md) | Referencia de 12 tools MCP, 4 hooks, flujos comunes | Usuarios diarios |
| [TROUBLESHOOTING.md](guides/TROUBLESHOOTING.md) | Errores comunes, diagnóstico, soluciones | Debugging |

## Diseño (`docs/design/`)

| Archivo | Descripción |
|---------|-------------|
| [PROGRESSIVE_DISCLOSURE.md](design/PROGRESSIVE_DISCLOSURE.md) | Diseño v2 de context injection por niveles (3 niveles, vibe awareness) |

## Decisiones (`docs/decisions/`)

| ADR | Título |
|-----|--------|
| [001](decisions/001-no-http-server.md) | No HTTP server — solo stdio |
| [002](decisions/002-no-auto-install.md) | No auto-install — instalación explícita |
| [003](decisions/003-fts5-over-vectors.md) | FTS5 sobre vectores |
| [004](decisions/004-hybrid-summaries.md) | Resúmenes híbridos (transcript + metadata) |
| [005](decisions/005-bun-sqlite-builtin.md) | SQLite built-in de Bun |
| [006](decisions/006-open-source-strategy.md) | Estrategia open source |
| [007](decisions/007-db-location.md) | Ubicación de la DB |
| [008](decisions/008-redaction-strategy.md) | Estrategia de redacción |
| [009](decisions/009-multi-project-isolation.md) | Aislamiento multi-proyecto |
| [010](decisions/010-mcp-without-sdk.md) | MCP sin SDK |

## Internos (`docs/internal/`)

Documentos de desarrollo, contexto histórico. No necesarios para usar el proyecto.

| Archivo | Descripción |
|---------|-------------|
| [IMPLEMENTATION.md](internal/IMPLEMENTATION.md) | Plan de implementación original v0.1.0 |
| [IMPLEMENTATION_REPORT.md](internal/IMPLEMENTATION_REPORT.md) | Reporte post-implementación v0.1.0 |
| [CONTEXT_SNAPSHOT.md](internal/CONTEXT_SNAPSHOT.md) | Snapshot de contexto SPEC v0.4.0 (histórico) |
| [COMPACT_CONTEXT.md](internal/COMPACT_CONTEXT.md) | Contexto para continuar post-compact v0.7.0 |

## Ejemplos (`examples/`)

| Archivo | Descripción |
|---------|-------------|
| [level3-mockup.md](../examples/level3-mockup.md) | Mockup de output nivel 3 (recovery post-compact) |
