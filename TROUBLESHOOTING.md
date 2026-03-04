# Troubleshooting — local-mem

Errores comunes, diagnóstico y soluciones.

---

## Diagnóstico rápido

Corré el health check primero:

```bash
bun /ruta/a/local-mem/scripts/status.mjs
```

Si algo falla, buscá el error en las secciones de abajo.

---

## Problemas de instalación

### "ERROR: Bun no esta instalado"

**Causa:** Bun no está en el PATH o no está instalado.

**Solución:**
```bash
# Verificar si está instalado
bun --version

# Si no está, instalar desde:
# https://bun.sh
```

En Windows, después de instalar Bun, reiniciá la terminal para que el PATH se actualice.

### "ERROR: Bun >= 1.1.0 requerido"

**Causa:** Versión de Bun demasiado vieja.

**Solución:**
```bash
bun upgrade
```

### "ERROR: settings.json no es JSON valido"

**Causa:** `~/.claude/settings.json` tiene un error de sintaxis.

**Solución:**
1. Restaurá desde el backup: `cp ~/.claude/settings.json.bak ~/.claude/settings.json`
2. Verificá manualmente el JSON (coma extra, comilla faltante, etc.)
3. Corré el instalador de nuevo

### El instalador dice "SKIP" en todos los hooks

**Causa:** local-mem ya estaba instalado. Esto es normal.

**No es un error.** El instalador es idempotente — si ya existen los hooks, los saltea.

### "ADVERTENCIA: Se detectaron otros plugins de memoria"

**Causa:** Tenés otro plugin de memoria instalado (claude-mem, etc.).

**Qué hacer:**
- Podés tener ambos, pero pueden competir por inyectar contexto
- Si experimentás problemas de contexto duplicado, deshabilitá uno de los dos en `~/.claude/settings.json`

---

## Problemas en runtime

### El contexto no se inyecta al inicio

**Síntomas:** No ves `<local-mem-data>` al iniciar Claude Code.

**Diagnóstico:**
1. Verificá que el hook existe en settings.json:
   ```bash
   cat ~/.claude/settings.json | grep "session-start"
   ```
2. Verificá que el script funciona:
   ```bash
   echo '{"session_id":"test","cwd":"/tmp"}' | bun /ruta/a/local-mem/scripts/session-start.mjs
   ```
3. Verificá que hay datos en la DB (si es la primera sesión, el contexto es un mensaje de bienvenida):
   ```bash
   bun /ruta/a/local-mem/scripts/status.mjs
   ```

**Causas comunes:**
- Reiniciar Claude Code después de instalar (obligatorio)
- La ruta en settings.json apunta a una ubicación incorrecta (moviste la carpeta)
- El script tiene un error de timeout (>10 segundos)

### "UserPromptSubmit hook success" no aparece

**Síntomas:** No se graban los prompts.

**Diagnóstico:**
```bash
echo '{"session_id":"test","cwd":"/tmp","prompt":"test"}' | bun /ruta/a/local-mem/scripts/prompt-submit.mjs
```

Si imprime `Success`, el hook funciona. El problema puede ser que Claude Code no está enviando el evento.

**Solución:** Verificá en `~/.claude/settings.json` que el hook UserPromptSubmit existe y apunta al script correcto.

### Las observaciones no se graban

**Síntomas:** `recent` devuelve lista vacía aunque usaste herramientas.

**Diagnóstico:**
```bash
echo '{"session_id":"test","cwd":"/tmp","tool_name":"Read","tool_input":{"file_path":"/tmp/x"}}' | bun /ruta/a/local-mem/scripts/observation.mjs
```

**Causas comunes:**
- La herramienta está en la lista de SKIP (TaskCreate, AskUserQuestion, etc. no se graban — esto es intencional)
- El `cwd` de la consulta no coincide con el `cwd` donde se grabaron las observaciones
- El script observation.mjs no está en settings.json

### El MCP server no inicia

**Síntomas:** Las herramientas `mcp__local_mem__*` no están disponibles.

**Diagnóstico:**
1. Verificá que el MCP server está registrado:
   ```bash
   cat ~/.claude/settings.json | grep "local-mem"
   ```
2. Probá iniciar manualmente:
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | bun /ruta/a/local-mem/mcp/server.mjs
   ```

**Causas comunes:**
- Ruta incorrecta al `server.mjs` en settings.json
- Ruta incorrecta al ejecutable de Bun
- La DB está bloqueada por otro proceso

### "Database is locked"

**Causa:** SQLite WAL lock — otro proceso tiene la DB abierta con un write pendiente.

**Solución:**
1. Cerrá todas las instancias de Claude Code
2. Esperá unos segundos
3. Si persiste, borrá el WAL file:
   ```bash
   rm ~/.local-mem/data/local-mem.db-wal
   rm ~/.local-mem/data/local-mem.db-shm
   ```
4. Reabrí Claude Code

### Los datos de un proyecto aparecen en otro

**Esto no debería pasar.** Cada proyecto se filtra por `cwd`.

**Diagnóstico:**
- En Windows, verificá que no hay diferencias de mayúsculas/minúsculas en las rutas (local-mem las normaliza, pero verificá)
- Verificá que no estás abriendo Claude Code desde el mismo directorio para ambos proyectos

---

## Problemas de datos

### Se grabó un secreto por accidente

**Solución inmediata:**
1. Buscá el registro:
   ```
   Buscá en local-mem "el texto que contenga el secreto"
   ```
2. Anotá el ID del registro
3. Eliminalo:
   ```
   Borrá la observación #ID de local-mem
   ```

**Nota:** local-mem redacta 22 tipos de secretos automáticamente (API keys, tokens, passwords, etc.), pero no es infalible. Si tenés un formato de secreto no cubierto, puede pasar.

### La DB creció demasiado

**Diagnóstico:**
```bash
bun /ruta/a/local-mem/scripts/status.mjs
# Mirá el tamaño de la DB
```

**Solución:**
```
# Primero ver qué se puede limpiar (preview)
Mostrá qué datos se pueden limpiar en local-mem (más de 30 días)

# Si está bien, ejecutar
Ejecutá cleanup en local-mem (más de 30 días, sin preview)
```

### Quiero empezar de cero

```bash
# Opción 1: Borrar solo la DB (mantener configuración)
rm ~/.local-mem/data/local-mem.db
rm -f ~/.local-mem/data/local-mem.db-wal
rm -f ~/.local-mem/data/local-mem.db-shm
# La próxima vez que abras Claude Code, se crea una DB nueva

# Opción 2: Desinstalar completamente
cd /ruta/a/local-mem
bun uninstall.mjs
rm -rf ~/.local-mem/data/
```

### Quiero mover la DB a otra ubicación

Usá la variable de entorno `LOCAL_MEM_DB_PATH`:

```bash
# En tu .bashrc, .zshrc, o variables de entorno de Windows:
export LOCAL_MEM_DB_PATH="/ruta/segura/local-mem.db"
```

Después reiniciá Claude Code. La nueva DB se crea vacía — los datos anteriores quedan en la ubicación vieja.

---

## Problemas en Windows

### Cloud sync (OneDrive/Dropbox)

**Síntoma:** El status muestra "WARNING — DB en directorio sincronizado".

**Riesgo:** SQLite puede corromperse si OneDrive sincroniza el archivo mientras se escribe.

**Soluciones (elegí una):**

1. **Excluir la carpeta en OneDrive:**
   - Abrí OneDrive Settings → Sync and Backup → Manage Backup
   - Desactivá la sincronización de la carpeta que contiene `~/.local-mem/`

2. **Mover la DB fuera del sync:**
   ```
   SET LOCAL_MEM_DB_PATH=C:\local-mem-data\local-mem.db
   ```
   Configurá esta variable de entorno en Windows y reiniciá Claude Code.

3. **Usar .nosync (macOS)** o equivalente de tu servicio de sync

### Paths con espacios

Los paths con espacios se manejan automáticamente. El instalador pone comillas en todos los comandos de settings.json.

Si algo falla, verificá que las rutas en `settings.json` tengan comillas:

```json
"command": "\"C:\\Users\\Mike Bennett\\.bun\\bin\\bun.exe\" \"C:\\Users\\Mike Bennett\\local-mem/scripts/session-start.mjs\""
```

### Permisos de archivo

En Windows, `chmod` no aplica. Asegurate de que:
- `~/.local-mem/data/` no esté compartido en red
- No tenga permisos de lectura para otros usuarios
- Idealmente no esté en un directorio sincronizado con la nube

---

## FAQ

### ¿local-mem usa AI o APIs externas?

No. Todo corre localmente con Bun + SQLite. No hace llamadas a APIs de AI. Los "resúmenes" se extraen del transcript de Claude Code, no se generan con otro modelo.

### ¿Cuánto espacio usa?

Depende del uso. Referencia:
- Sesión típica (1 hora): ~2-5 KB
- 100 sesiones: ~50-200 KB
- La DB nunca crece sin límite si usás `cleanup` periódicamente

### ¿Puedo usar local-mem en múltiples proyectos simultáneamente?

Sí. Cada instancia de Claude Code abre su propia conexión al MCP server. Los datos se filtran por `cwd` así que no hay contaminación cruzada.

### ¿Qué pasa si muevo la carpeta del proyecto local-mem?

Los paths en `settings.json` se rompen. Solución:
```bash
cd /nueva/ubicacion/local-mem
bun install.mjs
```

El instalador actualiza los paths automáticamente.

### ¿Puedo ver los datos directamente en la DB?

Sí. Es un archivo SQLite estándar:
```bash
# Con Bun
bun -e "import{Database}from'bun:sqlite';const d=new Database(process.env.HOME+'/.local-mem/data/local-mem.db');console.table(d.query('SELECT id,tool_name,action FROM observations ORDER BY id DESC LIMIT 10').all())"

# O con cualquier cliente SQLite (DB Browser, DBeaver, etc.)
```

### ¿Es compatible con claude-mem?

Pueden coexistir, pero ambos inyectan contexto al inicio de sesión. Si el contexto se siente duplicado o confuso, deshabilitá uno de los dos.

### ¿Cómo migro datos a otra máquina?

1. Copiá `~/.local-mem/data/local-mem.db` a la nueva máquina
2. Cloná e instalá local-mem en la nueva máquina
3. La DB contiene datos de todos los proyectos — automáticamente se filtra por `cwd`

**Nota:** Los `cwd` son rutas absolutas. Si los proyectos están en rutas distintas en la nueva máquina, las observaciones viejas no van a aparecer automáticamente.

### ¿Cómo actualizo local-mem?

```bash
cd /ruta/a/local-mem
git pull
bun install.mjs
```

El instalador es idempotente — solo agrega lo que falta.

---

## Obtener ayuda

Si tu problema no está listado acá:

1. Corré `bun scripts/status.mjs` y revisá qué falla
2. Probá los hooks manualmente (ver sección de Testing en [USAGE_GUIDE.md](USAGE_GUIDE.md#testing))
3. Reportá el issue en el repositorio de GitHub
