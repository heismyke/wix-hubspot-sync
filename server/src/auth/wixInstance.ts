import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { hmac, safeEqual } from '../lib/crypto.js';

export interface WixInstance {
  instanceId: string;
  signDate?: string;
  permissions?: string;
  siteOwnerId?: string;
}

/**
 * Wix appends `?instance=<signature>.<payload>` to a self-hosted dashboard page URL.
 * The signature is HMAC-SHA256(appSecret, payload), base64url. Verifying it proves the
 * request comes from a dashboard of a site that installed this app, without trusting
 * anything the browser says about itself.
 */
export function verifyWixInstance(token: string, appSecret = config.WIX_APP_SECRET, maxAgeHours = config.WIX_INSTANCE_MAX_AGE_HOURS): WixInstance {
  const [signature, payload] = token.split('.');
  if (!signature || !payload) throw new Error('Malformed instance');
  const expected = hmac(appSecret, payload, 'base64url');
  if (!safeEqual(signature.replace(/=+$/, ''), expected)) throw new Error('Bad instance signature');

  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as WixInstance;
  if (!data.instanceId) throw new Error('Instance has no instanceId');
  if (data.signDate) {
    const age = Date.now() - new Date(data.signDate).getTime();
    if (age > maxAgeHours * 3600_000) throw new Error('Instance expired');
  }
  return data;
}

declare module 'express-serve-static-core' {
  interface Request {
    wix?: WixInstance;
  }
}

/** Guards every dashboard/sync API route. Expects `Authorization: Instance <token>`. */
export function requireWixInstance(req: Request, res: Response, next: NextFunction) {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Instance ') ? header.slice('Instance '.length).trim() : '';
  if (!token) return res.status(401).json({ error: 'missing_instance' });
  try {
    req.wix = verifyWixInstance(token);
    next();
  } catch {
    res.status(401).json({ error: 'invalid_instance' });
  }
}
