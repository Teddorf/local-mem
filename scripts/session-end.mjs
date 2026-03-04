import { readFileSync } from 'fs';
import { basename, isAbsolute } from 'path';
import { readStdin } from './stdin.mjs';
import { getDb, completeSession, getSessionStats, normalizeCwd, insertTurnLog } from './db.mjs';
import { redact } from './redact.mjs';

const LAST_200KB = 200 * 1024;

function extractTranscriptSummary(transcriptPath) {
  try {
    let buf;
    try { buf = readFileSync(transcriptPath); } catch { return null; }
    const slice = buf.length > LAST_200KB
      ? buf.slice(buf.length - LAST_200KB).toString('utf8')
      : buf.toString('utf8');

    const lines = slice.split('\n').filter(l => l.trim());
    let lastAssistant = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'assistant') {
          lastAssistant = entry;
        }
      } catch { /* skip malformed lines */ }
    }

    if (!lastAssistant) return null;

    let text = '';
    const msg = lastAssistant.message || lastAssistant;
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

    if (!text) return null;

    // Limpiar system-reminders
    text = text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
      .replace(/<parameter name="context">[\s\S]*?<\/parameter>/gi, '')
      .trim();

    return text ? redact(text) : null;
  } catch {
    return null;
  }
}

async function extractThinkingFromTranscript(transcriptPath, sessionId, cwd) {
  let buf;
  try { buf = readFileSync(transcriptPath); } catch { return; }
  const slice = buf.length > LAST_200KB
    ? buf.slice(buf.length - LAST_200KB).toString('utf8')
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
      if (block.type === 'thinking' && block.text) {
        thinking_text += (thinking_text ? '\n' : '') + block.text;
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

    const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
    for (const row of rows) {
      if (row.tool_name) toolsCounts[row.tool_name] = (toolsCounts[row.tool_name] || 0) + 1;
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
      files_modified: [...filesModified]
    };
  } finally {
    db.close();
  }
}

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

  if (useTranscript) {
    summaryText = extractTranscriptSummary(transcript_path);
  }

  if (useTranscript) {
    try {
      await extractThinkingFromTranscript(transcript_path, session_id, cwd);
    } catch { /* best-effort — session still completes normally */ }
  }

  const stats = getSessionStats(session_id);
  const { tools_used, files_read, files_modified } = getToolsAndFiles(session_id);

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
    observation_count: stats ? stats.observation_count : 0,
    prompt_count: stats ? stats.prompt_count : 0,
    duration_seconds: durationSeconds
  });

  process.stdout.write('Success\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`[local-mem] Error: ${err.message}\n`);
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}
