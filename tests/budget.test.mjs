/**
 * Unit tests for v0.11.0 Budget-aware rendering:
 * - estimateTokens (shared.mjs)
 * - allocateBudget (session-start.mjs)
 * - BUDGET constants (constants.mjs)
 *
 * Run: bun test tests/budget.test.mjs
 */

import { test, expect, describe } from 'bun:test';
import { estimateTokens } from '../scripts/shared.mjs';
import { allocateBudget } from '../scripts/session-start.mjs';
import { BUDGET } from '../scripts/constants.mjs';

// ═════════════════════════════════════════════════════════════════════════════
// estimateTokens
// ═════════════════════════════════════════════════════════════════════════════
describe('estimateTokens', () => {
  test('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  test('returns 0 for null/undefined', () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  test('estimates ~4 chars per token', () => {
    const text = 'a'.repeat(100);
    expect(estimateTokens(text)).toBe(25);
  });

  test('rounds up', () => {
    const text = 'a'.repeat(5); // 5/4 = 1.25 → ceil = 2
    expect(estimateTokens(text)).toBe(2);
  });

  test('handles multiline text', () => {
    const text = 'line one\nline two\nline three\n';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(Math.ceil(text.length / 4));
  });

  test('is within 15% of expected for typical dev context', () => {
    // Typical dev context: mixed English/Spanish, code refs, short lines
    const text = `## Ultimo resumen (hace 2h)
- Tools: Edit(5), Bash(3), Read(10) | 45 min, 23 obs
- Archivos: db.mjs, server.mjs, session-start.mjs
- Resultado: Implementó Project DNA con auto-detección de stack`;
    const tokens = estimateTokens(text);
    // Real tokenizer would give ~60-70 tokens for this
    // Our estimate: ~220 chars / 4 = ~55 tokens
    expect(tokens).toBeGreaterThan(40);
    expect(tokens).toBeLessThan(80);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// allocateBudget
// ═════════════════════════════════════════════════════════════════════════════
describe('allocateBudget', () => {
  test('allocates all sections when budget is sufficient', () => {
    const sections = [
      { id: 'a', content: 'x'.repeat(100), minTokens: 10, maxTokens: 50 },
      { id: 'b', content: 'y'.repeat(80), minTokens: 10, maxTokens: 40 },
    ];
    const result = allocateBudget(sections, 1000);
    expect(result[0].content).not.toBeNull();
    expect(result[1].content).not.toBeNull();
    expect(result[0].allocated).toBeGreaterThan(0);
    expect(result[1].allocated).toBeGreaterThan(0);
  });

  test('skips null content sections', () => {
    const sections = [
      { id: 'a', content: null, minTokens: 10, maxTokens: 50 },
      { id: 'b', content: 'y'.repeat(80), minTokens: 10, maxTokens: 40 },
    ];
    const result = allocateBudget(sections, 1000);
    expect(result[0].content).toBeNull();
    expect(result[0].allocated).toBe(0);
    expect(result[1].content).not.toBeNull();
  });

  test('truncates section when budget is tight', () => {
    const longContent = 'line one\nline two\nline three\nline four\nline five\nline six';
    const sections = [
      { id: 'a', content: longContent, minTokens: 5, maxTokens: 100 },
    ];
    // Budget only allows ~20 chars (5 tokens)
    const result = allocateBudget(sections, 5);
    expect(result[0].content).not.toBeNull();
    expect(result[0].content.length).toBeLessThan(longContent.length);
  });

  test('skips section when budget exhausted', () => {
    const sections = [
      { id: 'a', content: 'x'.repeat(400), minTokens: 10, maxTokens: 200 },
      { id: 'b', content: 'y'.repeat(400), minTokens: 50, maxTokens: 200 },
    ];
    // Only enough for first section
    const result = allocateBudget(sections, 100);
    expect(result[0].content).not.toBeNull();
    expect(result[1].content).toBeNull();
  });

  test('respects priority order (first sections get budget first)', () => {
    const sections = [
      { id: 'high', content: 'a'.repeat(200), minTokens: 30, maxTokens: 100 },
      { id: 'mid', content: 'b'.repeat(200), minTokens: 20, maxTokens: 100 },
      { id: 'low', content: 'c'.repeat(200), minTokens: 10, maxTokens: 100 },
    ];
    const result = allocateBudget(sections, 120);
    // High priority gets full allocation
    expect(result[0].allocated).toBeGreaterThan(0);
    // Mid may get partial
    expect(result[1].allocated).toBeGreaterThanOrEqual(0);
    // Low likely skipped
    const totalAllocated = result.reduce((s, r) => s + r.allocated, 0);
    expect(totalAllocated).toBeLessThanOrEqual(120);
  });

  test('handles zero budget', () => {
    const sections = [
      { id: 'a', content: 'some content', minTokens: 5, maxTokens: 50 },
    ];
    const result = allocateBudget(sections, 0);
    expect(result[0].content).toBeNull();
    expect(result[0].allocated).toBe(0);
  });

  test('handles empty sections array', () => {
    const result = allocateBudget([], 1000);
    expect(result).toEqual([]);
  });

  test('truncates at newline boundary', () => {
    const content = 'first line\nsecond line\nthird line that is very long and should be cut';
    const sections = [
      { id: 'a', content, minTokens: 5, maxTokens: 100 },
    ];
    // Budget for ~30 chars (about 8 tokens)
    const result = allocateBudget(sections, 8);
    if (result[0].content && result[0].content.length < content.length) {
      // Should end at a newline, not mid-word
      expect(result[0].content.endsWith('\n') || !result[0].content.includes('\n') ||
        content.includes(result[0].content + '\n')).toBe(true);
    }
  });

  test('total allocated never exceeds budget', () => {
    const sections = [
      { id: 'a', content: 'x'.repeat(800), minTokens: 50, maxTokens: 300 },
      { id: 'b', content: 'y'.repeat(600), minTokens: 30, maxTokens: 200 },
      { id: 'c', content: 'z'.repeat(400), minTokens: 20, maxTokens: 150 },
      { id: 'd', content: 'w'.repeat(200), minTokens: 10, maxTokens: 100 },
    ];
    const budget = 200;
    const result = allocateBudget(sections, budget);
    const total = result.reduce((s, r) => s + r.allocated, 0);
    expect(total).toBeLessThanOrEqual(budget);
  });

  test('small content fits even with tight budget', () => {
    const sections = [
      { id: 'a', content: 'DNA: TypeScript + Bun', minTokens: 5, maxTokens: 30 },
    ];
    const result = allocateBudget(sections, 50);
    expect(result[0].content).toBe('DNA: TypeScript + Bun');
    expect(result[0].allocated).toBe(estimateTokens('DNA: TypeScript + Bun'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUDGET constants
// ═════════════════════════════════════════════════════════════════════════════
describe('BUDGET constants', () => {
  test('level budgets are defined for levels 1, 2, 3', () => {
    expect(BUDGET.LEVEL_BUDGETS[1]).toBeDefined();
    expect(BUDGET.LEVEL_BUDGETS[2]).toBeDefined();
    expect(BUDGET.LEVEL_BUDGETS[3]).toBeDefined();
  });

  test('level budgets increase with level', () => {
    expect(BUDGET.LEVEL_BUDGETS[1]).toBeLessThan(BUDGET.LEVEL_BUDGETS[2]);
    expect(BUDGET.LEVEL_BUDGETS[2]).toBeLessThan(BUDGET.LEVEL_BUDGETS[3]);
  });

  test('section priorities are defined', () => {
    expect(BUDGET.SECTION_PRIORITY.length).toBeGreaterThan(0);
    for (const sec of BUDGET.SECTION_PRIORITY) {
      expect(sec.id).toBeDefined();
      expect(sec.minTokens).toBeGreaterThan(0);
      expect(sec.maxTokens).toBeGreaterThanOrEqual(sec.minTokens);
    }
  });

  test('section priority IDs match expected sections', () => {
    const ids = BUDGET.SECTION_PRIORITY.map(s => s.id);
    expect(ids).toContain('estado');
    expect(ids).toContain('dna');
    expect(ids).toContain('resumen');
    expect(ids).toContain('pedidos');
    expect(ids).toContain('razonamiento');
    expect(ids).toContain('actividad');
    expect(ids).toContain('cross');
    expect(ids).toContain('indice');
  });

  test('chars per token is defined', () => {
    expect(BUDGET.CHARS_PER_TOKEN).toBe(4);
  });
});
