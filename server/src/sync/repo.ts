import { randomBytes } from 'node:crypto';
import { one, pool, query } from '../db/pool.js';
import { DEFAULT_MAPPINGS, type FieldMapping } from './fields.js';

export async function ensureInstallation(instanceId: string): Promise<{ siteKey: string }> {
  const row = await one<{ site_key: string }>(
    `INSERT INTO installations (instance_id, site_key) VALUES ($1, $2)
     ON CONFLICT (instance_id) DO UPDATE SET instance_id = EXCLUDED.instance_id
     RETURNING site_key`,
    [instanceId, randomBytes(12).toString('base64url')],
  );
  return { siteKey: row!.site_key };
}

export async function instanceForSiteKey(siteKey: string): Promise<string | null> {
  const row = await one<{ instance_id: string }>('SELECT instance_id FROM installations WHERE site_key = $1', [siteKey]);
  return row?.instance_id ?? null;
}

export async function getMappings(instanceId: string): Promise<FieldMapping[]> {
  const res = await query(
    'SELECT id, wix_field, hubspot_property, direction, transform FROM field_mappings WHERE instance_id = $1 ORDER BY position',
    [instanceId],
  );
  if (res.rowCount === 0) return DEFAULT_MAPPINGS;
  return res.rows.map((r) => ({
    id: r.id,
    wixField: r.wix_field,
    hubspotProperty: r.hubspot_property,
    direction: r.direction,
    transform: r.transform,
  }));
}

export async function saveMappings(instanceId: string, mappings: FieldMapping[]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM field_mappings WHERE instance_id = $1', [instanceId]);
    for (const [i, m] of mappings.entries()) {
      await client.query(
        'INSERT INTO field_mappings (instance_id, position, wix_field, hubspot_property, direction, transform) VALUES ($1,$2,$3,$4,$5,$6)',
        [instanceId, i, m.wixField, m.hubspotProperty, m.direction, m.transform],
      );
    }
    // Fingerprints were computed with the old mapping; clear them so the next event
    // re-evaluates every linked contact under the new rules instead of being skipped.
    await client.query('UPDATE contact_links SET wix_hash = NULL, hubspot_hash = NULL WHERE instance_id = $1', [instanceId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface ContactLink {
  wix_contact_id: string;
  hubspot_contact_id: string;
  wix_hash: string | null;
  hubspot_hash: string | null;
  last_sync_source: string | null;
  last_synced_at: Date;
}

export function linkByWix(instanceId: string, wixId: string) {
  return one<ContactLink>('SELECT * FROM contact_links WHERE instance_id = $1 AND wix_contact_id = $2', [instanceId, wixId]);
}

export function linkByHubspot(instanceId: string, hsId: string) {
  return one<ContactLink>('SELECT * FROM contact_links WHERE instance_id = $1 AND hubspot_contact_id = $2', [instanceId, hsId]);
}

export async function saveLink(
  instanceId: string,
  l: { wixId: string; hubspotId: string; wixHash: string; hubspotHash: string; source: 'wix' | 'hubspot' | 'form'; syncId: string },
) {
  // A contact can only be linked once on each side; drop any stale pairing first.
  await query(
    'DELETE FROM contact_links WHERE instance_id = $1 AND ((wix_contact_id = $2 AND hubspot_contact_id <> $3) OR (hubspot_contact_id = $3 AND wix_contact_id <> $2))',
    [instanceId, l.wixId, l.hubspotId],
  );
  await query(
    `INSERT INTO contact_links (instance_id, wix_contact_id, hubspot_contact_id, wix_hash, hubspot_hash, last_sync_source, last_sync_id, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (instance_id, wix_contact_id) DO UPDATE SET
       hubspot_contact_id = EXCLUDED.hubspot_contact_id, wix_hash = EXCLUDED.wix_hash, hubspot_hash = EXCLUDED.hubspot_hash,
       last_sync_source = EXCLUDED.last_sync_source, last_sync_id = EXCLUDED.last_sync_id, last_synced_at = now()`,
    [instanceId, l.wixId, l.hubspotId, l.wixHash, l.hubspotHash, l.source, l.syncId],
  );
}

export function dropLink(instanceId: string, wixId: string) {
  return query('DELETE FROM contact_links WHERE instance_id = $1 AND wix_contact_id = $2', [instanceId, wixId]);
}

export async function logSync(
  instanceId: string,
  e: { source: string; action: string; wixId?: string | null; hubspotId?: string | null; syncId?: string; detail?: string },
) {
  await query(
    'INSERT INTO sync_log (instance_id, source, action, wix_contact_id, hubspot_contact_id, sync_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [instanceId, e.source, e.action, e.wixId ?? null, e.hubspotId ?? null, e.syncId ?? null, e.detail ?? null],
  );
}
