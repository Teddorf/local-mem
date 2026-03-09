import { getStatusData, normalizeCwd } from './db.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TIME, PATTERNS } from './constants.mjs';

const HOME = process.env.HOME || process.env.USERPROFILE;
const SETTINGS_PATH = join(HOME, '.claude', 'settings.json');
const DB_PATH = process.env.LOCAL_MEM_DB_PATH || join(HOME, '.local-mem', 'data', 'local-mem.db');
const pkg = JSON.parse(readFileSync(import.meta.dirname + '/../package.json', 'utf8'));

try {
  const cwd = normalizeCwd(process.cwd());

  console.log(`local-mem v${pkg.version} — Health Check`);
  console.log('================================');

  // DB check
  if (!existsSync(DB_PATH)) {
    console.log('DB:           NOT FOUND (' + DB_PATH + ')');
    console.log('Run install first: bun install.mjs');
    process.exit(0);
  }

  const data = getStatusData(cwd);
  const dbSizeKB = Math.round((data.dbSize || 0) / 1024);
  console.log(`DB:           OK (${dbSizeKB} KB, ${DB_PATH})`);
  console.log(`Schema:       v${data.schemaVersion || '?'}`);
  console.log(`Sesiones:     ${data.sessions.total || 0} total (${data.sessions.active || 0} active, ${data.sessions.completed || 0} completed, ${data.sessions.abandoned || 0} abandoned)`);
  console.log(`Observaciones: ${data.observations || 0}`);
  console.log(`Prompts:      ${data.prompts || 0}`);
  console.log(`Snapshots:    ${data.snapshots || 0}`);

  if (data.lastActivity) {
    const ago = Math.round((Date.now() / 1000 - data.lastActivity) / 60);
    const agoStr = ago < 1 ? 'just now' : ago < TIME.SECONDS_PER_MINUTE ? `hace ${ago} min` : `hace ${Math.round(ago / TIME.SECONDS_PER_MINUTE)}h`;
    console.log(`Ultima actividad: ${agoStr}`);
  } else {
    console.log(`Ultima actividad: nunca`);
  }

  // Hooks check
  let hooksOk = 0;
  const requiredHooks = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'SessionEnd'];
  if (existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
      for (const event of requiredHooks) {
        const entries = settings.hooks?.[event] || [];
        const hasLocalMem = entries.some(e =>
          e.hooks?.some(h => h.command?.includes('local-mem'))
        );
        if (hasLocalMem) hooksOk++;
      }
    } catch {}
  }
  console.log(`Hooks:        ${hooksOk === 4 ? 'OK' : 'INCOMPLETE'} (${hooksOk}/4 registrados en settings.json)`);

  // MCP check
  let mcpOk = false;
  if (existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
      mcpOk = !!settings.mcpServers?.['local-mem'];
    } catch {}
  }
  console.log(`MCP Server:   ${mcpOk ? 'OK' : 'NOT FOUND'} (${mcpOk ? 'registrado' : 'no registrado'} en settings.json)`);

  // Cloud sync warning
  const dbLower = DB_PATH.toLowerCase();
  const cloudDirs = PATTERNS.CLOUD_SYNC_DIRS;
  const cloudMatch = cloudDirs.find(d => dbLower.includes(d));
  if (cloudMatch) {
    console.log(`Cloud sync:   WARNING — DB en directorio sincronizado con ${cloudMatch}`);
  }

} catch (err) {
  process.stderr.write(`[local-mem] Status error: ${err.message}\n`);
  process.exit(1);
}
