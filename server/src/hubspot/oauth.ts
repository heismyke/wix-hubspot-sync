import { config, HUBSPOT_SCOPES } from '../config.js';
import { one, query } from '../db/pool.js';
import { signState, verifyState } from '../lib/crypto.js';
import { log } from '../lib/logger.js';
import { KeyedMutex } from '../lib/mutex.js';
import { masterKey, secretStore } from '../lib/secretStore.js';

const HUBSPOT_API = 'https://api.hubapi.com';
export const REDIRECT_PATH = '/oauth/hubspot/callback';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export class NotConnectedError extends Error {
  constructor() {
    super('HubSpot is not connected for this site');
  }
}

function redirectUri() {
  return new URL(REDIRECT_PATH, config.PUBLIC_BASE_URL).toString();
}

export function buildAuthorizeUrl(instanceId: string): string {
  const url = new URL('https://app.hubspot.com/oauth/authorize');
  url.searchParams.set('client_id', config.HUBSPOT_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', HUBSPOT_SCOPES.join(' '));
  // State binds the callback to the Wix site that started the flow (CSRF + instance binding).
  url.searchParams.set('state', signState({ instanceId }, masterKey));
  return url.toString();
}

export function readState(state: string): { instanceId: string } {
  return verifyState<{ instanceId: string }>(state, masterKey);
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${HUBSPOT_API}/oauth/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.HUBSPOT_CLIENT_ID,
      client_secret: config.HUBSPOT_CLIENT_SECRET,
      ...params,
    }),
  });
  if (!res.ok) {
    // HubSpot error bodies don't contain tokens, but keep only the status/category.
    const body = (await res.json().catch(() => ({}))) as { status?: string; message?: string };
    throw new Error(`HubSpot token request failed: ${res.status} ${body.status ?? ''}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function exchangeCode(instanceId: string, code: string) {
  const tokens = await tokenRequest({ grant_type: 'authorization_code', redirect_uri: redirectUri(), code });

  const infoRes = await fetch(`${HUBSPOT_API}/oauth/v1/access-tokens/${encodeURIComponent(tokens.access_token)}`);
  if (!infoRes.ok) throw new Error(`HubSpot token info failed: ${infoRes.status}`);
  const info = (await infoRes.json()) as { hub_id: number; hub_domain?: string; scopes?: string[] };

  await query(
    `INSERT INTO hubspot_connections (instance_id, portal_id, hub_domain, scopes, access_token_enc, refresh_token_enc, expires_at, hubspot_poll_cursor, wix_poll_cursor)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7), now(), now())
     ON CONFLICT (instance_id) DO UPDATE SET
       portal_id = EXCLUDED.portal_id, hub_domain = EXCLUDED.hub_domain, scopes = EXCLUDED.scopes,
       access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
       expires_at = EXCLUDED.expires_at, connected_at = now(),
       hubspot_poll_cursor = now(), wix_poll_cursor = now()`,
    [
      instanceId,
      info.hub_id,
      info.hub_domain ?? null,
      info.scopes ?? [],
      await secretStore.seal(tokens.access_token),
      await secretStore.seal(tokens.refresh_token),
      tokens.expires_in,
    ],
  );
  log.info({ instanceId, portalId: info.hub_id }, 'hubspot connected');
  return { portalId: info.hub_id, hubDomain: info.hub_domain };
}

const refreshLock = new KeyedMutex();

/**
 * Returns a valid access token, rotating it with the refresh token when it is within
 * 2 minutes of expiry. Concurrent callers for the same site share a single refresh.
 */
export async function getAccessToken(instanceId: string, { force = false } = {}): Promise<string> {
  return refreshLock.run(instanceId, async () => {
    const row = await one<{ access_token_enc: string; refresh_token_enc: string; expires_at: Date }>(
      'SELECT access_token_enc, refresh_token_enc, expires_at FROM hubspot_connections WHERE instance_id = $1',
      [instanceId],
    );
    if (!row) throw new NotConnectedError();

    if (!force && row.expires_at.getTime() - Date.now() > 120_000) {
      return secretStore.open(row.access_token_enc);
    }

    const refreshToken = await secretStore.open(row.refresh_token_enc);
    const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    await query(
      `UPDATE hubspot_connections SET access_token_enc = $2, refresh_token_enc = $3, expires_at = now() + make_interval(secs => $4)
       WHERE instance_id = $1`,
      [instanceId, await secretStore.seal(tokens.access_token), await secretStore.seal(tokens.refresh_token), tokens.expires_in],
    );
    log.info({ instanceId }, 'hubspot token refreshed');
    return tokens.access_token;
  });
}

export async function disconnect(instanceId: string) {
  const row = await one<{ refresh_token_enc: string }>('SELECT refresh_token_enc FROM hubspot_connections WHERE instance_id = $1', [instanceId]);
  if (!row) return;
  try {
    const refreshToken = await secretStore.open(row.refresh_token_enc);
    await fetch(`${HUBSPOT_API}/oauth/v1/refresh-tokens/${encodeURIComponent(refreshToken)}`, { method: 'DELETE' });
  } catch (err) {
    // Revocation is best-effort; the local credentials are deleted regardless.
    log.warn({ instanceId, err: (err as Error).message }, 'hubspot token revoke failed');
  }
  await query('DELETE FROM hubspot_connections WHERE instance_id = $1', [instanceId]);
  await query("UPDATE jobs SET status = 'failed', last_error = 'disconnected' WHERE instance_id = $1 AND status = 'pending'", [instanceId]);
  log.info({ instanceId }, 'hubspot disconnected');
}
