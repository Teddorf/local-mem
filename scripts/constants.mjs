// ─── Central constants for local-mem ──────────────────────────────────────────
// All magic numbers, limits, and thresholds in one place.
// Import what you need: import { LIMITS, TIMEOUTS } from './constants.mjs';

// ─── Size limits (bytes) ─────────────────────────────────────────────────────
export const SIZES = {
  MAX_STDIN_BYTES:        1_048_576,   // 1MB — stdin read limit
  MAX_JSON_FIELD:         10_240,      // 10KB — JSON fields in DB
  MAX_THINKING_TEXT:      4_096,       // 4KB — thinking_text in turn_log
  MAX_RESPONSE_TEXT:      2_048,       // 2KB — response_text in turn_log
  MAX_FTS_QUERY:          500,         // chars — sanitized FTS5 query
  TRANSCRIPT_LAST_500KB:  500 * 1024,  // 500KB — transcript read (normal)
  TRANSCRIPT_LAST_2MB:    2 * 1024 * 1024, // 2MB — transcript read (compact)
  TRANSCRIPT_MAX_END:     200 * 1024,  // 200KB — transcript read (session-end)
  TRANSCRIPT_MAX_THINKING: 20 * 1024 * 1024, // 20MB — thinking extraction
  MAX_SNAPSHOT_FIELD:     10_240,      // 10KB — snapshot field size in MCP
};

// ─── Timeouts (milliseconds) ─────────────────────────────────────────────────
export const TIMEOUTS = {
  STDIN_DEFAULT:       3_000,   // 3s — stdin read timeout
  HOOK_FAST:           10,      // 10s — SessionStart, UserPromptSubmit, PostToolUse (used in install.mjs as seconds)
  HOOK_SLOW:           20,      // 20s — SessionEnd (used in install.mjs as seconds)
  FETCH_UPDATE:        3_000,   // 3s — remote version check
  GIT_COMMAND:         5_000,   // 5s — git commands in context validity
  TSC_COMMAND:         10_000,  // 10s — tsc type check
  DB_BUSY:             5_000,   // 5s — SQLite busy_timeout pragma
  CLI_COMMAND:         10_000,  // 10s — install CLI commands
  MCP_REGISTRATION:    15_000,  // 15s — MCP server registration
};

// ─── Database config ─────────────────────────────────────────────────────────
export const DB = {
  WAL_AUTOCHECKPOINT:  1_000,  // pages — WAL checkpoint threshold
  VACUUM_THRESHOLD:    100,    // rows deleted before VACUUM
  PERMISSIONS_DIR:     0o700,  // rwx------
  PERMISSIONS_FILE:    0o600,  // rw-------
};

// ─── Query limits per disclosure level ───────────────────────────────────────
export const LEVEL_LIMITS = {
  1: {
    observations: 0,
    prompts: 1,
    thinking: 0,
    topScored: 0,
    recentSessions: 0,
    maxObsLines: 0,
  },
  2: {
    observations: 5,
    prompts: 5,
    thinking: 3,
    topScored: 7,
    recentSessions: 3,
    maxObsLines: 5,
  },
  3: {
    observations: 200,    // safety net for active session
    prompts: 50,          // cap for active session
    thinking: 5,
    topScored: 0,         // skipped in level 3
    recentSessions: 1,
    maxObsLines: 30,
  },
};

// ─── Scoring ─────────────────────────────────────────────────────────────────
export const SCORING = {
  RECENCY_1H:          3_600,   // 1 hour in seconds
  RECENCY_6H:          21_600,  // 6 hours in seconds
  DEFAULT_THRESHOLD:   0.25,    // fallback score threshold
  SAMPLE_SIZE:         30,      // rows to sample for threshold calc
  MIN_SCORED_FALLBACK: 5,       // minimum scored results before fallback
  WEIGHTS: {
    impact: 0.4,
    recency: 0.2,
    error: 0.1,
  },
  PREV_HIGH_IMPACT_LIMIT: 5,    // high-impact actions from prev session
};

// ─── Truncation limits (characters) ──────────────────────────────────────────
export const TRUNCATE = {
  // session-start.mjs — rendering
  CROSS_SESSION_ACTION:   200,
  CROSS_SESSION_FILE:     80,
  CROSS_SESSION_RESULT:   300,
  CROSS_SESSION_PENDING:  120,
  SUMMARY_RESULT:         150,
  SUMMARY_FILE:           200,
  PLAN_TEXT:              300,
  PENDING_TASKS:         500,
  THINKING_TEXT:         500,
  RESPONSE_TEXT:         300,
  PROMPT_TEXT:           120,
  OBS_ACTION:            100,
  OBS_DETAIL:            80,
  OBS_FILE:              80,
  OBS_GROUPED_DETAIL:    60,
  OBS_GROUPED_LINE:      200,
  OBS_SCORED_ACTION:     80,
  EXECUTION_POINT_L1:    100,

  // session-end.mjs — summary
  SUMMARY_MAX:           500,
  SUMMARY_MIN_LENGTH:    80,    // minimum chars to consider non-trivial

  // observation.mjs — distillation
  DISTILL_EDIT_STRING:   80,
  DISTILL_BASH_CMD:      200,
  DISTILL_BASH_OUTPUT:   500,
  DISTILL_READ_OUTPUT:   200,
  DISTILL_GREP_OUTPUT:   400,
  DISTILL_GLOB_FILES:    300,
  DISTILL_WEBSEARCH:     300,
  DISTILL_WEBFETCH:      300,
  DISTILL_AGENT:         300,
  DISTILL_DEFAULT:       120,
  DISTILL_TEST_SUMMARY:  200,

  // observation.mjs — auto-snapshot
  SNAPSHOT_EXECUTION_POINT: 500,
  SNAPSHOT_NEXT_ACTION:    300,
};

// ─── Rendering limits (counts) ───────────────────────────────────────────────
export const RENDER = {
  MAX_FILES_CROSS_SESSION: 5,  // files shown in cross-session
  MAX_FILES_SUMMARY:       5,  // files shown in session summary
  MAX_FILES_CHECK_GIT:     10, // files to verify via git
  MAX_PLAN_ITEMS:          10, // plan items shown
  MAX_PENDING_TASKS:       10, // pending tasks shown
  SESSION_ID_DISPLAY_LEN:  8,  // chars of session ID to display
  MAX_KEY_FILES_DETECT:    10, // max key_files from inferProjectDna
  MAX_KEY_FILES_INDEX:     2,  // key files in session index
  MAX_SUMMARY_FILES:       3,  // files in summary section
  WRITE_PREVIEW_LINES:     2,  // lines to preview in Write distill
  WEBSEARCH_MAX_LINES:     6,  // lines from WebSearch results
  GLOB_MAX_FILES:          10, // files shown in Glob distill
  MAX_ACTIVE_FILES:        20, // active files in snapshot
  MAX_RECENT_ACTIONS:      10, // recent actions in snapshot
  MAX_AUTO_SNAPSHOTS:      3,  // auto snapshots to keep
  MAX_VERSION_STRING:      30, // max length of version string
  THINKING_DEDUP_PREFIX:   50, // chars for thinking dedup key
  PROJECT_DIR_SLICE:       60, // chars for project dir in fallback
  THINKING_BLOCKS_DEFAULT: 5,  // thinking blocks to extract
};

// ─── Time constants ──────────────────────────────────────────────────────────
export const TIME = {
  SECONDS_PER_MINUTE: 60,
  SECONDS_PER_HOUR:   3_600,
  SECONDS_PER_DAY:    86_400,
  ORPHAN_SESSION_HOURS: 4,     // hours before abandoning orphan sessions
  CLEANUP_DEFAULT_DAYS: 90,    // days before cleanup
};

// ─── MCP server defaults ─────────────────────────────────────────────────────
export const MCP = {
  SEARCH_LIMIT_DEFAULT:    20,
  SEARCH_LIMIT_MAX:        100,
  RECENT_LIMIT_DEFAULT:    30,
  RECENT_LIMIT_MAX:        100,
  THINKING_SEARCH_LIMIT:   10,
  TOP_PRIORITY_LIMIT:      15,
  EXPORT_LIMIT_DEFAULT:    500,
  MAX_FORGET_IDS:          50,
};

// ─── Patterns ────────────────────────────────────────────────────────────────
export const PATTERNS = {
  CLOUD_SYNC_DIRS: ['onedrive', 'dropbox', 'icloud', 'iclouddrive', 'google drive', 'nextcloud'],
  OTHER_MEMORY_PLUGINS: ['claude-mem', 'memory-plugin', 'persistent-memory', 'cline-memory'],
};

// ─── URLs ────────────────────────────────────────────────────────────────────
export const URLS = {
  GITHUB_PACKAGE_JSON: 'https://raw.githubusercontent.com/Teddorf/local-mem/main/package.json',
};

// ─── Bun version ─────────────────────────────────────────────────────────────
export const MIN_BUN_VERSION = { major: 1, minor: 1 };
