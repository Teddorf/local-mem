import { readStdin } from './stdin.mjs';
import { getDb, ensureSession, insertObservation, normalizeCwd } from './db.mjs';
import { redact, isSensitiveFile, truncate } from './redact.mjs';
import path from 'node:path';

const SKIP_TOOLS = new Set([
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree',
  'Skill', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'TaskStop', 'TaskOutput'
]);

function getFilePath(tool_name, tool_input) {
  if (!tool_input) return null;
  switch (tool_name) {
    case 'Edit': return tool_input.file_path || null;
    case 'Write': return tool_input.file_path || null;
    case 'Read': return tool_input.file_path || null;
    case 'NotebookEdit': return tool_input.notebook_path || null;
    default: return null;
  }
}

function distill(tool_name, tool_input, sensitive) {
  const inp = tool_input || {};

  switch (tool_name) {
    case 'Edit': {
      const file = inp.file_path || '';
      const action = `Edito ${file}`;
      if (sensitive) return { action, detail: null };
      const oldStr = String(inp.old_string || '').slice(0, 80);
      const newStr = String(inp.new_string || '').slice(0, 80);
      const raw = `${oldStr} → ${newStr}`;
      return { action, detail: redact(raw) };
    }

    case 'Write': {
      const file = inp.file_path || '';
      const action = `Creo ${file}`;
      if (sensitive) return { action, detail: null };
      const lines = String(inp.content || '').split('\n').slice(0, 2).join('\n');
      return { action, detail: redact(lines) };
    }

    case 'Bash': {
      const cmd = inp.command || inp.cmd || String(inp).slice(0, 200);
      return { action: redact(`Ejecuto: ${cmd}`), detail: null };
    }

    case 'Read': {
      const file = inp.file_path || '';
      return { action: `Leyo ${file}`, detail: null };
    }

    case 'Grep': {
      const pattern = inp.pattern || '';
      const p = inp.path || inp.directory || '.';
      return { action: `Busco "${pattern}" en ${p}`, detail: null };
    }

    case 'Glob': {
      const pattern = inp.pattern || '';
      return { action: `Busco archivos: ${pattern}`, detail: null };
    }

    case 'WebSearch': {
      const query = inp.query || '';
      return { action: `Investigo: "${query}"`, detail: null };
    }

    case 'WebFetch': {
      const url = inp.url || '';
      return { action: `Consulto: ${url}`, detail: null };
    }

    case 'Agent': {
      const desc = inp.description || inp.task || '';
      return { action: `Delego: ${desc}`, detail: null };
    }

    case 'NotebookEdit': {
      const nb = inp.notebook_path || '';
      return { action: `Edito notebook ${nb}`, detail: null };
    }

    default: {
      const preview = truncate(JSON.stringify(inp), 120);
      return { action: `${tool_name}: ${preview}`, detail: null };
    }
  }
}

function isReadDuplicate(db, session_id, action, cwd) {
  const nCwd = normalizeCwd(cwd);
  const row = db.prepare(
    `SELECT 1 FROM observations WHERE session_id=? AND tool_name='Read' AND action=? AND cwd=? LIMIT 1`
  ).get(session_id, action, nCwd);
  return !!row;
}

try {
  const input = await readStdin();
  const { session_id, cwd, tool_name, tool_input } = input;

  if (!session_id || !cwd || !tool_name) {
    if (!session_id) process.stderr.write('[local-mem] Missing required field: session_id\n');
    if (!cwd) process.stderr.write('[local-mem] Missing required field: cwd\n');
    if (!tool_name) process.stderr.write('[local-mem] Missing required field: tool_name\n');
    console.log('Success');
    process.exit(0);
  }

  if (SKIP_TOOLS.has(tool_name)) {
    console.log('Success');
    process.exit(0);
  }

  const filePath = getFilePath(tool_name, tool_input);
  const sensitive = filePath ? isSensitiveFile(filePath) : false;

  const { action: rawAction, detail: rawDetail } = distill(tool_name, tool_input, sensitive);

  if (tool_name === 'Read') {
    const db = getDb();
    try {
      if (isReadDuplicate(db, session_id, rawAction, cwd)) {
        console.log('Success');
        process.exit(0);
      }
    } finally {
      db.close();
    }
  }

  const action = redact(rawAction);
  const detail = rawDetail ? redact(rawDetail) : null;

  const project = path.basename(normalizeCwd(cwd));
  ensureSession(session_id, project, cwd);

  insertObservation(session_id, {
    tool_name,
    action,
    files: filePath ? JSON.stringify([filePath]) : null,
    detail,
    cwd
  });

  process.stdout.write('Success\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`[local-mem] Error: ${err.message}\n`);
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}
