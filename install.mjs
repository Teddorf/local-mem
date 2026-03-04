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
  const { getDb } = await import('./scripts/db.mjs');
  const db = getDb();
  db.close();
  console.log('[OK] Base de datos inicializada.');
}

// Build hook config with quoted paths
function buildHookConfig() {
  const b = `"${BUN_PATH}"`;
  const p = `"${PROJECT_PATH}`;

  return {
    SessionStart: {
      matcher: 'startup|resume|clear|compact',
      hooks: [{
        type: 'command',
        command: `${b} ${p}/scripts/session-start.mjs"`,
        timeout: 10
      }]
    },
    UserPromptSubmit: {
      hooks: [{
        type: 'command',
        command: `${b} ${p}/scripts/prompt-submit.mjs"`,
        timeout: 10
      }]
    },
    PostToolUse: {
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `${b} ${p}/scripts/observation.mjs"`,
        timeout: 10
      }]
    },
    SessionEnd: {
      hooks: [{
        type: 'command',
        command: `${b} ${p}/scripts/session-end.mjs"`,
        timeout: 15
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

// Merge MCP server into settings
function mergeMcp(settings) {
  if (!settings.mcpServers) settings.mcpServers = {};

  if (settings.mcpServers['local-mem']) {
    console.log('  [SKIP] MCP server local-mem ya existe.');
    return false;
  }

  settings.mcpServers['local-mem'] = {
    command: BUN_PATH,
    args: [`${PROJECT_PATH}/mcp/server.mjs`],
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

  // 7. Merge MCP
  console.log('\nMergeando MCP server...');
  const mcpAdded = mergeMcp(settings);
  if (mcpAdded) {
    console.log('  [OK] MCP server local-mem agregado.');
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
