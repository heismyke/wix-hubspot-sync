import { one, query } from '../db/pool.js';
import { HubspotClient } from '../hubspot/client.js';
import { emailRef, log } from '../lib/logger.js';
import { logSync } from '../sync/repo.js';
import { readWixField } from '../sync/fields.js';
import { wixFor } from '../wix/client.js';
import { wixContacts } from '../wix/contacts.js';
import { attributionToProperties, ensureAttributionProperties, type StoredAttribution } from './attribution.js';

export class RetryLater extends Error {
  constructor(public readonly delayMs: number) {
    super('retry later');
  }
}

export interface ExtractedLead {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  utmFromFields: Partial<Record<'source' | 'medium' | 'campaign' | 'term' | 'content', string>>;
  other: Record<string, string>;
}

/**
 * Wix Forms field keys are generated from the label (e.g. `email_4b2c`, `first_name_9a1f`).
 * Pick out the contact fields by key; everything else is kept as custom fields. Hidden fields
 * named utm_* (if the site owner added them) are honoured as attribution too.
 */
export function extractLead(fields: Record<string, unknown>): ExtractedLead {
  const lead: ExtractedLead = { email: null, firstName: null, lastName: null, phone: null, utmFromFields: {}, other: {} };
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === null || raw === undefined || typeof raw === 'object') continue;
    const value = String(raw).trim();
    if (!value) continue;
    const k = key.toLowerCase();
    const utm = k.match(/^utm_(source|medium|campaign|term|content)/);
    if (utm) lead.utmFromFields[utm[1] as keyof ExtractedLead['utmFromFields']] = value;
    else if (!lead.email && k.includes('email') && value.includes('@')) lead.email = value.toLowerCase();
    else if (!lead.firstName && /first_?name/.test(k)) lead.firstName = value;
    else if (!lead.lastName && /last_?name/.test(k)) lead.lastName = value;
    else if (!lead.phone && k.includes('phone')) lead.phone = value;
    else lead.other[key.replace(/_[0-9a-f]{4,}$/i, '')] = value.slice(0, 500);
  }
  return lead;
}

async function findAttribution(instanceId: string, ref: string): Promise<StoredAttribution | null> {
  const row = await one<{ data: StoredAttribution }>(
    `SELECT data FROM attributions WHERE instance_id = $1 AND email_ref = $2 AND created_at > now() - interval '30 minutes'
     ORDER BY created_at DESC LIMIT 1`,
    [instanceId, ref],
  );
  return row?.data ?? null;
}

/** Wix form submission → HubSpot contact create/update with attribution. */
export async function processSubmission(instanceId: string, submissionId: string, attempt: number): Promise<string> {
  const submission = await wixFor(instanceId).submissions.getSubmission(submissionId);
  const lead = extractLead((submission.submissions ?? {}) as Record<string, unknown>);

  // Fall back to the Wix contact that Wix Forms created/matched for this submission.
  if ((!lead.email || !lead.firstName) && submission.contactId) {
    const contact = await wixContacts(instanceId).get(submission.contactId);
    if (contact) {
      lead.email ??= readWixField(contact, 'email')?.toLowerCase() ?? null;
      lead.firstName ??= readWixField(contact, 'firstName');
      lead.lastName ??= readWixField(contact, 'lastName');
      lead.phone ??= readWixField(contact, 'phone');
    }
  }
  if (!lead.email) {
    await logSync(instanceId, { source: 'form', action: 'skipped_no_email', detail: `submission ${submissionId}` });
    return 'skipped_no_email';
  }

  const ref = emailRef(lead.email)!;
  let attribution = await findAttribution(instanceId, ref);
  const submittedAt = submission._createdDate ? new Date(submission._createdDate) : new Date();

  // The site script's beacon and Wix's webhook race; give the beacon a few seconds.
  if (!attribution && attempt < 3 && Date.now() - submittedAt.getTime() < 30_000) throw new RetryLater(3000);

  if (Object.keys(lead.utmFromFields).length) {
    attribution = { ...(attribution ?? {}), utm: { ...(attribution?.utm ?? {}), ...lead.utmFromFields } };
  }

  const hubspot = new HubspotClient(instanceId);
  await ensureAttributionProperties(instanceId, hubspot);
  const existing = await hubspot.findContactByEmail(lead.email, ['email', 'wix_first_utm_source', 'wix_first_landing_page']);

  const props: Record<string, string> = {
    email: lead.email,
    ...attributionToProperties(attribution, existing?.properties ?? {}, submittedAt, submission.formId),
  };
  if (lead.firstName) props.firstname = lead.firstName;
  if (lead.lastName) props.lastname = lead.lastName;
  if (lead.phone) props.phone = lead.phone;
  if (Object.keys(lead.other).length) {
    props.wix_form_fields = Object.entries(lead.other)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
      .slice(0, 5000);
  }

  const hs = existing ? await hubspot.updateContact(existing.id, props) : await hubspot.createContact(props);

  await query(
    `INSERT INTO form_events (instance_id, submission_id, form_id, email_ref, hubspot_contact_id, attribution)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (instance_id, submission_id) DO UPDATE SET hubspot_contact_id = EXCLUDED.hubspot_contact_id, attribution = EXCLUDED.attribution`,
    [instanceId, submissionId, submission.formId ?? null, ref, hs.id, attribution ? JSON.stringify(attribution) : null],
  );
  const action = existing ? 'form_updated_hubspot' : 'form_created_in_hubspot';
  await logSync(instanceId, {
    source: 'form',
    action,
    wixId: submission.contactId ?? null,
    hubspotId: hs.id,
    detail: attribution?.utm?.source ? `utm_source=${attribution.utm.source}` : 'no attribution',
  });
  log.info({ instanceId, submissionId, hubspotId: hs.id, ref, attributed: !!attribution }, 'form submission synced');
  return action;
}

/** Beacon arrived after the submission was already pushed: patch attribution onto the contact. */
export async function applyLateAttribution(instanceId: string, submissionId: string): Promise<string> {
  const ev = await one<{ email_ref: string; hubspot_contact_id: string; form_id: string | null; created_at: Date; attribution: unknown }>(
    'SELECT email_ref, hubspot_contact_id, form_id, created_at, attribution FROM form_events WHERE instance_id = $1 AND submission_id = $2',
    [instanceId, submissionId],
  );
  if (!ev || ev.attribution) return 'skipped';
  const attribution = await findAttribution(instanceId, ev.email_ref);
  if (!attribution) return 'skipped';

  const hubspot = new HubspotClient(instanceId);
  const contact = await hubspot.getContact(ev.hubspot_contact_id, ['wix_first_utm_source', 'wix_first_landing_page']);
  if (!contact) return 'skipped';
  await hubspot.updateContact(contact.id, attributionToProperties(attribution, contact.properties, ev.created_at, ev.form_id ?? undefined));
  await query('UPDATE form_events SET attribution = $3 WHERE instance_id = $1 AND submission_id = $2', [instanceId, submissionId, JSON.stringify(attribution)]);
  await logSync(instanceId, { source: 'form', action: 'attribution_applied', hubspotId: contact.id });
  return 'attribution_applied';
}
