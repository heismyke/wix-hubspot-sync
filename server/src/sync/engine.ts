import { randomUUID } from 'node:crypto';
import type { HubspotClient, HubspotContact } from '../hubspot/client.js';
import { emailRef, log } from '../lib/logger.js';
import {
  applyTransform,
  buildWixInfoPatch,
  canonical,
  fingerprint,
  hubspotSnapshot,
  hubspotToWix,
  readWixField,
  wixSnapshot,
  wixToHubspot,
  type FieldMapping,
  type WixContactLike,
} from './fields.js';
import { dropLink, linkByHubspot, linkByWix, logSync, saveLink, type ContactLink } from './repo.js';

/**
 * The Wix operations the engine needs. Production wires these to the Wix SDK; tests use
 * an in-memory fake, which is how the loop-prevention rules are verified end to end.
 */
export interface WixContacts {
  get(id: string): Promise<WixContactLike | null>;
  findByEmail(email: string): Promise<WixContactLike | null>;
  create(info: Record<string, any>): Promise<WixContactLike>;
  update(id: string, info: Record<string, any>, revision: number): Promise<WixContactLike>;
}

export interface SyncContext {
  instanceId: string;
  mappings: FieldMapping[];
  hubspot: Pick<HubspotClient, 'getContact' | 'findContactByEmail' | 'createContact' | 'updateContact'>;
  wix: WixContacts;
}

const time = (v: Date | string | null | undefined) => (v ? new Date(v).getTime() : 0);

function hubspotProps(mappings: FieldMapping[]) {
  return [...new Set(['email', 'lastmodifieddate', ...mappings.map((m) => m.hubspotProperty)])];
}

/** Entry point for a Wix contact create/update (webhook or poll). */
export async function syncFromWix(ctx: SyncContext, wixId: string): Promise<string> {
  const { instanceId, mappings } = ctx;
  const syncId = randomUUID();
  const wixContact = await ctx.wix.get(wixId);
  if (!wixContact) return 'wix_contact_missing';

  const wixHash = fingerprint(wixSnapshot(wixContact, mappings));
  let link = await linkByWix(instanceId, wixId);

  // Loop prevention + idempotency: the mapped values are exactly what we last synced
  // (typically the echo of our own write) → nothing to do.
  if (link && link.wix_hash === wixHash) {
    await logSync(instanceId, { source: 'wix', action: 'skipped_no_change', wixId, hubspotId: link.hubspot_contact_id, syncId });
    return 'skipped_no_change';
  }

  const props = hubspotProps(mappings);
  let hs: HubspotContact | null = null;
  if (link) {
    hs = await ctx.hubspot.getContact(link.hubspot_contact_id, props);
    if (!hs) {
      await dropLink(instanceId, wixId);
      link = null;
    }
  }
  if (!hs) {
    const email = readWixField(wixContact, 'email');
    if (!email) {
      await logSync(instanceId, { source: 'wix', action: 'skipped_no_email', wixId, syncId });
      return 'skipped_no_email';
    }
    hs = await ctx.hubspot.findContactByEmail(email, props);
  }

  // Conflict rule: last updated wins. HubSpot only "wins" if it holds mapped changes we
  // haven't synced yet AND those are newer than the Wix edit.
  if (hs && hubspotHasUnsyncedChanges(hs, link, mappings) && time(hs.updatedAt) > time(wixContact._updatedDate)) {
    await logSync(instanceId, { source: 'wix', action: 'conflict_hubspot_newer', wixId, hubspotId: hs.id, syncId });
    return pushHubspotToWix(ctx, hs, wixContact, syncId, !link);
  }
  return pushWixToHubspot(ctx, wixContact, hs, syncId, !link);
}

/** Entry point for a HubSpot contact create/update (webhook or poll). */
export async function syncFromHubspot(ctx: SyncContext, hubspotId: string): Promise<string> {
  const { instanceId, mappings } = ctx;
  const syncId = randomUUID();
  const hs = await ctx.hubspot.getContact(hubspotId, hubspotProps(mappings));
  if (!hs) return 'hubspot_contact_missing';

  const hsHash = fingerprint(hubspotSnapshot(hs.properties, mappings));
  let link = await linkByHubspot(instanceId, hubspotId);
  if (link && link.hubspot_hash === hsHash) {
    await logSync(instanceId, { source: 'hubspot', action: 'skipped_no_change', wixId: link.wix_contact_id, hubspotId, syncId });
    return 'skipped_no_change';
  }

  let wixContact: WixContactLike | null = null;
  if (link) {
    wixContact = await ctx.wix.get(link.wix_contact_id);
    if (!wixContact) {
      await dropLink(instanceId, link.wix_contact_id);
      link = null;
    }
  }
  if (!wixContact) {
    const email = hs.properties.email;
    if (!email) {
      await logSync(instanceId, { source: 'hubspot', action: 'skipped_no_email', hubspotId, syncId });
      return 'skipped_no_email';
    }
    wixContact = await ctx.wix.findByEmail(email);
  }

  if (wixContact && wixHasUnsyncedChanges(wixContact, link, mappings) && time(wixContact._updatedDate) > time(hs.updatedAt)) {
    await logSync(instanceId, { source: 'hubspot', action: 'conflict_wix_newer', wixId: wixContact._id, hubspotId, syncId });
    return pushWixToHubspot(ctx, wixContact, hs, syncId, !link);
  }
  return pushHubspotToWix(ctx, hs, wixContact, syncId, !link);
}

function hubspotHasUnsyncedChanges(hs: HubspotContact, link: ContactLink | null, mappings: FieldMapping[]) {
  if (!link) return true; // never synced: compare timestamps only
  return link.hubspot_hash !== fingerprint(hubspotSnapshot(hs.properties, mappings));
}

function wixHasUnsyncedChanges(wix: WixContactLike, link: ContactLink | null, mappings: FieldMapping[]) {
  if (!link) return true;
  return link.wix_hash !== fingerprint(wixSnapshot(wix, mappings));
}

/**
 * `firstLink`: the two records were just matched by email. Then an empty value on the winning
 * side never clears a filled one on the other side (merge), so linking can't destroy data.
 */
async function pushWixToHubspot(ctx: SyncContext, wix: WixContactLike, hs: HubspotContact | null, syncId: string, firstLink: boolean): Promise<string> {
  const { instanceId, mappings } = ctx;
  const wixId = wix._id!;
  const changes: Record<string, string> = {};

  for (const m of mappings.filter(wixToHubspot)) {
    const desired = applyTransform(readWixField(wix, m.wixField), m.transform);
    if (firstLink && !desired) continue;
    // Idempotency: only send properties whose value would actually change.
    if (canonical(m.wixField, desired) !== canonical(m.wixField, hs?.properties[m.hubspotProperty])) {
      changes[m.hubspotProperty] = desired ?? '';
    }
  }

  let after: Record<string, string | null>;
  let hubspotId: string;
  let action: string;
  if (!hs) {
    const email = readWixField(wix, 'email');
    if (!email) return 'skipped_no_email';
    const created = await ctx.hubspot.createContact({ ...stripEmpty(changes), email: email.trim().toLowerCase() });
    hubspotId = created.id;
    after = { ...created.properties, ...changes, email: email.trim().toLowerCase() };
    action = 'created_in_hubspot';
  } else if (Object.keys(changes).length === 0) {
    hubspotId = hs.id;
    after = hs.properties;
    action = 'linked_no_change';
  } else {
    await ctx.hubspot.updateContact(hs.id, changes);
    hubspotId = hs.id;
    after = { ...hs.properties, ...changes };
    action = 'updated_hubspot';
  }

  // Record what each side now holds. The webhook HubSpot fires for this very write will
  // fingerprint to `hubspotHash` and be ignored (origin tagging via content).
  await saveLink(instanceId, {
    wixId,
    hubspotId,
    wixHash: fingerprint(wixSnapshot(wix, mappings)),
    hubspotHash: fingerprint(hubspotSnapshot(after, mappings)),
    source: 'wix',
    syncId,
  });
  await logSync(instanceId, { source: 'wix', action, wixId, hubspotId, syncId, detail: Object.keys(changes).join(',') || undefined });
  log.info({ instanceId, syncId, action, wixId, hubspotId, fields: Object.keys(changes) }, 'sync wix→hubspot');
  return action;
}

async function pushHubspotToWix(ctx: SyncContext, hs: HubspotContact, wix: WixContactLike | null, syncId: string, firstLink: boolean): Promise<string> {
  const { instanceId, mappings } = ctx;
  const changes: Record<string, string | null> = {};

  for (const m of mappings.filter(hubspotToWix)) {
    const desired = applyTransform(hs.properties[m.hubspotProperty] ?? null, m.transform);
    if (firstLink && !desired) continue;
    if (canonical(m.wixField, desired) !== canonical(m.wixField, wix ? readWixField(wix, m.wixField) : null)) {
      changes[m.wixField] = desired === '' ? null : desired;
    }
  }

  let result: WixContactLike;
  let action: string;
  if (!wix) {
    const email = hs.properties.email;
    if (!email) return 'skipped_no_email';
    result = await ctx.wix.create(buildWixInfoPatch(null, { ...stripEmpty(changes), email }));
    action = 'created_in_wix';
  } else if (Object.keys(changes).length === 0) {
    result = wix;
    action = 'linked_no_change';
  } else {
    result = await updateWixWithRetry(ctx, wix, changes);
    action = 'updated_wix';
  }

  await saveLink(instanceId, {
    wixId: result._id!,
    hubspotId: hs.id,
    wixHash: fingerprint(wixSnapshot(result, mappings)),
    hubspotHash: fingerprint(hubspotSnapshot(hs.properties, mappings)),
    source: 'hubspot',
    syncId,
  });
  await logSync(instanceId, { source: 'hubspot', action, wixId: result._id, hubspotId: hs.id, syncId, detail: Object.keys(changes).join(',') || undefined });
  log.info({ instanceId, syncId, action, wixId: result._id, hubspotId: hs.id, fields: Object.keys(changes), ref: emailRef(hs.properties.email) }, 'sync hubspot→wix');
  return action;
}

/** Wix uses optimistic concurrency (revision); refetch once if someone else wrote in between. */
async function updateWixWithRetry(ctx: SyncContext, wix: WixContactLike, changes: Record<string, string | null>) {
  try {
    return await ctx.wix.update(wix._id!, buildWixInfoPatch(wix, changes), wix.revision ?? 0);
  } catch (err) {
    const fresh = await ctx.wix.get(wix._id!);
    if (!fresh) throw err;
    return ctx.wix.update(fresh._id!, buildWixInfoPatch(fresh, changes), fresh.revision ?? 0);
  }
}

function stripEmpty<T extends Record<string, string | null>>(o: T): Record<string, string> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== '')) as Record<string, string>;
}
