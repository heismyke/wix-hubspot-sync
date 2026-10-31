import { z } from 'zod';
import { HubspotClient } from '../hubspot/client.js';

export const GROUP = { name: 'wix_integration', label: 'Wix integration' };

/**
 * Attribution is stored on the HubSpot contact as custom properties in a dedicated group,
 * so it is visible on the contact record, filterable in lists and usable in reports.
 * "Latest" values are overwritten on each submission; "first" values are only set once.
 */
export const ATTRIBUTION_PROPERTIES = [
  { name: 'wix_utm_source', label: 'Wix UTM source (latest)' },
  { name: 'wix_utm_medium', label: 'Wix UTM medium (latest)' },
  { name: 'wix_utm_campaign', label: 'Wix UTM campaign (latest)' },
  { name: 'wix_utm_term', label: 'Wix UTM term (latest)' },
  { name: 'wix_utm_content', label: 'Wix UTM content (latest)' },
  { name: 'wix_first_utm_source', label: 'Wix UTM source (first touch)' },
  { name: 'wix_first_utm_medium', label: 'Wix UTM medium (first touch)' },
  { name: 'wix_first_utm_campaign', label: 'Wix UTM campaign (first touch)' },
  { name: 'wix_first_landing_page', label: 'Wix landing page (first touch)' },
  { name: 'wix_form_page_url', label: 'Wix form page URL' },
  { name: 'wix_form_referrer', label: 'Wix form referrer' },
  { name: 'wix_form_id', label: 'Wix form ID' },
  { name: 'wix_form_submitted_at', label: 'Wix form submitted at', type: 'datetime', fieldType: 'date' },
  { name: 'wix_form_fields', label: 'Wix form fields (last submission)', fieldType: 'textarea' },
] as const;

const ensured = new Set<string>();

export async function ensureAttributionProperties(instanceId: string, hubspot = new HubspotClient(instanceId)) {
  if (ensured.has(instanceId)) return;
  await hubspot.ensurePropertyGroup(GROUP.name, GROUP.label);
  for (const p of ATTRIBUTION_PROPERTIES) {
    await hubspot.ensureProperty({
      name: p.name,
      label: p.label,
      type: 'type' in p ? p.type : 'string',
      fieldType: 'fieldType' in p ? p.fieldType : 'text',
      groupName: GROUP.name,
      description: 'Set by the Wix ↔ HubSpot integration',
    });
  }
  ensured.add(instanceId);
}

const utm = z
  .object({
    source: z.string().max(255).optional(),
    medium: z.string().max(255).optional(),
    campaign: z.string().max(255).optional(),
    term: z.string().max(255).optional(),
    content: z.string().max(255).optional(),
  })
  .partial();

/** What the site script posts (see public/utm.js). */
export const attributionPayload = z.object({
  siteKey: z.string().min(8).max(64),
  email: z.email().max(320),
  utm: utm.default({}),
  firstTouch: z
    .object({ utm: utm.default({}), landingPage: z.string().max(2048).optional(), referrer: z.string().max(2048).optional(), at: z.string().max(40).optional() })
    .optional(),
  pageUrl: z.string().max(2048).optional(),
  referrer: z.string().max(2048).optional(),
  ts: z.string().max(40).optional(),
});
export type AttributionPayload = z.infer<typeof attributionPayload>;
export type StoredAttribution = Omit<AttributionPayload, 'email' | 'siteKey'>;

/** Strip query params that aren't attribution (could carry tokens/PII) from stored URLs. */
export function cleanUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    for (const key of [...u.searchParams.keys()]) {
      if (!key.startsWith('utm_') && key !== 'gclid' && key !== 'fbclid') u.searchParams.delete(key);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return undefined;
  }
}

export function attributionToProperties(a: StoredAttribution | null, existing: Record<string, string | null>, submittedAt: Date, formId?: string) {
  const props: Record<string, string> = { wix_form_submitted_at: String(submittedAt.getTime()) };
  if (formId) props.wix_form_id = formId;
  if (!a) return props;

  const set = (k: string, v: string | undefined) => {
    if (v) props[k] = v.slice(0, 1000);
  };
  set('wix_utm_source', a.utm?.source);
  set('wix_utm_medium', a.utm?.medium);
  set('wix_utm_campaign', a.utm?.campaign);
  set('wix_utm_term', a.utm?.term);
  set('wix_utm_content', a.utm?.content);
  set('wix_form_page_url', a.pageUrl);
  set('wix_form_referrer', a.referrer);

  // First touch is write-once: never overwrite an earlier visit's attribution.
  const ft = a.firstTouch;
  if (ft && !existing.wix_first_utm_source && !existing.wix_first_landing_page) {
    set('wix_first_utm_source', ft.utm?.source);
    set('wix_first_utm_medium', ft.utm?.medium);
    set('wix_first_utm_campaign', ft.utm?.campaign);
    set('wix_first_landing_page', ft.landingPage);
  }
  return props;
}
