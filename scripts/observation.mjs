import { readStdin } from './stdin.mjs';
import { getDb, ensureSession, insertObservation, normalizeCwd, insertObservationScore, getSessionStats, saveExecutionSnapshot, getRecentObservations, pruneAutoSnapshots, getRecentPrompts } from './db.mjs';
import { redact, isSensitiveFile, truncate } from './redact.mjs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

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

function extractResponseText(tool_response) {
  if (!tool_response) return null;
  if (typeof tool_response === 'string') return tool_response;
  if (typeof tool_response === 'object') {
    // Claude Code tool_response is often { output: '...', error: '...', exitCode: N }
    if (tool_response.output != null) return String(tool_response.output);
    if (Array.isArray(tool_response.content)) {
      const textPart = tool_response.content.find(p => p && p.type === 'text');
      if (textPart) return textPart.text;
      return JSON.stringify(tool_response.content);
    }
    if (tool_response.content != null) return String(tool_response.content);
    if (tool_response.text != null) return String(tool_response.text);
    // Fallback: stringify
    try { return JSON.stringify(tool_response); } catch { return null; }
  }
  return null;
}

function distill(tool_name, tool_input, tool_response, sensitive) {
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
      let detail = null;
      if (tool_response) {
        const exitCode = tool_response.exitCode ?? tool_response.exit_code;
        const out = extractResponseText(tool_response) || '';
        const prefix = exitCode != null ? `[exit ${exitCode}] ` : '';
        const body = out.slice(0, 500 - prefix.length);
        if (prefix || body.trim()) detail = redact(prefix + body);
      }
      return { action: redact(`Ejecuto: ${cmd}`), detail };
    }

    case 'Read': {
      const file = inp.file_path || '';
      let detail = null;
      if (tool_response) {
        const out = extractResponseText(tool_response) || '';
        if (/error|not found|cannot|failed/i.test(out)) {
          detail = redact(out.slice(0, 200));
        }
      }
      return { action: `Leyo ${file}`, detail };
    }

    case 'Grep': {
      const pattern = inp.pattern || '';
      const p = inp.path || inp.directory || '.';
      let detail = null;
      if (tool_response) {
        const out = extractResponseText(tool_response) || '';
        if (out.trim()) detail = redact(out.slice(0, 400));
      }
      return { action: `Busco "${pattern}" en ${p}`, detail };
    }

    case 'Glob': {
      const pattern = inp.pattern || '';
      let detail = null;
      if (tool_response) {
        const out = extractResponseText(tool_response) || '';
        if (out.trim()) {
          const files = out.split('\n').filter(Boolean).slice(0, 10).join('\n');
          detail = redact(files.slice(0, 300));
        }
      }
      return { action: `Busco archivos: ${pattern}`, detail };
    }

    case 'WebSearch': {
      const query = inp.query || '';
      let detail = null;
      if (tool_response) {
        const out = extractResponseText(tool_response) || '';
        if (out.trim()) {
          // Extract first 3 title+URL patterns or just take the first 300 chars
          const lines = out.split('\n').filter(Boolean).slice(0, 6).join('\n');
          detail = redact(lines.slice(0, 300));
        }
      }
      return { action: `Investigo: "${query}"`, detail };
    }

    case 'WebFetch': {
      const url = inp.url || '';
      let detail = null;
      if (tool_response) {
        const out = extractResponseText(tool_response) || '';
        if (out.trim()) detail = redact(out.slice(0, 300));
      }
      return { action: `Consulto: ${url}`, detail };
    }

    case 'Agent': {
      const desc = inp.description || inp.task || '';
      let detail = null;
      if (tool_response) {
        const out = extractResponseText(tool_response) || '';
        if (out.trim()) detail = redact(out.slice(0, 300));
      }
      return { action: `Delego: ${desc}`, detail };
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

// Base score without recency (recency applied at query-time in SQL)
// composite_score = base_score = 0.4*impact + 0.2*errorFlag + 0.1*toolWeight (max 0.7)
// At query-time: effective_score = base_score + 0.3 * recencyBand(age)
function computeScore(toolName, action) {
  const impactMap = { Edit: 0.85, Write: 0.75, Bash: 0.70, Agent: 0.60 };
  const impact = impactMap[toolName] ?? 0.30;
  const errorFlag = /error|failed|crashed/i.test(action || '') ? 1.0 : 0.0;
  const toolWeight = impactMap[toolName] != null ? 1.0 : 0.5;
  return 0.4 * impact + 0.2 * errorFlag + 0.1 * toolWeight;
}

function captureTechnicalState(cwd) {
  const state = {};
  const timeout = 10_000;

  // Solo si existe tsconfig.json (JS puro, sin grep/tail — cross-platform)
  try {
    if (existsSync(path.join(cwd, 'tsconfig.json'))) {
      const stdout = execSync('npx tsc --noEmit 2>&1',
        { cwd, timeout, encoding: 'utf8' });
      state.ts_errors = stdout.split('\n').filter(l => l.includes('error TS')).length;
    }
  } catch (e) {
    // tsc exits non-zero when there are errors — parse stderr/stdout from the error
    if (e.stdout || e.stderr) {
      const out = (e.stdout || '') + (e.stderr || '');
      // Only set ts_errors if output looks like tsc output (not npx/command-not-found errors)
      if (out.includes('error TS') || out.includes('.ts(') || out.includes('.tsx(')) {
        state.ts_errors = out.split('\n').filter(l => l.includes('error TS')).length;
      }
    }
  }

  // Solo si existe tests/ o __tests__ (JS puro, sin tail — cross-platform)
  try {
    const hasTests = existsSync(path.join(cwd, 'tests')) || existsSync(path.join(cwd, '__tests__'));
    if (hasTests) {
      const stdout = execSync('bun test 2>&1',
        { cwd, timeout, encoding: 'utf8' });
      state.test_summary = stdout.replace(/\r/g, '').split('\n').filter(Boolean).slice(-3).join('\n').slice(0, 200);
    }
  } catch (e) {
    // bun test exits non-zero on failures — still capture summary
    if (e.stdout || e.stderr) {
      const out = ((e.stdout || '') + (e.stderr || '')).replace(/\r/g, '');
      state.test_summary = out.split('\n').filter(Boolean).slice(-3).join('\n').slice(0, 200);
    }
  }

  return Object.keys(state).length > 0 ? JSON.stringify(state) : null;
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
  const { session_id, cwd, tool_name, tool_input, tool_response } = input;

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

  const { action: rawAction, detail: rawDetail } = distill(tool_name, tool_input, tool_response, sensitive);

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

  const result = insertObservation(session_id, {
    tool_name,
    action,
    files: filePath ? JSON.stringify([filePath]) : null,
    detail,
    cwd
  });

  // Priority scoring
  try {
    const score = computeScore(tool_name, action);
    insertObservationScore(Number(result.lastInsertRowid), score);
  } catch (e) {
    process.stderr.write(`[local-mem] Score error: ${e.message}\n`);
  }

  // Auto-snapshot every 25 observations (v0.7: with active files)
  try {
    const stats = getSessionStats(session_id);
    if (stats && stats.observation_count > 0 && stats.observation_count % 25 === 0) {
      const recentObs = getRecentObservations(cwd, { limit: 25 });
      const lastActions = recentObs.slice(0, 10).map(o => o.action).join('\n');
      const recentPrompts = getRecentPrompts(cwd, 3);
      const lastPrompts = recentPrompts.map(p => p.prompt_text || '').join('\n');

      // v0.7: Extract unique active files from recent observations
      const activeFilesSet = new Set();
      for (const obs of recentObs) {
        if (obs.files) {
          try {
            const files = typeof obs.files === 'string' ? JSON.parse(obs.files) : obs.files;
            if (Array.isArray(files)) files.forEach(f => f && activeFilesSet.add(f));
          } catch { /* skip */ }
        }
      }

      // v0.7: capture technical state (sync, best-effort)
      let technicalState = null;
      try {
        technicalState = captureTechnicalState(cwd);
      } catch { /* best-effort */ }

      saveExecutionSnapshot(session_id, {
        cwd,
        current_task: `Auto-snapshot at ${stats.observation_count} observations`,
        execution_point: lastActions.slice(0, 500),
        next_action: lastPrompts.slice(0, 300),
        active_files: [...activeFilesSet].slice(0, 20),
        snapshot_type: 'auto',
        task_status: 'in_progress',
        technical_state: technicalState,
      });
      pruneAutoSnapshots(session_id, cwd, 3);
    }
  } catch (e) {
    process.stderr.write(`[local-mem] Auto-snapshot error: ${e.message}\n`);
  }

  process.stdout.write('Success\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`[local-mem] Error: ${err.message}\n`);
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}
