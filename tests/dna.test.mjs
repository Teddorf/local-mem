/**
 * Unit tests for v0.9.0 Project DNA:
 * - getProjectDna / updateProjectDna / setProjectDna (db.mjs)
 * - inferProjectDna (session-end.mjs)
 *
 * Run: bun test tests/dna.test.mjs
 */

import { test, expect, describe, beforeEach } from 'bun:test';
import { mkdirSync } from 'fs';
import { join } from 'path';

// ─── Test DB setup ───────────────────────────────────────────────────────────
const TEST_DB_DIR = '/tmp/local-mem-test-dna';
const TEST_DB_PATH = join(TEST_DB_DIR, 'test-dna.db');

mkdirSync(TEST_DB_DIR, { recursive: true });
process.env.LOCAL_MEM_DB_PATH = TEST_DB_PATH;

// Import after setting env
import {
  getDb, ensureSession, getProjectDna, updateProjectDna, setProjectDna,
} from '../scripts/db.mjs';

import { inferProjectDna } from '../scripts/session-end.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────
const TEST_CWD = '/test/project/dna-test';

function cleanDb() {
  const db = getDb();
  db.exec('DELETE FROM project_profile');
  db.exec('DELETE FROM sessions');
  db.close();
}

// ═════════════════════════════════════════════════════════════════════════════
// inferProjectDna
// ═════════════════════════════════════════════════════════════════════════════
describe('inferProjectDna', () => {
  test('detects TypeScript from .ts files', () => {
    const result = inferProjectDna({}, ['src/app.ts', 'src/db.ts'], []);
    expect(result.stack).toContain('TypeScript');
  });

  test('detects ESM from .mjs files', () => {
    const result = inferProjectDna({}, ['scripts/db.mjs'], []);
    expect(result.stack).toContain('ESM');
  });

  test('detects Python from .py files', () => {
    const result = inferProjectDna({}, ['main.py'], []);
    expect(result.stack).toContain('Python');
  });

  test('detects Rust from .rs files', () => {
    const result = inferProjectDna({}, ['src/main.rs'], []);
    expect(result.stack).toContain('Rust');
  });

  test('detects Go from .go files', () => {
    const result = inferProjectDna({}, ['cmd/server.go'], []);
    expect(result.stack).toContain('Go');
  });

  test('detects React from .tsx/.jsx files', () => {
    const result = inferProjectDna({}, ['src/App.tsx', 'src/Button.jsx'], []);
    expect(result.stack).toContain('React');
  });

  test('detects Vue from .vue files', () => {
    const result = inferProjectDna({}, ['src/App.vue'], []);
    expect(result.stack).toContain('Vue');
  });

  test('detects Svelte from .svelte files', () => {
    const result = inferProjectDna({}, ['src/App.svelte'], []);
    expect(result.stack).toContain('Svelte');
  });

  test('detects SQLite from .sql files', () => {
    const result = inferProjectDna({}, ['schema.sql'], []);
    expect(result.stack).toContain('SQLite');
  });

  test('detects SQLite from sqlite in path', () => {
    const result = inferProjectDna({}, ['lib/sqlite-wrapper.js'], []);
    expect(result.stack).toContain('SQLite');
  });

  test('detects Docker from Dockerfile', () => {
    const result = inferProjectDna({}, ['Dockerfile'], []);
    expect(result.stack).toContain('Docker');
  });

  test('detects Docker from docker-compose', () => {
    const result = inferProjectDna({}, ['docker-compose.yml'], []);
    expect(result.stack).toContain('Docker');
  });

  test('detects Bun from bash actions', () => {
    const result = inferProjectDna({}, [], [], ['bun test', 'bun install']);
    expect(result.stack).toContain('Bun');
  });

  test('detects Node.js from npm in bash actions', () => {
    const result = inferProjectDna({}, [], [], ['npm install', 'npm run build']);
    expect(result.stack).toContain('Node.js');
  });

  test('detects Node.js from yarn in bash actions', () => {
    const result = inferProjectDna({}, [], [], ['yarn add react']);
    expect(result.stack).toContain('Node.js');
  });

  test('detects Node.js from pnpm in bash actions', () => {
    const result = inferProjectDna({}, [], [], ['pnpm install']);
    expect(result.stack).toContain('Node.js');
  });

  test('detects multiple stacks simultaneously', () => {
    const result = inferProjectDna({}, ['src/app.ts', 'scripts/db.mjs', 'Dockerfile'], [], ['bun test']);
    expect(result.stack).toContain('TypeScript');
    expect(result.stack).toContain('ESM');
    expect(result.stack).toContain('Docker');
    expect(result.stack).toContain('Bun');
  });

  test('collects key_files from modified files (basenames)', () => {
    const result = inferProjectDna({}, ['/project/src/app.ts', '/project/scripts/db.mjs'], []);
    expect(result.key_files).toContain('app.ts');
    expect(result.key_files).toContain('db.mjs');
  });

  test('key_files are deduplicated', () => {
    const result = inferProjectDna({}, ['/a/app.ts', '/b/app.ts'], []);
    expect(result.key_files.filter(f => f === 'app.ts').length).toBe(1);
  });

  test('key_files limited to 10', () => {
    const files = Array.from({ length: 20 }, (_, i) => `/project/file${i}.ts`);
    const result = inferProjectDna({}, files, []);
    expect(result.key_files.length).toBeLessThanOrEqual(10);
  });

  test('handles empty inputs gracefully', () => {
    const result = inferProjectDna({}, [], []);
    expect(result.stack).toEqual([]);
    expect(result.patterns).toEqual([]);
    expect(result.key_files).toEqual([]);
  });

  test('handles null/undefined inputs', () => {
    const result = inferProjectDna({}, null, null, null);
    expect(result.stack).toEqual([]);
    expect(result.key_files).toEqual([]);
  });

  test('reads files from filesRead too', () => {
    const result = inferProjectDna({}, [], ['src/main.rs']);
    expect(result.stack).toContain('Rust');
  });

  test('does not include bun from bunny or similar', () => {
    const result = inferProjectDna({}, [], [], ['bunny hop']);
    expect(result.stack).not.toContain('Bun');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DB functions: getProjectDna / updateProjectDna / setProjectDna
// ═════════════════════════════════════════════════════════════════════════════
describe('Project DNA DB functions', () => {
  beforeEach(() => cleanDb());

  test('getProjectDna returns null when no DNA exists', () => {
    const dna = getProjectDna(TEST_CWD);
    expect(dna).toBeNull();
  });

  test('updateProjectDna creates auto entry', () => {
    updateProjectDna(TEST_CWD, {
      stack: ['TypeScript', 'Bun'],
      patterns: ['zero-deps'],
      key_files: ['db.mjs'],
    });

    const dna = getProjectDna(TEST_CWD);
    expect(dna).not.toBeNull();
    expect(dna.source).toBe('auto');
    expect(dna.stack).toContain('TypeScript');
    expect(dna.stack).toContain('Bun');
    expect(dna.patterns).toContain('zero-deps');
    expect(dna.key_files).toContain('db.mjs');
  });

  test('updateProjectDna merges with existing auto data (union)', () => {
    updateProjectDna(TEST_CWD, {
      stack: ['TypeScript'],
      key_files: ['app.ts'],
    });

    updateProjectDna(TEST_CWD, {
      stack: ['Bun'],
      key_files: ['db.mjs'],
    });

    const dna = getProjectDna(TEST_CWD);
    expect(dna.stack).toContain('TypeScript');
    expect(dna.stack).toContain('Bun');
    expect(dna.key_files).toContain('app.ts');
    expect(dna.key_files).toContain('db.mjs');
  });

  test('setProjectDna creates manual entry', () => {
    setProjectDna(TEST_CWD, {
      stack: ['React', 'Node.js'],
      patterns: ['monorepo'],
      key_files: ['index.tsx'],
      conventions: 'english, verbose',
    });

    const dna = getProjectDna(TEST_CWD);
    expect(dna.source).toBe('manual');
    expect(dna.stack).toContain('React');
    expect(dna.conventions).toBe('english, verbose');
  });

  test('updateProjectDna does NOT overwrite manual entry', () => {
    setProjectDna(TEST_CWD, {
      stack: ['React'],
      conventions: 'manual entry',
    });

    updateProjectDna(TEST_CWD, {
      stack: ['Vue'],
      key_files: ['app.vue'],
    });

    const dna = getProjectDna(TEST_CWD);
    expect(dna.source).toBe('manual');
    expect(dna.stack).toContain('React');
    expect(dna.stack).not.toContain('Vue');
  });

  test('setProjectDna overwrites auto entry', () => {
    updateProjectDna(TEST_CWD, {
      stack: ['TypeScript'],
    });

    setProjectDna(TEST_CWD, {
      stack: ['Python'],
      conventions: 'nuevo',
    });

    const dna = getProjectDna(TEST_CWD);
    expect(dna.source).toBe('manual');
    expect(dna.stack).toContain('Python');
    expect(dna.stack).not.toContain('TypeScript');
  });

  test('setProjectDna overwrites manual entry', () => {
    setProjectDna(TEST_CWD, { stack: ['React'] });
    setProjectDna(TEST_CWD, { stack: ['Vue'] });

    const dna = getProjectDna(TEST_CWD);
    expect(dna.stack).toContain('Vue');
    expect(dna.stack).not.toContain('React');
  });

  test('normalizes cwd (Windows paths)', () => {
    updateProjectDna('C:\\Users\\test\\project', {
      stack: ['TypeScript'],
    });

    const dna = getProjectDna('C:\\Users\\test\\project');
    expect(dna).not.toBeNull();
    expect(dna.stack).toContain('TypeScript');
  });

  test('different cwds have independent DNA', () => {
    updateProjectDna('/project/a', { stack: ['TypeScript'] });
    updateProjectDna('/project/b', { stack: ['Python'] });

    const dnaA = getProjectDna('/project/a');
    const dnaB = getProjectDna('/project/b');
    expect(dnaA.stack).toContain('TypeScript');
    expect(dnaA.stack).not.toContain('Python');
    expect(dnaB.stack).toContain('Python');
    expect(dnaB.stack).not.toContain('TypeScript');
  });

  test('updated_at is set', () => {
    updateProjectDna(TEST_CWD, { stack: ['Bun'] });
    const dna = getProjectDna(TEST_CWD);
    expect(dna.updated_at).toBeGreaterThan(0);
  });

  test('handles empty arrays gracefully', () => {
    updateProjectDna(TEST_CWD, { stack: [], patterns: [], key_files: [] });
    const dna = getProjectDna(TEST_CWD);
    expect(dna).not.toBeNull();
    expect(dna.stack).toEqual([]);
  });
});
