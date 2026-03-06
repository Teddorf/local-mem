# COMPACT CONTEXT — local-mem v0.7.0 Implementation

> Este archivo contiene TODO el contexto necesario para continuar la implementación después de /compact.
> Leé este archivo completo antes de hacer cualquier otra cosa.

## Estado actual del proyecto

- **Versión**: 0.6.4 (committeada en `cfe9ed7` y `540600c`)
- **Branch**: main (ahead of origin by 2 commits, no pusheado)
- **Tests**: 75/75 unit pass. e2e tiene 25 fallas PRE-EXISTENTES (aislamiento DB, no causadas por nosotros)
- **CWD**: `C:\Users\m_ben\OneDrive\Escritorio\Mike\local-mem`

## Qué se hizo en esta sesión (cronológico)

1. **Smoke test de integración**: Probé las 12 tools MCP + 4 hooks. Todas funcionan.
2. **4 bugs encontrados y fixeados (v0.6.4)**:
   - Score float largo (`0.7999999999999999` → `.toFixed(2)`) en `session-start.mjs:225` y `server.mjs:412`
   - Agent detail `[object Object]`: `extractResponseText()` en `observation.mjs:29` no manejaba arrays MCP
   - Ghost sessions: `session-end.mjs` ahora hace early return si 0 obs + 0 prompts
   - `session_detail` observations vacías: `db.mjs:768` filtraba por `session_id AND cwd`, pero CD cambia cwd mid-session. Ahora filtra solo por `session_id`
3. **2 bugs críticos de thinking capture fixeados**:
   - `block.thinking` vs `block.text`: el transcript usa la key `thinking`, no `text` (`session-end.mjs:84`)
   - Cap 200KB → 20MB: sesiones largas (9MB) perdían 98% de thinking blocks (`session-end.mjs:62`)
4. **Análisis con 4 agentes especializados** para diseñar v0.7.0 (continuidad perfecta post-compact)

## Análisis de los 4 agentes — RESUMEN EJECUTIVO

### Agente 1: Arquitecto de Datos
- 10 tipos de datos identificados con prioridades P0/P1/P2
- Los datos más valiosos (plan, decisiones, modelo mental) los GENERA Claude, no se extraen de tool I/O
- El auto-snapshot actual es un parche: graba "Auto-snapshot at 25 obs" genérico
- Propone estructura `continuity_snapshot` con 5 bloques (~750-1000 tokens)
- **3 problemas estructurales**: momento de captura, naturaleza del dato, curación

### Agente 2: Especialista en Hooks
- NO existe hook PreCompact — solo podemos reaccionar después
- SessionStart recibe `source: "compact"` — es el único momento para actuar
- Transcript JSONL se escribe en append en tiempo real — se puede leer mid-session
- PostToolUse NO recibe thinking — solo tool_name, tool_input, tool_response
- SessionEnd recibe transcript_path pero NO se dispara en compact
- **Discrepancia**: SPEC dice timeout SessionEnd = 20s, settings.json tiene 15s

### Agente 3: Token Budget
- Context window 200K tokens, system prompt ~8-15K
- Budget recomendado: **1,200 tokens para compact, 800 para new session**
- Formato bullets > tables (-30% tokens)
- Estrategia hybrid es correcta: bootstrap crítico + puntero a MCP tools
- Index-first solo NO funciona — Claude no sabe qué pedir sin bootstrap
- Diferenciar output según `source === 'compact'` vs otros

### Agente 4: Thinking/Reasoning
- Transcript es append en tiempo real — se puede leer desde SessionStart(compact)
- Últimos 5 thinking blocks son suficientes (no todos)
- `block.thinking` es la key correcta (ya fixeado en v0.6.4)
- Captura en compact event es la estrategia más viable
- Prioridad: 1) 5 thinking blocks, 2) captura en compact, 3) polling mid-session

## Plan de implementación v0.7.0

### Fase 1 — Quick wins (sin cambio arquitectural)

**1.1** Inyectar 5 thinking blocks en vez de 1:
- `db.mjs` `getRecentContext()` línea ~596: cambiar query `LIMIT 1` → `LIMIT 5`
- `session-start.mjs` `buildHistoricalContext()`: renderizar 5 bloques (viejo→nuevo), 500 chars c/u
- `server.mjs` `formatContextMarkdown()`: sincronizar mismo cambio

**1.2** Aumentar truncado en DB:
- `db.mjs` `insertTurnLog()` línea ~464: thinking `slice(0, 2048)` → `slice(0, 4096)`, response `slice(0, 1024)` → `slice(0, 2048)`

**1.3** Diferenciar compact vs new session:
- `session-start.mjs`: leer `input.source`, si es `'compact'`:
  - Priorizar snapshot + thinking + prompts
  - Reducir índice sesiones a 0-1
  - Budget 1,200 tokens
- Si es `'startup'` u otro:
  - Priorizar resumen + índice sesiones
  - Budget 800 tokens

**1.4** Formato bullets en vez de tables:
- Cambiar las 2 tablas (últimas acciones y top por score) a bullets compactos
- Ejemplo: `- #42 14:30 Edit session-start.mjs: added thinking [0.80]`
- Ahorro: ~30% tokens (~100 tokens libres para más contenido)

**1.5** Prompts y merge:
- Truncar prompts a 120 chars (no 80)
- Merge "últimas 5 acciones" y "top 10 por score" en una sola lista: "Top 7 acciones (por score)"

### Fase 2 — Captura en compact event (cambio arquitectural)

**2.1** Descubrir transcript path:
- En SessionStart, el `session_id` está disponible
- Pattern: `~/.claude/projects/<project-hash>/<session_id>.jsonl`
- Glob: `~/.claude/projects/**/${session_id}.jsonl`

**2.2** Leer transcript en compact:
- Solo cuando `source === 'compact'`
- Leer últimos 500KB del transcript (no todo)
- Extraer últimos 5 thinking blocks + último response text
- Guardar en `turn_log` con el session_id actual

**2.3** Inyectar inmediatamente:
- Los thinking blocks recién extraídos se inyectan en el `additionalContext` de esa misma sesión

### Fase 3 — Auto-save_state inteligente

**3.1** Reemplazar auto-snapshot genérico:
- En vez de "Auto-snapshot at N obs", extraer del último thinking block:
  - Plan en ejecución
  - Punto de ejecución
  - Decisiones tomadas

**3.2** Archivos activos automáticos:
- Extraer de las últimas 25 observaciones los archivos únicos tocados (Edit/Write/Read)
- Guardar en `active_files` del snapshot

### Fix adicional
- Alinear SessionEnd timeout: settings.json 15s → 20s (como dice el SPEC)

## Decisiones abiertas

1. **Token budget compact**: 1,200 tokens (recomendado)
2. **Formato**: bullets (recomendado, -30%)
3. **Transcript path discovery**: glob por session_id (más robusto)
4. **Thinking blocks**: 5 x 500 chars (recomendado)

## Archivos a modificar

| Archivo | Cambios |
|---------|---------|
| `scripts/db.mjs` | getRecentContext LIMIT 5, insertTurnLog truncados, posible nueva función getTranscriptThinking |
| `scripts/session-start.mjs` | buildHistoricalContext diferenciado compact/startup, formato bullets, 5 thinking, merge acciones |
| `scripts/session-end.mjs` | Ya fixeado thinking capture |
| `scripts/observation.mjs` | Fase 3: auto-snapshot inteligente |
| `mcp/server.mjs` | Sincronizar formatContextMarkdown con session-start, version bump |
| `SPEC.md` | Documentar v0.7.0 |
| `~/.claude/settings.json` | Timeout SessionEnd 15→20 |

## Orden de ejecución

Ejecutar Fase 1 completa primero (1.1 → 1.5), correr tests después de cada cambio.
Fase 2 después (depende de Fase 1 para el formato).
Fase 3 al final.

## Contexto técnico relevante

- Bun runtime, no Node.js
- SQLite via `bun:sqlite`
- Windows paths se normalizan con `normalizeCwd()` (lowercase, forward slashes)
- MCP server es long-running stdio JSON-RPC 2.0
- Hooks son procesos efímeros (se spawnan y mueren)
- DB singleton pattern en db.mjs
