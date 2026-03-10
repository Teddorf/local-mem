/**
 * Unit tests for v0.10.0 AI Summary:
 * - generateAiSummary (ai.mjs)
 * - loadSettings / clearSettingsCache (settings.mjs)
 * - collectAiContext integration (session-end.mjs)
 *
 * Run: bun test tests/ai.test.mjs
 */

import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

// ─── Settings tests ─────────────────────────────────────────────────────────

const TEST_SETTINGS_DIR = '/tmp/local-mem-test-settings';
const TEST_SETTINGS_PATH = join(TEST_SETTINGS_DIR, 'settings.json');

describe('loadSettings', () => {
  beforeEach(() => {
    mkdirSync(TEST_SETTINGS_DIR, { recursive: true });
    process.env.LOCAL_MEM_SETTINGS_PATH = TEST_SETTINGS_PATH;
    // Clear cache before each test
    const { clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
  });

  afterEach(() => {
    delete process.env.LOCAL_MEM_SETTINGS_PATH;
    try { rmSync(TEST_SETTINGS_DIR, { recursive: true }); } catch {}
  });

  test('returns empty object when file does not exist', () => {
    process.env.LOCAL_MEM_SETTINGS_PATH = '/tmp/nonexistent-settings.json';
    const { loadSettings, clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const settings = loadSettings();
    expect(settings).toEqual({});
  });

  test('loads valid settings from file', () => {
    writeFileSync(TEST_SETTINGS_PATH, JSON.stringify({
      ai_summary: { enabled: true, api_key: 'sk-test-123' }
    }));
    const { loadSettings, clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const settings = loadSettings();
    expect(settings.ai_summary.enabled).toBe(true);
    expect(settings.ai_summary.api_key).toBe('sk-test-123');
  });

  test('returns empty object for invalid JSON', () => {
    writeFileSync(TEST_SETTINGS_PATH, 'not valid json {{{');
    const { loadSettings, clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const settings = loadSettings();
    expect(settings).toEqual({});
  });

  test('caches result after first load', () => {
    writeFileSync(TEST_SETTINGS_PATH, JSON.stringify({ cached: true }));
    const { loadSettings, clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const first = loadSettings();
    // Change file — should still return cached
    writeFileSync(TEST_SETTINGS_PATH, JSON.stringify({ cached: false }));
    const second = loadSettings();
    expect(first).toBe(second); // same reference
    expect(second.cached).toBe(true);
  });

  test('clearSettingsCache resets cache', () => {
    writeFileSync(TEST_SETTINGS_PATH, JSON.stringify({ v: 1 }));
    const { loadSettings, clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const first = loadSettings();
    expect(first.v).toBe(1);

    writeFileSync(TEST_SETTINGS_PATH, JSON.stringify({ v: 2 }));
    clearSettingsCache();
    const second = loadSettings();
    expect(second.v).toBe(2);
  });
});

// ─── generateAiSummary tests ────────────────────────────────────────────────

describe('generateAiSummary', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    const { clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.LOCAL_MEM_SETTINGS_PATH;
    delete process.env.LOCAL_MEM_AI_KEY;
  });

  test('returns null when AI not enabled', async () => {
    const settingsDir = '/tmp/local-mem-ai-test-disabled';
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({}));
    process.env.LOCAL_MEM_SETTINGS_PATH = settingsPath;

    const { clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const { generateAiSummary } = require('../scripts/ai.mjs');

    const result = await generateAiSummary({ files_modified: [], prompts: [] });
    expect(result).toBeNull();
    rmSync(settingsDir, { recursive: true });
  });

  test('returns null when no API key', async () => {
    const settingsDir = '/tmp/local-mem-ai-test-nokey';
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ ai_summary: { enabled: true } }));
    process.env.LOCAL_MEM_SETTINGS_PATH = settingsPath;

    const { clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const { generateAiSummary } = require('../scripts/ai.mjs');

    const result = await generateAiSummary({ files_modified: [], prompts: [] });
    expect(result).toBeNull();
    rmSync(settingsDir, { recursive: true });
  });

  test('uses LOCAL_MEM_AI_KEY env var as fallback', async () => {
    const settingsDir = '/tmp/local-mem-ai-test-envkey';
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ ai_summary: { enabled: true } }));
    process.env.LOCAL_MEM_SETTINGS_PATH = settingsPath;
    process.env.LOCAL_MEM_AI_KEY = 'sk-env-key';

    const { clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const { generateAiSummary } = require('../scripts/ai.mjs');

    // Mock fetch to capture the call
    let fetchCalled = false;
    let capturedHeaders = null;
    globalThis.fetch = async (url, opts) => {
      fetchCalled = true;
      capturedHeaders = opts.headers;
      return {
        ok: true,
        json: async () => ({ content: [{ text: 'Implementó feature X en archivo Y para resolver Z.' }] })
      };
    };

    const result = await generateAiSummary({
      files_modified: ['db.mjs'],
      prompts: ['Implementar feature'],
    });

    expect(fetchCalled).toBe(true);
    expect(capturedHeaders['x-api-key']).toBe('sk-env-key');
    expect(result).toContain('Implementó feature X');
    rmSync(settingsDir, { recursive: true });
  });

  test('returns redacted summary on success', async () => {
    const settingsDir = '/tmp/local-mem-ai-test-success';
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      ai_summary: { enabled: true, api_key: 'sk-test' }
    }));
    process.env.LOCAL_MEM_SETTINGS_PATH = settingsPath;

    const { clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const { generateAiSummary } = require('../scripts/ai.mjs');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        content: [{ text: 'Refactorizó el módulo de autenticación para soportar OAuth2.' }]
      })
    });

    const result = await generateAiSummary({
      files_modified: ['auth.mjs'],
      prompts: ['Agregar OAuth2'],
      current_task: 'Auth',
      top_observations: ['Edit auth.mjs'],
    });

    expect(result).toBe('Refactorizó el módulo de autenticación para soportar OAuth2.');
    rmSync(settingsDir, { recursive: true });
  });

  test('returns null on HTTP error', async () => {
    const settingsDir = '/tmp/local-mem-ai-test-httperr';
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      ai_summary: { enabled: true, api_key: 'sk-test' }
    }));
    process.env.LOCAL_MEM_SETTINGS_PATH = settingsPath;

    const { clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const { generateAiSummary } = require('../scripts/ai.mjs');

    globalThis.fetch = async () => ({ ok: false, status: 429 });

    const result = await generateAiSummary({ files_modified: [], prompts: [] });
    expect(result).toBeNull();
    rmSync(settingsDir, { recursive: true });
  });

  test('returns null on network error', async () => {
    const settingsDir = '/tmp/local-mem-ai-test-neterr';
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      ai_summary: { enabled: true, api_key: 'sk-test' }
    }));
    process.env.LOCAL_MEM_SETTINGS_PATH = settingsPath;

    const { clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const { generateAiSummary } = require('../scripts/ai.mjs');

    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

    const result = await generateAiSummary({ files_modified: [], prompts: [] });
    expect(result).toBeNull();
    rmSync(settingsDir, { recursive: true });
  });

  test('returns null when response text too short', async () => {
    const settingsDir = '/tmp/local-mem-ai-test-short';
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      ai_summary: { enabled: true, api_key: 'sk-test' }
    }));
    process.env.LOCAL_MEM_SETTINGS_PATH = settingsPath;

    const { clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const { generateAiSummary } = require('../scripts/ai.mjs');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ text: 'Ok.' }] })
    });

    const result = await generateAiSummary({ files_modified: [], prompts: [] });
    expect(result).toBeNull();
    rmSync(settingsDir, { recursive: true });
  });

  test('returns null when response text too long', async () => {
    const settingsDir = '/tmp/local-mem-ai-test-long';
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      ai_summary: { enabled: true, api_key: 'sk-test' }
    }));
    process.env.LOCAL_MEM_SETTINGS_PATH = settingsPath;

    const { clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const { generateAiSummary } = require('../scripts/ai.mjs');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ text: 'x'.repeat(501) }] })
    });

    const result = await generateAiSummary({ files_modified: [], prompts: [] });
    expect(result).toBeNull();
    rmSync(settingsDir, { recursive: true });
  });

  test('redacts secrets in AI response', async () => {
    const settingsDir = '/tmp/local-mem-ai-test-redact';
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      ai_summary: { enabled: true, api_key: 'sk-test' }
    }));
    process.env.LOCAL_MEM_SETTINGS_PATH = settingsPath;

    const { clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const { generateAiSummary } = require('../scripts/ai.mjs');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        content: [{ text: 'Configuró API key sk-ant-api03-secretvalue1234567890abcdefghij para el servicio.' }]
      })
    });

    const result = await generateAiSummary({ files_modified: [], prompts: [] });
    expect(result).not.toContain('sk-ant-api03');
    expect(result).toContain('[REDACTED]');
    rmSync(settingsDir, { recursive: true });
  });

  test('sends correct model and headers', async () => {
    const settingsDir = '/tmp/local-mem-ai-test-model';
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      ai_summary: { enabled: true, api_key: 'sk-test', model: 'claude-haiku-4-5-20251001' }
    }));
    process.env.LOCAL_MEM_SETTINGS_PATH = settingsPath;

    const { clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const { generateAiSummary } = require('../scripts/ai.mjs');

    let capturedBody = null;
    let capturedHeaders = null;
    globalThis.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      capturedHeaders = opts.headers;
      return {
        ok: true,
        json: async () => ({ content: [{ text: 'Resumen válido de al menos diez caracteres.' }] })
      };
    };

    await generateAiSummary({
      files_modified: ['test.ts'],
      prompts: ['Test prompt'],
      current_task: 'Testing',
      top_observations: ['Edit test.ts'],
    });

    expect(capturedBody.model).toBe('claude-haiku-4-5-20251001');
    expect(capturedBody.max_tokens).toBe(200);
    expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
    expect(capturedHeaders['x-api-key']).toBe('sk-test');
    rmSync(settingsDir, { recursive: true });
  });

  test('uses default model when not specified', async () => {
    const settingsDir = '/tmp/local-mem-ai-test-defmodel';
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      ai_summary: { enabled: true, api_key: 'sk-test' }
    }));
    process.env.LOCAL_MEM_SETTINGS_PATH = settingsPath;

    const { clearSettingsCache } = require('../scripts/settings.mjs');
    clearSettingsCache();
    const { generateAiSummary } = require('../scripts/ai.mjs');

    let capturedBody = null;
    globalThis.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({ content: [{ text: 'Resumen con modelo por defecto válido.' }] })
      };
    };

    await generateAiSummary({ files_modified: [], prompts: [] });
    expect(capturedBody.model).toBe('claude-haiku-4-5-20251001');
    rmSync(settingsDir, { recursive: true });
  });
});
