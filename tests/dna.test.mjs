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

// ═════════════════════════════════════════════════════════════════════════════
// DNA Tooling CLI — v0.12.0
// ═════════════════════════════════════════════════════════════════════════════
describe('DNA Tooling CLI — v0.12.0', () => {

  // ─── T4.1 — Lockfile detection ──────────────────────────────────────────────
  describe('T4.1 — Lockfile detection', () => {
    test('bun.lock → tools includes bun', () => {
      const result = inferProjectDna({}, [], ['bun.lock'], []);
      expect(result.tools).toContain('bun');
    });

    test('Cargo.lock → tools includes cargo', () => {
      const result = inferProjectDna({}, [], ['Cargo.lock'], []);
      expect(result.tools).toContain('cargo');
    });

    test('go.mod → tools includes go', () => {
      const result = inferProjectDna({}, [], ['go.mod'], []);
      expect(result.tools).toContain('go');
    });

    test('Makefile → tools includes make', () => {
      const result = inferProjectDna({}, [], ['Makefile'], []);
      expect(result.tools).toContain('make');
    });

    test('Dockerfile → tools includes docker', () => {
      const result = inferProjectDna({}, [], ['Dockerfile'], []);
      expect(result.tools).toContain('docker');
    });

    test('multiple lockfiles → tools has all without duplicates', () => {
      const result = inferProjectDna(
        {},
        ['bun.lock', 'Dockerfile', 'go.mod', 'Makefile'],
        ['Cargo.lock', 'docker-compose.yml'],
        []
      );
      expect(result.tools).toContain('bun');
      expect(result.tools).toContain('docker');
      expect(result.tools).toContain('go');
      expect(result.tools).toContain('make');
      expect(result.tools).toContain('cargo');
      // docker should not be duplicated (Dockerfile + docker-compose.yml)
      expect(result.tools.filter(t => t === 'docker').length).toBe(1);
    });
  });

  // ─── T4.2 — Bash action detection ──────────────────────────────────────────
  describe('T4.2 — Bash action detection', () => {
    test('terraform plan → tools includes terraform', () => {
      const result = inferProjectDna({}, [], [], ['terraform plan']);
      expect(result.tools).toContain('terraform');
    });

    test('kubectl apply -f deploy.yaml → tools includes kubectl', () => {
      const result = inferProjectDna({}, [], [], ['kubectl apply -f deploy.yaml']);
      expect(result.tools).toContain('kubectl');
    });

    test('docker build . → tools includes docker', () => {
      const result = inferProjectDna({}, [], [], ['docker build .']);
      expect(result.tools).toContain('docker');
    });

    test('aws s3 ls → tools includes aws-cli', () => {
      const result = inferProjectDna({}, [], [], ['aws s3 ls']);
      expect(result.tools).toContain('aws-cli');
    });

    test('cargo build → tools includes cargo', () => {
      const result = inferProjectDna({}, [], [], ['cargo build']);
      expect(result.tools).toContain('cargo');
    });
  });

  // ─── T4.3 — False positive mitigation ──────────────────────────────────────
  describe('T4.3 — False positive mitigation', () => {
    test('empty filesRead/bashActions → tools is empty array', () => {
      const result = inferProjectDna({}, [], [], []);
      expect(result.tools).toEqual([]);
    });

    test('filesRead without known lockfiles → tools empty', () => {
      const result = inferProjectDna({}, [], ['src/app.ts', 'README.md', 'lib/utils.js'], []);
      expect(result.tools).toEqual([]);
    });

    test('bashActions with docker as substring in another word → NOT detected', () => {
      // 'dockerize-app' does not match \\bdocker\\s+(build|run|compose|push|pull)
      const result = inferProjectDna({}, [], [], ['dockerize-app start']);
      expect(result.tools).not.toContain('docker');
    });
  });

  // ─── T4.4 — Migration v6 ──────────────────────────────────────────────────
  describe('T4.4 — Migration v6', () => {
    test('DB has schema version 6', () => {
      const db = getDb();
      try {
        const row = db.prepare('SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1').get();
        expect(row.version).toBe(6);
      } finally {
        db.close();
      }
    });

    test('project_profile has tools column', () => {
      const db = getDb();
      try {
        const cols = db.prepare("PRAGMA table_info(project_profile)").all();
        const colNames = cols.map(c => c.name);
        expect(colNames).toContain('tools');
      } finally {
        db.close();
      }
    });
  });

  // ─── T4.5 — renderDna() con tools ─────────────────────────────────────────
  describe('T4.5 — renderDna() with tools', () => {
    beforeEach(() => cleanDb());

    test('with tools → output includes Tools:', () => {
      updateProjectDna(TEST_CWD, {
        stack: ['TypeScript'],
        tools: ['docker', 'terraform'],
        key_files: ['app.ts'],
      });
      const dna = getProjectDna(TEST_CWD);
      // Replicate renderDna logic since it's not exported
      const parts = [];
      if (dna.stack.length > 0) parts.push(dna.stack.join(' + '));
      if (dna.tools && dna.tools.length > 0) parts.push(`Tools: ${dna.tools.join(', ')}`);
      if (dna.patterns.length > 0) parts.push(dna.patterns.join(', '));
      if (dna.key_files.length > 0) parts.push(`Key: ${dna.key_files.slice(0, 5).join(', ')}`);
      const output = `DNA: ${parts.join(' | ')}`;
      expect(output).toContain('Tools:');
      expect(output).toContain('docker');
      expect(output).toContain('terraform');
    });

    test('without tools → output does NOT include Tools:', () => {
      updateProjectDna(TEST_CWD, {
        stack: ['TypeScript'],
        tools: [],
        key_files: ['app.ts'],
      });
      const dna = getProjectDna(TEST_CWD);
      const parts = [];
      if (dna.stack.length > 0) parts.push(dna.stack.join(' + '));
      if (dna.tools && dna.tools.length > 0) parts.push(`Tools: ${dna.tools.join(', ')}`);
      if (dna.patterns.length > 0) parts.push(dna.patterns.join(', '));
      if (dna.key_files.length > 0) parts.push(`Key: ${dna.key_files.slice(0, 5).join(', ')}`);
      const output = `DNA: ${parts.join(' | ')}`;
      expect(output).not.toContain('Tools:');
    });
  });

  // ─── T4.6 — updateProjectDna() merge tools ────────────────────────────────
  describe('T4.6 — updateProjectDna() merge tools', () => {
    beforeEach(() => cleanDb());

    test('merges tools from successive calls', () => {
      updateProjectDna(TEST_CWD, {
        stack: ['TypeScript'],
        tools: ['docker'],
      });
      updateProjectDna(TEST_CWD, {
        stack: ['TypeScript'],
        tools: ['terraform'],
      });
      const dna = getProjectDna(TEST_CWD);
      expect(dna.tools).toContain('docker');
      expect(dna.tools).toContain('terraform');
    });

    test('does not duplicate existing tools', () => {
      updateProjectDna(TEST_CWD, {
        stack: ['TypeScript'],
        tools: ['docker'],
      });
      updateProjectDna(TEST_CWD, {
        stack: ['TypeScript'],
        tools: ['docker', 'terraform'],
      });
      const dna = getProjectDna(TEST_CWD);
      expect(dna.tools.filter(t => t === 'docker').length).toBe(1);
      expect(dna.tools).toContain('terraform');
    });
  });

  // ─── T4.7 — setProjectDna() manual override con tools ─────────────────────
  describe('T4.7 — setProjectDna() manual override with tools', () => {
    beforeEach(() => cleanDb());

    test('setProjectDna with tools → getProjectDna returns tools', () => {
      setProjectDna(TEST_CWD, {
        stack: ['Python'],
        tools: ['custom-tool'],
      });
      const dna = getProjectDna(TEST_CWD);
      expect(dna.tools).toEqual(['custom-tool']);
    });

    test('source is manual', () => {
      setProjectDna(TEST_CWD, {
        stack: ['Python'],
        tools: ['custom-tool'],
      });
      const dna = getProjectDna(TEST_CWD);
      expect(dna.source).toBe('manual');
    });
  });
});
