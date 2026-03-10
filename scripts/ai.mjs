import { redact } from './redact.mjs';
import { loadSettings } from './settings.mjs';
import { AI } from './constants.mjs';

/**
 * Genera un resumen semántico de la sesión usando la API de Claude.
 * Retorna null si AI no está habilitado, falta API key, o hay cualquier error.
 *
 * @param {{ files_modified: string[], prompts: string[], current_task: string|null, top_observations: string[] }} context
 * @returns {Promise<string|null>}
 */
export async function generateAiSummary(context) {
  try {
    const settings = loadSettings();

    if (!settings.ai_summary?.enabled) return null;

    // API key: settings o variable de entorno
    const apiKey = settings.ai_summary.api_key || process.env.LOCAL_MEM_AI_KEY;
    if (!apiKey) return null;

    const { files_modified = [], prompts = [], current_task = null, top_observations = [] } = context;

    const prompt = [
      'Resume esta sesión de desarrollo en 2-3 frases concisas en español.',
      'Enfócate en QUÉ se hizo y POR QUÉ, no en herramientas usadas.',
      '',
      `Archivos modificados: ${files_modified.join(', ')}`,
      `Últimos pedidos del usuario: ${prompts.join(' | ')}`,
      `Tarea actual: ${current_task || '(no definida)'}`,
      `Acciones principales: ${top_observations.join(' | ')}`,
      '',
      'Responde SOLO con el resumen, sin preámbulos.',
    ].join('\n');

    const model = settings.ai_summary.model || AI.DEFAULT_MODEL;
    const timeoutMs = settings.ai_summary.timeout_ms || AI.DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(AI.API_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': AI.API_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: AI.MAX_TOKENS,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      process.stderr.write(`[local-mem] AI summary request failed: HTTP ${res.status}\n`);
      return null;
    }

    const data = await res.json();
    const text = data?.content?.[0]?.text;

    if (!text || text.length < AI.RESPONSE_MIN_LENGTH || text.length > AI.RESPONSE_MAX_LENGTH) return null;

    return redact(text);
  } catch (err) {
    process.stderr.write(`[local-mem] AI summary error: ${err.message}\n`);
    return null;
  }
}
