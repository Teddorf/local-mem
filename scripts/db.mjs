import { Database } from 'bun:sqlite';
import { mkdirSync, statSync } from 'fs';
import { dirname, basename } from 'path';
import { SIZES, TIMEOUTS, DB, LEVEL_LIMITS, SCORING, TRUNCATE, RENDER, TIME } from './constants.mjs';

const HOME = process.env.HOME || process.env.USERPROFILE;
const DEFAULT_DB_PATH = `${HOME}/.local-mem/data/local-mem.db`;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO schema_version (rowid, version, applied_at)
VALUES (1, 1, unixepoch());

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  project TEXT NOT NULL,
  cwd TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  observation_count INTEGER DEFAULT 0,
  prompt_count INTEGER DEFAULT 0,
  status TEXT CHECK(status IN ('active','completed','abandoned')) DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  action TEXT NOT NULL,
  files TEXT,
  detail TEXT,
  cwd TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  cwd TEXT NOT NULL,
  summary_text TEXT,
  tools_used TEXT,
  files_read TEXT,
  files_modified TEXT,
  observation_count INTEGER DEFAULT 0,
  prompt_count INTEGER DEFAULT 0,
  duration_seconds INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS execution_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  current_task TEXT,
  execution_point TEXT,
  next_action TEXT,
  pending_tasks TEXT,
  plan TEXT,
  open_decisions TEXT,
  active_files TEXT,
  blocking_issues TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_cwd_epoch ON observations(cwd, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_tool ON observations(tool_name);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_epoch ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
CREATE INDEX IF NOT EXISTS idx_prompts_session ON user_prompts(session_id);
CREATE INDEX IF NOT EXISTS idx_summaries_cwd ON session_summaries(cwd);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON execution_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_cwd ON execution_snapshots(cwd, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  tool_name, action, files, detail,
  content=observations, content_rowid=id
);
CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
  prompt_text,
  content=user_prompts, content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS inc_obs_count AFTER INSERT ON observations BEGIN
  UPDATE sessions SET observation_count = observation_count + 1
  WHERE session_id = new.session_id;
END;

CREATE TRIGGER IF NOT EXISTS inc_prompt_count AFTER INSERT ON user_prompts BEGIN
  UPDATE sessions SET prompt_count = prompt_count + 1
  WHERE session_id = new.session_id;
END;

CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, tool_name, action, files, detail)
  VALUES (new.id, new.tool_name, new.action, new.files, new.detail);
END;

CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, tool_name, action, files, detail)
  VALUES ('delete', old.id, old.tool_name, old.action, old.files, old.detail);
END;

CREATE TRIGGER IF NOT EXISTS obs_fts_update AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, tool_name, action, files, detail)
  VALUES ('delete', old.id, old.tool_name, old.action, old.files, old.detail);
  INSERT INTO observations_fts(rowid, tool_name, action, files, detail)
  VALUES (new.id, new.tool_name, new.action, new.files, new.detail);
END;

CREATE TRIGGER IF NOT EXISTS prompts_fts_insert AFTER INSERT ON user_prompts BEGIN
  INSERT INTO prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
END;

CREATE TRIGGER IF NOT EXISTS prompts_fts_delete AFTER DELETE ON user_prompts BEGIN
  INSERT INTO prompts_fts(prompts_fts, rowid, prompt_text)
  VALUES ('delete', old.id, old.prompt_text);
END;

CREATE TRIGGER IF NOT EXISTS prompts_fts_update AFTER UPDATE ON user_prompts BEGIN
  INSERT INTO prompts_fts(prompts_fts, rowid, prompt_text)
  VALUES ('delete', old.id, old.prompt_text);
  INSERT INTO prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
END;
`;

function sanitizeFtsQuery(query) {
  if (!query || typeof query !== 'string') return null;
  let sanitized = query
    .replace(/['"(){}[\]^~*:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) return null;
  // Strip FTS5 boolean keywords when they appear as bare terms
  sanitized = sanitized
    .split(' ')
    .filter(t => !/^(AND|OR|NOT|NEAR)$/i.test(t))
    .filter(t => t !== '-')
    .join(' ')
    .trim();
  if (!sanitized) return null;
  if (sanitized.length > SIZES.MAX_FTS_QUERY) sanitized = sanitized.slice(0, SIZES.MAX_FTS_QUERY);
  return sanitized;
}

const MAX_JSON_FIELD_SIZE = SIZES.MAX_JSON_FIELD;

function validateJsonFieldSize(value) {
  if (value && typeof value === 'string' && value.length > MAX_JSON_FIELD_SIZE) {
    return value.slice(0, MAX_JSON_FIELD_SIZE);
  }
  return value;
}

function jsonStringify(value) {
  if (value === null || value === undefined) return null;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return validateJsonFieldSize(str);
}

export function normalizeCwd(cwd) {
  if (!cwd) return cwd;
  let normalized = cwd.replace(/\\/g, '/');
  normalized = normalized.replace(/\/+$/, '');
  if (/^[a-zA-Z]:/.test(normalized)) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

// Singleton connection cache per process
let _cachedDb = null;
let _cachedDbPath = null;

export function getDb(dbPath) {
  const resolvedPath = dbPath || process.env.LOCAL_MEM_DB_PATH || DEFAULT_DB_PATH;

  // Return cached connection if same path and still open
  if (_cachedDb && _cachedDbPath === resolvedPath) {
    try {
      // Quick check if connection is still valid
      _cachedDb.prepare('SELECT 1').get();
      return _cachedDb;
    } catch {
      _cachedDb = null;
      _cachedDbPath = null;
    }
  }

  const dir = dirname(resolvedPath);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {}
  const db = new Database(resolvedPath, { create: true });
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(`PRAGMA busy_timeout=${TIMEOUTS.DB_BUSY}`);
  db.exec(`PRAGMA wal_autocheckpoint=${DB.WAL_AUTOCHECKPOINT}`);
  db.exec(SCHEMA_SQL);

  // Wrap close() to be a no-op for singleton — actual close via closeDb()
  const originalClose = db.close.bind(db);
  db.close = () => {}; // no-op: singleton stays open until process exit
  db._realClose = originalClose;

  _cachedDb = db;
  _cachedDbPath = resolvedPath;
  // Migration logic: read schema_version and apply migrations if needed
  const row = db.prepare('SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1').get();
  const currentVersion = row ? row.version : 1;

  if (currentVersion < 2) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // 1. Nuevas columnas en execution_snapshots
      db.exec(`ALTER TABLE execution_snapshots ADD COLUMN snapshot_type TEXT DEFAULT 'manual'`);
      db.exec(`ALTER TABLE execution_snapshots ADD COLUMN task_status TEXT DEFAULT 'in_progress'`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_type
        ON execution_snapshots(session_id, cwd, snapshot_type, created_at DESC)`);

      // 2. Fix snapshots existentes (no dejar in_progress para sesiones cerradas)
      db.exec(`UPDATE execution_snapshots SET task_status='completed'
        WHERE session_id IN (SELECT session_id FROM sessions WHERE status='completed')`);
      db.exec(`UPDATE execution_snapshots SET task_status='abandoned'
        WHERE session_id IN (SELECT session_id FROM sessions WHERE status='abandoned')`);

      // 3. Nueva tabla turn_log
      db.exec(`CREATE TABLE IF NOT EXISTS turn_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        thinking_text TEXT,
        response_text TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, turn_number),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_session ON turn_log(session_id, turn_number)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_cwd ON turn_log(cwd, created_at DESC)`);

      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS turn_fts USING fts5(
        thinking_text, response_text,
        content=turn_log, content_rowid=id
      )`);

      // FTS triggers for turn_log
      db.exec(`CREATE TRIGGER IF NOT EXISTS turn_fts_insert AFTER INSERT ON turn_log BEGIN
        INSERT INTO turn_fts(rowid, thinking_text, response_text)
        VALUES (new.id, new.thinking_text, new.response_text);
      END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS turn_fts_delete AFTER DELETE ON turn_log BEGIN
        INSERT INTO turn_fts(turn_fts, rowid, thinking_text, response_text)
        VALUES ('delete', old.id, old.thinking_text, old.response_text);
      END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS turn_fts_update AFTER UPDATE ON turn_log BEGIN
        INSERT INTO turn_fts(turn_fts, rowid, thinking_text, response_text)
        VALUES ('delete', old.id, old.thinking_text, old.response_text);
        INSERT INTO turn_fts(rowid, thinking_text, response_text)
        VALUES (new.id, new.thinking_text, new.response_text);
      END`);

      // 4. Nueva tabla observation_scores
      db.exec(`CREATE TABLE IF NOT EXISTS observation_scores (
        observation_id INTEGER PRIMARY KEY,
        composite_score REAL DEFAULT 0.5,
        computed_at INTEGER NOT NULL,
        FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_scores_composite ON observation_scores(composite_score DESC)`);

      // 5. Actualizar version
      db.exec(`UPDATE schema_version SET version=2, applied_at=unixepoch() WHERE rowid=1`);

      db.exec('COMMIT');
      process.stderr.write('[local-mem] Migration v1→v2 applied\n');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration v1→v2 failed: ${e.message}`);
    }
  }

  if (currentVersion < 3) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // 1. Deduplicate session_summaries: keep only most recent per session_id
      db.exec(`DELETE FROM session_summaries WHERE id NOT IN (
        SELECT MAX(id) FROM session_summaries GROUP BY session_id
      )`);

      // 2. Add unique index to prevent future duplicates
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_session_unique
        ON session_summaries(session_id)`);

      db.exec(`UPDATE schema_version SET version=3, applied_at=unixepoch() WHERE rowid=1`);

      db.exec('COMMIT');
      process.stderr.write('[local-mem] Migration v2→v3 applied\n');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration v2→v3 failed: ${e.message}`);
    }
  }

  if (currentVersion < 4) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // v0.7 Progressive Disclosure: vibe awareness columns
      db.exec(`ALTER TABLE execution_snapshots ADD COLUMN technical_state TEXT`);
      db.exec(`ALTER TABLE execution_snapshots ADD COLUMN confidence INTEGER`);

      db.exec(`UPDATE schema_version SET version=4, applied_at=unixepoch() WHERE rowid=1`);

      db.exec('COMMIT');
      process.stderr.write('[local-mem] Migration v3→v4 applied\n');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration v3→v4 failed: ${e.message}`);
    }
  }

  if (currentVersion < 5) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // v0.9 Project DNA: per-project identity profile
      db.exec(`CREATE TABLE IF NOT EXISTS project_profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cwd TEXT UNIQUE NOT NULL,
        stack TEXT,
        patterns TEXT,
        key_files TEXT,
        conventions TEXT,
        updated_at INTEGER NOT NULL,
        source TEXT CHECK(source IN ('auto','manual')) DEFAULT 'auto'
      )`);

      db.exec(`UPDATE schema_version SET version=5, applied_at=unixepoch() WHERE rowid=1`);

      db.exec('COMMIT');
      process.stderr.write('[local-mem] Migration v4→v5 applied\n');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration v4→v5 failed: ${e.message}`);
    }
  }

  return db;
}

// Explicitly close the singleton connection (for process exit or install.mjs)
export function closeDb() {
  if (_cachedDb) {
    try { _cachedDb._realClose(); } catch {}
    _cachedDb = null;
    _cachedDbPath = null;
  }
}

export function ensureSession(sessionId, project, cwd) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  try {
    db.prepare(`
      INSERT INTO sessions (session_id, project, cwd, started_at, status)
      VALUES (?, ?, ?, unixepoch(), 'active')
      ON CONFLICT(session_id) DO UPDATE SET
        status = 'active'
    `).run(sessionId, project, nCwd);
  } finally {
    db.close();
  }
}

export function completeSession(sessionId, summaryData) {
  const db = getDb();
  try {
    db.exec('BEGIN');
    try {
      db.prepare(`
        UPDATE sessions SET status = 'completed', completed_at = unixepoch()
        WHERE session_id = ?
      `).run(sessionId);

      const sd = summaryData || {};
      const nCwd = normalizeCwd(sd.cwd);
      db.prepare(`
        INSERT INTO session_summaries
          (session_id, project, cwd, summary_text, tools_used, files_read,
           files_modified, observation_count, prompt_count, duration_seconds, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(session_id) DO UPDATE SET
          summary_text = excluded.summary_text,
          tools_used = excluded.tools_used,
          files_read = excluded.files_read,
          files_modified = excluded.files_modified,
          observation_count = excluded.observation_count,
          prompt_count = excluded.prompt_count,
          duration_seconds = excluded.duration_seconds,
          created_at = excluded.created_at
      `).run(
        sessionId,
        sd.project || '',
        nCwd || '',
        sd.summary_text || null,
        jsonStringify(sd.tools_used),
        jsonStringify(sd.files_read),
        jsonStringify(sd.files_modified),
        sd.observation_count || 0,
        sd.prompt_count || 0,
        sd.duration_seconds || null
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
}

export function insertObservation(sessionId, data) {
  const db = getDb();
  const nCwd = normalizeCwd(data.cwd);
  try {
    const result = db.prepare(`
      INSERT INTO observations (session_id, tool_name, action, files, detail, cwd, created_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    `).run(
      sessionId,
      data.tool_name,
      data.action,
      jsonStringify(data.files),
      data.detail || null,
      nCwd
    );
    return result;
  } finally {
    db.close();
  }
}

export function insertPrompt(sessionId, promptText) {
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO user_prompts (session_id, prompt_text, created_at)
      VALUES (?, ?, unixepoch())
    `).run(sessionId, promptText);
  } finally {
    db.close();
  }
}

export function saveExecutionSnapshot(sessionId, data) {
  const db = getDb();
  const nCwd = normalizeCwd(data.cwd);
  try {
    const result = db.prepare(`
      INSERT INTO execution_snapshots
        (session_id, cwd, current_task, execution_point, next_action,
         pending_tasks, plan, open_decisions, active_files, blocking_issues,
         snapshot_type, task_status, technical_state, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    `).run(
      sessionId,
      nCwd,
      data.current_task || null,
      data.execution_point || null,
      data.next_action || null,
      jsonStringify(data.pending_tasks),
      jsonStringify(data.plan),
      jsonStringify(data.open_decisions),
      jsonStringify(data.active_files),
      jsonStringify(data.blocking_issues),
      data.snapshot_type || 'manual',
      data.task_status || 'in_progress',
      data.technical_state || null,
      data.confidence != null ? data.confidence : null
    );
    return { id: Number(result.lastInsertRowid) };
  } finally {
    db.close();
  }
}

export function insertTurnLog(sessionId, cwd, turnData) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  try {
    const thinkingText = turnData.thinking_text
      ? turnData.thinking_text.slice(0, SIZES.MAX_THINKING_TEXT) : null;  // max 4KB
    const responseText = turnData.response_text
      ? turnData.response_text.slice(0, SIZES.MAX_RESPONSE_TEXT) : null;  // max 2KB
    db.prepare(`
      INSERT INTO turn_log (session_id, cwd, turn_number, thinking_text, response_text, created_at)
      VALUES (?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(session_id, turn_number) DO UPDATE SET
        thinking_text = excluded.thinking_text,
        response_text = excluded.response_text
    `).run(sessionId, nCwd, turnData.turn_number, thinkingText, responseText);
  } finally {
    db.close();
  }
}

export function insertObservationScore(observationId, compositeScore) {
  const db = getDb();
  try {
    db.prepare(`
      INSERT OR REPLACE INTO observation_scores (observation_id, composite_score, computed_at)
      VALUES (?, ?, unixepoch())
    `).run(observationId, compositeScore);
  } finally {
    db.close();
  }
}

export function searchThinking(query, cwd, opts = {}) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  const limit = opts.limit || 10;
  try {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];
    return db.prepare(`
      SELECT t.id, t.session_id, t.turn_number, t.thinking_text, t.response_text,
             t.created_at, f.rank
      FROM turn_fts f
      JOIN turn_log t ON t.id = f.rowid
      WHERE turn_fts MATCH ? AND t.cwd = ?
      ORDER BY f.rank
      LIMIT ?
    `).all(sanitized, nCwd, limit);
  } finally {
    db.close();
  }
}

/**
 * Selecciona thinking blocks relevantes usando FTS5 keywords.
 * Prioriza bloques con decisiones/razonamiento sobre los operativos.
 * Fallback: más recientes si FTS no encuentra suficientes.
 */
export function getKeyThinking(cwd, sessionId, limit = 5) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  try {
    // Sanitize each keyword individually, then join with OR (sanitizeFtsQuery strips OR)
    const DECISION_TERMS = [
      'decidí', 'decided', 'opté', 'chose', 'plan', 'trade-off',
      'porque', 'because', 'problema', 'problem', 'solución', 'solution',
      'estrategia', 'strategy', 'alternativa', 'alternative', 'tradeoff',
      'razón', 'reason'
    ];
    const ftsQuery = DECISION_TERMS.map(t => t.replace(/['"(){}[\]^~*:]/g, '')).filter(Boolean).join(' OR ');

    // 1. FTS5 search for decision-bearing thinking
    let ftsResults = [];
    try {
      if (ftsQuery) {
        const whereClause = sessionId
          ? 'AND t.session_id = ? AND t.cwd = ?'
          : 'AND t.cwd = ?';
        const params = sessionId
          ? [ftsQuery, sessionId, nCwd, limit]
          : [ftsQuery, nCwd, limit];
        ftsResults = db.prepare(`
          SELECT t.thinking_text, t.response_text, t.created_at
          FROM turn_fts f
          JOIN turn_log t ON t.id = f.rowid
          WHERE turn_fts MATCH ? ${whereClause}
            AND length(t.thinking_text) >= 50
          ORDER BY t.created_at DESC
          LIMIT ?
        `).all(...params);
      }
    } catch { /* FTS can fail on corrupted index — fallback below */ }

    // 2. If FTS found enough, return sorted chronologically
    if (ftsResults.length >= limit) {
      return ftsResults.slice(0, limit).sort((a, b) => a.created_at - b.created_at);
    }

    // 3. Fallback: fill remaining slots with most recent (excluding duplicates)
    const ftsIds = new Set(ftsResults.map(r => `${r.created_at}_${(r.thinking_text || '').slice(0, RENDER.THINKING_DEDUP_PREFIX)}`));
    const remaining = limit - ftsResults.length;

    const whereClause = sessionId
      ? 'WHERE t.session_id = ? AND t.cwd = ?'
      : 'WHERE t.cwd = ?';
    const params = sessionId
      ? [sessionId, nCwd, remaining + ftsResults.length]
      : [nCwd, remaining + ftsResults.length];

    const recentRows = db.prepare(`
      SELECT t.thinking_text, t.response_text, t.created_at
      FROM turn_log t
      ${whereClause}
      ORDER BY t.created_at DESC
      LIMIT ?
    `).all(...params);

    // Merge: FTS results + recent (deduplicated)
    const merged = [...ftsResults];
    for (const row of recentRows) {
      const key = `${row.created_at}_${(row.thinking_text || '').slice(0, RENDER.THINKING_DEDUP_PREFIX)}`;
      if (!ftsIds.has(key) && merged.length < limit) {
        merged.push(row);
        ftsIds.add(key);
      }
    }

    // Sort chronologically
    return merged.sort((a, b) => a.created_at - b.created_at);
  } finally {
    db.close();
  }
}

// Recency band applied at query-time: base_score + 0.3 * CASE(age)
const RECENCY_SQL = `(s.composite_score + 0.3 * CASE
  WHEN (unixepoch() - o.created_at) < ${SCORING.RECENCY_1H} THEN 1.0
  WHEN (unixepoch() - o.created_at) < ${SCORING.RECENCY_6H} THEN 0.5
  ELSE 0.25 END)`;

export function getTopScoredObservations(cwd, opts = {}) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  const minScore = opts.minScore ?? 0.4;
  const limit = opts.limit || 15;
  try {
    return db.prepare(`
      WITH scored AS (
        SELECT o.id, o.tool_name, o.action, o.detail,
               ${RECENCY_SQL} AS composite_score, o.created_at
        FROM observation_scores s
        JOIN observations o ON o.id = s.observation_id
        WHERE o.cwd = ?
      )
      SELECT * FROM scored
      WHERE composite_score >= ?
      ORDER BY composite_score DESC
      LIMIT ?
    `).all(nCwd, minScore, limit);
  } finally {
    db.close();
  }
}

// Lightweight prompt fetcher (avoids full getRecentContext for auto-snapshots)
export function getRecentPrompts(cwd, limit = 3) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  try {
    return db.prepare(`
      SELECT p.prompt_text, p.created_at
      FROM user_prompts p
      JOIN sessions s ON s.session_id = p.session_id
      WHERE s.cwd = ?
      ORDER BY p.created_at DESC LIMIT ?
    `).all(nCwd, limit);
  } finally {
    db.close();
  }
}

// Dynamic threshold: max(0.25, topScore * 0.5)
function getThreshold(scores) {
  if (!scores || scores.length === 0) return SCORING.DEFAULT_THRESHOLD;
  const topScore = Math.max(...scores);
  return Math.max(SCORING.DEFAULT_THRESHOLD, topScore * 0.5);
}

export function getRecentContext(cwd, opts = {}) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  const level = opts.level || 2;
  try {
    // === SIEMPRE (todos los niveles) ===
    const summary = db.prepare(`
      SELECT id, session_id, project, cwd, summary_text, tools_used, files_read,
             files_modified, observation_count, prompt_count, duration_seconds, created_at
      FROM session_summaries WHERE cwd = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(nCwd) || null;

    // Preferir snapshot manual, fallback auto
    const snapshot = db.prepare(`
      SELECT id, session_id, cwd, current_task, execution_point, next_action,
             pending_tasks, plan, open_decisions, active_files, blocking_issues,
             snapshot_type, task_status, technical_state, confidence, created_at
      FROM execution_snapshots WHERE cwd = ?
      ORDER BY CASE WHEN snapshot_type = 'manual' THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1
    `).get(nCwd) || null;

    // === Nivel 1: minimo ===
    if (level === 1) {
      const prompts = db.prepare(`
        SELECT p.prompt_text, p.created_at
        FROM user_prompts p
        JOIN sessions s ON s.session_id = p.session_id
        WHERE s.cwd = ?
        ORDER BY p.created_at DESC LIMIT 1
      `).all(nCwd);
      return { observations: [], summary, snapshot, thinking: null,
               topScored: [], prompts, recentSessions: [],
               prevSession: null, prevActions: [] };
    }

    // === Nivel 2+: contexto completo ===
    const topLimit = LEVEL_LIMITS[level]?.topScored || LEVEL_LIMITS[2].topScored;

    // Sesión activa para nivel 3 (reutilizada en F2+F3)
    let activeSessionId = null;
    if (level === 3) {
      const activeRow = db.prepare(`
        SELECT session_id FROM sessions
        WHERE cwd = ? AND status = 'active'
        ORDER BY started_at DESC LIMIT 1
      `).get(nCwd);
      activeSessionId = activeRow ? activeRow.session_id : null;
    }

    let observations;
    if (level === 3 && activeSessionId) {
      // F2: TODAS las obs de la sesión actual, cronológico (safety net: 200)
      observations = db.prepare(`
        SELECT o.id, o.tool_name, o.action, o.files, o.detail, o.cwd, o.created_at
        FROM observations o WHERE o.session_id = ?
        ORDER BY o.created_at ASC LIMIT ${LEVEL_LIMITS[3].observations}
      `).all(activeSessionId);
    } else {
      const obsLimit = LEVEL_LIMITS[level]?.observations || LEVEL_LIMITS[2].observations;
      observations = db.prepare(`
        SELECT o.id, o.tool_name, o.action, o.files, o.detail, o.cwd, o.created_at
        FROM observations o WHERE o.cwd = ?
        ORDER BY o.created_at DESC LIMIT ?
      `).all(nCwd, obsLimit);
    }

    // Thinking blocks: FTS5 selection (F10) con fallback reciente
    const thinkingLimit = LEVEL_LIMITS[level]?.thinking || LEVEL_LIMITS[2].thinking;
    const thinkingSessionId = (level === 3 && activeSessionId) ? activeSessionId : null;
    const thinkingRows = getKeyThinking(nCwd, thinkingSessionId, thinkingLimit);
    const thinking = thinkingRows.length > 0 ? thinkingRows : null;

    // Top observaciones por score con threshold dinamico (skip en nivel 3 — no se renderiza)
    let topScored = [];
    if (level !== 3) {
      const allScored = db.prepare(`
        WITH scored AS (
          SELECT o.id, o.tool_name, o.action, o.created_at,
                 ${RECENCY_SQL} AS composite_score
          FROM observation_scores s
          JOIN observations o ON o.id = s.observation_id
          WHERE o.cwd = ?
        )
        SELECT * FROM scored
        ORDER BY composite_score DESC
        LIMIT ${SCORING.SAMPLE_SIZE}
      `).all(nCwd);
      const threshold = getThreshold(allScored.map(r => r.composite_score));
      topScored = allScored.filter(r => r.composite_score >= threshold);
      if (topScored.length < SCORING.MIN_SCORED_FALLBACK && allScored.length >= SCORING.MIN_SCORED_FALLBACK) {
        topScored = allScored.slice(0, SCORING.MIN_SCORED_FALLBACK);
      }
      topScored = topScored.slice(0, topLimit);
    }

    let prompts;
    if (level === 3 && activeSessionId) {
      // F3: TODOS los prompts de la sesión actual, cronológico (cap: 50)
      prompts = db.prepare(`
        SELECT p.prompt_text, p.created_at
        FROM user_prompts p WHERE p.session_id = ?
        ORDER BY p.created_at ASC LIMIT ${LEVEL_LIMITS[3].prompts}
      `).all(activeSessionId);
    } else {
      const promptLimit = LEVEL_LIMITS[2].prompts;
      prompts = db.prepare(`
        SELECT p.prompt_text, p.created_at
        FROM user_prompts p
        JOIN sessions s ON s.session_id = p.session_id
        WHERE s.cwd = ?
        ORDER BY p.created_at DESC LIMIT ?
      `).all(nCwd, promptLimit);
    }

    // Sesiones index: nivel 2 = 3, nivel 3 = 1
    const sessionIndexLimit = LEVEL_LIMITS[level]?.recentSessions || LEVEL_LIMITS[2].recentSessions;
    const recentSessions = db.prepare(`
      SELECT s.session_id, s.project, s.started_at, s.completed_at, s.status,
             s.observation_count, s.prompt_count,
             ss.files_modified, ss.files_read
      FROM sessions s
      LEFT JOIN session_summaries ss ON ss.session_id = s.session_id
      WHERE s.cwd = ?
      ORDER BY s.started_at DESC LIMIT ?
    `).all(nCwd, sessionIndexLimit);

    // Cross-session curada (nivel 2+ — contexto perdido = bugs)
    const prevSession = queryCuratedPrevSession(db, nCwd);
    let prevActions = [];
    if (prevSession) {
      prevActions = queryPrevHighImpactActions(db, nCwd);
    }

    return { observations, summary, snapshot, thinking, topScored,
             prompts, recentSessions, prevSession, prevActions };
  } finally {
    db.close();
  }
}

/**
 * Datos curados de la sesion anterior.
 * Cruza sessions + execution_snapshots + user_prompts + turn_log
 * para extraer lo ACCIONABLE, no un resumen generico.
 */
function queryCuratedPrevSession(db, nCwd) {
  return db.prepare(`
    WITH prev_session AS (
      SELECT session_id, started_at, completed_at, observation_count, status
      FROM sessions WHERE cwd = ?
      ORDER BY started_at DESC LIMIT 1 OFFSET 1
    )
    SELECT
      ps.session_id,
      ps.started_at,
      ps.status,
      ps.observation_count,
      es.current_task,
      CASE WHEN es.snapshot_type = 'auto' THEN NULL ELSE es.next_action END AS next_action,
      CASE WHEN es.snapshot_type = 'auto' THEN NULL ELSE es.execution_point END AS execution_point,
      es.open_decisions,
      es.blocking_issues,
      es.active_files,
      es.technical_state,
      es.confidence,
      (SELECT prompt_text FROM user_prompts
       WHERE session_id = ps.session_id
       ORDER BY created_at DESC LIMIT 1) AS last_prompt,
      (SELECT thinking_text FROM turn_log
       WHERE session_id = ps.session_id
       ORDER BY created_at DESC LIMIT 1) AS last_thinking
    FROM prev_session ps
    LEFT JOIN execution_snapshots es
      ON es.session_id = ps.session_id
      AND es.id = (
        SELECT id FROM execution_snapshots
        WHERE session_id = ps.session_id
        ORDER BY CASE WHEN snapshot_type='manual' THEN 0 ELSE 1 END,
                 created_at DESC
        LIMIT 1
      )
  `).get(nCwd) || null;
}

/**
 * Top 5 acciones de alto impacto de la sesion anterior.
 * Solo Edit/Write/Bash — las que cambiaron algo.
 */
function queryPrevHighImpactActions(db, nCwd) {
  return db.prepare(`
    SELECT o.tool_name, o.action, o.files, o.detail
    FROM observations o
    JOIN (SELECT session_id FROM sessions WHERE cwd = ?
          ORDER BY started_at DESC LIMIT 1 OFFSET 1) ps
      ON o.session_id = ps.session_id
    LEFT JOIN observation_scores s ON s.observation_id = o.id
    WHERE o.tool_name IN ('Edit', 'Write', 'Bash')
    ORDER BY s.composite_score DESC
    LIMIT ${SCORING.PREV_HIGH_IMPACT_LIMIT}
  `).all(nCwd);
}

// ─── Project DNA ─────────────────────────────────────────────────────────────

export function getProjectDna(cwd) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  try {
    const row = db.prepare(`
      SELECT stack, patterns, key_files, conventions, updated_at, source
      FROM project_profile WHERE cwd = ?
    `).get(nCwd);
    if (!row) return null;
    return {
      stack: row.stack ? JSON.parse(row.stack) : [],
      patterns: row.patterns ? JSON.parse(row.patterns) : [],
      key_files: row.key_files ? JSON.parse(row.key_files) : [],
      conventions: row.conventions || '',
      updated_at: row.updated_at,
      source: row.source,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function updateProjectDna(cwd, detected) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Never overwrite manual entries
      const existing = db.prepare(`
        SELECT stack, patterns, key_files, source FROM project_profile WHERE cwd = ?
      `).get(nCwd);

      if (existing && existing.source === 'manual') {
        db.exec('COMMIT');
        return;
      }

      // Merge with existing auto data (union of sets)
      let stack = new Set(detected.stack || []);
      let patterns = new Set(detected.patterns || []);
      let key_files = new Set(detected.key_files || []);

      if (existing) {
        try {
          const oldStack = JSON.parse(existing.stack || '[]');
          const oldPatterns = JSON.parse(existing.patterns || '[]');
          const oldKeyFiles = JSON.parse(existing.key_files || '[]');
          for (const s of oldStack) stack.add(s);
          for (const p of oldPatterns) patterns.add(p);
          for (const f of oldKeyFiles) key_files.add(f);
        } catch { /* corrupted JSON — start fresh */ }
      }

      db.prepare(`
        INSERT INTO project_profile (cwd, stack, patterns, key_files, conventions, updated_at, source)
        VALUES (?, ?, ?, ?, ?, unixepoch(), 'auto')
        ON CONFLICT(cwd) DO UPDATE SET
          stack = excluded.stack,
          patterns = excluded.patterns,
          key_files = excluded.key_files,
          updated_at = excluded.updated_at
      `).run(
        nCwd,
        JSON.stringify([...stack]),
        JSON.stringify([...patterns]),
        JSON.stringify([...key_files]),
        detected.conventions || null
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
}

export function setProjectDna(cwd, data) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  try {
    db.prepare(`
      INSERT INTO project_profile (cwd, stack, patterns, key_files, conventions, updated_at, source)
      VALUES (?, ?, ?, ?, ?, unixepoch(), 'manual')
      ON CONFLICT(cwd) DO UPDATE SET
        stack = excluded.stack,
        patterns = excluded.patterns,
        key_files = excluded.key_files,
        conventions = excluded.conventions,
        updated_at = excluded.updated_at,
        source = 'manual'
    `).run(
      nCwd,
      JSON.stringify(data.stack || []),
      JSON.stringify(data.patterns || []),
      JSON.stringify(data.key_files || []),
      data.conventions || null
    );
  } finally {
    db.close();
  }
}

export function pruneAutoSnapshots(sessionId, cwd, maxKeep = 3) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  try {
    // Keep only the N most recent auto-snapshots for this session
    db.prepare(`
      DELETE FROM execution_snapshots
      WHERE id NOT IN (
        SELECT id FROM execution_snapshots
        WHERE session_id = ? AND cwd = ? AND snapshot_type = 'auto'
        ORDER BY created_at DESC LIMIT ?
      )
      AND session_id = ? AND cwd = ? AND snapshot_type = 'auto'
    `).run(sessionId, nCwd, maxKeep, sessionId, nCwd);
  } finally {
    db.close();
  }
}

export function getRecentObservations(cwd, opts = {}) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  const limit = opts.limit || 30;
  try {
    return db.prepare(`
      SELECT id, tool_name, action, files, cwd, created_at
      FROM observations WHERE cwd = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(nCwd, limit);
  } finally {
    db.close();
  }
}

export function searchObservations(query, cwd, opts = {}) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  const limit = opts.limit || 20;
  const offset = opts.offset || 0;
  try {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];
    return db.prepare(`
      SELECT o.id, o.tool_name, o.action, o.files, o.detail, o.cwd, o.created_at,
             f.rank
      FROM observations_fts f
      JOIN observations o ON o.id = f.rowid
      WHERE observations_fts MATCH ? AND o.cwd = ?
      ORDER BY f.rank
      LIMIT ? OFFSET ?
    `).all(sanitized, nCwd, limit, offset);
  } finally {
    db.close();
  }
}

export function getSessionStats(sessionId) {
  const db = getDb();
  try {
    const session = db.prepare(`
      SELECT observation_count, prompt_count, started_at, completed_at, status
      FROM sessions WHERE session_id = ?
    `).get(sessionId);
    return session || null;
  } finally {
    db.close();
  }
}

export function getLatestSnapshot(cwd, snapshotType) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  try {
    if (snapshotType) {
      return db.prepare(`
        SELECT id, session_id, cwd, current_task, execution_point, next_action,
               pending_tasks, plan, open_decisions, active_files, blocking_issues,
               snapshot_type, task_status, technical_state, confidence, created_at
        FROM execution_snapshots WHERE cwd = ? AND snapshot_type = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(nCwd, snapshotType) || null;
    }
    return db.prepare(`
      SELECT id, session_id, cwd, current_task, execution_point, next_action,
             pending_tasks, plan, open_decisions, active_files, blocking_issues,
             snapshot_type, task_status, technical_state, confidence, created_at
      FROM execution_snapshots WHERE cwd = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(nCwd) || null;
  } finally {
    db.close();
  }
}

export function getSessionDetail(sessionId, cwd) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  try {
    let session;
    if (sessionId) {
      session = db.prepare(`
        SELECT id, session_id, project, cwd, started_at, completed_at, status,
               observation_count, prompt_count
        FROM sessions WHERE session_id = ? AND cwd = ?
      `).get(sessionId, nCwd);
    } else {
      session = db.prepare(`
        SELECT id, session_id, project, cwd, started_at, completed_at, status,
               observation_count, prompt_count
        FROM sessions WHERE cwd = ?
        ORDER BY started_at DESC LIMIT 1
      `).get(nCwd);
    }
    if (!session) return null;

    const sid = session.session_id;

    const observations = db.prepare(`
      SELECT id, tool_name, action, files, detail, cwd, created_at
      FROM observations WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sid);

    const prompts = db.prepare(`
      SELECT id, prompt_text, created_at
      FROM user_prompts WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sid);

    const summary = db.prepare(`
      SELECT id, session_id, project, cwd, summary_text, tools_used, files_read,
             files_modified, observation_count, prompt_count, duration_seconds, created_at
      FROM session_summaries WHERE session_id = ? AND cwd = ?
    `).get(sid, nCwd) || null;

    return { session, observations, prompts, summary };
  } finally {
    db.close();
  }
}

export function getActiveSession(cwd) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  try {
    const row = db.prepare(`
      SELECT session_id FROM sessions
      WHERE cwd = ? AND status = 'active'
      ORDER BY started_at DESC LIMIT 1
    `).get(nCwd);
    return row ? row.session_id : null;
  } finally {
    db.close();
  }
}

export function abandonOrphanSessions(cwd, maxAgeHours = 4) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  try {
    const result = db.prepare(`
      UPDATE sessions SET status = 'abandoned'
      WHERE cwd = ? AND status = 'active'
        AND started_at < unixepoch() - ? * 3600
    `).run(nCwd, maxAgeHours);
    return result.changes;
  } finally {
    db.close();
  }
}

export function forgetRecords(type, ids, cwd) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  try {
    const tableMap = {
      observation: 'observations',
      prompt: 'user_prompts',
      snapshot: 'execution_snapshots'
    };
    const table = tableMap[type];
    if (!table) throw { code: -32602, message: `Invalid type: ${type}` };

    const cwdCol = table === 'user_prompts' ? null : 'cwd';

    if (cwdCol) {
      const placeholders = ids.map(() => '?').join(',');
      const owned = db.prepare(
        `SELECT id FROM ${table} WHERE id IN (${placeholders}) AND ${cwdCol} = ?`
      ).all(...ids, nCwd);
      if (owned.length !== ids.length) {
        throw { code: -32602, message: 'Some IDs do not belong to this project' };
      }
    } else {
      const placeholders = ids.map(() => '?').join(',');
      const owned = db.prepare(
        `SELECT p.id FROM ${table} p
         JOIN sessions s ON s.session_id = p.session_id
         WHERE p.id IN (${placeholders}) AND s.cwd = ?`
      ).all(...ids, nCwd);
      if (owned.length !== ids.length) {
        throw { code: -32602, message: 'Some IDs do not belong to this project' };
      }
    }

    const placeholders = ids.map(() => '?').join(',');
    const result = db.prepare(
      `DELETE FROM ${table} WHERE id IN (${placeholders})`
    ).run(...ids);

    process.stderr.write(`[local-mem] Forgot ${type} IDs: [${ids.join(',')}] at ${new Date().toISOString()}\n`);
    return result.changes;
  } finally {
    db.close();
  }
}

export function getCleanupTargets(cwd, olderThanDays) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  const cutoff = olderThanDays * TIME.SECONDS_PER_DAY;
  try {
    const obs = db.prepare(`
      SELECT COUNT(*) as count FROM observations
      WHERE cwd = ? AND created_at < unixepoch() - ?
        AND session_id NOT IN (SELECT session_id FROM sessions WHERE status = 'active')
    `).get(nCwd, cutoff);

    const prompts = db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts
      WHERE created_at < unixepoch() - ?
        AND session_id IN (SELECT session_id FROM sessions WHERE cwd = ? AND status != 'active')
    `).get(cutoff, nCwd);

    const snapshots = db.prepare(`
      SELECT COUNT(*) as count FROM execution_snapshots
      WHERE cwd = ? AND created_at < unixepoch() - ?
        AND session_id NOT IN (SELECT session_id FROM sessions WHERE status = 'active')
    `).get(nCwd, cutoff);

    const summaries = db.prepare(`
      SELECT COUNT(*) as count FROM session_summaries
      WHERE cwd = ? AND created_at < unixepoch() - ?
        AND session_id NOT IN (SELECT session_id FROM sessions WHERE status = 'active')
    `).get(nCwd, cutoff);

    const turnLogs = db.prepare(`
      SELECT COUNT(*) as count FROM turn_log
      WHERE cwd = ? AND created_at < unixepoch() - ?
        AND session_id NOT IN (SELECT session_id FROM sessions WHERE status = 'active')
    `).get(nCwd, cutoff);

    return {
      observations: obs.count,
      prompts: prompts.count,
      snapshots: snapshots.count,
      summaries: summaries.count,
      turnLogs: turnLogs.count,
      total: obs.count + prompts.count + snapshots.count + summaries.count + turnLogs.count
    };
  } finally {
    db.close();
  }
}

export function executeCleanup(cwd, olderThanDays) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  const cutoff = olderThanDays * TIME.SECONDS_PER_DAY;
  let totalDeleted = 0;
  let obsDeleted = 0, promptsDeleted = 0, snapshotsDeleted = 0, summariesDeleted = 0, turnLogsDeleted = 0;
  try {
    db.exec('BEGIN');
    try {
      const r1 = db.prepare(`
        DELETE FROM observations
        WHERE cwd = ? AND created_at < unixepoch() - ?
          AND session_id NOT IN (SELECT session_id FROM sessions WHERE status = 'active')
      `).run(nCwd, cutoff);
      obsDeleted = r1.changes;

      const r2 = db.prepare(`
        DELETE FROM user_prompts
        WHERE created_at < unixepoch() - ?
          AND session_id IN (SELECT session_id FROM sessions WHERE cwd = ? AND status != 'active')
      `).run(cutoff, nCwd);
      promptsDeleted = r2.changes;

      const r3 = db.prepare(`
        DELETE FROM execution_snapshots
        WHERE cwd = ? AND created_at < unixepoch() - ?
          AND session_id NOT IN (SELECT session_id FROM sessions WHERE status = 'active')
      `).run(nCwd, cutoff);
      snapshotsDeleted = r3.changes;

      const r4 = db.prepare(`
        DELETE FROM session_summaries
        WHERE cwd = ? AND created_at < unixepoch() - ?
          AND session_id NOT IN (SELECT session_id FROM sessions WHERE status = 'active')
      `).run(nCwd, cutoff);
      summariesDeleted = r4.changes;

      const r5 = db.prepare(`
        DELETE FROM turn_log
        WHERE cwd = ? AND created_at < unixepoch() - ?
          AND session_id NOT IN (SELECT session_id FROM sessions WHERE status = 'active')
      `).run(nCwd, cutoff);
      turnLogsDeleted = r5.changes;

      // v0.6: observation_scores cleaned via CASCADE on observations delete

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    totalDeleted = obsDeleted + promptsDeleted + snapshotsDeleted + summariesDeleted + turnLogsDeleted;
    if (totalDeleted > DB.VACUUM_THRESHOLD) {
      db.exec('VACUUM');
    }

    return {
      observations: obsDeleted,
      prompts: promptsDeleted,
      snapshots: snapshotsDeleted,
      summaries: summariesDeleted,
      turnLogs: turnLogsDeleted,
      total: totalDeleted,
      vacuumed: totalDeleted > DB.VACUUM_THRESHOLD
    };
  } finally {
    db.close();
  }
}

export function getExportData(cwd, format, limit = 500, offset = 0) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  const cappedLimit = Math.min(limit, 500);
  try {
    const totalRow = db.prepare(`
      SELECT COUNT(*) as count FROM observations WHERE cwd = ?
    `).get(nCwd);
    const total = totalRow.count;

    const observations = db.prepare(`
      SELECT id, session_id, tool_name, action, files, detail, cwd, created_at
      FROM observations WHERE cwd = ?
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(nCwd, cappedLimit, offset);

    const prompts = db.prepare(`
      SELECT p.id, p.session_id, p.prompt_text, p.created_at
      FROM user_prompts p
      JOIN sessions s ON s.session_id = p.session_id
      WHERE s.cwd = ?
      ORDER BY p.created_at DESC LIMIT ? OFFSET ?
    `).all(nCwd, cappedLimit, offset);

    const summaries = db.prepare(`
      SELECT id, session_id, project, cwd, summary_text, tools_used, files_read,
             files_modified, observation_count, prompt_count, duration_seconds, created_at
      FROM session_summaries WHERE cwd = ?
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(nCwd, cappedLimit, offset);

    const returned = observations.length;

    if (format === 'csv') {
      const header = 'id,session_id,tool_name,action,files,detail,cwd,created_at';
      const rows = observations.map(o =>
        [o.id, o.session_id, o.tool_name, o.action, o.files, o.detail, o.cwd, o.created_at]
          .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`)
          .join(',')
      );
      return {
        data: [header, ...rows].join('\n'),
        metadata: { total, returned, offset, hasMore: offset + returned < total }
      };
    }

    return {
      data: { observations, prompts, summaries },
      metadata: { total, returned, offset, hasMore: offset + returned < total }
    };
  } finally {
    db.close();
  }
}

export function getStatusData(cwd) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  try {
    const resolvedPath = process.env.LOCAL_MEM_DB_PATH || DEFAULT_DB_PATH;
    let dbSize = 0;
    try {
      dbSize = statSync(resolvedPath).size;
    } catch {}

    const version = db.prepare(`
      SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1
    `).get();

    const sessionCounts = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) as abandoned
      FROM sessions WHERE cwd = ?
    `).get(nCwd);

    const obsCount = db.prepare(`
      SELECT COUNT(*) as count FROM observations WHERE cwd = ?
    `).get(nCwd);

    const promptCount = db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts p
      JOIN sessions s ON s.session_id = p.session_id
      WHERE s.cwd = ?
    `).get(nCwd);

    const snapshotCount = db.prepare(`
      SELECT COUNT(*) as count FROM execution_snapshots WHERE cwd = ?
    `).get(nCwd);

    const lastActivity = db.prepare(`
      SELECT MAX(created_at) as last FROM observations WHERE cwd = ?
    `).get(nCwd);

    return {
      dbPath: resolvedPath,
      dbSize,
      schemaVersion: version ? version.version : null,
      sessions: {
        total: sessionCounts.total,
        active: sessionCounts.active,
        completed: sessionCounts.completed,
        abandoned: sessionCounts.abandoned
      },
      observations: obsCount.count,
      prompts: promptCount.count,
      snapshots: snapshotCount.count,
      lastActivity: lastActivity.last || null
    };
  } finally {
    db.close();
  }
}
