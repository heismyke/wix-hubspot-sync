import express, { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { requireWixInstance } from '../auth/wixInstance.js';
import { HubspotClient } from '../hubspot/client.js';
import { buildAuthorizeUrl, disconnect } from '../hubspot/oauth.js';
import { enqueue } from '../jobs/queue.js';
import { errMessage, log } from '../lib/logger.js';
import { STANDARD_WIX_FIELDS, validateMappings, type FieldMapping } from '../sync/fields.js';
import { ensureInstallation, getMappings, saveMappings } from '../sync/repo.js';
import { listWixCustomFields, wixContactsUpdatedSince } from '../wix/contacts.js';

/** Dashboard API. Every route requires a valid signed Wix instance; tokens never leave the server. */
export const api = Router();
api.use('/api', express.json({ limit: '100kb' }));
api.use('/api', (req, res, next) => (req.path.startsWith('/public/') ? next('router') : requireWixInstance(req, res, next)));

const id = (req: express.Request) => req.wix!.instanceId;

api.get('/api/status', async (req, res) => {
  const { siteKey } = await ensureInstallation(id(req));
  const conn = await one('SELECT portal_id, hub_domain, scopes, connected_at FROM hubspot_connections WHERE instance_id = $1', [id(req)]);
  res.json({
    connected: !!conn,
    hubspot: conn ? { portalId: conn.portal_id, hubDomain: conn.hub_domain, scopes: conn.scopes, connectedAt: conn.connected_at } : null,
    siteKey,
    trackingSnippet: `<script src="${config.PUBLIC_BASE_URL}/utm.js" data-site-key="${siteKey}" async></script>`,
  });
});

api.post('/api/hubspot/connect', async (req, res) => {
  await ensureInstallation(id(req));
  res.json({ url: buildAuthorizeUrl(id(req)) });
});

api.post('/api/hubspot/disconnect', async (req, res) => {
  await disconnect(id(req));
  res.json({ connected: false });
});

api.get('/api/fields', async (req, res) => {
  let custom: Array<{ key: string; label: string }> = [];
  try {
    custom = await listWixCustomFields(id(req));
  } catch (err) {
    log.warn({ err: errMessage(err) }, 'could not load Wix custom fields');
  }
  let hubspotProperties: Array<{ name: string; label: string; group: string }> = [];
  const connected = await one('SELECT 1 FROM hubspot_connections WHERE instance_id = $1', [id(req)]);
  if (connected) {
    const props = await new HubspotClient(id(req)).listContactProperties();
    hubspotProperties = props
      .filter((p) => !p.hidden && !p.calculated && !p.modificationMetadata?.readOnlyValue && !p.name.startsWith('wix_'))
      .map((p) => ({ name: p.name, label: p.label, group: p.groupName }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  res.json({ wixFields: [...STANDARD_WIX_FIELDS, ...custom], hubspotProperties });
});

api.get('/api/mappings', async (req, res) => {
  res.json({ mappings: await getMappings(id(req)) });
});

const mappingSchema = z.object({
  mappings: z
    .array(
      z.object({
        wixField: z.string().min(1).max(200),
        hubspotProperty: z.string().min(1).max(200),
        direction: z.enum(['wix_to_hubspot', 'hubspot_to_wix', 'bidirectional']),
        transform: z.enum(['none', 'trim', 'lowercase', 'uppercase']).default('none'),
      }),
    )
    .min(1)
    .max(100),
});

api.put('/api/mappings', async (req, res) => {
  const parsed = mappingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const mappings = parsed.data.mappings as FieldMapping[];
  const errors = validateMappings(mappings);
  if (errors.length) return res.status(400).json({ errors });
  await ensureInstallation(id(req));
  await saveMappings(id(req), mappings);
  res.json({ mappings: await getMappings(id(req)) });
});

api.get('/api/activity', async (req, res) => {
  const { rows } = await query(
    'SELECT at, source, action, wix_contact_id, hubspot_contact_id, sync_id, detail FROM sync_log WHERE instance_id = $1 ORDER BY at DESC LIMIT 50',
    [id(req)],
  );
  const stats = await one(
    `SELECT
       (SELECT count(*) FROM contact_links WHERE instance_id = $1)::int AS linked,
       (SELECT count(*) FROM form_events WHERE instance_id = $1)::int AS submissions,
       (SELECT count(*) FROM jobs WHERE instance_id = $1 AND status = 'pending')::int AS pending,
       (SELECT count(*) FROM jobs WHERE instance_id = $1 AND status = 'failed' AND created_at > now() - interval '1 day')::int AS failed`,
    [id(req)],
  );
  res.json({ events: rows, stats });
});

/** Initial sync of existing contacts (Wix side; HubSpot-only contacts arrive via webhooks/poll). */
api.post('/api/sync/backfill', async (req, res) => {
  const connected = await one('SELECT 1 FROM hubspot_connections WHERE instance_id = $1', [id(req)]);
  if (!connected) return res.status(409).json({ error: 'not_connected' });
  const contacts = await wixContactsUpdatedSince(id(req), new Date(0), 1000);
  for (const c of contacts) await enqueue(id(req), 'wix_contact', c._id!);
  res.json({ enqueued: contacts.length });
});
