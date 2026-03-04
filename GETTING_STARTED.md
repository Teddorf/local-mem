# Primeros Pasos con local-mem

Guía rápida para instalar, verificar y empezar a usar local-mem en Claude Code.

---

## Requisitos

- **Bun >= 1.1.0** — [instalar desde bun.sh](https://bun.sh)
- **Claude Code** — instalado y funcionando

Verificar Bun:

```bash
bun --version
# Debe mostrar 1.1.0 o superior
```

---

## Instalación

```bash
git clone https://github.com/tu-usuario/local-mem.git
cd local-mem
bun install.mjs
```

El instalador hace todo automáticamente:

1. Crea `~/.local-mem/data/` con la base de datos SQLite
2. Hace backup de `~/.claude/settings.json` → `settings.json.bak`
3. Agrega 4 hooks a Claude Code (SessionStart, UserPromptSubmit, PostToolUse, SessionEnd)
4. Registra el servidor MCP `local-mem`
5. Escribe settings.json de forma atómica (sin riesgo de corrupción)

**Importante:** Reiniciá Claude Code después de instalar.

---

## Verificar la instalación

### Opción 1: Script de status (fuera de Claude Code)

```bash
bun /ruta/a/local-mem/scripts/status.mjs
```

Deberías ver algo así:

```
local-mem v0.1.0 — Health Check
================================
DB:           OK (12 KB, ~/.local-mem/data/local-mem.db)
Schema:       v1
Sesiones:     0 total (0 active, 0 completed, 0 abandoned)
Observaciones: 0
Prompts:      0
Hooks:        OK (4/4 registrados en settings.json)
MCP Server:   OK (registrado en settings.json)
```

Todo OK si:
- **DB:** muestra "OK" con ruta válida
- **Hooks:** muestra "4/4 registrados"
- **MCP Server:** muestra "OK"

### Opción 2: Desde dentro de Claude Code

Después de reiniciar Claude Code, pedile que ejecute el tool `status`:

```
Ejecutá el tool status de local-mem
```

Claude va a usar `mcp__local_mem__status` automáticamente.

### Opción 3: Verificar que los hooks funcionan

Iniciá una nueva sesión de Claude Code. Al inicio deberías ver un mensaje de sistema como:

```
SessionStart:startup hook success: Success
```

Y al enviar cualquier prompt:

```
UserPromptSubmit hook success: Success
```

Si ves estos mensajes, local-mem está grabando todo correctamente.

---

## Primera prueba completa

Seguí estos pasos para verificar que todo funciona de punta a punta:

### Paso 1: Iniciá una sesión nueva

Abrí Claude Code en cualquier proyecto. Al inicio vas a ver el mensaje de SessionStart.

### Paso 2: Hacé algunas acciones

Pedile a Claude que haga cosas normales:

```
Leé el archivo package.json
```

```
Listá los archivos del directorio actual
```

```
Buscá la palabra "function" en los archivos .js
```

Cada acción queda registrada como una "observación" en la base de datos.

### Paso 3: Verificá que se grabaron

Pedile a Claude:

```
Mostrá las observaciones recientes de local-mem
```

Claude va a usar el tool `recent` y vas a ver una lista de todo lo que hizo en esta sesión.

### Paso 4: Probá la búsqueda

```
Buscá en local-mem "package.json"
```

Claude va a usar el tool `search` con FTS5 y te va a mostrar todas las observaciones que mencionan "package.json".

### Paso 5: Guardá estado

Antes de cerrar o hacer `/compact`, pedile:

```
Guardá el estado actual en local-mem: estoy probando la instalación
```

Claude va a usar `save_state` para guardar un snapshot del contexto.

### Paso 6: Cerrá y volvé a abrir

Cerrá Claude Code y abrilo de nuevo en el mismo proyecto. Al inicio vas a ver el contexto inyectado automáticamente:

```
<local-mem-data type="historical-context">
# mi-proyecto — contexto reciente

## Ultimo resumen
...

## Estado guardado
- Tarea: estoy probando la instalación
...

## Actividad reciente
| # | Hora | Que hizo |
...
</local-mem-data>
```

Si ves esto, **local-mem está funcionando perfectamente**.

---

## Qué pasa automáticamente (sin que hagas nada)

| Evento | Qué hace local-mem |
|--------|---------------------|
| Abrís Claude Code | Inyecta contexto de sesiones anteriores |
| Escribís un prompt | Lo graba (redactando secretos) |
| Claude usa una herramienta | Graba la observación (qué hizo, qué archivo, detalle) |
| Cerrás Claude Code | Genera resumen de la sesión y la cierra |

No tenés que hacer nada especial. local-mem trabaja en segundo plano.

---

## Qué podés hacer manualmente (10 herramientas MCP)

Estas herramientas están disponibles dentro de Claude Code. Podés pedirle a Claude que las use, o las va a usar automáticamente según el contexto.

| Herramienta | Para qué sirve |
|-------------|----------------|
| `search` | Buscar en toda tu historia (observaciones + prompts) |
| `recent` | Ver las últimas observaciones |
| `context` | Recargar el contexto completo (como si reiniciaras) |
| `save_state` | Guardar snapshot del estado actual (antes de `/compact`) |
| `get_state` | Recuperar el último snapshot guardado |
| `status` | Ver salud del sistema (DB, sesiones, hooks) |
| `session_detail` | Ver detalles completos de una sesión |
| `cleanup` | Limpiar datos viejos (modo preview por defecto) |
| `export` | Exportar datos como JSON o CSV |
| `forget` | Borrar registros específicos (si grabó algo sensible) |

Para más detalles de cada herramienta, ver [USAGE_GUIDE.md](USAGE_GUIDE.md).

---

## Estructura de archivos

```
~/.local-mem/
  data/
    local-mem.db          ← Base de datos SQLite (toda tu memoria)

~/.claude/
  settings.json           ← Configuración con hooks y MCP server
  settings.json.bak       ← Backup pre-instalación

/ruta/donde/clonaste/local-mem/
  scripts/                ← Scripts de hooks y utilidades
  mcp/                    ← Servidor MCP
  install.mjs             ← Instalador
  uninstall.mjs           ← Desinstalador
```

**No muevas la carpeta `local-mem/`** después de instalar. Los paths en `settings.json` apuntan a esa ubicación. Si la movés, corré `bun install.mjs` de nuevo.

---

## Desinstalación

```bash
cd /ruta/a/local-mem
bun uninstall.mjs
```

Esto remueve hooks y MCP de `settings.json` pero **no borra la base de datos**. Para borrar todo:

```bash
rm -rf ~/.local-mem/data/
```

---

## Siguiente paso

→ [USAGE_GUIDE.md](USAGE_GUIDE.md) — Guía completa con ejemplos de cada herramienta
→ [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — Si algo no funciona
→ [SECURITY.md](SECURITY.md) — Cómo protege tus datos
