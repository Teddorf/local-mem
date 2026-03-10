// Shared utilities between session-start.mjs and server.mjs

export function parseJsonSafe(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

export function formatTime(epochSeconds) {
  if (!epochSeconds) return '';
  const d = new Date(epochSeconds * 1000);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

export const CONFIDENCE_LABELS = {
  1: 'explorando, no se si funciona',
  2: 'implementado parcialmente, no testeado',
  3: 'implementado, tests pasan pero no revisado',
  4: 'tests pasan, revisado, falta probar manualmente',
  5: 'todo OK, listo para merge/deploy'
};

export const AUTO_SNAPSHOT_INTERVAL = 25;

/**
 * Estimate token count for a string (~4 chars per token for mixed content).
 * Accurate to ≤15% vs real tokenizer for typical dev context.
 */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
