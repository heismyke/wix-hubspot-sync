import { createHash } from 'node:crypto';
import pino from 'pino';

// Anything that could hold a secret or PII is redacted at the logger level,
// so a careless `log.info({ body })` still can't leak it.
const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.access_token',
  '*.refresh_token',
  '*.accessToken',
  '*.refreshToken',
  '*.token',
  '*.email',
  '*.phone',
  '*.firstname',
  '*.lastname',
  '*.properties',
  '*.info',
  '*.submissions',
];

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: REDACT, censor: '[redacted]' },
  base: { service: 'wix-hubspot-sync' },
});

/** Stable, non-reversible reference to an email for logs and joins. */
export function emailRef(email: string | null | undefined): string | null {
  if (!email) return null;
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}
