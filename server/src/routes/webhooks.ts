import express, { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { hmac, safeEqual } from '../lib/crypto.js';
import { errMessage, log } from '../lib/logger.js';
import { wixWebhooks } from '../wix/client.js';
import { disconnect } from '../hubspot/oauth.js';

export const webhooks = Router();

const isConnected = async (instanceId: string) =>
  ((await query('SELECT 1 FROM hubspot_connections WHERE instance_id = $1', [instanceId])).rowCount ?? 0) > 0;

/**
 * Wix → us. The body is a JWT signed with the app's key pair; the SDK verifies it against
 * WIX_PUBLIC_KEY. We only enqueue ids and answer 200 quickly; the worker does the API calls.
 */
webhooks.post('/webhooks/wix', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  let event;
  try {
    event = await wixWebhooks.webhooks.parseJWT(req.body as string);
  } catch (err) {
    log.warn({ err: errMessage(err) }, 'wix webhook rejected');
    return res.status(401).end();
  }
  const { eventType, instanceId } = event;
  const payload = (event.payload ?? {}) as { id?: string; entityId?: string; originatedFrom?: string };

  try {
    switch (eventType) {
      case 'wix.contacts.v4.contact_created':
      case 'wix.contacts.v4.contact_updated':
        if (payload.entityId && (await isConnected(instanceId))) await enqueue(instanceId, 'wix_contact', payload.entityId, `wix:${payload.id ?? `${payload.entityId}:${Date.now()}`}`);
        break;
      case 'wix.forms.v4.submission_created':
        if (payload.entityId && (await isConnected(instanceId))) await enqueue(instanceId, 'wix_submission', payload.entityId, `wix:${payload.id ?? payload.entityId}`);
        break;
      case 'AppRemoved':
      case 'wix.devcenter.apps.v1.app_instance_removed':
        await disconnect(instanceId);
        await query('DELETE FROM installations WHERE instance_id = $1', [instanceId]);
        break;
      default:
        log.debug({ eventType }, 'wix webhook ignored');
    }
    log.info({ eventType, instanceId, entityId: payload.entityId, originatedFrom: payload.originatedFrom }, 'wix webhook');
    res.status(200).end();
  } catch (err) {
    log.error({ eventType, err: errMessage(err) }, 'wix webhook handling failed');
    res.status(500).end(); // Wix retries
  }
});

/**
 * HubSpot v3 request signature:
 * base64(HMAC-SHA256(clientSecret, method + uri + body + timestamp)), timestamp ≤ 5 min old.
 */
export function verifyHubspotSignature(opts: { method: string; uri: string; body: string; timestamp: string; signature: string; secret: string; now?: number }) {
  const ts = Number(opts.timestamp);
  if (!Number.isFinite(ts) || Math.abs((opts.now ?? Date.now()) - ts) > 5 * 60_000) return false;
  const expected = hmac(opts.secret, `${opts.method}${opts.uri}${opts.body}${opts.timestamp}`, 'base64');
  return safeEqual(expected, opts.signature);
}

interface HubspotEvent {
  eventId: number;
  portalId: number;
  objectId: number;
  subscriptionType: string;
  propertyName?: string;
  changeSource?: string;
  occurredAt: number;
}

webhooks.post('/webhooks/hubspot', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const body = (req.body as Buffer).toString('utf8');
  const uri = decodeURIComponent(new URL(req.originalUrl, config.PUBLIC_BASE_URL).toString());
  const ok = verifyHubspotSignature({
    method: 'POST',
    uri,
    body,
    timestamp: req.header('x-hubspot-request-timestamp') ?? '',
    signature: req.header('x-hubspot-signature-v3') ?? '',
    secret: config.HUBSPOT_CLIENT_SECRET,
  });
  if (!ok) {
    log.warn('hubspot webhook rejected: bad signature');
    return res.status(401).end();
  }

  try {
    const events = JSON.parse(body) as HubspotEvent[];
    for (const e of events) {
      if (!['contact.creation', 'contact.propertyChange', 'contact.restore', 'contact.merge'].includes(e.subscriptionType)) continue;
      // One HubSpot portal may be connected to several Wix sites.
      const { rows } = await query<{ instance_id: string }>('SELECT instance_id FROM hubspot_connections WHERE portal_id = $1', [e.portalId]);
      for (const { instance_id } of rows) {
        await enqueue(instance_id, 'hubspot_contact', String(e.objectId), `hs:${e.eventId}`);
      }
    }
    log.info({ count: events.length }, 'hubspot webhook');
    res.status(200).end();
  } catch (err) {
    log.error({ err: errMessage(err) }, 'hubspot webhook handling failed');
    res.status(500).end();
  }
});
