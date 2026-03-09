/**
 * Unit tests for v0.8.0 new functions:
 * - getKeyThinking (db.mjs)
 * - groupObservations (session-start.mjs)
 * - renderGroupedObservations (session-start.mjs)
 * - buildStructuredSummary (session-end.mjs)
 *
 * Run: bun test tests/v080.test.mjs
 */

import { test, expect, describe, beforeEach } from 'bun:test';
import { mkdirSync } from 'fs';
import { join } from 'path';

// ─── Test DB setup ───────────────────────────────────────────────────────────
const TEST_DB_DIR = '/tmp/local-mem-test-v080';
const TEST_DB_PATH = join(TEST_DB_DIR, 'test-v080.db');

mkdirSync(TEST_DB_DIR, { recursive: true });
process.env.LOCAL_MEM_DB_PATH = TEST_DB_PATH;

// Import after setting env
import {
  getDb, ensureSession, insertObservation, insertTurnLog,
  saveExecutionSnapshot, normalizeCwd, getKeyThinking,
} from '../scripts/db.mjs';

import { groupObservations, renderGroupedObservations } from '../scripts/session-start.mjs';
import { buildStructuredSummary } from '../scripts/session-end.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────
const TEST_CWD = '/test/project/v080';
let sessionCounter = 0;

function freshSession() {
  return `v080-sess-${Date.now()}-${++sessionCounter}`;
}

function cleanDb() {
  const db = getDb();
  db.exec('DELETE FROM turn_log');
  db.exec('DELETE FROM observations');
  db.exec('DELETE FROM execution_snapshots');
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM session_summaries');
  db.close();
}

function insertThinking(sessionId, cwd, text, responseText = '', offsetSec = 0) {
  insertTurnLog(sessionId, cwd, {
    turn_number: ++sessionCounter,
    thinking_text: text,
    response_text: responseText,
  });
  // Adjust created_at for ordering
  if (offsetSec) {
    const db = getDb();
    db.prepare(`
      UPDATE turn_log SET created_at = created_at + ?
      WHERE session_id = ? AND thinking_text = ?
    `).run(offsetSec, sessionId, text);
    db.close();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// getKeyThinking
// ═════════════════════════════════════════════════════════════════════════════
describe('getKeyThinking', () => {
  beforeEach(() => cleanDb());

  test('returns decision-bearing thinking via FTS5', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    insertThinking(sid, TEST_CWD, 'Decidí usar SQLite porque es más simple y no requiere servidor externo. La alternativa era PostgreSQL.', '', -30);
    insertThinking(sid, TEST_CWD, 'Analyzing imports...', '', -20);
    insertThinking(sid, TEST_CWD, 'El problema principal es que FTS5 no indexa bien los acentos. La solución fue sanitizar keywords individualmente.', '', -10);

    const results = getKeyThinking(TEST_CWD, sid, 5);
    expect(results.length).toBeGreaterThanOrEqual(2);

    // Decision-bearing entries should be present
    const texts = results.map(r => r.thinking_text);
    expect(texts.some(t => t.includes('Decidí'))).toBe(true);
    expect(texts.some(t => t.includes('problema'))).toBe(true);
  });

  test('fallback returns recent thinking when FTS finds nothing', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    // Short thinking that won't match FTS keywords
    insertThinking(sid, TEST_CWD, 'Checking file structure', '', -20);
    insertThinking(sid, TEST_CWD, 'Looking at imports and exports', '', -10);

    const results = getKeyThinking(TEST_CWD, sid, 5);
    expect(results.length).toBe(2);
  });

  test('returns empty array when no thinking exists', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    const results = getKeyThinking(TEST_CWD, sid, 5);
    expect(results).toEqual([]);
  });

  test('respects limit parameter', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    for (let i = 0; i < 10; i++) {
      insertThinking(sid, TEST_CWD, `Decidí la estrategia ${i} porque es mejor alternativa`, '', -100 + i * 10);
    }

    const results = getKeyThinking(TEST_CWD, sid, 3);
    expect(results.length).toBe(3);
  });

  test('filters by sessionId when provided', () => {
    const sid1 = freshSession();
    const sid2 = freshSession();
    ensureSession(sid1, 'test-project', TEST_CWD);
    ensureSession(sid2, 'test-project', TEST_CWD);

    insertThinking(sid1, TEST_CWD, 'Decidí usar patrón A porque es más eficiente', '', -20);
    insertThinking(sid2, TEST_CWD, 'Decidí usar patrón B por la alternativa', '', -10);

    const results = getKeyThinking(TEST_CWD, sid1, 5);
    const texts = results.map(r => r.thinking_text);
    expect(texts.some(t => t.includes('patrón A'))).toBe(true);
    expect(texts.some(t => t.includes('patrón B'))).toBe(false);
  });

  test('returns results for all sessions when sessionId is null', () => {
    const sid1 = freshSession();
    const sid2 = freshSession();
    ensureSession(sid1, 'test-project', TEST_CWD);
    ensureSession(sid2, 'test-project', TEST_CWD);

    insertThinking(sid1, TEST_CWD, 'Decidí usar patrón A porque es mejor', '', -20);
    insertThinking(sid2, TEST_CWD, 'Decidí usar patrón B como alternativa', '', -10);

    const results = getKeyThinking(TEST_CWD, null, 5);
    expect(results.length).toBe(2);
  });

  test('deduplicates FTS and fallback results', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    // This matches FTS AND would appear in fallback (recent)
    insertThinking(sid, TEST_CWD, 'Decidí usar SQLite porque es la mejor solución para este problema específico');

    const results = getKeyThinking(TEST_CWD, sid, 5);
    // Should not have duplicates
    const uniqueTexts = new Set(results.map(r => r.thinking_text));
    expect(uniqueTexts.size).toBe(results.length);
  });

  test('results are sorted chronologically', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    insertThinking(sid, TEST_CWD, 'Decidí primero la estrategia general', '', -30);
    insertThinking(sid, TEST_CWD, 'Luego decidí la implementación específica porque era mejor', '', -10);

    const results = getKeyThinking(TEST_CWD, sid, 5);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].created_at).toBeGreaterThanOrEqual(results[i - 1].created_at);
    }
  });

  test('includes response_text in results', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    insertThinking(sid, TEST_CWD, 'Decidí refactorizar porque el código era complejo', 'Refactoricé el módulo principal');

    const results = getKeyThinking(TEST_CWD, sid, 5);
    expect(results[0].response_text).toBe('Refactoricé el módulo principal');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// groupObservations
// ═════════════════════════════════════════════════════════════════════════════
describe('groupObservations', () => {
  test('groups Edit/Write by file', () => {
    const obs = [
      { tool_name: 'Edit', files: '["src/app.ts"]', action: 'edit1', detail: 'changed imports' },
      { tool_name: 'Edit', files: '["src/app.ts"]', action: 'edit2', detail: 'added function' },
      { tool_name: 'Write', files: '["src/new.ts"]', action: 'write1', detail: 'created file' },
    ];

    const { editGroups, readGroups, ungrouped } = groupObservations(obs);

    expect(editGroups.size).toBe(2);
    expect(editGroups.get('src/app.ts').length).toBe(2);
    expect(editGroups.get('src/new.ts').length).toBe(1);
    expect(readGroups.size).toBe(0);
    expect(ungrouped.length).toBe(0);
  });

  test('groups NotebookEdit with edits', () => {
    const obs = [
      { tool_name: 'NotebookEdit', files: '["notebook.ipynb"]', action: 'edit cell', detail: 'updated cell 3' },
      { tool_name: 'Edit', files: '["notebook.ipynb"]', action: 'edit meta', detail: 'updated metadata' },
    ];

    const { editGroups } = groupObservations(obs);
    expect(editGroups.get('notebook.ipynb').length).toBe(2);
  });

  test('groups Read by file with count', () => {
    const obs = [
      { tool_name: 'Read', files: '["src/app.ts"]', action: 'read' },
      { tool_name: 'Read', files: '["src/app.ts"]', action: 'read' },
      { tool_name: 'Read', files: '["src/db.ts"]', action: 'read' },
    ];

    const { readGroups } = groupObservations(obs);
    expect(readGroups.get('src/app.ts')).toBe(2);
    expect(readGroups.get('src/db.ts')).toBe(1);
  });

  test('puts Bash/Agent/Grep/Glob in ungrouped', () => {
    const obs = [
      { tool_name: 'Bash', action: 'run tests', detail: 'bun test' },
      { tool_name: 'Agent', action: 'delegate', detail: 'search for patterns' },
      { tool_name: 'Grep', action: 'search', files: '["src/"]' },
      { tool_name: 'Glob', action: 'find files' },
    ];

    const { editGroups, readGroups, ungrouped } = groupObservations(obs);
    expect(editGroups.size).toBe(0);
    expect(readGroups.size).toBe(0);
    expect(ungrouped.length).toBe(4);
  });

  test('handles mixed observations correctly', () => {
    const obs = [
      { tool_name: 'Read', files: '["src/a.ts"]', action: 'read' },
      { tool_name: 'Edit', files: '["src/a.ts"]', action: 'edit', detail: 'changed line' },
      { tool_name: 'Bash', action: 'git status' },
      { tool_name: 'Read', files: '["src/a.ts"]', action: 'read' },
      { tool_name: 'Edit', files: '["src/b.ts"]', action: 'edit', detail: 'new file' },
    ];

    const { editGroups, readGroups, ungrouped } = groupObservations(obs);
    expect(editGroups.size).toBe(2); // a.ts, b.ts
    expect(editGroups.get('src/a.ts').length).toBe(1);
    expect(readGroups.get('src/a.ts')).toBe(2);
    expect(ungrouped.length).toBe(1); // Bash
  });

  test('handles malformed files JSON gracefully', () => {
    const obs = [
      { tool_name: 'Edit', files: 'not-json', action: 'edit', detail: 'something' },
      { tool_name: 'Read', files: '', action: 'read' },
    ];

    const { editGroups, readGroups, ungrouped } = groupObservations(obs);
    // Malformed JSON should fall through to ungrouped
    expect(ungrouped.length).toBe(2);
  });

  test('handles empty observations array', () => {
    const { editGroups, readGroups, ungrouped } = groupObservations([]);
    expect(editGroups.size).toBe(0);
    expect(readGroups.size).toBe(0);
    expect(ungrouped.length).toBe(0);
  });

  test('handles null files field', () => {
    const obs = [
      { tool_name: 'Edit', files: null, action: 'edit' },
      { tool_name: 'Read', files: null, action: 'read' },
    ];

    const { ungrouped } = groupObservations(obs);
    expect(ungrouped.length).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// renderGroupedObservations
// ═════════════════════════════════════════════════════════════════════════════
describe('renderGroupedObservations', () => {
  test('renders single edit per file with detail', () => {
    const obs = [
      { tool_name: 'Edit', files: '["src/app.ts"]', action: 'edit', detail: 'added validation', id: 42, created_at: 1000 },
    ];
    const lines = [];
    renderGroupedObservations(lines, obs, 10);

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('#42');
    expect(lines[0]).toContain('src/app.ts');
    expect(lines[0]).toContain('added validation');
  });

  test('renders multiple edits per file as grouped', () => {
    const obs = [
      { tool_name: 'Edit', files: '["src/app.ts"]', action: 'edit', detail: 'fix imports', id: 1, created_at: 1000 },
      { tool_name: 'Edit', files: '["src/app.ts"]', action: 'edit', detail: 'add function', id: 2, created_at: 1001 },
    ];
    const lines = [];
    renderGroupedObservations(lines, obs, 10);

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('2 edits');
    expect(lines[0]).toContain('src/app.ts');
  });

  test('renders read counts', () => {
    const obs = [
      { tool_name: 'Read', files: '["src/a.ts"]', action: 'read' },
      { tool_name: 'Read', files: '["src/a.ts"]', action: 'read' },
      { tool_name: 'Read', files: '["src/b.ts"]', action: 'read' },
    ];
    const lines = [];
    renderGroupedObservations(lines, obs, 10);

    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('2x');
    expect(lines[0]).toContain('src/a.ts');
    expect(lines[1]).toContain('src/b.ts');
    expect(lines[1]).not.toContain('x)');
  });

  test('renders ungrouped with timestamp and action', () => {
    const obs = [
      { tool_name: 'Bash', action: 'Ejecuto: bun test', detail: 'all passed', id: 99, created_at: Math.floor(Date.now() / 1000) },
    ];
    const lines = [];
    renderGroupedObservations(lines, obs, 10);

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('#99');
    expect(lines[0]).toContain('Ejecuto: bun test');
  });

  test('respects maxLines limit', () => {
    const obs = [];
    for (let i = 0; i < 20; i++) {
      obs.push({ tool_name: 'Bash', action: `cmd-${i}`, id: i, created_at: 1000 + i });
    }
    const lines = [];
    renderGroupedObservations(lines, obs, 5);

    // 5 rendered + 1 overflow indicator "... y N acciones más"
    expect(lines.length).toBe(6);
    expect(lines[5]).toContain('acciones más');
  });

  test('prioritizes edits over reads over ungrouped', () => {
    const obs = [
      { tool_name: 'Bash', action: 'git status', id: 1, created_at: 1000 },
      { tool_name: 'Read', files: '["src/a.ts"]', action: 'read' },
      { tool_name: 'Edit', files: '["src/b.ts"]', action: 'edit', detail: 'fix', id: 3, created_at: 1002 },
    ];
    const lines = [];
    renderGroupedObservations(lines, obs, 10);

    // Edit first, then Read, then Bash
    expect(lines[0]).toContain('src/b.ts');
    expect(lines[1]).toContain('src/a.ts');
    expect(lines[2]).toContain('git status');
  });

  test('handles empty observations', () => {
    const lines = [];
    renderGroupedObservations(lines, [], 10);
    expect(lines.length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// buildStructuredSummary
// ═════════════════════════════════════════════════════════════════════════════
describe('buildStructuredSummary', () => {
  beforeEach(() => cleanDb());

  test('builds summary from files_modified', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    const summary = buildStructuredSummary(sid, TEST_CWD, {
      files_modified: ['/project/src/app.ts', '/project/src/db.ts'],
    });

    expect(summary).toContain('Editó 2 archivo(s)');
    expect(summary).toContain('app.ts');
    expect(summary).toContain('db.ts');
  });

  test('truncates file list at 5 with +N indicator', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    const files = Array.from({ length: 8 }, (_, i) => `/project/file${i}.ts`);
    const summary = buildStructuredSummary(sid, TEST_CWD, { files_modified: files });

    expect(summary).toContain('8 archivo(s)');
    expect(summary).toContain('+3');
  });

  test('includes manual snapshot task and pending', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    saveExecutionSnapshot(sid, { cwd: TEST_CWD,
      current_task: 'Implementar auth',
      next_action: 'Agregar tests',
      snapshot_type: 'manual',
    });

    const summary = buildStructuredSummary(sid, TEST_CWD, {
      files_modified: ['/project/auth.ts'],
    });

    expect(summary).toContain('Tarea: Implementar auth');
    expect(summary).toContain('Pendiente: Agregar tests');
  });

  test('excludes task/pending from auto snapshots', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    saveExecutionSnapshot(sid, { cwd: TEST_CWD,
      current_task: 'Auto task',
      next_action: 'Auto next',
      snapshot_type: 'auto',
    });

    const summary = buildStructuredSummary(sid, TEST_CWD, {
      files_modified: ['/project/a.ts'],
    });

    expect(summary).not.toContain('Auto task');
    expect(summary).not.toContain('Auto next');
  });

  test('includes technical state from snapshot', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    saveExecutionSnapshot(sid, { cwd: TEST_CWD,
      technical_state: JSON.stringify({ ts_errors: 3, test_summary: 'Tests:\n5 passed, 1 failed' }),
      snapshot_type: 'auto',
    });

    const summary = buildStructuredSummary(sid, TEST_CWD, {
      files_modified: ['/project/a.ts'],
    });

    expect(summary).toContain('3 TS errors');
    expect(summary).toContain('1 failed');
  });

  test('falls back to tools_used when nothing else', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    const summary = buildStructuredSummary(sid, TEST_CWD, {
      tools_used: { Edit: 5, Bash: 3 },
    });

    expect(summary).toContain('Tools:');
    expect(summary).toContain('Edit(5)');
    expect(summary).toContain('Bash(3)');
  });

  test('returns null when no data', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    const summary = buildStructuredSummary(sid, TEST_CWD, {});
    expect(summary).toBeNull();
  });

  test('truncates summary to 500 chars', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    const longFiles = Array.from({ length: 50 }, (_, i) => `/very/long/path/to/deeply/nested/file-number-${i}.typescript.ts`);
    const summary = buildStructuredSummary(sid, TEST_CWD, {
      files_modified: longFiles,
    });

    expect(summary.length).toBeLessThanOrEqual(500);
  });

  test('prefers manual snapshot over auto snapshot', () => {
    const sid = freshSession();
    ensureSession(sid, 'test-project', TEST_CWD);

    saveExecutionSnapshot(sid, { cwd: TEST_CWD,
      current_task: 'Auto task',
      next_action: 'Auto action',
      snapshot_type: 'auto',
    });
    saveExecutionSnapshot(sid, { cwd: TEST_CWD,
      current_task: 'Manual task',
      next_action: 'Manual action',
      snapshot_type: 'manual',
    });

    const summary = buildStructuredSummary(sid, TEST_CWD, {
      files_modified: ['/a.ts'],
    });

    expect(summary).toContain('Manual task');
    expect(summary).not.toContain('Auto task');
  });
});
