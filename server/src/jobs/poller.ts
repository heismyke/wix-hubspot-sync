import { config } from '../config.js';
import { query } from '../db/pool.js';
import { HubspotClient } from '../hubspot/client.js';
import { errMessage, log } from '../lib/logger.js';
import { wixContactsUpdatedSince } from '../wix/contacts.js';
import { enqueue } from './queue.js';

/**
 * Reconciliation poll. Webhooks are the fast path; this catches anything they missed
 * (delivery failures, HubSpot properties without a propertyChange subscription, downtime).
 * Events produced by our own writes come back here too and are dropped by the fingerprint check.
 */
// The 5s overlap re-returns records at the cursor; remember what each poll already enqueued
// (side:instance:id → modified time) so an unchanged record isn't re-queued every interval.
const seen = new Map<string, number>();
function isNew(key: string, t: Date): boolean {
  const ms = t.getTime();
  if ((seen.get(key) ?? -1) >= ms) return false;
  seen.set(key, ms);
  if (seen.size > 50_000) seen.clear();
  return true;
}

async function pollOnce() {
  const { rows } = await query<{ instance_id: string; wix_poll_cursor: Date | null; hubspot_poll_cursor: Date | null }>(
    'SELECT instance_id, wix_poll_cursor, hubspot_poll_cursor FROM hubspot_connections',
  );
  for (const c of rows) {
    try {
      // Overlap the window slightly so clock skew can't drop an edit.
      const hsSince = new Date((c.hubspot_poll_cursor ?? new Date()).getTime() - 5000);
      const hsChanged = await new HubspotClient(c.instance_id).contactsModifiedSince(hsSince, ['lastmodifieddate']);
      let hsCursor = c.hubspot_poll_cursor ?? new Date();
      let hsQueued = 0;
      for (const contact of hsChanged) {
        const t = new Date(contact.properties.lastmodifieddate ?? contact.updatedAt);
        if (isNew(`hs:${c.instance_id}:${contact.id}`, t)) {
          await enqueue(c.instance_id, 'hubspot_contact', contact.id);
          hsQueued++;
        }
        if (t > hsCursor) hsCursor = t;
      }

      const wixSince = new Date((c.wix_poll_cursor ?? new Date()).getTime() - 5000);
      const wixChanged = await wixContactsUpdatedSince(c.instance_id, wixSince);
      let wixCursor = c.wix_poll_cursor ?? new Date();
      let wixQueued = 0;
      for (const contact of wixChanged) {
        const t = contact._updatedDate ? new Date(contact._updatedDate) : wixCursor;
        if (isNew(`wix:${c.instance_id}:${contact._id}`, t)) {
          await enqueue(c.instance_id, 'wix_contact', contact._id!);
          wixQueued++;
        }
        if (t > wixCursor) wixCursor = t;
      }

      await query('UPDATE hubspot_connections SET hubspot_poll_cursor = $2, wix_poll_cursor = $3 WHERE instance_id = $1', [c.instance_id, hsCursor, wixCursor]);
      if (hsQueued || wixQueued) log.info({ instanceId: c.instance_id, hubspot: hsQueued, wix: wixQueued }, 'poll enqueued');
    } catch (err) {
      log.warn({ instanceId: c.instance_id, err: errMessage(err) }, 'poll failed');
    }
  }
}

export function startPoller(): () => void {
  if (!config.POLL_INTERVAL_SECONDS) return () => {};
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce();
    } finally {
      running = false;
    }
  }, config.POLL_INTERVAL_SECONDS * 1000);
  return () => clearInterval(timer);
}
