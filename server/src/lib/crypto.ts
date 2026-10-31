import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url parts). */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(payload: string, key: Buffer): string {
  const [version, iv, tag, ct] = payload.split('.');
  if (version !== VERSION || !iv || !tag || !ct) throw new Error('Unsupported ciphertext format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

export function hmac(secret: string | Buffer, data: string, encoding: 'base64' | 'base64url' | 'hex' = 'base64url'): string {
  return createHmac('sha256', secret).update(data).digest(encoding);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Short-lived signed blob, used for the OAuth `state` parameter. */
export function signState(data: Record<string, unknown>, secret: Buffer, ttlSeconds = 600): string {
  const body = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + ttlSeconds * 1000, n: randomBytes(8).toString('hex') })).toString('base64url');
  return `${body}.${hmac(secret, body)}`;
}

export function verifyState<T>(state: string, secret: Buffer): T {
  const [body, sig] = state.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(secret, body))) throw new Error('Invalid state signature');
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (typeof data.exp !== 'number' || data.exp < Date.now()) throw new Error('State expired');
  return data as T;
}
