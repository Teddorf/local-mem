# CONTEXT SNAPSHOT — local-mem SPEC v0.4.0
## Generado: 2026-03-03
## Propósito: Restaurar contexto completo post-compact

---

## ESTADO DE EJECUCIÓN

### Tarea actual
Actualización del SPEC.md de local-mem a v0.4.0 con fixes de 4 agentes especializados + requisito de aislamiento multi-proyecto del usuario.

### Punto exacto de ejecución
**COMPLETÉ** todas las ediciones al SPEC.md v0.4.0. Los cambios ya están escritos en el archivo.
**PENDIENTE**: Lanzar 4 agentes de re-evaluación final del SPEC v0.4.0 actualizado. El usuario interrumpió justo antes de que se lanzaran.

### Siguiente acción literal
Lanzar 4 agentes EN PARALELO para re-auditar el SPEC v0.4.0:
1. Arquitecto top 0.1% — audit final
2. Ciberseguridad top 0.1% — audit final
3. DX/UX expert — audit final
4. MCP Protocol specialist — verificar que los 7 bugs fueron corregidos

Después de recibir los 4 resultados, presentar resumen consolidado al usuario.

---

## HISTORIAL COMPLETO DE RONDAS

### Ronda 1 (v0.1.0 → v0.2.0)
- 2 agentes: Arquitecto + Seguridad
- Arquitecto encontró ~10 problemas: DB en repo, sin schema versioning, sin forget, sin execution state, Bun barrier, sin tests, etc.
- Seguridad encontró 2 CRITICOS (secrets en plaintext, exfiltration via export), 6 ALTOS, 7 MEDIOS, 4 BAJOS
- Se actualizó el SPEC a v0.2.0 con todos los fixes

### Ronda 2 (v0.2.0 → v0.3.0)
- 2 agentes: mismos roles
- Arquitecto: 8.5/10, LISTO. Pendientes menores (sanitizeXml sin &, tests de redact, forget sin snapshots)
- Seguridad: 8.5/10, APTO. 2 bloqueantes: save_state sin redacción + patrones faltantes
- Se actualizó el SPEC a v0.3.0 con esos fixes

### Ronda 3 (v0.3.0 → v0.4.0) — RONDA ACTUAL
- 4 agentes: Arquitecto + Seguridad + DX Expert + MCP Protocol Specialist
- Arquitecto (8.5/10 LISTO): sanitizeXml debería escapear &, ADR-006 falta en tabla, ensureSession ON CONFLICT no especifica campos, transcript limit en Stop
- Seguridad (8.5/10 APTO): 0 criticos/altos nuevos. Residuales: permisos Windows, forget hard-delete, redacción regex limitada
- DX Expert: onboarding 10-15min (debería ser 5), sistema invisible, quick wins: mensaje bienvenida, status como MCP tool, npx installer
- **MCP Protocol Specialist (7 BUGS BLOQUEANTES)**:
  1. Hook `Stop` incorrecto → debe ser `SessionEnd`
  2. SessionStart SÍ recibe stdin con session_id, cwd, source
  3. Falta handler de `ping` en MCP server
  4. Falta handler de `notifications/initialized`
  5. Falta line buffering en stdin del MCP server
  6. Tool result format incorrecto → debe ser `content: [{type: "text", text: "..."}]`
  7. Matcher falta `resume` → `startup|resume|clear|compact`
  - Plus: naming redundante, SIGTERM handling, MCP es long-running (SQLite persistente)

### Requisito del usuario (mid-ronda 3)
"Tener en cuenta que un usuario puede estar trabajando en más de un proyecto al mismo tiempo. No se debe mezclar los contextos."

---

## CAMBIOS APLICADOS AL SPEC v0.4.0 (todos ya escritos en el archivo)

### Changelog v0.4.0 agregado ✅
- MCP Protocol: 7 bugs corregidos
- Multi-proyecto: sección completa de aislamiento
- MCP Tools: renaming, tool #10 status, descriptions, cleanup default preview:true
- DX: mensaje bienvenida, sanitizeXml con &, ensureSession ON CONFLICT, transcript 50KB limit

### Ediciones específicas completadas ✅
1. Version bumped a 0.4.0 ✅
2. Changelog v0.4.0 completo ✅
3. Árbol de arquitectura: session-stop.mjs → session-end.mjs, 10 tools, ADRs 008-010 ✅
4. SessionStart corregido: recibe stdin, cwd del stdin, abandonOrphanSessions filtra por cwd, mensaje bienvenida ✅
5. sanitizeXml escapa & → &amp; ✅
6. Hook Stop → SessionEnd con transcript 50KB limit ✅
7. MCP Server reescrito completo: lifecycle, line buffering, ping, SIGTERM, tool results format, naming sin prefijo, 10 tools con descriptions, SQLite persistente ✅
8. Matcher: startup|resume|clear|compact ✅
9. settings.json hooks: Stop → SessionEnd ✅
10. Merge pseudocode: Stop → SessionEnd ✅
11. ensureSession: ON CONFLICT DO UPDATE SET status='active' ✅
12. abandonOrphanSessions: recibe cwd como parámetro ✅
13. Sección "Aislamiento multi-proyecto" completa con tabla de garantías y escenarios ✅
14. Tabla de archivos: 28 archivos, ADR-006 incluido, ADR-009, ADR-010 ✅

### Lo que NO se editó (verificar que quedó bien de rondas anteriores)
- Schema SQL (ya tenía cwd en todas las tablas, counters, etc.)
- Módulo redact.mjs (18 patrones, redactObject, sanitizeXml, truncate)
- stdin.mjs (1MB limit, timeout absoluto)
- Principios de seguridad (13 principios)
- Deuda técnica (8 items)

---

## ARCHIVOS RELEVANTES

| Archivo | Path | Estado |
|---------|------|--------|
| SPEC.md | C:\Users\m_ben\OneDrive\Escritorio\Mike\local-mem\SPEC.md | v0.4.0 actualizado, listo para re-audit |
| Este snapshot | C:\Users\m_ben\OneDrive\Escritorio\Mike\local-mem\CONTEXT_SNAPSHOT.md | Contexto completo |

---

## DECISIONES TOMADAS

1. **Stop → SessionEnd**: Confirmado por docs de Claude Code hooks. Stop se dispara cada turno.
2. **Tool naming sin prefijo**: `search` en vez de `local_mem_search` para evitar `mcp__local_mem__local_mem_search`
3. **cleanup default preview:true**: Más seguro, evita borrado accidental
4. **MCP long-running**: Una conexión SQLite persistente, no abrir/cerrar por request
5. **Multi-proyecto**: Todas las queries filtran por cwd. abandonOrphanSessions solo afecta cwd actual.
6. **session_id removido de save_state params**: Claude no puede proveerlo, detección automática por cwd

---

## PROMPT EXACTO PARA LOS 4 AGENTES (pendiente de ejecutar)

### Agente 1: Arquitecto
"Sos un arquitecto del top 0.1%. Audit FINAL del SPEC v0.4.0. Foco en: ¿los 7 bugs MCP fueron corregidos? ¿El aislamiento multi-proyecto es correcto? ¿Queda algo bloqueante? Score 1-10. LISTO/NO LISTO."

### Agente 2: Seguridad
"Sos un experto en ciberseguridad del top 0.1%. Audit FINAL de seguridad v0.4.0. ¿El aislamiento multi-proyecto cierra vectores de cross-project data leak? ¿Los cambios MCP introducen nuevas vulnerabilidades? Score 1-10. APTO/NO APTO."

### Agente 3: DX Expert
"Sos un experto en DX del top 0.1%. Re-evalua v0.4.0: ¿Se resolvieron los quick wins (bienvenida, status tool, naming)? ¿El aislamiento multi-proyecto es transparente para el usuario? Score 1-10."

### Agente 4: MCP Protocol
"Sos un experto MCP del top 0.1%. Verifica que los 7 bugs que reportaste están corregidos en v0.4.0: SessionEnd, stdin en SessionStart, ping, notifications, line buffering, tool result format, matcher resume. ¿Queda algo? Score 1-10."

---

## CONTEXTO DEL USUARIO
- Idioma: Español (Argentina)
- Working dir: C:\Users\m_ben\OneDrive\Escritorio\Mike\local-mem
- Proyecto: local-mem — memoria persistente local para Claude Code
- Flujo: escribir SPEC → auditar con agentes → corregir → re-auditar → implementar
- El usuario quiere el SPEC perfecto antes de implementar
