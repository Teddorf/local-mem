# PLAN DE IMPLEMENTACIÓN — local-mem v0.1.0

**Basado en**: SPEC v0.4.4
**Fecha**: 2026-03-04
**Total**: 28 archivos, ~2,565 líneas, 0 dependencias externas

---

## Índice de Tareas de Implementación

| # | Tarea | Archivos | Líneas aprox | Dependencias | Agente | Modelo | Workers |
|---|-------|----------|-------------|--------------|--------|--------|---------|
| T1 | Core DB + Schema | `scripts/db.mjs` | ~420 | ninguna | DB Architect | **opus** | 1 |
| T2 | Módulo Redact | `scripts/redact.mjs` | ~120 | ninguna | Security Engineer | **sonnet** | 1 |
| T3 | Tests de Redact | `tests/redact.test.mjs` | ~80 | T2 | Security Engineer | **sonnet** | 1 |
| T4 | Helper stdin | `scripts/stdin.mjs` | ~40 | ninguna | Systems Engineer | **haiku** | 1 |
| T5 | Hook SessionStart | `scripts/session-start.mjs` | ~120 | T1, T2, T4 | Hooks Engineer | **sonnet** | 1 |
| T6 | Hook PromptSubmit | `scripts/prompt-submit.mjs` | ~40 | T1, T2, T4 | Hooks Engineer | **haiku** | 1 |
| T7 | Hook PostToolUse | `scripts/observation.mjs` | ~90 | T1, T2, T4 | Hooks Engineer | **sonnet** | 1 |
| T8 | Hook SessionEnd | `scripts/session-end.mjs` | ~80 | T1, T4 | Hooks Engineer | **sonnet** | 1 |
| T9 | MCP Server | `mcp/server.mjs` | ~600 | T1, T2 | MCP Protocol Engineer | **opus** | 2 |
| T10 | Health Check | `scripts/status.mjs` | ~60 | T1 | Systems Engineer | **haiku** | 1 |
| T11 | Instalador | `install.mjs` | ~180 | T1 | DX Engineer | **sonnet** | 1 |
| T12 | Desinstalador | `uninstall.mjs` | ~70 | ninguna | DX Engineer | **haiku** | 1 |
| T13 | Package + Config | `package.json`, `.gitignore`, `LICENSE` | ~45 | ninguna | Systems Engineer | **haiku** | 1 |
| T14 | Documentación | `README.md`, `SECURITY.md`, `CHANGELOG.md` | ~390 | T1-T12 | Technical Writer | **sonnet** | 1 |
| T15 | ADRs | `docs/decisions/001-010` (10 archivos) | ~275 | ninguna | Technical Writer | **sonnet** | 1 |

### Estrategia de modelos

| Modelo | Tareas | Justificación |
|--------|--------|---------------|
| **opus** | T1 (db.mjs), T9 (server.mjs) | Las 2 piezas más complejas (~1000 líneas combinadas). SQL+FTS5+triggers, protocolo JSON-RPC+10 tools |
| **sonnet** | T2,T3,T5,T7,T8,T11,T14 + QA1-QA7 + R1-R3 | Grueso del trabajo: hooks con lógica media, tests, docs, reviews (17 invocaciones) |
| **haiku** | T4,T6,T10,T12,T13,T15 | Archivos cortos/simples con lógica bien definida en el SPEC (6 invocaciones) |

**Nota**: local-mem NO usa ningún modelo de Claude en runtime. Es 100% local (Bun + SQLite). Los modelos listados son para los agentes que **escriben el código** durante la implementación.

---

## Fase 0 — Análisis Pre-Implementación ✅ COMPLETADA

Fase 0 ya se ejecutó: 14 agentes (7 implementadores + 7 testers) analizaron el SPEC. Se encontraron 9 gaps convergentes que fueron aplicados al SPEC v0.4.2→v0.4.3. Resultado: 610 test cases, score promedio 7.9/10, Go aprobado.

---

## Flujo de Review Inline (3 reviewers después de CADA tarea)

Los reviewers son **Staff Engineers del top 0.1% mundial**. NO esperan a que termine toda la implementación — **revisan cada tarea apenas se completa**. Si encuentran defectos, el implementador los corrige antes de que la tarea se considere terminada.

### Agentes Reviewer

| # | Reviewer | Especialidad top 0.1% | Scope | Criterios |
|---|----------|----------------------|-------|-----------|
| R1 | **Architecture Reviewer** | Staff Engineer / Arquitecto de software del top 0.1% mundial | Estructura de cada archivo, API contracts, imports, error handling, dead code, over-engineering | ✅ APPROVED / ⚠️ COMMENTS / ❌ CHANGES REQUESTED |
| R2 | **Security Reviewer** | Staff Engineer / Auditor de seguridad del top 0.1% mundial | Redacción en puntos de entrada, prepared statements, no console.log en stdout MCP, sanitizeXml, path traversal, try/catch, exit 0, permisos | ✅ APPROVED / ⚠️ COMMENTS / ❌ CHANGES REQUESTED |
| R3 | **SPEC Compliance Reviewer** | Staff Engineer / Compliance del top 0.1% mundial | Cada requisito del SPEC implementado, naming correcto, formatos exactos, valores default, error codes | ✅ APPROVED / ⚠️ COMMENTS / ❌ CHANGES REQUESTED |

### Flujo por tarea

```
Implementador escribe código (Tx)
         │
         ▼
┌─────────────────────────────────┐
│  3 REVIEWERS EN PARALELO        │
│  R1 (Arch) + R2 (Sec) + R3 (SPEC) │
│  Revisan Tx vs SPEC + calidad   │
└─────────┬───────────────────────┘
          │
    ┌─────┴─────┐
    │           │
  ✅ OK      ❌ CHANGES REQUESTED
    │           │
    │     Implementador corrige
    │           │
    │     Reviewers re-verifican
    │           │
    └─────┬─────┘
          │
     Tx COMPLETADA
```

### Prompt de cada reviewer (por tarea)

```
Sos un Staff Engineer / {especialidad} del top 0.1% mundial.
Razona con Rol Research --all.

Tu tarea: Code review de {archivo} (tarea {Tx}). Revisa código que NO escribiste.

Contexto: Lee las secciones relevantes del SPEC v0.4.4 y compara con el código.

Criterios de review:
1. SPEC COMPLIANCE: ¿El código cumple con el SPEC v0.4.4? Requisito por requisito.
2. CORRECTNESS: ¿La lógica es correcta? ¿Hay bugs?
3. SECURITY: ¿Hay vulnerabilidades? ¿Se aplica redacción donde corresponde?
4. QUALITY: ¿Código limpio, legible, mantenible? ¿Sin over-engineering?
5. EDGE CASES: ¿Se manejan inputs inválidos, archivos faltantes, permisos, encoding?
6. CONSISTENCY: ¿Estilo consistente con otros archivos ya aprobados?

Output:
- ✅ APPROVED / ⚠️ APPROVED WITH COMMENTS / ❌ CHANGES REQUESTED
- Lista de findings: BLOCKER / MAJOR / MINOR / NIT
- Propuesta de fix para cada finding
```

### Qué revisa cada reviewer por tarea

| Tarea | R1 (Architecture) | R2 (Security) | R3 (SPEC Compliance) |
|-------|-------------------|---------------|---------------------|
| T1 db.mjs | API exports, schema structure, separation of concerns | Prepared statements, no string concat in SQL, WAL config | 6 tablas, 20 funciones, indices, triggers, pragmas, FTS5 JOIN cwd |
| T2 redact.mjs | Module exports, function signatures | 22 patrones, bypass resistance, regex performance | Patrones exactos, redactObject, sanitizeXml(&), truncate, isSensitiveFile |
| T3 tests | Test structure, coverage | Tests cubren bypass attempts | 1+ test por patrón, false positives, edge cases per SPEC |
| T4 stdin.mjs | Promise API, cleanup | MAX_STDIN_SIZE 1MB, timeout, no memory leak | Límite 1MB, timeout absoluto, safeParse |
| T5 session-start | Imports from db/redact/stdin, output format | sanitizeXml en todo output, cwd isolation, no raw prompts | Stdin fields, abandonOrphanSessions(cwd), contexto format, bienvenida |
| T6 prompt-submit | Imports, validation pattern | redact() applied before insert | Stdin fields, redact→insert, output "Success", exit 0 |
| T7 observation | Destiladores, SKIP_TOOLS list | redact() on action+detail, SENSITIVE_FILES check | 11 destiladores, SKIP_TOOLS list exacta, dedup Read |
| T8 session-end | Transcript reading logic | Path traversal validation on transcript_path | SessionEnd (NOT Stop), 50KB limit, resumen híbrido |
| T9 server.mjs | Lifecycle, routing, tool dispatch | No console.log on stdout, all stderr, error handling | 10 tools, descriptions, schemas, error codes, line buffer, ping, naming |
| T10 status.mjs | Output format, DB access | No sensitive data in output | Health check fields per SPEC |
| T11 install.mjs | Merge logic, atomic write | Backup, permissions, no destructive overwrite | Merge hooks array, mcpServers, cloud sync warning |
| T12 uninstall.mjs | Cleanup logic | Backup, only remove local-mem entries | No delete DB, atomic write, backup |
| T14 docs | Structure, accuracy | No secrets in examples | Claims match code, versions consistent, cross-refs |
| T15 ADRs | ADR format (Context/Decision/Consequences) | No sensitive info | 10 ADRs, topics match SPEC decisions |

---

## FASE 1 — Fundaciones (sin dependencias entre sí)

**Paralelo máximo: 6 implementadores + reviewers por tarea completada (tier system)**

```
Implementación (paralelo):
├── T1:  DB Architect        → scripts/db.mjs         → [R1+R2+R3 review] → ✅  (Tier A)
├── T2:  Security Engineer   → scripts/redact.mjs     → [R1+R2+R3 review] → ✅  (Tier A)
├── T4:  Systems Engineer    → scripts/stdin.mjs      → [R3 review]       → ✅  (Tier C)
├── T12: DX Engineer         → uninstall.mjs          → [R3 review]       → ✅  (Tier C)
├── T13: Systems Engineer    → package.json, etc.     → [R3 review]       → ✅  (Tier C)
└── T15: Technical Writer    → 10 ADRs               → [R3 review]       → ✅  (Tier C)
```

### Gate: Micro-test funcional de T1

**ANTES de iniciar Fase 2**, ejecutar un test rápido de T1 (db.mjs):
1. Importar `db.mjs` y llamar `getDb()` con path temporal
2. Verificar que las 6 tablas existen (`SELECT name FROM sqlite_master WHERE type='table'`)
3. Verificar que las 20 funciones son exportadas
4. Insertar una sesión + observación + prompt, verificar counters via triggers
5. Si falla → bloquear Fase 2 hasta que T1 se corrija

Este gate previene que 9 tareas de Fase 2 dependan de un db.mjs roto.

---

## FASE 2 — Módulos dependientes

**Paralelo máximo: 5 implementadores + reviewers por tarea (tier system). Requiere: Fase 1 aprobada + micro-test T1 OK.**

```
Implementación (paralelo, después de gate de T1):
├── T3:  Security Engineer    → tests/redact.test.mjs  → [R2+R3]    → ✅  (Tier B)
├── T5:  Hooks Engineer       → session-start.mjs      → [R1+R2+R3] → ✅  (Tier A)
├── T6:  Hooks Engineer       → prompt-submit.mjs      → [R2+R3]    → ✅  (Tier B)
├── T7:  Hooks Engineer       → observation.mjs        → [R1+R2+R3] → ✅  (Tier A)
├── T8:  Hooks Engineer       → session-end.mjs        → [R1+R2+R3] → ✅  (Tier A)
├── T9A: MCP Protocol Eng.    → server.mjs [skeleton]  → [R1+R2+R3] → ✅  (Tier A)
│   └── T9B (SECUENCIAL después de T9A aprobado):
│         MCP Protocol Eng.    → server.mjs [10 tools]  → [R1+R2+R3] → ✅  (Tier A)
├── T10: Systems Engineer     → status.mjs             → [R3]       → ✅  (Tier C)
└── T11: DX Engineer          → install.mjs            → [R1+R2+R3] → ✅  (Tier A)
```

**Nota**: T9B es SECUENCIAL dentro de Fase 2 — espera a que T9A pase review antes de implementar las 10 tools.

---

## FASE 3 — Documentación final

**1 implementador + 3 reviewers**

```
└── T14: Technical Writer → README, SECURITY, CHANGELOG → [R1+R2+R3] → ✅
```

---

## FASE 4 — Testing (7 agentes tester en paralelo)

Cada agente tester es un **QA Engineer del top 0.1% mundial** que verifica la implementación contra el SPEC. NO confían en que el implementador hizo todo bien — verifican independientemente.

### Agentes Tester

| # | Tester | Qué testea | Verificaciones |
|---|--------|-----------|----------------|
| QA1 | **DB Tester** | `scripts/db.mjs` | Schema match con SPEC, 20 funciones exportadas, normalizeCwd, sanitizeFtsQuery, pragmas, FTS5 JOIN cwd, forget valida cwd, prepared statements, triggers, indices, migrations, ON CONFLICT, WAL |
| QA2 | **Security Tester** | `scripts/redact.mjs` + `tests/redact.test.mjs` | Ejecuta `bun test`, verifica 22 patrones, false positives, redactObject recursivo, sanitizeXml (& primero), isSensitiveFile, edge cases (null, empty, huge strings) |
| QA3 | **Hooks Tester** | Los 4 hooks + `stdin.mjs` | Simula stdin de Claude Code para cada hook, verifica output format, try/catch global, exit 0, validación de campos, redacción aplicada, SKIP_TOOLS, dedup Read, SENSITIVE_FILES, path traversal en SessionEnd, bienvenida |
| QA4 | **MCP Protocol Tester** | `mcp/server.mjs` | Simula lifecycle completo (initialize → tools/list → tools/call → ping → shutdown), verifica line buffering, JSON malformado → -32700, método desconocido → -32601, tool results format, SIGTERM cleanup, 10 tools con params válidos e inválidos |
| QA5 | **Integration Tester** | Todo junto | Flujo end-to-end: install → SessionStart → PromptSubmit → PostToolUse × N → SessionEnd → nueva sesión → verificar contexto inyectado. Multi-proyecto: dos cwds simultáneos → verificar aislamiento |
| QA6 | **DX Tester** | `install.mjs` + `uninstall.mjs` + `status.mjs` | Install en directorio limpio, install con hooks existentes (merge), install ya instalado (idempotente), uninstall limpio, status OK, permisos de archivos |
| QA7 | **Docs Tester** | README, SECURITY, CHANGELOG, 10 ADRs | Cada afirmación en docs existe en el código, links internos válidos, versiones consistentes, no hay features documentadas sin implementar ni features implementadas sin documentar |

### Prompt de cada tester (Fase 4)

```
Sos un QA Engineer del top 0.1% mundial. Razona con Rol Research --all.

Tu tarea: Verificar que la implementación de {componente} cumple AL 100%
con el SPEC v0.4.4. NO confíes en que el implementador lo hizo bien.

Proceso:
1. Lee el SPEC completo (secciones relevantes a tu área)
2. Lee el código implementado
3. Genera una MATRIZ DE VERIFICACIÓN: cada requisito del SPEC → ¿implementado? (sí/no/parcial)
4. Si encontrás un requisito NO implementado o PARCIAL:
   - Clasifica: BLOCKER / MAJOR / MINOR
   - Describe qué falta exactamente
   - Propone el fix
5. Ejecuta tests si aplica (bun test)
6. Score: % de cumplimiento con el SPEC

Output: Matriz de verificación + lista de defectos + score
```

---

## FASE 5 — Fix & Final (según resultados de Fase 4)

Si los testers encuentran defectos BLOCKER o MAJOR (los reviewers ya corrigieron lo suyo inline):
1. El agente implementador original recibe la lista de defectos
2. Aplica los fixes
3. Los 3 reviewers re-revisan los archivos modificados
4. El tester correspondiente re-verifica SOLO los items corregidos
5. Loop hasta 0 BLOCKERs y 0 MAJORs

---

## Diagrama de Dependencias Completo

```
               FASE 0: ANÁLISIS ✅ COMPLETADA
              (14 agentes, 610 test cases, 9 gaps → SPEC v0.4.4)
                         │
                    FASE 1: FUNDACIONES
              ┌─────┬─────┬─────┬─────┬─────┐
              T1    T2    T4   T12  T13   T15       ← 6 implementadores
              DB    RED   STDIN UNIN PKG   ADRs
              │     │     │     │    │     │
              ▼     ▼     ▼     ▼    ▼     ▼
            [review por tier]                       ← reviewers inline
              │     │     │     │    │     │
              ✅    ✅    ✅    ✅   ✅    ✅
              └──┬──┴──┬──┴──┬──┘    │     │
                 │     │     │       │     │
                    FASE 2: MÓDULOS
    ┌────┬────┬────┬────┬─────┬─────┬────┬────┐
    T3   T5   T6   T7   T8   T9A   T9B  T10  T11   ← 9 workers
    TEST SS   PS   PTU  SE   MCPA  MCPB STAT INST
    │    │    │    │    │     │     │    │    │
    ▼    ▼    ▼    ▼    ▼     ▼     ▼    ▼    ▼
  [review por tier]                                 ← reviewers inline
    │    │    │    │    │     │     │    │    │
    ✅   ✅   ✅   ✅   ✅    ✅    ✅   ✅   ✅
    └────┴────┴────┴────┴─────┴─────┴────┴────┘
                         │
                    FASE 3: DOCS
                        T14                              ← 1 implementador
                    README+SEC+CL
                         │
                    [R1+R2+R3 review]                    ← 3 reviewers inline
                         │
                         ✅
                         │
                    FASE 4: TESTING (7 testers en paralelo)
    ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┐
    QA1   QA2   QA3   QA4   QA5   QA6   QA7
    DB    SEC   HOOK  MCP   INTEG DX    DOCS
    └─────┴─────┴─────┴─────┴─────┴─────┴─────┘
                         │
                    FASE 5: FIX & FINAL (si hay defectos)
                 Fix → [R1+R2+R3] → Re-test → ✅
```

---

## Resumen Total de Agentes y Workers

### Agentes Implementadores (top 0.1% mundial)

| # | Agente | Especialidad | Tareas | Modelo | Workers |
|---|--------|-------------|--------|--------|---------|
| 1 | **DB Architect** | SQLite, FTS5, WAL, migrations, triggers | T1 | **opus** | 1 |
| 2 | **Security Engineer** | Regex, redacción, sanitización, crypto patterns | T2, T3 | **sonnet** | 1 |
| 3 | **Hooks Engineer** | Claude Code hooks, stdin protocol, destiladores | T5, T6, T7, T8 | **sonnet/haiku** | 1 |
| 4 | **MCP Protocol Engineer** | MCP 2025-03-26, JSON-RPC 2.0, stdio servers | T9 | **opus** | 2 |
| 5 | **DX Engineer** | Instaladores CLI, settings merge, atomic writes | T11, T12 | **sonnet/haiku** | 1 |
| 6 | **Technical Writer** | Docs técnicos, ADRs, README, SECURITY | T14, T15 | **sonnet/haiku** | 1 |
| 7 | **Systems Engineer** | Cross-platform, Bun runtime, process signals | T4, T10, T13 | **haiku** | 1 |

### Agentes Tester (top 0.1% mundial)

| # | Tester | Área | Modelo | Workers |
|---|--------|------|--------|---------|
| QA1 | DB Tester | Schema, queries, FTS5 | **sonnet** | 1 |
| QA2 | Security Tester | Redact, sanitize, tests | **sonnet** | 1 |
| QA3 | Hooks Tester | 4 hooks + stdin | **sonnet** | 1 |
| QA4 | MCP Protocol Tester | Server lifecycle + 10 tools | **sonnet** | 1 |
| QA5 | Integration Tester | End-to-end + multi-proyecto | **sonnet** | 1 |
| QA6 | DX Tester | Install, uninstall, status | **sonnet** | 1 |
| QA7 | Docs Tester | Docs vs código vs SPEC | **sonnet** | 1 |

### Agentes Reviewer (top 0.1% mundial)

| # | Reviewer | Scope | Modelo | Workers |
|---|----------|-------|--------|---------|
| R1 | Architecture Reviewer | Estructura, APIs, coherencia | **sonnet** | 1 |
| R2 | Security Reviewer | Todos los archivos, seguridad | **sonnet** | 1 |
| R3 | SPEC Compliance Reviewer | SPEC vs código al 100% | **sonnet** | 1 |

### Totales por Fase

| Fase | Agentes | Workers | Descripción |
|------|---------|---------|-------------|
| 0 — Análisis | 14 | 14 | ✅ COMPLETADA — 610 test cases, 9 gaps aplicados |
| 1 — Fundaciones | 6 impl + 3 rev | 6+3 | 6 módulos base (T1,T2,T4,T12,T13,T15) + review inline |
| 2 — Módulos | 6 impl + 3 rev | 9+3 | 9 tareas dependientes + review inline |
| 3 — Docs | 1 impl + 3 rev | 1+3 | README, SECURITY, CHANGELOG + review |
| 4 — Testing | 7 | 7 | 7 testers verifican contra SPEC |
| 5 — Fix | variable + 3 rev | variable | Correcciones + re-review + re-test |
| **TOTAL** | **17 únicos** | **14 max simultáneos** | Reviewers reutilizados en cada fase |

**Nota**: Los 3 reviewers actúan en Fases 1-3 y 5 (no en Fase 0 ni 4). Revisan cada tarea apenas se completa, en paralelo entre sí.

---

## Prompt Template para Implementadores (Fases 1-3)

Cada agente implementador recibe este prompt base + su sección específica del SPEC:

```
Sos un {especialidad} del top 0.1% mundial.

Tu tarea: Implementar {archivo} según el SPEC v0.4.4 de local-mem.
Tenés tu checklist de Fase 0 como referencia adicional.

REGLAS DE CÓDIGO (OBLIGATORIAS — violar cualquiera es BLOCKER):
1. ESM puro: import/export, NO require/module.exports
2. 0 dependencias externas. Solo bun:sqlite (nativo de Bun)
3. Sin TypeScript — .mjs puro, sin JSDoc types
4. Sin console.log en stdout (MCP usa stdout). Todo log → process.stderr.write()
5. Hooks: try/catch global → stderr log → process.exit(0) SIEMPRE
6. MCP tool results: content: [{type: "text", text: JSON.stringify(data)}]
7. SQL: prepared statements SIEMPRE. NUNCA string concat/template literals en queries
8. Redacción: llamar redact() en TODO dato que venga del usuario antes de INSERT
9. Aislamiento: TODA query filtra por cwd. NUNCA retornar datos de otro proyecto
10. normalizeCwd(): usar en todo punto de entrada que reciba cwd
11. Encoding: process.stdin.setEncoding('utf8') donde se lea stdin
12. Errores MCP: JSON-RPC 2.0 format con codes (-32700, -32601, -32602, -32603)
13. Sin over-engineering: NO agregar features no pedidas en el SPEC
14. Sin comentarios redundantes: el código debe ser autoexplicativo

PATRONES DE REFERENCIA:
- Hook skeleton:
  try {
    const data = await readStdin();  // scripts/stdin.mjs
    // ... lógica
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[local-mem] ${err.message}\n`);
    process.exit(0);  // SIEMPRE exit 0, no romper Claude
  }

- MCP tool result:
  { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }] }

- MCP error result:
  { content: [{ type: "text", text: JSON.stringify({ error: msg }) }], isError: true }

Output: El archivo completo, listo para guardar. Sin explicaciones.
```

---

## Modo de Ejecución Autónoma

La implementación se ejecuta de forma **100% autónoma** — sin intervención humana, sin preguntas, sin pausas.

### Directiva principal

```
Implementar TODO el proyecto local-mem siguiendo este IMPLEMENTATION.md fase por fase,
usando el SPEC.md v0.4.4 como fuente de verdad. Ejecutar de forma AUTÓNOMA sin preguntar.
Al final, generar un REPORTE de resultados.
```

### Reglas de ejecución autónoma

1. **NO preguntar nada** — si hay ambigüedad, usar lo que dice el SPEC. Si el SPEC no lo cubre, tomar la decisión más conservadora y documentarla en el reporte
2. **Seguir el orden de fases** — Fase 1 → Gate T1 → Fase 2 → Fase 3 → Fase 4 → Fase 5
3. **Respetar dependencias** — no iniciar una tarea si sus dependencias no están completadas
4. **Review inline obligatorio** — cada tarea pasa por sus reviewers antes de considerarse completada. Si un reviewer pide cambios, corregir y re-verificar
5. **Gate de T1 es bloqueante** — si el micro-test de db.mjs falla, corregir antes de avanzar a Fase 2
6. **Usar el tier system de reviewers** — Tier A: R1+R2+R3, Tier B: R2+R3, Tier C: R3 solo
7. **Crear cada archivo en su path exacto** según la tabla del SPEC
8. **Ejecutar tests** donde corresponda (`bun test` para T3/QA2)
9. **Si un agente encuentra un bug** — corregir inmediatamente, no acumular para después
10. **Al terminar** — generar `IMPLEMENTATION_REPORT.md` con resultados por fase, defectos encontrados/corregidos, y estado final

### Reporte final esperado (`IMPLEMENTATION_REPORT.md`)

```markdown
# Reporte de Implementación — local-mem v0.1.0

## Resumen ejecutivo
- Estado: ✅ COMPLETADO / ⚠️ PARCIAL / ❌ FALLIDO
- Archivos creados: X/28
- Líneas de código: X (~2565 estimadas)
- Defectos encontrados: X (BLOCKERs: X, MAJORs: X, MINORs: X)
- Defectos corregidos: X
- Defectos pendientes: X

## Resultados por Fase
### Fase 1 — Fundaciones
| Tarea | Archivo | Estado | Reviewer | Defectos | Notas |
...

### Fase 2 — Módulos
...

### Fase 3 — Docs
...

### Fase 4 — Testing
| Tester | Área | Score | BLOCKERs | MAJORs | MINORs |
...

### Fase 5 — Fixes
| Defecto | Origen | Fix aplicado | Re-verificado |
...

## Decisiones tomadas (no cubiertas por SPEC)
...

## Estado final
- [ ] Todos los archivos creados
- [ ] 0 BLOCKERs
- [ ] 0 MAJORs
- [ ] Tests pasando
- [ ] SPEC compliance verificado por 7 testers
```

### Script de lanzamiento

Archivo: `run-implementation.bat`

```bat
cd /d "C:\Users\m_ben\OneDrive\Escritorio\Mike\local-mem"
claude -p "Lee IMPLEMENTATION.md y SPEC.md. Ejecuta la implementación completa en modo autónomo (sección 'Modo de Ejecución Autónoma'). Implementa TODAS las fases (1-5) siguiendo el índice de tareas, respetando dependencias, ejecutando reviews inline, y generando IMPLEMENTATION_REPORT.md al final. NO preguntes nada. Si hay ambigüedad, usá el SPEC como fuente de verdad." --dangerously-skip-permissions
```

---

## Notas de Implementación

1. **Cada agente recibe**: el SPEC.md completo + el prompt template de arriba
2. **Convención de código**: ESM (`import`/`export`), sin TypeScript, sin dependencias, `bun:sqlite` nativo
3. **Patrón obligatorio en hooks**: try/catch global → stderr log → exit 0
4. **Patrón obligatorio en MCP**: tool results → `content: [{type: "text", text: "..."}]`
5. **Testing en Fase 4**: Cada tester verifica la implementación contra el SPEC + escribe tests adicionales si encuentra necesario
6. **El MCP Server (T9) es el archivo más crítico**: 600 líneas, protocolo estricto. 2 workers: skeleton + tools
7. **Review inline es inversión que AHORRA la Fase 5**: defectos se corrigen en el momento, no se acumulan
9. **Fase 5 es iterativa**: loop fix → review → re-test hasta convergencia. Máximo 2 iteraciones esperadas.
10. **Criterio de release**: 0 BLOCKERs, 0 MAJORs, MINORs documentados como known issues
11. **Una tarea NO avanza a la siguiente fase hasta que los 3 reviewers den ✅ o ⚠️** (nunca con ❌ pendiente)
12. **Estrategia de modelos**: opus para las 2 tareas críticas (T1 db.mjs, T9 server.mjs), sonnet para el grueso (hooks, tests, reviews), haiku para tareas simples/cortas. Optimiza costo sin sacrificar calidad donde importa.
13. **local-mem NO usa ningún modelo de Claude en runtime** — es 100% local (Bun + SQLite). Los modelos son solo para los agentes de implementación.
