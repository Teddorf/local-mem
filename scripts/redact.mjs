import path from 'node:path';

const SECRET_PATTERNS = [
  // --- Cloud providers ---
  /sk-[a-zA-Z0-9_-]{20,}/g,                         // OpenAI / Anthropic API keys
  /AKIA[A-Z0-9]{16}/g,                               // AWS access key IDs
  /(?:AccountKey|SharedAccessKey)=[a-zA-Z0-9+\/=]{20,}/gi, // Azure connection strings
  /AIzaSy[a-zA-Z0-9_-]{33}/g,                        // Google Cloud API keys
  /ya29\.[a-zA-Z0-9_-]{50,}/g,                       // Google OAuth access tokens

  // --- Git platforms ---
  /ghp_[a-zA-Z0-9]{36,}/g,                           // GitHub personal access tokens
  /ghs_[a-zA-Z0-9]{36,}/g,                           // GitHub server tokens
  /github_pat_[a-zA-Z0-9_]{22,}/g,                   // GitHub fine-grained PATs
  /glpat-[a-zA-Z0-9_\-]{20,}/g,                      // GitLab personal access tokens

  // --- Payment / SaaS ---
  /[sr]k_live_[a-zA-Z0-9]{20,}/g,                    // Stripe secret/restricted keys
  /pk_live_[a-zA-Z0-9]{20,}/g,                       // Stripe publishable keys
  /SG\.[a-zA-Z0-9_\-]{22,}\.[a-zA-Z0-9_\-]{22,}/g,  // SendGrid API keys
  /xox[bpoas]-[a-zA-Z0-9\-]+/g,                      // Slack tokens
  /npm_[a-zA-Z0-9]{36,}/g,                           // npm access tokens
  /sbp_[a-zA-Z0-9]{40,}/g,                           // Supabase service role keys
  /vercel_[a-zA-Z0-9_-]{24,}/g,                      // Vercel tokens

  // --- Auth generics ---
  /Bearer\s+[a-zA-Z0-9._\-\/+=]{20,}/gi,             // Bearer tokens
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,      // JWT tokens
  /-----BEGIN\s+(RSA|DSA|EC|OPENSSH)?\s*PRIVATE KEY-----/g, // Private keys (PEM)

  // --- Assignments (generic catch-all) ---
  /password\s*[:=]\s*['"]?[^\s'"]{4,}/gi,             // password= or password:
  /(?:secret|token|api_key|apikey|access_key|api_secret)\s*[:=]\s*['"]?[^\s'"]{8,}/gi, // generic secret/token/api_key assignments
  /(?:mongodb|postgres|mysql|redis):\/\/[^\s]+/gi,     // Connection strings with credentials
];

const SENSITIVE_FILES = [
  '.env', '.env.local', '.env.production', '.env.staging',
  '.env.development', '.env.test',
  'credentials.json', 'credentials.yml', 'credentials.yaml',
  'secrets.json', 'secrets.yml', 'secrets.yaml',
  '.npmrc',
  'id_rsa', 'id_ed25519', 'id_ecdsa',
  'kubeconfig',
  'token.json',
];

export function isSensitiveFile(filePath) {
  const basename = path.basename(filePath);
  return SENSITIVE_FILES.includes(basename)
    || basename.startsWith('.env.')
    || basename.endsWith('.pem')
    || basename.endsWith('.key');
}

export function redact(text) {
  if (!text) return text;
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

export function redactObject(obj) {
  if (!obj) return obj;
  if (typeof obj === 'string') return redact(obj);
  if (Array.isArray(obj)) return obj.map(item => redactObject(item));
  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = redactObject(value);
    }
    return result;
  }
  return obj;
}

export function sanitizeXml(text) {
  if (!text) return text;
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function truncate(text, maxLen = 200) {
  if (!text || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}
