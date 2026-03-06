import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME || process.env.USERPROFILE;
const SETTINGS_PATH = join(HOME, '.claude', 'settings.json');

try {
  if (!existsSync(SETTINGS_PATH)) {
    console.log('No settings.json found — nothing to uninstall.');
    process.exit(0);
  }

  const raw = readFileSync(SETTINGS_PATH, 'utf8');
  const settings = JSON.parse(raw);

  // Backup
  const backupPath = SETTINGS_PATH + '.bak';
  writeFileSync(backupPath, raw, 'utf8');
  console.log(`Backup: ${backupPath}`);

  let changed = false;

  // Remove local-mem hook entries
  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[event])) continue;
      const before = settings.hooks[event].length;
      settings.hooks[event] = settings.hooks[event].filter(entry => {
        if (!entry.hooks || !Array.isArray(entry.hooks)) return true;
        return !entry.hooks.some(h => h.command && h.command.includes('local-mem'));
      });
      if (settings.hooks[event].length !== before) changed = true;
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  // Remove MCP server entry
  if (settings.mcpServers && settings.mcpServers['local-mem']) {
    delete settings.mcpServers['local-mem'];
    changed = true;
    if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
  }

  if (!changed) {
    console.log('No local-mem entries found in settings.json — already clean.');
    process.exit(0);
  }

  // Atomic write
  const tmpPath = SETTINGS_PATH + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, SETTINGS_PATH);

  console.log('local-mem uninstalled from settings.json.');
  console.log('');
  console.log('Your memory database was NOT deleted.');
  const dataDir = join(HOME, '.local-mem', 'data');
  const deleteCmd = process.platform === 'win32'
    ? `rmdir /s /q "${dataDir}"`
    : `rm -rf "${dataDir}"`;
  console.log(`To delete all data: ${deleteCmd}`);
  console.log('');
  console.log('Restart Claude Code for changes to take effect.');
} catch (err) {
  process.stderr.write(`[local-mem] Uninstall error: ${err.message}\n`);
  process.exit(1);
}
