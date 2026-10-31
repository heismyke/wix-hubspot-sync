import express, { Router } from 'express';
import { query } from '../db/pool.js';
import { attributionPayload, cleanUrl } from '../forms/attribution.js';
import { exchangeCode, readState, REDIRECT_PATH } from '../hubspot/oauth.js';
import { ensureAttributionProperties } from '../forms/attribution.js';
import { enqueue } from '../jobs/queue.js';
import { emailRef, errMessage, log } from '../lib/logger.js';
import { ensureInstallation, instanceForSiteKey } from '../sync/repo.js';
import { embedTrackingScript } from '../wix/client.js';

export const publicRoutes = Router();

/** Small fixed-window rate limiter for the unauthenticated beacon endpoint. */
const hits = new Map<string, { n: number; reset: number }>();
function rateLimited(key: string, limit = 30, windowMs = 60_000) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) {
    hits.set(key, { n: 1, reset: now + windowMs });
    if (hits.size > 10_000) hits.clear();
    return false;
  }
  return ++h.n > limit;
}

const page = (title: string, message: string, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;color:#162d3d}div{text-align:center}</style></head>
<body><div><h2>${title}</h2><p>${message}</p></div>${script}</body></html>`;

/** HubSpot redirects here after the user approves the app. */
publicRoutes.get(REDIRECT_PATH, async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  if (error || !code || !state) return res.status(400).send(page('Connection cancelled', 'You can close this window.'));
  try {
    const { instanceId } = readState(state);
    await exchangeCode(instanceId, code);
    ensureAttributionProperties(instanceId).catch((err) => log.warn({ err: errMessage(err) }, 'attribution properties setup failed'));
    ensureInstallation(instanceId)
      .then(({ siteKey }) => embedTrackingScript(instanceId, siteKey))
      .then((ok) => log.info({ instanceId, ok }, 'embedded script activation'))
      .catch((err) => log.warn({ err: errMessage(err) }, 'embedded script activation failed'));
    res.send(
      page(
        'HubSpot connected',
        'You can close this window.',
        `<script>try{window.opener&&window.opener.postMessage({type:'hubspot-connected'},'*')}catch(e){}setTimeout(function(){window.close()},800)</script>`,
      ),
    );
  } catch (err) {
    log.warn({ err: errMessage(err) }, 'hubspot oauth callback failed');
    res.status(400).send(page('Connection failed', 'Please close this window and try again from the Wix dashboard.'));
  }
});

/** Beacon from the site script: UTM/referrer context for a form submission about to happen. */
publicRoutes.options('/api/public/attribution', (_req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
  res.status(204).end();
});

publicRoutes.post('/api/public/attribution', express.text({ type: '*/*', limit: '16kb' }), async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (rateLimited(req.ip ?? 'unknown')) return res.status(429).end();
  let body: unknown;
  try {
    body = JSON.parse(req.body as string);
  } catch {
    return res.status(400).end();
  }
  const parsed = attributionPayload.safeParse(body);
  if (!parsed.success) return res.status(400).end();
  const instanceId = await instanceForSiteKey(parsed.data.siteKey);
  if (!instanceId) return res.status(404).end();

  // The email is only used to derive a one-way join key; it is not stored.
  const ref = emailRef(parsed.data.email)!;
  const { email: _e, siteKey: _s, ...rest } = parsed.data;
  const data = {
    ...rest,
    pageUrl: cleanUrl(rest.pageUrl),
    referrer: cleanUrl(rest.referrer),
    firstTouch: rest.firstTouch ? { ...rest.firstTouch, landingPage: cleanUrl(rest.firstTouch.landingPage), referrer: cleanUrl(rest.firstTouch.referrer) } : undefined,
  };
  await query('INSERT INTO attributions (instance_id, email_ref, data) VALUES ($1,$2,$3)', [instanceId, ref, JSON.stringify(data)]);

  // If the submission was already processed (webhook beat the beacon), patch it now.
  const late = await query<{ submission_id: string }>(
    `SELECT submission_id FROM form_events WHERE instance_id = $1 AND email_ref = $2 AND attribution IS NULL AND created_at > now() - interval '15 minutes'`,
    [instanceId, ref],
  );
  for (const r of late.rows) await enqueue(instanceId, 'apply_attribution', r.submission_id);
  res.status(204).end();
});
