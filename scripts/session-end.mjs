import { readFileSync } from 'fs';
import { basename, isAbsolute } from 'path';
import { readStdin } from './stdin.mjs';
import { getDb, completeSession, getSessionStats, normalizeCwd, insertTurnLog, updateProjectDna } from './db.mjs';
import { redact } from './redact.mjs';
import { SIZES, TRUNCATE, RENDER, AI } from './constants.mjs';
import { generateAiSummary } from './ai.mjs';

const LAST_200KB = SIZES.TRANSCRIPT_MAX_END;

export function inferProjectDna(toolsUsed, filesModified, filesRead, bashActions) {
  const stackSet = new Set();
  const patterns = [];
  const keyFilesSet = new Set();

  const allFiles = [...(filesModified || []), ...(filesRead || [])];

  for (const f of allFiles) {
    if (!f || typeof f !== 'string') continue;
    const lower = f.toLowerCase();
    const base = basename(f);

    if (lower.endsWith('.ts') || lower.endsWith('.d.ts')) stackSet.add('TypeScript');
    if (lower.endsWith('.mjs')) stackSet.add('ESM');
    if (lower.endsWith('.py')) stackSet.add('Python');
    if (lower.endsWith('.rs')) stackSet.add('Rust');
    if (lower.endsWith('.go')) stackSet.add('Go');
    if (lower.endsWith('.jsx') || lower.endsWith('.tsx')) stackSet.add('React');
    if (lower.endsWith('.vue')) stackSet.add('Vue');
    if (lower.endsWith('.svelte')) stackSet.add('Svelte');
    if (lower.endsWith('.sql') || lower.includes('sqlite')) stackSet.add('SQLite');
    if (lower.includes('docker') || base === 'Dockerfile') stackSet.add('Docker');
  }

  // Detect from Bash tool actions
  if (Array.isArray(bashActions)) {
    const joined = bashActions.join(' ').toLowerCase();
    if (/\bbun\b/.test(joined)) stackSet.add('Bun');
    if (/\bnpm\b/.test(joined) || /\byarn\b/.test(joined) || /\bpnpm\b/.test(joined)) stackSet.add('Node.js');
  }

  // Collect key_files from modified files (basenames, deduplicated, max 10)
  for (const f of (filesModified || [])) {
    if (f && typeof f === 'string') {
      keyFilesSet.add(basename(f));
      if (keyFilesSet.size >= RENDER.MAX_KEY_FILES_DETECT) break;
    }
  }

  return {
    stack: [...stackSet],
    patterns,
    key_files: [...keyFilesSet]
  };
}

function extractTranscriptSummary(transcriptPath) {
  try {
    let buf;
    try { buf = readFileSync(transcriptPath); } catch { return null; }
    const slice = buf.length > LAST_200KB
      ? buf.slice(buf.length - LAST_200KB).toString('utf8')
      : buf.toString('utf8');

    const lines = slice.split('\n').filter(l => l.trim());
    const TRIVIAL = /^(ok|listo|perfecto|hecho|done|sí|si|ya|claro|gracias|entendido|dale)[.!,\s]*$/i;
    let bestText = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'assistant') continue;

        let text = '';
        const msg = entry.message || entry;
        if (msg.content) {
          if (typeof msg.content === 'string') {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            text = msg.content
              .filter(c => c.type === 'text')
              .map(c => c.text || '')
              .join('\n')
              .trim();
          }
        }

        if (!text) continue;

        // Limpiar system-reminders
        text = text
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
          .replace(/<parameter name="context">[\s\S]*?<\/parameter>/gi, '')
          .trim();

        if (!text || text.length < TRUNCATE.SUMMARY_MIN_LENGTH) continue;
        if (TRIVIAL.test(text)) continue;

        bestText = text;
      } catch { /* skip malformed lines */ }
    }

    if (!bestText) return null;
    // Truncar a max chars
    if (bestText.length > TRUNCATE.SUMMARY_MAX) bestText = bestText.slice(0, TRUNCATE.SUMMARY_MAX);
    return redact(bestText);
  } catch {
    return null;
  }
}

export function buildStructuredSummary(sessionId, cwd, opts = {}) {
  try {
    const tools_used = opts.tools_used || {};
    const files_modified = opts.files_modified || [];
    const db = getDb();
    let snapshot = null;
    try {
      const nCwd = normalizeCwd(cwd);
      snapshot = db.prepare(`
        SELECT current_task, next_action, technical_state, snapshot_type
        FROM execution_snapshots
        WHERE session_id = ? AND cwd = ?
        ORDER BY CASE WHEN snapshot_type = 'manual' THEN 0 ELSE 1 END, created_at DESC
        LIMIT 1
      `).get(sessionId, nCwd) || null;
    } finally {
      db.close();
    }

    const parts = [];

    // Archivos editados
    if (files_modified.length > 0) {
      const shown = files_modified.slice(0, RENDER.MAX_FILES_SUMMARY).map(f => basename(f)).join(', ');
      const extra = files_modified.length > RENDER.MAX_FILES_SUMMARY ? ` +${files_modified.length - RENDER.MAX_FILES_SUMMARY}` : '';
      parts.push(`Editó ${files_modified.length} archivo(s): ${shown}${extra}`);
    }

    // Estado técnico
    if (snapshot?.technical_state) {
      try {
        const ts = JSON.parse(snapshot.technical_state);
        const tsParts = [];
        if (ts.ts_errors !== undefined) tsParts.push(`${ts.ts_errors} TS errors`);
        if (ts.test_summary) tsParts.push(ts.test_summary.split('\n').pop());
        if (tsParts.length > 0) parts.push(tsParts.join(', '));
      } catch {}
    }

    // Tarea principal
    if (snapshot?.current_task && snapshot.snapshot_type === 'manual') {
      parts.push(`Tarea: ${snapshot.current_task}`);
    }

    // Pendiente
    if (snapshot?.next_action && snapshot.snapshot_type === 'manual') {
      parts.push(`Pendiente: ${snapshot.next_action}`);
    }

    // Tools usados
    const toolEntries = Object.entries(tools_used);
    if (toolEntries.length > 0 && parts.length === 0) {
      // Si no hay nada más, al menos listar tools
      const toolStr = toolEntries.map(([k, v]) => `${k}(${v})`).join(', ');
      parts.push(`Tools: ${toolStr}`);
    }

    if (parts.length === 0) return null;

    const summary = parts.join('. ') + '.';
    return redact(summary.slice(0, TRUNCATE.SUMMARY_MAX));
  } catch {
    return null;
  }
}

const MAX_TRANSCRIPT = SIZES.TRANSCRIPT_MAX_THINKING;

async function extractThinkingFromTranscript(transcriptPath, sessionId, cwd) {
  let buf;
  try { buf = readFileSync(transcriptPath); } catch { return; }
  // Read full transcript (up to 20MB) — thinking is not just at the end
  const slice = buf.length > MAX_TRANSCRIPT
    ? buf.slice(buf.length - MAX_TRANSCRIPT).toString('utf8')
    : buf.toString('utf8');

  const lines = slice.split('\n').filter(l => l.trim());
  let turnNumber = 0;

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'assistant') continue;

    const contentArray = entry.message?.content ?? entry.content;
    if (!Array.isArray(contentArray)) continue;

    let thinking_text = '';
    let response_text = '';

    for (const block of contentArray) {
      if (block.type === 'thinking' && (block.thinking || block.text)) {
        const t = block.thinking || block.text;
        thinking_text += (thinking_text ? '\n' : '') + t;
      } else if (block.type === 'text' && block.text) {
        response_text += (response_text ? '\n' : '') + block.text;
      }
    }

    if (!thinking_text && !response_text) continue;

    turnNumber++;
    try {
      insertTurnLog(sessionId, cwd, {
        turn_number: turnNumber,
        thinking_text: thinking_text ? redact(thinking_text) : '',
        response_text: response_text ? redact(response_text) : ''
      });
    } catch { /* best-effort */ }
  }
}

function collectAiContext(sessionId, cwd, filesModified) {
  const db = getDb();
  try {
    const nCwd = normalizeCwd(cwd);

    const promptRows = db.prepare(`
      SELECT prompt_text FROM user_prompts
      WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(sessionId, AI.CONTEXT_PROMPTS);
    const prompts = promptRows.map(r => r.prompt_text).reverse();

    // Current task from snapshot
    const snapshot = db.prepare(`
      SELECT current_task FROM execution_snapshots
      WHERE session_id = ? AND cwd = ?
      ORDER BY CASE WHEN snapshot_type = 'manual' THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1
    `).get(sessionId, nCwd);

    const obsRows = db.prepare(`
      SELECT action FROM observations
      WHERE session_id = ? AND action IS NOT NULL
      ORDER BY created_at DESC LIMIT ?
    `).all(sessionId, AI.CONTEXT_OBSERVATIONS);
    const topObservations = obsRows.map(r => r.action).reverse();

    return {
      files_modified: (filesModified || []).map(f => basename(f)),
      prompts,
      current_task: snapshot?.current_task || null,
      top_observations: topObservations,
    };
  } finally {
    db.close();
  }
}

function getToolsAndFiles(sessionId) {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT tool_name, action, files
      FROM observations WHERE session_id = ?
    `).all(sessionId);

    const toolsCounts = {};
    const filesRead = new Set();
    const filesModified = new Set();
    const bashActions = [];

    const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
    for (const row of rows) {
      if (row.tool_name) toolsCounts[row.tool_name] = (toolsCounts[row.tool_name] || 0) + 1;
      if (row.tool_name === 'Bash' && row.action) bashActions.push(row.action);
      if (row.files) {
        let files;
        try { files = JSON.parse(row.files); } catch { files = [row.files]; }
        if (!Array.isArray(files)) files = [files];
        const isWrite = WRITE_TOOLS.has(row.tool_name);
        for (const f of files) {
          if (f && typeof f === 'string') {
            if (isWrite) filesModified.add(f);
            else filesRead.add(f);
          }
        }
      }
    }

    return {
      tools_used: toolsCounts,
      files_read: [...filesRead],
      files_modified: [...filesModified],
      bash_actions: bashActions
    };
  } finally {
    db.close();
  }
}

async function main() {
  try {
    const input = await readStdin();
    const { session_id, cwd, transcript_path } = input;

    if (!session_id || !cwd) {
      if (!session_id) process.stderr.write('[local-mem] session-end: missing session_id\n');
      if (!cwd) process.stderr.write('[local-mem] session-end: missing cwd\n');
      process.exit(0);
    }

    let summaryText = null;
    let useTranscript = false;

    if (transcript_path) {
      if (isAbsolute(transcript_path) && !transcript_path.includes('..')) {
        useTranscript = true;
      } else {
        process.stderr.write('[local-mem] session-end: invalid transcript_path, skipping\n');
      }
    }

    const stats = getSessionStats(session_id);

    const obsCount = stats ? stats.observation_count : 0;
    const promptCount = stats ? stats.prompt_count : 0;

    // Skip completing sessions with zero activity (ghost sessions)
    if (obsCount === 0 && promptCount === 0) {
      process.stdout.write('Success\n');
      process.exit(0);
    }

    const { tools_used, files_read, files_modified, bash_actions } = getToolsAndFiles(session_id);

    // Collect prompts + snapshot for AI summary context
    const aiContext = collectAiContext(session_id, cwd, files_modified);

    // 1) Intentar resumen con IA (opt-in, necesita API key)
    try {
      summaryText = await generateAiSummary(aiContext);
    } catch { /* best-effort — fall through to structured */ }

    // 2) Fallback: resumen estructurado (datos DB)
    if (!summaryText) {
      summaryText = buildStructuredSummary(session_id, cwd, { tools_used, files_modified });
    }

    // 3) Fallback: extraer del transcript
    if (!summaryText && useTranscript) {
      summaryText = extractTranscriptSummary(transcript_path);
    }

    if (useTranscript) {
      try {
        await extractThinkingFromTranscript(transcript_path, session_id, cwd);
      } catch { /* best-effort — session still completes normally */ }
    }

    const now = Math.floor(Date.now() / 1000);
    const startedAt = stats ? stats.started_at : null;
    const durationSeconds = startedAt ? now - startedAt : null;

    const nCwd = normalizeCwd(cwd || '');
    const project = nCwd ? basename(nCwd) : '';

    completeSession(session_id, {
      cwd: nCwd,
      project,
      summary_text: summaryText,
      tools_used,
      files_read,
      files_modified,
      observation_count: obsCount,
      prompt_count: promptCount,
      duration_seconds: durationSeconds
    });

    if (obsCount > 0) {
      try {
        const detected = inferProjectDna(tools_used, files_modified, files_read, bash_actions);
        if (detected.stack.length > 0 || detected.key_files.length > 0) {
          updateProjectDna(cwd, detected);
        }
      } catch { /* best-effort */ }
    }

    process.stdout.write('Success\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[local-mem] Error: ${err.message}\n`);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    process.exit(0);
  }
}

// Only run main when executed directly (not when imported for testing)
const isDirectRun = process.argv[1] && import.meta.path.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isDirectRun) {
  main();
}
