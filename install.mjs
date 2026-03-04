import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, chmodSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const HOME = process.env.HOME || process.env.USERPROFILE;
const SETTINGS_PATH = join(HOME, '.claude', 'settings.json');
const DATA_DIR = join(HOME, '.local-mem', 'data');
const BUN_PATH = process.execPath;
const PROJECT_PATH = import.meta.dirname;
const IS_WIN = process.platform === 'win32';

// Cloud sync detection
const CLOUD_PATTERNS = ['OneDrive', 'Dropbox', 'iCloudDrive', 'Google Drive', 'Nextcloud'];

function isCloudPath(p) {
  return CLOUD_PATTERNS.some(pat => p.includes(pat));
}

// Bun version check
function checkBun() {
  try {
    const out = execSync(`"${BUN_PATH}" --version`, { encoding: 'utf8' }).trim();
    const match = out.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      console.error('ERROR: No se pudo determinar la version de Bun.');
      process.exit(1);
    }
    const [, major, minor] = match.map(Number);
    if (major < 1 || (major === 1 && minor < 1)) {
      console.error(`ERROR: Bun >= 1.1.0 requerido. Version actual: ${out}`);
      process.exit(1);
    }
    console.log(`[OK] Bun ${out} detectado.`);
  } catch {
    console.error('ERROR: Bun no esta instalado o no es accesible.');
    console.error('Instala Bun desde https://bun.sh antes de continuar.');
    process.exit(1);
  }
}

// Create data directory and apply permissions
function setupDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!IS_WIN) {
    chmodSync(DATA_DIR, 0o700);
    // chmod 600 on any existing db files
    try {
      const files = readdirSync(DATA_DIR);
      for (const f of files) {
        if (f.includes('.db')) {
          chmodSync(join(DATA_DIR, f), 0o600);
        }
      }
    } catch {}
  }
  console.log(`[OK] Directorio de datos: ${DATA_DIR}`);
}

// Initialize DB
async function initDb() {
  const { getDb, closeDb } = await import('./scripts/db.mjs');
  getDb();
  closeDb();
  console.log('[OK] Base de datos inicializada.');
}

// Build hook config with properly quoted and normalized paths
function buildHookConfig() {
  const b = `"${BUN_PATH}"`;
  // Use join() for consistent path separators per platform
  const scriptPath = (name) => `"${join(PROJECT_PATH, 'scripts', name)}"`;

  return {
    SessionStart: {
      matcher: 'startup|resume|clear|compact',
      hooks: [{
        type: 'command',
        command: `${b} ${scriptPath('session-start.mjs')}`,
        timeout: 10
      }]
    },
    UserPromptSubmit: {
      hooks: [{
        type: 'command',
        command: `${b} ${scriptPath('prompt-submit.mjs')}`,
        timeout: 10
      }]
    },
    PostToolUse: {
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `${b} ${scriptPath('observation.mjs')}`,
        timeout: 10
      }]
    },
    SessionEnd: {
      hooks: [{
        type: 'command',
        command: `${b} ${scriptPath('session-end.mjs')}`,
        timeout: 20
      }]
    }
  };
}

// Merge hooks into settings
function mergeHooks(settings, hookConfig) {
  if (!settings.hooks) settings.hooks = {};
  const events = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'SessionEnd'];
  const added = [];

  for (const event of events) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];

    const hasLocalMem = settings.hooks[event].some(entry =>
      entry.hooks?.some(h => h.command?.includes('local-mem'))
    );

    if (!hasLocalMem) {
      settings.hooks[event].push(hookConfig[event]);
      added.push(event);
    } else {
      console.log(`  [SKIP] Hook ${event} ya existe.`);
    }
  }

  return added;
}

// Register MCP server via claude mcp add (scope user)
function registerMcp() {
  try {
    // Check if already registered
    const existing = execSync('claude mcp list 2>&1', { encoding: 'utf8', timeout: 10000 });
    if (existing.includes('local-mem')) {
      console.log('  [SKIP] MCP server local-mem ya registrado.');
      return false;
    }
  } catch {
    // claude CLI may not be available or mcp list failed — continue with registration
  }

  try {
    const serverPath = join(PROJECT_PATH, 'mcp', 'server.mjs');
    const cmd = `claude mcp add --scope user local-mem "${BUN_PATH}" "${serverPath}"`;
    execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    return true;
  } catch (e) {
    // Fallback: write to settings.json mcpServers for backwards compat
    console.warn(`  [WARN] claude mcp add fallo (${e.message}). Usando fallback settings.json.`);
    return 'fallback';
  }
}

// Fallback: merge MCP into settings.json if claude mcp add fails
function mergeMcpFallback(settings) {
  if (!settings.mcpServers) settings.mcpServers = {};
  if (settings.mcpServers['local-mem']) {
    return false;
  }
  settings.mcpServers['local-mem'] = {
    command: BUN_PATH,
    args: [join(PROJECT_PATH, 'mcp', 'server.mjs')],
    env: {}
  };
  return true;
}

// Atomic write settings.json
function writeSettings(settings) {
  const tmpPath = SETTINGS_PATH + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, SETTINGS_PATH);
}

// Main
async function main() {
  console.log('=== local-mem Instalador ===\n');

  // 1. Check Bun
  checkBun();

  // 2. Create data dir + permissions
  setupDataDir();

  // 3. Init DB
  await initDb();

  // 4. Read settings.json
  let settings = {};
  let rawSettings = '{}';
  if (existsSync(SETTINGS_PATH)) {
    rawSettings = readFileSync(SETTINGS_PATH, 'utf8');
    try {
      settings = JSON.parse(rawSettings);
    } catch {
      console.error('ERROR: settings.json no es JSON valido.');
      process.exit(1);
    }
  } else {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  }

  // 5. Backup
  const backupPath = SETTINGS_PATH + '.bak';
  writeFileSync(backupPath, rawSettings, 'utf8');
  console.log(`[OK] Backup creado: ${backupPath}`);

  // 6. Detect other memory plugins
  const memoryIndicators = ['claude-mem', 'memory-plugin', 'persistent-memory', 'cline-memory'];
  const allHookCommands = Object.values(settings.hooks || {})
    .flat()
    .flatMap(entry => (entry.hooks || []).map(h => h.command || ''));
  const allMcpNames = Object.keys(settings.mcpServers || {});
  const detectedPlugins = [];
  for (const indicator of memoryIndicators) {
    if (allHookCommands.some(cmd => cmd.includes(indicator))) {
      detectedPlugins.push(indicator + ' (hook)');
    }
    if (allMcpNames.some(name => name.includes(indicator))) {
      detectedPlugins.push(indicator + ' (MCP)');
    }
  }
  if (detectedPlugins.length > 0) {
    console.warn(`\nADVERTENCIA: Se detectaron otros plugins de memoria:`);
    for (const p of detectedPlugins) {
      console.warn(`  - ${p}`);
    }
    console.warn('Tener multiples plugins de memoria puede causar conflictos de contexto.');
    console.warn('Considera deshabilitarlos en settings.json si experimentas problemas.\n');
  }

  // 7. Merge hooks
  const hookConfig = buildHookConfig();
  console.log('\nMergeando hooks...');
  const addedHooks = mergeHooks(settings, hookConfig);
  if (addedHooks.length > 0) {
    console.log(`  [OK] Hooks agregados: ${addedHooks.join(', ')}`);
  }

  // 7. Register MCP via claude mcp add
  console.log('\nRegistrando MCP server...');
  const mcpResult = registerMcp();
  let mcpFallbackUsed = false;
  if (mcpResult === true) {
    console.log('  [OK] MCP server registrado via claude mcp add.');
  } else if (mcpResult === 'fallback') {
    mcpFallbackUsed = mergeMcpFallback(settings);
    if (mcpFallbackUsed) {
      console.log('  [OK] MCP server agregado a settings.json (fallback).');
    }
  }

  // 8. Atomic write
  writeSettings(settings);
  console.log(`\n[OK] settings.json actualizado: ${SETTINGS_PATH}`);

  // 9. Summary
  console.log('\n=== Resumen ===');
  console.log(`Bun:         ${BUN_PATH}`);
  console.log(`Proyecto:    ${PROJECT_PATH}`);
  console.log(`DB:          ${join(DATA_DIR, 'local-mem.db')}`);
  console.log(`Settings:    ${SETTINGS_PATH}`);
  console.log(`Backup:      ${backupPath}`);
  console.log('\nPara verificar: bun "' + PROJECT_PATH + '/scripts/status.mjs"');
  console.log('Reinicia Claude Code para que los cambios tomen efecto.\n');

  // 10. Cloud sync warning
  if (isCloudPath(DATA_DIR)) {
    console.warn('ADVERTENCIA: La base de datos esta en un directorio sincronizado con la nube.');
    console.warn(`  Ruta detectada: ${DATA_DIR}`);
    console.warn('  Esto puede causar corrupcion de la DB SQLite durante sincronizacion.');
    console.warn(`  Considera mover los datos a una ruta local y configurar LOCAL_MEM_DB_PATH.\n`);
  }
}

main().catch(err => {
  process.stderr.write(`[local-mem] Error de instalacion: ${err.message}\n`);
  process.exit(1);
});
