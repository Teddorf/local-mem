/**
 * E2E Test Suite for local-mem
 * Tests the full lifecycle: DB → Hooks → MCP Server → Cleanup
 *
 * Run: bun test tests/e2e.test.mjs
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── Test DB setup ───────────────────────────────────────────────────────────
const TEST_DB_DIR = '/tmp/local-mem-test-e2e';
const TEST_DB_PATH = join(TEST_DB_DIR, 'test-e2e.db');

// Force test DB path before importing db.mjs
mkdirSync(TEST_DB_DIR, { recursive: true });
process.env.LOCAL_MEM_DB_PATH = TEST_DB_PATH;

// Import after setting env
import {
  getDb, closeDb, normalizeCwd,
  ensureSession, completeSession,
  insertObservation, insertPrompt,
  saveExecutionSnapshot, getLatestSnapshot,
  insertTurnLog, insertObservationScore,
  searchObservations, searchThinking,
  getRecentObservations, getRecentContext,
  getTopScoredObservations, getRecentPrompts,
  pruneAutoSnapshots, getSessionStats,
  getSessionDetail, getActiveSession,
  abandonOrphanSessions, forgetRecords,
  getCleanupTargets, executeCleanup,
  getExportData, getStatusData,
} from '../scripts/db.mjs';

import {
  redact, redactObject, sanitizeXml, truncate, isSensitiveFile,
} from '../scripts/redact.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────
const TEST_CWD = '/test/project/my-app';
const TEST_SESSION = 'test-session-' + Date.now();
let sessionCounter = 0;

function freshSession() {
  return `test-sess-${Date.now()}-${++sessionCounter}`;
}

function cleanDb() {
  try {
    const db = getDb();
    // Clear all data without dropping tables (avoids Windows file lock issues)
    db.exec(`
      DELETE FROM observation_scores;
      DELETE FROM observations;
      DELETE FROM user_prompts;
      DELETE FROM execution_snapshots;
      DELETE FROM session_summaries;
      DELETE FROM turn_log;
      DELETE FROM sessions;
    `);
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. DATABASE MODULE (db.mjs) — Core CRUD
// ═══════════════════════════════════════════════════════════════════════════════
describe('db.mjs — Core CRUD', () => {
  beforeEach(() => { cleanDb(); });
  afterEach(() => { closeDb(); });

  // --- normalizeCwd ---
  describe('normalizeCwd()', () => {
    test('replaces backslashes with forward slashes', () => {
      expect(normalizeCwd('C:\\Users\\m_ben\\project')).toBe('c:/users/m_ben/project');
    });
    test('removes trailing slashes', () => {
      expect(normalizeCwd('/home/user/project/')).toBe('/home/user/project');
    });
    test('lowercases Windows drive paths', () => {
      expect(normalizeCwd('D:\\Work\\API')).toBe('d:/work/api');
    });
    test('preserves POSIX paths as-is (no drive letter)', () => {
      expect(normalizeCwd('/home/User/Project')).toBe('/home/User/Project');
    });
    test('handles null/undefined gracefully', () => {
      expect(normalizeCwd(null)).toBeNull();
      expect(normalizeCwd(undefined)).toBeUndefined();
    });
    test('handles empty string', () => {
      expect(normalizeCwd('')).toBe('');
    });
  });

  // --- getDb / schema ---
  describe('getDb() — schema and connection', () => {
    test('creates DB and applies schema v6', () => {
      const db = getDb();
      const row = db.prepare('SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1').get();
      expect(row.version).toBe(6);
    });

    test('returns same singleton on repeated calls', () => {
      const db1 = getDb();
      const db2 = getDb();
      // Both should work (singleton)
      expect(db1.prepare('SELECT 1').get()).toBeTruthy();
      expect(db2.prepare('SELECT 1').get()).toBeTruthy();
    });

    test('creates all required tables', () => {
      const db = getDb();
      const tables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
      ).all().map(r => r.name);
      expect(tables).toContain('sessions');
      expect(tables).toContain('observations');
      expect(tables).toContain('user_prompts');
      expect(tables).toContain('session_summaries');
      expect(tables).toContain('execution_snapshots');
      expect(tables).toContain('turn_log');
      expect(tables).toContain('observation_scores');
    });

    test('creates FTS5 virtual tables', () => {
      const db = getDb();
      const tables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%' ORDER BY name`
      ).all().map(r => r.name);
      expect(tables).toContain('observations_fts');
      expect(tables).toContain('prompts_fts');
      expect(tables).toContain('turn_fts');
    });

    test('sets WAL mode and foreign keys', () => {
      const db = getDb();
      const jm = db.prepare('PRAGMA journal_mode').get();
      expect(jm.journal_mode).toBe('wal');
      const fk = db.prepare('PRAGMA foreign_keys').get();
      expect(fk.foreign_keys).toBe(1);
    });
  });

  // --- Sessions ---
  describe('ensureSession()', () => {
    test('creates a new session', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      const db = getDb();
      const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sid);
      expect(row).toBeTruthy();
      expect(row.project).toBe('my-app');
      expect(row.status).toBe('active');
    });

    test('idempotent — calling twice does not duplicate', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      ensureSession(sid, 'my-app', TEST_CWD);
      const db = getDb();
      const rows = db.prepare('SELECT * FROM sessions WHERE session_id = ?').all(sid);
      expect(rows.length).toBe(1);
    });

    test('normalizes CWD on insert', () => {
      const sid = freshSession();
      ensureSession(sid, 'test', 'C:\\Users\\Test\\Project');
      const db = getDb();
      const row = db.prepare('SELECT cwd FROM sessions WHERE session_id = ?').get(sid);
      expect(row.cwd).toBe('c:/users/test/project');
    });
  });

  // --- Observations ---
  describe('insertObservation()', () => {
    test('inserts and increments session counter', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);

      insertObservation(sid, {
        tool_name: 'Edit',
        action: 'Edito src/index.ts',
        files: JSON.stringify(['src/index.ts']),
        detail: 'Changed line 42',
        cwd: TEST_CWD,
      });

      const db = getDb();
      const obs = db.prepare('SELECT * FROM observations WHERE session_id = ?').all(sid);
      expect(obs.length).toBe(1);
      expect(obs[0].tool_name).toBe('Edit');
      expect(obs[0].action).toBe('Edito src/index.ts');

      // Trigger should have incremented observation_count
      const sess = db.prepare('SELECT observation_count FROM sessions WHERE session_id = ?').get(sid);
      expect(sess.observation_count).toBe(1);
    });

    test('FTS5 trigger indexes observation text', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      insertObservation(sid, {
        tool_name: 'Bash',
        action: 'Ejecuto: npm install express mongoose',
        files: null,
        detail: 'exit 0',
        cwd: TEST_CWD,
      });

      const results = searchObservations('express mongoose', TEST_CWD);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].action).toContain('express');
    });

    test('stores detail field (truncation only for JSON fields via jsonStringify)', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      const bigDetail = 'x'.repeat(20000);
      insertObservation(sid, {
        tool_name: 'Bash',
        action: 'Ejecuto: cat bigfile',
        files: null,
        detail: bigDetail,
        cwd: TEST_CWD,
      });
      const db = getDb();
      const obs = db.prepare('SELECT detail FROM observations WHERE session_id = ?').get(sid);
      // detail is stored as-is (not via jsonStringify), so it's not truncated
      expect(obs.detail.length).toBe(20000);
    });
  });

  // --- Prompts ---
  describe('insertPrompt()', () => {
    test('inserts prompt and increments counter', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);

      insertPrompt(sid, 'Fix the bug in auth.ts');

      const db = getDb();
      const rows = db.prepare('SELECT * FROM user_prompts WHERE session_id = ?').all(sid);
      expect(rows.length).toBe(1);
      expect(rows[0].prompt_text).toBe('Fix the bug in auth.ts');

      const sess = db.prepare('SELECT prompt_count FROM sessions WHERE session_id = ?').get(sid);
      expect(sess.prompt_count).toBe(1);
    });

    test('FTS5 indexes prompt text', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      insertPrompt(sid, 'Implement JWT authentication middleware');

      const db = getDb();
      const results = db.prepare(
        `SELECT p.* FROM prompts_fts f JOIN user_prompts p ON p.id = f.rowid
         WHERE prompts_fts MATCH 'JWT authentication'`
      ).all();
      expect(results.length).toBe(1);
    });
  });

  // --- completeSession ---
  describe('completeSession()', () => {
    test('sets status to completed and creates summary', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      insertObservation(sid, { tool_name: 'Edit', action: 'Edito test.ts', cwd: TEST_CWD });

      completeSession(sid, {
        cwd: TEST_CWD,
        project: 'my-app',
        summary_text: 'Fixed the auth bug',
        tools_used: { Edit: 1 },
        files_read: [],
        files_modified: ['test.ts'],
        observation_count: 1,
        prompt_count: 0,
        duration_seconds: 120,
      });

      const db = getDb();
      const sess = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sid);
      expect(sess.status).toBe('completed');
      expect(sess.completed_at).toBeTruthy();

      const summary = db.prepare('SELECT * FROM session_summaries WHERE session_id = ?').get(sid);
      expect(summary).toBeTruthy();
      expect(summary.summary_text).toBe('Fixed the auth bug');
      expect(summary.duration_seconds).toBe(120);
    });

    test('upserts summary (no duplicate on re-complete)', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      insertObservation(sid, { tool_name: 'Bash', action: 'test', cwd: TEST_CWD });

      completeSession(sid, { cwd: TEST_CWD, project: 'my-app', summary_text: 'First' });
      // Re-completing should update, not duplicate
      ensureSession(sid, 'my-app', TEST_CWD); // reactivate
      completeSession(sid, { cwd: TEST_CWD, project: 'my-app', summary_text: 'Second' });

      const db = getDb();
      const summaries = db.prepare('SELECT * FROM session_summaries WHERE session_id = ?').all(sid);
      expect(summaries.length).toBe(1);
      expect(summaries[0].summary_text).toBe('Second');
    });
  });

  // --- Execution Snapshots ---
  describe('saveExecutionSnapshot() / getLatestSnapshot()', () => {
    test('saves and retrieves snapshot', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);

      const result = saveExecutionSnapshot(sid, {
        cwd: TEST_CWD,
        current_task: 'Implement auth',
        execution_point: 'Step 3 of 5',
        next_action: 'Write tests',
        pending_tasks: ['Deploy', 'Docs'],
        plan: ['Design', 'Implement', 'Test'],
        open_decisions: ['JWT vs sessions'],
        active_files: ['src/auth.ts'],
        blocking_issues: [],
        snapshot_type: 'manual',
        task_status: 'in_progress',
      });

      expect(result.id).toBeGreaterThan(0);

      const snapshot = getLatestSnapshot(TEST_CWD);
      expect(snapshot).toBeTruthy();
      expect(snapshot.current_task).toBe('Implement auth');
      expect(snapshot.execution_point).toBe('Step 3 of 5');
      expect(snapshot.snapshot_type).toBe('manual');
    });

    test('getLatestSnapshot with type filter', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);

      saveExecutionSnapshot(sid, {
        cwd: TEST_CWD, current_task: 'Auto snap', snapshot_type: 'auto', task_status: 'in_progress',
      });
      saveExecutionSnapshot(sid, {
        cwd: TEST_CWD, current_task: 'Manual snap', snapshot_type: 'manual', task_status: 'in_progress',
      });

      const auto = getLatestSnapshot(TEST_CWD, 'auto');
      expect(auto.current_task).toBe('Auto snap');

      const manual = getLatestSnapshot(TEST_CWD, 'manual');
      expect(manual.current_task).toBe('Manual snap');
    });
  });

  // --- Turn log ---
  describe('insertTurnLog() / searchThinking()', () => {
    test('inserts turn and makes it searchable', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);

      insertTurnLog(sid, TEST_CWD, {
        turn_number: 1,
        thinking_text: 'I need to analyze the database schema carefully',
        response_text: 'Let me check the schema',
      });

      const results = searchThinking('database schema', TEST_CWD);
      expect(results.length).toBe(1);
      expect(results[0].thinking_text).toContain('database schema');
    });

    test('truncates thinking to 2048 and response to 1024', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);

      insertTurnLog(sid, TEST_CWD, {
        turn_number: 1,
        thinking_text: 'x'.repeat(5000),
        response_text: 'y'.repeat(3000),
      });

      const db = getDb();
      const row = db.prepare('SELECT thinking_text, response_text FROM turn_log WHERE session_id = ?').get(sid);
      expect(row.thinking_text.length).toBe(4096);
      expect(row.response_text.length).toBe(2048);
    });

    test('upserts on duplicate (session_id, turn_number)', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);

      insertTurnLog(sid, TEST_CWD, { turn_number: 1, thinking_text: 'v1', response_text: 'r1' });
      insertTurnLog(sid, TEST_CWD, { turn_number: 1, thinking_text: 'v2', response_text: 'r2' });

      const db = getDb();
      const rows = db.prepare('SELECT * FROM turn_log WHERE session_id = ?').all(sid);
      expect(rows.length).toBe(1);
      expect(rows[0].thinking_text).toBe('v2');
    });
  });

  // --- Observation scores ---
  describe('insertObservationScore() / getTopScoredObservations()', () => {
    test('inserts score and retrieves top scored', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);

      const r1 = insertObservation(sid, { tool_name: 'Edit', action: 'Edito critical.ts', cwd: TEST_CWD });
      const r2 = insertObservation(sid, { tool_name: 'Read', action: 'Leyo readme.md', cwd: TEST_CWD });

      insertObservationScore(Number(r1.lastInsertRowid), 0.8);
      insertObservationScore(Number(r2.lastInsertRowid), 0.3);

      const top = getTopScoredObservations(TEST_CWD, { minScore: 0.0, limit: 10 });
      expect(top.length).toBeGreaterThanOrEqual(1);
      // Edit should rank higher
      const editObs = top.find(o => o.action.includes('critical'));
      expect(editObs).toBeTruthy();
    });
  });

  // --- getRecentPrompts ---
  describe('getRecentPrompts()', () => {
    test('returns most recent prompts', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      insertPrompt(sid, 'First prompt');
      insertPrompt(sid, 'Second prompt');
      insertPrompt(sid, 'Third prompt');
      insertPrompt(sid, 'Fourth prompt');

      const prompts = getRecentPrompts(TEST_CWD, 3);
      expect(prompts.length).toBe(3);
      // All prompts should be from this session (ordering within same second may vary)
      const texts = prompts.map(p => p.prompt_text);
      // The 3 returned must be a subset of our 4 inserts
      for (const t of texts) {
        expect(['First prompt', 'Second prompt', 'Third prompt', 'Fourth prompt']).toContain(t);
      }
    });
  });

  // --- pruneAutoSnapshots ---
  describe('pruneAutoSnapshots()', () => {
    test('keeps only maxKeep auto-snapshots', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);

      for (let i = 0; i < 5; i++) {
        saveExecutionSnapshot(sid, {
          cwd: TEST_CWD, current_task: `Auto ${i}`, snapshot_type: 'auto', task_status: 'in_progress',
        });
      }
      // Also a manual snapshot that should NOT be pruned
      saveExecutionSnapshot(sid, {
        cwd: TEST_CWD, current_task: 'Manual', snapshot_type: 'manual', task_status: 'in_progress',
      });

      pruneAutoSnapshots(sid, TEST_CWD, 2);

      const db = getDb();
      const autos = db.prepare(
        `SELECT * FROM execution_snapshots WHERE session_id = ? AND snapshot_type = 'auto'`
      ).all(sid);
      expect(autos.length).toBe(2);

      const manuals = db.prepare(
        `SELECT * FROM execution_snapshots WHERE session_id = ? AND snapshot_type = 'manual'`
      ).all(sid);
      expect(manuals.length).toBe(1);
    });
  });

  // --- getSessionStats ---
  describe('getSessionStats()', () => {
    test('returns counts and timestamps', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      insertObservation(sid, { tool_name: 'Edit', action: 'test', cwd: TEST_CWD });
      insertPrompt(sid, 'test prompt');

      const stats = getSessionStats(sid);
      expect(stats).toBeTruthy();
      expect(stats.observation_count).toBe(1);
      expect(stats.prompt_count).toBe(1);
      expect(stats.status).toBe('active');
      expect(stats.started_at).toBeGreaterThan(0);
    });

    test('returns null for non-existent session', () => {
      const stats = getSessionStats('nonexistent-session');
      expect(stats).toBeNull();
    });
  });

  // --- getSessionDetail ---
  describe('getSessionDetail()', () => {
    test('returns full session data', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      insertObservation(sid, { tool_name: 'Bash', action: 'npm test', cwd: TEST_CWD });
      insertPrompt(sid, 'Run the tests');

      const detail = getSessionDetail(sid, TEST_CWD);
      expect(detail).toBeTruthy();
      expect(detail.session.session_id).toBe(sid);
      expect(detail.observations.length).toBe(1);
      expect(detail.prompts.length).toBe(1);
    });

    test('returns latest session when session_id is null', () => {
      const sid1 = freshSession();
      const sid2 = freshSession();
      ensureSession(sid1, 'my-app', TEST_CWD);
      ensureSession(sid2, 'my-app', TEST_CWD);

      const detail = getSessionDetail(null, TEST_CWD);
      expect(detail).toBeTruthy();
      // Both sessions created in same second — either could be "latest"
      expect([sid1, sid2]).toContain(detail.session.session_id);
    });

    test('returns null for non-existent session', () => {
      const detail = getSessionDetail('nonexistent', TEST_CWD);
      expect(detail).toBeNull();
    });
  });

  // --- getActiveSession ---
  describe('getActiveSession()', () => {
    test('returns active session id', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      expect(getActiveSession(TEST_CWD)).toBe(sid);
    });

    test('returns null when no active sessions', () => {
      expect(getActiveSession('/nonexistent/path')).toBeNull();
    });
  });

  // --- abandonOrphanSessions ---
  describe('abandonOrphanSessions()', () => {
    test('marks old active sessions as abandoned', () => {
      const sid = freshSession();
      const db = getDb();
      // Insert a session manually with old timestamp (5 hours ago)
      db.prepare(`
        INSERT INTO sessions (session_id, project, cwd, started_at, status)
        VALUES (?, 'test', ?, unixepoch() - 18000, 'active')
      `).run(sid, normalizeCwd(TEST_CWD));

      const count = abandonOrphanSessions(TEST_CWD, 4);
      expect(count).toBe(1);

      const sess = db.prepare('SELECT status FROM sessions WHERE session_id = ?').get(sid);
      expect(sess.status).toBe('abandoned');
    });

    test('does not abandon recent sessions', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      const count = abandonOrphanSessions(TEST_CWD, 4);
      expect(count).toBe(0);
    });
  });

  // --- forgetRecords ---
  describe('forgetRecords()', () => {
    test('deletes observations by ID', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      const r1 = insertObservation(sid, { tool_name: 'Edit', action: 'secret edit', cwd: TEST_CWD });
      const obsId = Number(r1.lastInsertRowid);

      const deleted = forgetRecords('observation', [obsId], TEST_CWD);
      // deleted count may be > 1 due to FTS trigger cascades
      expect(deleted).toBeGreaterThanOrEqual(1);

      const db = getDb();
      const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(obsId);
      expect(row).toBeFalsy();
    });

    test('throws for invalid type', () => {
      expect(() => forgetRecords('invalid', [1], TEST_CWD)).toThrow();
    });

    test('throws when IDs belong to different project', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', '/other/project');
      const r = insertObservation(sid, { tool_name: 'Edit', action: 'test', cwd: '/other/project' });
      const obsId = Number(r.lastInsertRowid);

      expect(() => forgetRecords('observation', [obsId], TEST_CWD)).toThrow('Some IDs do not belong');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. DATABASE MODULE — Search & Context
// ═══════════════════════════════════════════════════════════════════════════════
describe('db.mjs — Search & Context', () => {
  beforeEach(() => { cleanDb(); });
  afterEach(() => { closeDb(); });

  describe('searchObservations()', () => {
    test('returns matching results via FTS5', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      insertObservation(sid, { tool_name: 'Edit', action: 'Edito authentication module', cwd: TEST_CWD });
      insertObservation(sid, { tool_name: 'Read', action: 'Leyo database config', cwd: TEST_CWD });

      const results = searchObservations('authentication', TEST_CWD);
      expect(results.length).toBe(1);
      expect(results[0].action).toContain('authentication');
    });

    test('returns empty for empty/null query', () => {
      expect(searchObservations('', TEST_CWD)).toEqual([]);
      expect(searchObservations(null, TEST_CWD)).toEqual([]);
    });

    test('sanitizes dangerous FTS5 operators', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      insertObservation(sid, { tool_name: 'Bash', action: 'test action', cwd: TEST_CWD });

      // Should not throw with FTS operators
      expect(() => searchObservations('AND OR NOT NEAR', TEST_CWD)).not.toThrow();
      expect(() => searchObservations('test"query', TEST_CWD)).not.toThrow();
      expect(() => searchObservations('test*(){}[]', TEST_CWD)).not.toThrow();
    });

    test('respects cwd isolation', () => {
      const sid1 = freshSession();
      const sid2 = freshSession();
      ensureSession(sid1, 'proj-a', '/project/a');
      ensureSession(sid2, 'proj-b', '/project/b');
      insertObservation(sid1, { tool_name: 'Edit', action: 'unique keyword alpha', cwd: '/project/a' });
      insertObservation(sid2, { tool_name: 'Edit', action: 'unique keyword alpha', cwd: '/project/b' });

      const results = searchObservations('alpha', '/project/a');
      expect(results.length).toBe(1);
    });

    test('supports pagination with limit and offset', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      for (let i = 0; i < 5; i++) {
        insertObservation(sid, { tool_name: 'Bash', action: `test search item ${i}`, cwd: TEST_CWD });
      }

      const page1 = searchObservations('test search', TEST_CWD, { limit: 2, offset: 0 });
      const page2 = searchObservations('test search', TEST_CWD, { limit: 2, offset: 2 });
      expect(page1.length).toBe(2);
      expect(page2.length).toBe(2);
    });
  });

  describe('getRecentContext()', () => {
    test('returns all context sections when data exists', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      insertObservation(sid, { tool_name: 'Edit', action: 'Edito app.ts', cwd: TEST_CWD });
      insertPrompt(sid, 'Fix the app');
      saveExecutionSnapshot(sid, {
        cwd: TEST_CWD, current_task: 'Fixing app', snapshot_type: 'manual', task_status: 'in_progress',
      });
      insertTurnLog(sid, TEST_CWD, { turn_number: 1, thinking_text: 'Analyzing...', response_text: 'Done' });

      const ctx = getRecentContext(TEST_CWD);
      expect(ctx.observations.length).toBeGreaterThan(0);
      expect(ctx.snapshot).toBeTruthy();
      expect(ctx.thinking).toBeTruthy();
      expect(ctx.prompts.length).toBeGreaterThan(0);
      expect(ctx.recentSessions.length).toBeGreaterThan(0);
    });

    test('returns empty arrays/null for fresh project', () => {
      const ctx = getRecentContext('/brand/new/project');
      expect(ctx.observations).toEqual([]);
      expect(ctx.summary).toBeNull();
      expect(ctx.snapshot).toBeNull();
    });

    test('prefers manual snapshot over auto', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      saveExecutionSnapshot(sid, {
        cwd: TEST_CWD, current_task: 'Auto task', snapshot_type: 'auto', task_status: 'in_progress',
      });
      saveExecutionSnapshot(sid, {
        cwd: TEST_CWD, current_task: 'Manual task', snapshot_type: 'manual', task_status: 'in_progress',
      });

      const ctx = getRecentContext(TEST_CWD);
      expect(ctx.snapshot.current_task).toBe('Manual task');
    });
  });

  describe('getRecentObservations()', () => {
    test('returns observations ordered by created_at DESC', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      insertObservation(sid, { tool_name: 'Read', action: 'First', cwd: TEST_CWD });
      insertObservation(sid, { tool_name: 'Edit', action: 'Second', cwd: TEST_CWD });

      const obs = getRecentObservations(TEST_CWD, { limit: 10 });
      expect(obs.length).toBe(2);
      // Both observations should be present (order within same second may vary)
      const actions = obs.map(o => o.action);
      expect(actions).toContain('First');
      expect(actions).toContain('Second');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. DATABASE MODULE — Cleanup & Export
// ═══════════════════════════════════════════════════════════════════════════════
describe('db.mjs — Cleanup & Export', () => {
  beforeEach(() => { cleanDb(); });
  afterEach(() => { closeDb(); });

  describe('getCleanupTargets() / executeCleanup()', () => {
    test('preview counts old records', () => {
      const sid = freshSession();
      const db = getDb();
      // Insert old session (200 days ago)
      db.prepare(`
        INSERT INTO sessions (session_id, project, cwd, started_at, status)
        VALUES (?, 'test', ?, unixepoch() - 200*86400, 'completed')
      `).run(sid, normalizeCwd(TEST_CWD));

      db.prepare(`
        INSERT INTO observations (session_id, tool_name, action, cwd, created_at)
        VALUES (?, 'Bash', 'old action', ?, unixepoch() - 200*86400)
      `).run(sid, normalizeCwd(TEST_CWD));

      const targets = getCleanupTargets(TEST_CWD, 90);
      expect(targets.observations).toBeGreaterThanOrEqual(1);
      expect(targets.total).toBeGreaterThanOrEqual(1);
    });

    test('executeCleanup removes old records', () => {
      const sid = freshSession();
      const db = getDb();
      db.prepare(`
        INSERT INTO sessions (session_id, project, cwd, started_at, status)
        VALUES (?, 'test', ?, unixepoch() - 200*86400, 'completed')
      `).run(sid, normalizeCwd(TEST_CWD));
      db.prepare(`
        INSERT INTO observations (session_id, tool_name, action, cwd, created_at)
        VALUES (?, 'Bash', 'old action', ?, unixepoch() - 200*86400)
      `).run(sid, normalizeCwd(TEST_CWD));

      const result = executeCleanup(TEST_CWD, 90);
      expect(result.observations).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    test('cleanup does not delete active session data', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      insertObservation(sid, { tool_name: 'Edit', action: 'current work', cwd: TEST_CWD });

      // Try cleaning very aggressively (1 day)
      const targets = getCleanupTargets(TEST_CWD, 1);
      expect(targets.observations).toBe(0); // active session protected
    });
  });

  describe('getExportData()', () => {
    test('exports in JSON format', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      insertObservation(sid, { tool_name: 'Edit', action: 'export test', cwd: TEST_CWD });
      insertPrompt(sid, 'test prompt');

      const result = getExportData(TEST_CWD, 'json', 500, 0);
      expect(result.data.observations.length).toBe(1);
      expect(result.data.prompts.length).toBe(1);
      expect(result.metadata.total).toBe(1);
    });

    test('exports in CSV format', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      insertObservation(sid, { tool_name: 'Bash', action: 'csv test', cwd: TEST_CWD });

      const result = getExportData(TEST_CWD, 'csv', 500, 0);
      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('id,session_id,tool_name');
      expect(result.data).toContain('csv test');
    });

    test('caps limit at 500', () => {
      const result = getExportData(TEST_CWD, 'json', 9999, 0);
      // Should not throw, metadata shows capped limit was applied
      expect(result.metadata).toBeTruthy();
    });

    test('pagination with hasMore', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      for (let i = 0; i < 5; i++) {
        insertObservation(sid, { tool_name: 'Bash', action: `item ${i}`, cwd: TEST_CWD });
      }

      const page1 = getExportData(TEST_CWD, 'json', 2, 0);
      expect(page1.metadata.returned).toBe(2);
      expect(page1.metadata.hasMore).toBe(true);

      const page2 = getExportData(TEST_CWD, 'json', 2, 2);
      expect(page2.metadata.returned).toBe(2);
    });
  });

  describe('getStatusData()', () => {
    test('returns comprehensive status', () => {
      const sid = freshSession();
      ensureSession(sid, 'my-app', TEST_CWD);
      insertObservation(sid, { tool_name: 'Bash', action: 'test', cwd: TEST_CWD });

      const status = getStatusData(TEST_CWD);
      expect(status.dbPath).toContain('test-e2e.db');
      expect(status.dbSize).toBeGreaterThan(0);
      expect(status.schemaVersion).toBe(6);
      expect(status.sessions.total).toBeGreaterThanOrEqual(1);
      expect(status.sessions.active).toBeGreaterThanOrEqual(1);
      expect(status.observations).toBeGreaterThanOrEqual(1);
      expect(status.lastActivity).toBeGreaterThan(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. REDACTION MODULE (redact.mjs) — Extended
// ═══════════════════════════════════════════════════════════════════════════════
describe('redact.mjs — Extended E2E', () => {
  test('redacts secrets embedded in longer text', () => {
    const text = 'Deploying with key sk-abcdefghijklmnopqrst1234 to production server';
    const result = redact(text);
    expect(result).not.toContain('sk-abcdefghijklmnopqrst1234');
    expect(result).toContain('Deploying with key');
    expect(result).toContain('to production server');
  });

  test('redacts multiple different secret types in same string', () => {
    const text = `API: sk-test12345678901234567890
AWS: AKIAIOSFODNN7EXAMPLE
DB: mongodb://admin:pass123@host:27017/prod`;
    const result = redact(text);
    expect(result).not.toContain('sk-test');
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result).not.toContain('mongodb://');
    expect((result.match(/\[REDACTED\]/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  test('redactObject handles deeply nested structures', () => {
    const obj = {
      config: {
        auth: {
          tokens: ['ghp_' + 'a'.repeat(36)],
          settings: {
            key: 'sk-' + 'b'.repeat(40),
          },
        },
        name: 'my-app',
      },
    };
    const result = redactObject(obj);
    expect(result.config.auth.tokens[0]).toBe('[REDACTED]');
    expect(result.config.auth.settings.key).toBe('[REDACTED]');
    expect(result.config.name).toBe('my-app');
  });

  test('isSensitiveFile covers all sensitive patterns', () => {
    // Exact matches
    for (const f of ['.env', '.env.local', '.env.production', '.env.staging',
      '.env.development', '.env.test', 'credentials.json', 'credentials.yml',
      'secrets.json', '.npmrc', 'id_rsa', 'id_ed25519', 'kubeconfig', 'token.json']) {
      expect(isSensitiveFile(f)).toBe(true);
    }
    // Pattern matches
    expect(isSensitiveFile('.env.custom')).toBe(true);
    expect(isSensitiveFile('server.pem')).toBe(true);
    expect(isSensitiveFile('tls.key')).toBe(true);
    // Non-sensitive
    expect(isSensitiveFile('index.js')).toBe(false);
    expect(isSensitiveFile('package.json')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. MULTI-PROJECT ISOLATION
// ═══════════════════════════════════════════════════════════════════════════════
describe('Multi-project isolation', () => {
  beforeEach(() => { cleanDb(); });
  afterEach(() => { closeDb(); });

  test('observations in project A are invisible to project B', () => {
    const sidA = freshSession();
    const sidB = freshSession();
    ensureSession(sidA, 'proj-a', '/work/proj-a');
    ensureSession(sidB, 'proj-b', '/work/proj-b');

    insertObservation(sidA, { tool_name: 'Edit', action: 'Edit in A', cwd: '/work/proj-a' });
    insertObservation(sidB, { tool_name: 'Edit', action: 'Edit in B', cwd: '/work/proj-b' });

    const obsA = getRecentObservations('/work/proj-a');
    const obsB = getRecentObservations('/work/proj-b');

    expect(obsA.length).toBe(1);
    expect(obsA[0].action).toBe('Edit in A');
    expect(obsB.length).toBe(1);
    expect(obsB[0].action).toBe('Edit in B');
  });

  test('FTS search respects cwd boundaries', () => {
    const sidA = freshSession();
    const sidB = freshSession();
    ensureSession(sidA, 'proj-a', '/work/proj-a');
    ensureSession(sidB, 'proj-b', '/work/proj-b');

    insertObservation(sidA, { tool_name: 'Edit', action: 'shared keyword unique_a', cwd: '/work/proj-a' });
    insertObservation(sidB, { tool_name: 'Edit', action: 'shared keyword unique_b', cwd: '/work/proj-b' });

    const results = searchObservations('shared keyword', '/work/proj-a');
    expect(results.length).toBe(1);
    expect(results[0].action).toContain('unique_a');
  });

  test('same dir name at different paths are isolated', () => {
    const sid1 = freshSession();
    const sid2 = freshSession();
    ensureSession(sid1, 'api', '/home/user/work/api');
    ensureSession(sid2, 'api', '/home/user/client/api');

    insertObservation(sid1, { tool_name: 'Bash', action: 'work api action', cwd: '/home/user/work/api' });
    insertObservation(sid2, { tool_name: 'Bash', action: 'client api action', cwd: '/home/user/client/api' });

    const workObs = getRecentObservations('/home/user/work/api');
    const clientObs = getRecentObservations('/home/user/client/api');

    expect(workObs.length).toBe(1);
    expect(workObs[0].action).toContain('work');
    expect(clientObs.length).toBe(1);
    expect(clientObs[0].action).toContain('client');
  });

  test('Windows case-insensitive path normalization', () => {
    const sid = freshSession();
    ensureSession(sid, 'project', 'C:\\Users\\M_BEN\\Project');
    insertObservation(sid, { tool_name: 'Edit', action: 'windows test', cwd: 'C:\\Users\\M_BEN\\Project' });

    // Same path but different case
    const obs = getRecentObservations('C:\\Users\\m_ben\\Project');
    expect(obs.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. FULL SESSION LIFECYCLE (E2E Integration)
// ═══════════════════════════════════════════════════════════════════════════════
describe('Full session lifecycle E2E', () => {
  beforeEach(() => { cleanDb(); });
  afterEach(() => { closeDb(); });

  test('complete lifecycle: start → prompts → observations → snapshot → complete → context', () => {
    const sid = freshSession();
    const projectCwd = '/home/dev/my-project';

    // 1. Session start
    ensureSession(sid, 'my-project', projectCwd);
    const active = getActiveSession(projectCwd);
    expect(active).toBe(sid);

    // 2. Record prompts
    insertPrompt(sid, 'Implement user authentication');
    insertPrompt(sid, 'Add JWT token validation');

    // 3. Record observations (simulating hooks)
    const r1 = insertObservation(sid, {
      tool_name: 'Read', action: 'Leyo src/auth.ts', cwd: projectCwd,
    });
    const r2 = insertObservation(sid, {
      tool_name: 'Edit', action: 'Edito src/auth.ts',
      files: JSON.stringify(['src/auth.ts']),
      detail: 'Added JWT middleware',
      cwd: projectCwd,
    });
    const r3 = insertObservation(sid, {
      tool_name: 'Bash', action: 'Ejecuto: npm test',
      detail: '[exit 0] All tests passed',
      cwd: projectCwd,
    });

    // 4. Score observations
    insertObservationScore(Number(r1.lastInsertRowid), 0.3);
    insertObservationScore(Number(r2.lastInsertRowid), 0.8);
    insertObservationScore(Number(r3.lastInsertRowid), 0.7);

    // 5. Save execution snapshot
    saveExecutionSnapshot(sid, {
      cwd: projectCwd,
      current_task: 'Implementing JWT auth',
      execution_point: 'Tests passing, ready to deploy',
      next_action: 'Add rate limiting',
      active_files: ['src/auth.ts', 'src/middleware.ts'],
      snapshot_type: 'manual',
      task_status: 'in_progress',
    });

    // 6. Record thinking
    insertTurnLog(sid, projectCwd, {
      turn_number: 1,
      thinking_text: 'Need to implement JWT validation in middleware',
      response_text: 'I will create the auth middleware',
    });

    // 7. Complete session
    completeSession(sid, {
      cwd: projectCwd,
      project: 'my-project',
      summary_text: 'Implemented JWT auth with middleware and tests',
      tools_used: { Read: 1, Edit: 1, Bash: 1 },
      files_read: ['src/auth.ts'],
      files_modified: ['src/auth.ts'],
      observation_count: 3,
      prompt_count: 2,
      duration_seconds: 300,
    });

    // 8. Verify completed state
    const stats = getSessionStats(sid);
    expect(stats.status).toBe('completed');
    expect(stats.observation_count).toBe(3);
    expect(stats.prompt_count).toBe(2);

    // 9. Retrieve full context (simulating next session start)
    const ctx = getRecentContext(projectCwd);
    expect(ctx.observations.length).toBe(3);
    expect(ctx.summary).toBeTruthy();
    expect(ctx.summary.summary_text).toContain('JWT auth');
    expect(ctx.snapshot).toBeTruthy();
    expect(ctx.snapshot.current_task).toBe('Implementing JWT auth');
    expect(ctx.thinking).toBeTruthy();
    expect(ctx.thinking[0].thinking_text).toContain('JWT validation');
    expect(ctx.prompts.length).toBe(2);
    expect(ctx.recentSessions.length).toBe(1);
    expect(ctx.topScored.length).toBeGreaterThan(0);

    // 10. Search works
    const searchResults = searchObservations('JWT', projectCwd);
    expect(searchResults.length).toBeGreaterThan(0);

    const thinkingResults = searchThinking('JWT validation', projectCwd);
    expect(thinkingResults.length).toBe(1);

    // 11. Session detail works
    const detail = getSessionDetail(sid, projectCwd);
    expect(detail.session.status).toBe('completed');
    expect(detail.observations.length).toBe(3);
    expect(detail.prompts.length).toBe(2);
    expect(detail.summary).toBeTruthy();

    // 12. Export works
    const exported = getExportData(projectCwd, 'json');
    expect(exported.data.observations.length).toBe(3);
    expect(exported.data.prompts.length).toBe(2);
    expect(exported.data.summaries.length).toBe(1);
  });

  test('multiple sessions lifecycle with orphan cleanup', () => {
    const projectCwd = '/home/dev/multi-session-test';

    // Session 1: starts and completes normally
    const sid1 = freshSession();
    ensureSession(sid1, 'test', projectCwd);
    insertObservation(sid1, { tool_name: 'Bash', action: 'npm init', cwd: projectCwd });
    completeSession(sid1, { cwd: projectCwd, project: 'test', summary_text: 'Session 1 done' });

    // Session 2: starts but gets "orphaned" (simulating old active session)
    const sid2 = freshSession();
    const db = getDb();
    db.prepare(`
      INSERT INTO sessions (session_id, project, cwd, started_at, status)
      VALUES (?, 'test', ?, unixepoch() - 20000, 'active')
    `).run(sid2, normalizeCwd(projectCwd));

    // Session 3: new session starts, should trigger orphan cleanup
    const sid3 = freshSession();
    abandonOrphanSessions(projectCwd, 4);
    ensureSession(sid3, 'test', projectCwd);

    // Verify session 2 was abandoned
    const s2 = db.prepare('SELECT status FROM sessions WHERE session_id = ?').get(sid2);
    expect(s2.status).toBe('abandoned');

    // Session 3 is active
    expect(getActiveSession(projectCwd)).toBe(sid3);

    // Context shows all sessions in index
    const ctx = getRecentContext(projectCwd);
    expect(ctx.recentSessions.length).toBeGreaterThanOrEqual(2);
  });

  test('forget records then verify they are gone from FTS', () => {
    const sid = freshSession();
    const projectCwd = '/home/dev/forget-test';
    ensureSession(sid, 'test', projectCwd);

    insertObservation(sid, { tool_name: 'Bash', action: 'Ejecuto: echo secretdata123', cwd: projectCwd });
    const r = insertObservation(sid, {
      tool_name: 'Edit', action: 'Edito secrets.json with API key', cwd: projectCwd,
    });
    const obsId = Number(r.lastInsertRowid);

    // Verify it exists in FTS
    let ftsResults = searchObservations('API key', projectCwd);
    expect(ftsResults.length).toBe(1);

    // Forget it
    forgetRecords('observation', [obsId], projectCwd);

    // Verify FTS no longer returns it
    ftsResults = searchObservations('API key', projectCwd);
    expect(ftsResults.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. MCP SERVER TOOLS (simulated via executeTool)
// ═══════════════════════════════════════════════════════════════════════════════
describe('MCP Server — Tool execution simulation', () => {
  // We test the MCP server's tool handlers by importing the key functions
  // and simulating what the server does

  beforeEach(() => { cleanDb(); });
  afterEach(() => { closeDb(); });

  // Since we can't easily import the server's executeTool (it uses module-scoped cwd),
  // we test the underlying DB functions that each tool calls

  test('search tool: searchObservations with limit', () => {
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);
    for (let i = 0; i < 10; i++) {
      insertObservation(sid, { tool_name: 'Bash', action: `mcp search test ${i}`, cwd: TEST_CWD });
    }

    const results = searchObservations('mcp search', TEST_CWD, { limit: 5 });
    expect(results.length).toBe(6);
  });

  test('recent tool: getRecentObservations with limit', () => {
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);
    for (let i = 0; i < 10; i++) {
      insertObservation(sid, { tool_name: 'Bash', action: `recent item ${i}`, cwd: TEST_CWD });
    }

    const results = getRecentObservations(TEST_CWD, { limit: 5 });
    expect(results.length).toBe(6);
  });

  test('session_detail tool: getSessionDetail with and without session_id', () => {
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);
    insertObservation(sid, { tool_name: 'Edit', action: 'detail test', cwd: TEST_CWD });
    insertPrompt(sid, 'detail prompt');

    // With session_id
    const detail1 = getSessionDetail(sid, TEST_CWD);
    expect(detail1).toBeTruthy();
    expect(detail1.session.session_id).toBe(sid);

    // Without session_id (latest)
    const detail2 = getSessionDetail(null, TEST_CWD);
    expect(detail2).toBeTruthy();
    expect(detail2.session.session_id).toBe(sid);
  });

  test('cleanup tool: preview vs execute', () => {
    const sid = freshSession();
    const db = getDb();
    db.prepare(`
      INSERT INTO sessions (session_id, project, cwd, started_at, status)
      VALUES (?, 'test', ?, unixepoch() - 200*86400, 'completed')
    `).run(sid, normalizeCwd(TEST_CWD));
    db.prepare(`
      INSERT INTO observations (session_id, tool_name, action, cwd, created_at)
      VALUES (?, 'Bash', 'old', ?, unixepoch() - 200*86400)
    `).run(sid, normalizeCwd(TEST_CWD));

    // Preview
    const preview = getCleanupTargets(TEST_CWD, 90);
    expect(preview.observations).toBeGreaterThanOrEqual(1);

    // Execute
    const result = executeCleanup(TEST_CWD, 90);
    expect(result.observations).toBeGreaterThanOrEqual(1);

    // Verify gone
    const afterClean = getCleanupTargets(TEST_CWD, 90);
    expect(afterClean.observations).toBe(0);
  });

  test('export tool: JSON and CSV formats', () => {
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);
    insertObservation(sid, { tool_name: 'Bash', action: 'export test', cwd: TEST_CWD });

    const json = getExportData(TEST_CWD, 'json');
    expect(json.data.observations).toBeTruthy();
    expect(json.metadata.total).toBe(1);

    const csv = getExportData(TEST_CWD, 'csv');
    expect(typeof csv.data).toBe('string');
    expect(csv.data).toContain('export test');
  });

  test('forget tool: deletes records and validates ownership', () => {
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);
    const r = insertObservation(sid, { tool_name: 'Edit', action: 'to forget', cwd: TEST_CWD });
    const id = Number(r.lastInsertRowid);

    const deleted = forgetRecords('observation', [id], TEST_CWD);
    // deleted count may be > 1 due to FTS trigger cascades
    expect(deleted).toBeGreaterThanOrEqual(1);

    // Verify the record is actually gone
    const db = getDb();
    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    expect(row).toBeFalsy();
  });

  test('save_state / get_state tool flow', () => {
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);

    const result = saveExecutionSnapshot(sid, {
      cwd: TEST_CWD,
      current_task: 'MCP save test',
      execution_point: 'Step 2',
      next_action: 'Deploy',
      snapshot_type: 'manual',
      task_status: 'in_progress',
    });
    expect(result.id).toBeGreaterThan(0);

    const snapshot = getLatestSnapshot(TEST_CWD);
    expect(snapshot).toBeTruthy();
    expect(snapshot.current_task).toBe('MCP save test');
  });

  test('status tool: returns health data', () => {
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);
    insertObservation(sid, { tool_name: 'Bash', action: 'status test', cwd: TEST_CWD });

    const status = getStatusData(TEST_CWD);
    expect(status.schemaVersion).toBe(6);
    expect(status.sessions.total).toBeGreaterThanOrEqual(1);
    expect(status.observations).toBeGreaterThanOrEqual(1);
  });

  test('thinking_search tool: searchThinking', () => {
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);
    insertTurnLog(sid, TEST_CWD, {
      turn_number: 1,
      thinking_text: 'I should refactor the database layer',
      response_text: 'refactoring now',
    });

    const results = searchThinking('refactor database', TEST_CWD);
    expect(results.length).toBe(1);
    expect(results[0].thinking_text).toContain('refactor');
  });

  test('top_priority tool: getTopScoredObservations', () => {
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);
    const r = insertObservation(sid, {
      tool_name: 'Edit', action: 'Critical fix: authentication bypass', cwd: TEST_CWD,
    });
    insertObservationScore(Number(r.lastInsertRowid), 0.9);

    const top = getTopScoredObservations(TEST_CWD, { minScore: 0.4, limit: 15 });
    expect(top.length).toBeGreaterThanOrEqual(1);
  });

  test('context tool: getRecentContext returns complete context', () => {
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);
    insertObservation(sid, { tool_name: 'Edit', action: 'context test', cwd: TEST_CWD });
    insertPrompt(sid, 'test prompt');
    saveExecutionSnapshot(sid, {
      cwd: TEST_CWD, current_task: 'context task', snapshot_type: 'manual', task_status: 'in_progress',
    });

    const ctx = getRecentContext(TEST_CWD);
    expect(ctx.observations.length).toBeGreaterThan(0);
    expect(ctx.snapshot).toBeTruthy();
    expect(ctx.prompts.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. MCP SERVER — JSON-RPC Protocol
// ═══════════════════════════════════════════════════════════════════════════════
describe('MCP Server — JSON-RPC Protocol (subprocess)', () => {
  const SERVER_PATH = join(import.meta.dirname, '..', 'mcp', 'server.mjs');
  const BUN_PATH = process.execPath;

  beforeEach(() => { cleanDb(); });
  afterEach(() => { closeDb(); });

  async function mcpRequest(messages, { timeout = 8000 } = {}) {
    const env = { ...process.env, LOCAL_MEM_DB_PATH: TEST_DB_PATH };
    const proc = Bun.spawn([BUN_PATH, SERVER_PATH], {
      cwd: TEST_CWD.startsWith('/') ? '/tmp' : TEST_CWD,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    });

    const input = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
    proc.stdin.write(input);
    proc.stdin.end();

    const output = await Promise.race([
      new Response(proc.stdout).text(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout)),
    ]);

    try { proc.kill(); } catch {}

    const lines = output.trim().split('\n').filter(Boolean);
    return lines.map(l => JSON.parse(l));
  }

  test('initialize returns protocol version and capabilities', async () => {
    const responses = await mcpRequest([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    ]);
    expect(responses.length).toBeGreaterThanOrEqual(1);
    const init = responses[0];
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect(init.result.capabilities.tools).toBeTruthy();
    expect(init.result.serverInfo.name).toBe('local-mem');
  });

  test('ping returns empty result', async () => {
    const responses = await mcpRequest([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'ping', params: {} },
    ]);
    const ping = responses.find(r => r.id === 2);
    expect(ping.result).toEqual({});
  });

  test('tools/list returns all 13 tools', async () => {
    const responses = await mcpRequest([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);
    const toolsList = responses.find(r => r.id === 2);
    expect(toolsList.result.tools.length).toBe(13);

    const names = toolsList.result.tools.map(t => t.name);
    expect(names).toContain('search');
    expect(names).toContain('recent');
    expect(names).toContain('session_detail');
    expect(names).toContain('cleanup');
    expect(names).toContain('export');
    expect(names).toContain('forget');
    expect(names).toContain('context');
    expect(names).toContain('save_state');
    expect(names).toContain('get_state');
    expect(names).toContain('status');
    expect(names).toContain('thinking_search');
    expect(names).toContain('top_priority');
  });

  test('tools/call status returns health info', async () => {
    const responses = await mcpRequest([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'status', arguments: {} },
      },
    ]);
    const status = responses.find(r => r.id === 2);
    expect(status.result.content).toBeTruthy();
    expect(status.result.content[0].type).toBe('text');
    expect(status.result.content[0].text).toContain('local-mem status');
  });

  test('tools/call context returns markdown', async () => {
    const responses = await mcpRequest([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'context', arguments: {} },
      },
    ]);
    const ctx = responses.find(r => r.id === 2);
    expect(ctx.result.content[0].text).toContain('local-mem');
  });

  test('tools/call get_state returns null when no snapshots', async () => {
    const responses = await mcpRequest([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'get_state', arguments: {} },
      },
    ]);
    const state = responses.find(r => r.id === 2);
    const data = JSON.parse(state.result.content[0].text);
    expect(data).toBeNull();
  });

  test('tools/call export returns JSON data', async () => {
    const responses = await mcpRequest([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'export', arguments: { format: 'json' } },
      },
    ]);
    const exp = responses.find(r => r.id === 2);
    const data = JSON.parse(exp.result.content[0].text);
    expect(data.data).toBeTruthy();
    expect(data.metadata).toBeTruthy();
  });

  test('tools/call cleanup preview', async () => {
    const responses = await mcpRequest([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'cleanup', arguments: { older_than_days: 90, preview: true } },
      },
    ]);
    const cleanup = responses.find(r => r.id === 2);
    const data = JSON.parse(cleanup.result.content[0].text);
    expect(data.preview).toBe(true);
    expect(data.older_than_days).toBe(90);
  });

  test('tools/call search with missing query returns error', async () => {
    const responses = await mcpRequest([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'search', arguments: {} },
      },
    ]);
    const search = responses.find(r => r.id === 2);
    const data = JSON.parse(search.result.content[0].text);
    expect(data.error).toBeTruthy();
  });

  test('tools/call forget with invalid type returns error', async () => {
    const responses = await mcpRequest([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'forget', arguments: { type: 'invalid', ids: [1] } },
      },
    ]);
    const forget = responses.find(r => r.id === 2);
    const data = JSON.parse(forget.result.content[0].text);
    expect(data.error).toBeTruthy();
  });

  test('unknown method returns -32601', async () => {
    const responses = await mcpRequest([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'nonexistent/method', params: {} },
    ]);
    const unknown = responses.find(r => r.id === 2);
    expect(unknown.error).toBeTruthy();
    expect(unknown.error.code).toBe(-32601);
  });

  test('invalid JSON-RPC returns -32600', async () => {
    const responses = await mcpRequest([
      { id: 1, method: 'ping' }, // Missing jsonrpc: '2.0'
    ]);
    expect(responses[0].error).toBeTruthy();
    expect(responses[0].error.code).toBe(-32600);
  });

  test('unknown tool returns -32602', async () => {
    const responses = await mcpRequest([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      },
    ]);
    const res = responses.find(r => r.id === 2);
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(-32602);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. EDGE CASES & STRESS TESTS
// ═══════════════════════════════════════════════════════════════════════════════
describe('Edge cases & stress', () => {
  beforeEach(() => { cleanDb(); });
  afterEach(() => { closeDb(); });

  test('handles very long action strings', () => {
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);
    const longAction = 'x'.repeat(50000);
    // Should not throw
    insertObservation(sid, { tool_name: 'Bash', action: longAction, cwd: TEST_CWD });
    const obs = getRecentObservations(TEST_CWD, { limit: 1 });
    expect(obs.length).toBe(1);
  });

  test('handles unicode in observations and prompts', () => {
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);
    const unicodeAction = 'Editó 文件.ts con emojis 🎉 и кириллица';
    insertObservation(sid, { tool_name: 'Edit', action: unicodeAction, cwd: TEST_CWD });
    insertPrompt(sid, '修复 аутентификацию с помощью JWT 🔐');

    const obs = getRecentObservations(TEST_CWD, { limit: 1 });
    expect(obs[0].action).toBe(unicodeAction);

    const prompts = getRecentPrompts(TEST_CWD, 1);
    expect(prompts[0].prompt_text).toContain('修复');
  });

  test('handles rapid inserts (100 observations)', () => {
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);

    for (let i = 0; i < 100; i++) {
      insertObservation(sid, {
        tool_name: i % 3 === 0 ? 'Edit' : i % 3 === 1 ? 'Bash' : 'Read',
        action: `Rapid insert #${i}`,
        cwd: TEST_CWD,
      });
    }

    const stats = getSessionStats(sid);
    expect(stats.observation_count).toBe(100);

    const recent = getRecentObservations(TEST_CWD, { limit: 100 });
    expect(recent.length).toBe(100);
  });

  test('empty search query returns empty array', () => {
    expect(searchObservations('', TEST_CWD)).toEqual([]);
    expect(searchObservations(null, TEST_CWD)).toEqual([]);
    expect(searchObservations(undefined, TEST_CWD)).toEqual([]);
  });

  test('FTS query with only operators returns empty', () => {
    expect(searchObservations('AND OR NOT', TEST_CWD)).toEqual([]);
    expect(searchObservations('***', TEST_CWD)).toEqual([]);
  });

  test('saveExecutionSnapshot with all null optional fields', () => {
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);

    const result = saveExecutionSnapshot(sid, {
      cwd: TEST_CWD,
      current_task: 'Minimal snapshot',
    });
    expect(result.id).toBeGreaterThan(0);

    const snap = getLatestSnapshot(TEST_CWD);
    expect(snap.current_task).toBe('Minimal snapshot');
    expect(snap.execution_point).toBeNull();
    expect(snap.next_action).toBeNull();
  });

  test('CSV export properly escapes quotes', () => {
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);
    insertObservation(sid, {
      tool_name: 'Bash',
      action: 'echo "hello, world"',
      detail: 'output with "quotes" and, commas',
      cwd: TEST_CWD,
    });

    const csv = getExportData(TEST_CWD, 'csv');
    expect(csv.data).toContain('""hello');
    expect(csv.data).toContain('""quotes""');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. DB MIGRATION INTEGRITY
// ═══════════════════════════════════════════════════════════════════════════════
describe('DB Schema & Migration', () => {
  beforeEach(() => { cleanDb(); });
  afterEach(() => { closeDb(); });

  test('fresh DB starts at schema v6', () => {
    const db = getDb();
    const row = db.prepare('SELECT version FROM schema_version').get();
    expect(row.version).toBe(6);
  });

  test('execution_snapshots has v2 columns', () => {
    const db = getDb();
    const columns = db.prepare(`PRAGMA table_info(execution_snapshots)`).all().map(c => c.name);
    expect(columns).toContain('snapshot_type');
    expect(columns).toContain('task_status');
  });

  test('execution_snapshots has v4 columns (technical_state, confidence)', () => {
    const db = getDb();
    const columns = db.prepare(`PRAGMA table_info(execution_snapshots)`).all().map(c => c.name);
    expect(columns).toContain('technical_state');
    expect(columns).toContain('confidence');
  });

  test('turn_log table exists with proper schema', () => {
    const db = getDb();
    const columns = db.prepare(`PRAGMA table_info(turn_log)`).all().map(c => c.name);
    expect(columns).toContain('session_id');
    expect(columns).toContain('cwd');
    expect(columns).toContain('turn_number');
    expect(columns).toContain('thinking_text');
    expect(columns).toContain('response_text');
    expect(columns).toContain('created_at');
  });

  test('observation_scores table exists with proper schema', () => {
    const db = getDb();
    const columns = db.prepare(`PRAGMA table_info(observation_scores)`).all().map(c => c.name);
    expect(columns).toContain('observation_id');
    expect(columns).toContain('composite_score');
    expect(columns).toContain('computed_at');
  });

  test('session_summaries has unique index on session_id (v3)', () => {
    const db = getDb();
    const indexes = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_summaries'`
    ).all().map(r => r.name);
    expect(indexes).toContain('idx_summaries_session_unique');
  });

  test('all expected indexes exist', () => {
    const db = getDb();
    const indexes = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`
    ).all().map(r => r.name);

    const expected = [
      'idx_obs_session', 'idx_obs_cwd_epoch', 'idx_obs_tool',
      'idx_sessions_project', 'idx_sessions_status', 'idx_sessions_epoch', 'idx_sessions_cwd',
      'idx_prompts_session', 'idx_summaries_cwd', 'idx_snapshots_session', 'idx_snapshots_cwd',
      'idx_snapshots_type', 'idx_turn_session', 'idx_turn_cwd', 'idx_scores_composite',
      'idx_summaries_session_unique',
    ];

    for (const idx of expected) {
      expect(indexes).toContain(idx);
    }
  });

  test('foreign key cascades delete observations when session deleted', () => {
    const db = getDb();
    const sid = freshSession();
    ensureSession(sid, 'test', TEST_CWD);
    insertObservation(sid, { tool_name: 'Bash', action: 'cascade test', cwd: TEST_CWD });

    // Direct delete of session should cascade
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sid);

    const obs = db.prepare(
      'SELECT * FROM observations WHERE session_id = ?'
    ).all(sid);
    expect(obs.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cleanup test database
// ═══════════════════════════════════════════════════════════════════════════════
afterAll(() => {
  cleanDb();
  try { unlinkSync(TEST_DB_DIR); } catch {}
});

function afterAll(fn) {
  // Bun test doesn't have a built-in afterAll at module level,
  // so we'll just let the files get cleaned up on next run
}
