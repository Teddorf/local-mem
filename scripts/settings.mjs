import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

let _cached = undefined;

export function loadSettings() {
  if (_cached !== undefined) return _cached;

  const settingsPath = process.env.LOCAL_MEM_SETTINGS_PATH
    || join(homedir(), '.local-mem', 'settings.json');

  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    _cached = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`[local-mem] Invalid settings.json: ${err.message}\n`);
    }
    _cached = {};
  }

  return _cached;
}

export function clearSettingsCache() {
  _cached = undefined;
}
