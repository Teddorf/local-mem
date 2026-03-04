import { Database } from 'bun:sqlite';
import { mkdirSync, statSync } from 'fs';
import { dirname, basename } from 'path';

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
  if (sanitized.length > 500) sanitized = sanitized.slice(0, 500);
  return sanitized;
}

const MAX_JSON_FIELD_SIZE = 10240;

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

export function getDb(dbPath) {
  const resolvedPath = dbPath || process.env.LOCAL_MEM_DB_PATH || DEFAULT_DB_PATH;
  const dir = dirname(resolvedPath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  const db = new Database(resolvedPath, { create: true });
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA wal_autocheckpoint=1000');
  db.exec(SCHEMA_SQL);
  // Migration logic: read schema_version and apply migrations if needed
  const row = db.prepare('SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1').get();
  const currentVersion = row ? row.version : 1;
  // Future migrations go here:
  // if (currentVersion < 2) { db.exec(MIGRATION_V2); db.prepare('UPDATE schema_version SET version=2 WHERE rowid=1').run(); }
  void currentVersion;
  return db;
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
         pending_tasks, plan, open_decisions, active_files, blocking_issues, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
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
      jsonStringify(data.blocking_issues)
    );
    return { id: Number(result.lastInsertRowid) };
  } finally {
    db.close();
  }
}

export function getRecentContext(cwd, opts = {}) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  const limit = opts.limit || 30;
  try {
    const observations = db.prepare(`
      SELECT id, tool_name, action, files, cwd, created_at
      FROM observations WHERE cwd = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(nCwd, limit);

    const summary = db.prepare(`
      SELECT id, session_id, project, cwd, summary_text, tools_used, files_read,
             files_modified, observation_count, prompt_count, duration_seconds, created_at
      FROM session_summaries WHERE cwd = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(nCwd) || null;

    const snapshot = db.prepare(`
      SELECT id, session_id, cwd, current_task, execution_point, next_action,
             pending_tasks, plan, open_decisions, active_files, blocking_issues, created_at
      FROM execution_snapshots WHERE cwd = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(nCwd) || null;

    return { observations, summary, snapshot };
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

export function getLatestSnapshot(cwd) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  try {
    return db.prepare(`
      SELECT id, session_id, cwd, current_task, execution_point, next_action,
             pending_tasks, plan, open_decisions, active_files, blocking_issues, created_at
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
      FROM observations WHERE session_id = ? AND cwd = ?
      ORDER BY created_at ASC
    `).all(sid, nCwd);

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
  const cutoff = olderThanDays * 86400;
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

    return {
      observations: obs.count,
      prompts: prompts.count,
      snapshots: snapshots.count,
      summaries: summaries.count,
      total: obs.count + prompts.count + snapshots.count + summaries.count
    };
  } finally {
    db.close();
  }
}

export function executeCleanup(cwd, olderThanDays) {
  const db = getDb();
  const nCwd = normalizeCwd(cwd);
  const cutoff = olderThanDays * 86400;
  let totalDeleted = 0;
  let obsDeleted = 0, promptsDeleted = 0, snapshotsDeleted = 0, summariesDeleted = 0;
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

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    totalDeleted = obsDeleted + promptsDeleted + snapshotsDeleted + summariesDeleted;
    if (totalDeleted > 100) {
      db.exec('VACUUM');
    }

    return {
      observations: obsDeleted,
      prompts: promptsDeleted,
      snapshots: snapshotsDeleted,
      summaries: summariesDeleted,
      total: totalDeleted,
      vacuumed: totalDeleted > 100
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
