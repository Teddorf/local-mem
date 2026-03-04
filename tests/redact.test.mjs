import { test, expect, describe } from 'bun:test';
import { redact, redactObject, sanitizeXml, truncate, isSensitiveFile } from '../scripts/redact.mjs';

describe('SECRET_PATTERNS', () => {
  const cases = [
    ['OpenAI/Anthropic sk-', 'sk-abcdefghijklmnopqrst1234', 'hello world'],
    ['AWS AKIA', 'AKIAIOSFODNN7EXAMPLE', 'AKIAFAKE'],
    ['Azure AccountKey', 'AccountKey=abcdefghijklmnopqrstuvwxyz12345', 'AccountKey=short'],
    ['Google Cloud AIzaSy', 'AIzaSyabcdefghijklmnopqrstuvwxyz1234567', 'AIzaSy123'],
    ['Google OAuth ya29', 'ya29.' + 'a'.repeat(55), 'ya29.short'],
    ['GitHub ghp_', 'ghp_' + 'a'.repeat(36), 'ghp_short'],
    ['GitHub ghs_', 'ghs_' + 'a'.repeat(36), 'ghs_short'],
    ['GitHub fine-grained PAT', 'github_pat_' + 'a'.repeat(22), 'github_pat_short'],
    ['GitLab glpat-', 'glpat-' + 'a'.repeat(20), 'glpat-short'],
    ['Stripe sk_live_', 'sk_live_' + 'a'.repeat(20), 'sk_live_short'],
    ['Stripe pk_live_', 'pk_live_' + 'a'.repeat(20), 'pk_live_short'],
    ['SendGrid SG.', 'SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(22), 'SG.short.x'],
    ['Slack xoxb-', 'xoxb-abc123-def456-ghijklmnop', 'xoxz-invalid'],
    ['npm token', 'npm_' + 'a'.repeat(36), 'npm_short'],
    ['Supabase sbp_', 'sbp_' + 'a'.repeat(40), 'sbp_short'],
    ['Vercel token', 'vercel_' + 'a'.repeat(24), 'vercel_short'],
    ['Bearer token', 'Bearer abcdefghijklmnopqrstuvwxyz', 'Bearer short'],
    ['JWT eyJ', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0', 'eyJshort.x'],
    ['PEM private key', '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN PUBLIC KEY-----'],
    ['password=', 'password=supersecret123', 'password= '],
    ['generic secret=', 'secret=mysupersecretvalue', 'secret=short'],
    ['connection string', 'mongodb://user:pass@host:27017/db', 'text without db url'],
  ];

  for (const [name, match, noMatch] of cases) {
    test(`detects ${name}`, () => {
      expect(redact(match)).toBe('[REDACTED]');
    });
    test(`no false positive: ${name}`, () => {
      expect(redact(noMatch)).toBe(noMatch);
    });
  }
});

describe('redact()', () => {
  test('texto sin secrets pasa sin modificacion', () => {
    expect(redact('hello world')).toBe('hello world');
  });
  test('null retorna null', () => {
    expect(redact(null)).toBeNull();
  });
  test('undefined retorna undefined', () => {
    expect(redact(undefined)).toBeUndefined();
  });
  test('empty string retorna empty string', () => {
    expect(redact('')).toBe('');
  });
  test('multiples secrets redactados', () => {
    const text = 'key: sk-abcdefghijklmnopqrst1234 token: ghp_' + 'a'.repeat(36);
    const result = redact(text);
    expect(result).not.toContain('sk-');
    expect(result).not.toContain('ghp_');
    expect(result).toContain('[REDACTED]');
  });
});

describe('redactObject()', () => {
  test('string → redacta', () => {
    expect(redactObject('sk-abcdefghijklmnopqrst1234')).toBe('[REDACTED]');
  });
  test('array de strings → redacta cada uno', () => {
    const result = redactObject(['hello', 'sk-abcdefghijklmnopqrst1234']);
    expect(result[0]).toBe('hello');
    expect(result[1]).toBe('[REDACTED]');
  });
  test('object con strings → redacta valores', () => {
    const result = redactObject({ a: 'hello', b: 'sk-abcdefghijklmnopqrst1234' });
    expect(result.a).toBe('hello');
    expect(result.b).toBe('[REDACTED]');
  });
  test('nested objects/arrays → recursivo', () => {
    const result = redactObject({ nested: { arr: ['sk-abcdefghijklmnopqrst1234'] } });
    expect(result.nested.arr[0]).toBe('[REDACTED]');
  });
  test('null → null', () => {
    expect(redactObject(null)).toBeNull();
  });
  test('non-string primitives → sin cambio', () => {
    expect(redactObject(42)).toBe(42);
    expect(redactObject(true)).toBe(true);
  });
});

describe('sanitizeXml()', () => {
  test('& → &amp;', () => expect(sanitizeXml('a&b')).toBe('a&amp;b'));
  test('< → &lt;', () => expect(sanitizeXml('a<b')).toBe('a&lt;b'));
  test('> → &gt;', () => expect(sanitizeXml('a>b')).toBe('a&gt;b'));
  test('combinacion', () => expect(sanitizeXml('</tag>&value')).toBe('&lt;/tag&gt;&amp;value'));
  test('null → null', () => expect(sanitizeXml(null)).toBeNull());
});

describe('truncate()', () => {
  test('texto corto → sin cambio', () => expect(truncate('hello')).toBe('hello'));
  test('texto largo → truncado con ...', () => {
    const text = 'a'.repeat(300);
    expect(truncate(text)).toBe('a'.repeat(200) + '...');
  });
  test('default 200 chars', () => {
    const text = 'a'.repeat(201);
    expect(truncate(text).length).toBe(203);
  });
  test('custom maxLen', () => {
    expect(truncate('abcdef', 3)).toBe('abc...');
  });
});

describe('isSensitiveFile()', () => {
  test('.env → true', () => expect(isSensitiveFile('.env')).toBe(true));
  test('.env.local → true', () => expect(isSensitiveFile('.env.local')).toBe(true));
  test('.env.production → true', () => expect(isSensitiveFile('.env.production')).toBe(true));
  test('.env.development → true', () => expect(isSensitiveFile('.env.development')).toBe(true));
  test('.env.custom.local → true', () => expect(isSensitiveFile('.env.custom.local')).toBe(true));
  test('credentials.json → true', () => expect(isSensitiveFile('credentials.json')).toBe(true));
  test('id_rsa → true', () => expect(isSensitiveFile('id_rsa')).toBe(true));
  test('file.pem → true', () => expect(isSensitiveFile('file.pem')).toBe(true));
  test('file.key → true', () => expect(isSensitiveFile('file.key')).toBe(true));
  test('normal.js → false', () => expect(isSensitiveFile('normal.js')).toBe(false));
  test('.environment → false', () => expect(isSensitiveFile('.environment')).toBe(false));
});
