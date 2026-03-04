import { readStdin } from './stdin.mjs';
import { ensureSession, insertPrompt, normalizeCwd } from './db.mjs';
import { redact } from './redact.mjs';
import { basename } from 'node:path';

try {
  const input = await readStdin();

  if (!input.session_id || !input.cwd || !input.prompt) {
    if (!input.session_id) process.stderr.write('[local-mem] Missing required field: session_id\n');
    if (!input.cwd) process.stderr.write('[local-mem] Missing required field: cwd\n');
    if (!input.prompt) process.stderr.write('[local-mem] Missing required field: prompt\n');
    console.log('Success');
    process.exit(0);
  }

  const cwd = normalizeCwd(input.cwd);
  const project = basename(input.cwd);

  ensureSession(input.session_id, project, cwd);
  insertPrompt(input.session_id, redact(input.prompt));

  console.log('Success');
  process.exit(0);
} catch (err) {
  process.stderr.write(`[local-mem] Error: ${err.message}\n`);
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}
