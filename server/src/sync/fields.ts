import { createHash } from 'node:crypto';

export type Direction = 'wix_to_hubspot' | 'hubspot_to_wix' | 'bidirectional';
export type Transform = 'none' | 'trim' | 'lowercase' | 'uppercase';

export interface FieldMapping {
  id?: number;
  wixField: string;
  hubspotProperty: string;
  direction: Direction;
  transform: Transform;
}

/** Minimal structural view of a Wix contact (subset of @wix/crm Contact). */
export interface WixContactLike {
  _id?: string | null;
  revision?: number | null;
  _updatedDate?: Date | string | null;
  primaryInfo?: { email?: string | null; phone?: string | null } | null;
  info?: {
    name?: { first?: string | null; last?: string | null } | null;
    emails?: { items?: Array<{ _id?: string | null; tag?: string; email?: string; primary?: boolean | null }> } | null;
    phones?: { items?: Array<{ _id?: string | null; tag?: string; phone?: string; countryCode?: string | null; primary?: boolean | null }> } | null;
    company?: string | null;
    jobTitle?: string | null;
    birthdate?: string | null;
    locale?: string | null;
    extendedFields?: { items?: Record<string, any> } | null;
  } | null;
}

export const STANDARD_WIX_FIELDS = [
  { key: 'email', label: 'Email (primary)' },
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'phone', label: 'Phone (primary)' },
  { key: 'company', label: 'Company' },
  { key: 'jobTitle', label: 'Job title' },
  { key: 'birthdate', label: 'Birthdate (YYYY-MM-DD)' },
  { key: 'locale', label: 'Locale' },
] as const;

export const DEFAULT_MAPPINGS: FieldMapping[] = [
  { wixField: 'email', hubspotProperty: 'email', direction: 'bidirectional', transform: 'lowercase' },
  { wixField: 'firstName', hubspotProperty: 'firstname', direction: 'bidirectional', transform: 'trim' },
  { wixField: 'lastName', hubspotProperty: 'lastname', direction: 'bidirectional', transform: 'trim' },
  { wixField: 'phone', hubspotProperty: 'phone', direction: 'bidirectional', transform: 'trim' },
  { wixField: 'company', hubspotProperty: 'company', direction: 'bidirectional', transform: 'none' },
  { wixField: 'jobTitle', hubspotProperty: 'jobtitle', direction: 'bidirectional', transform: 'none' },
];

const primary = <T extends { primary?: boolean | null }>(items: T[] | undefined): T | undefined =>
  items?.find((i) => i.primary) ?? items?.[0];

export function readWixField(contact: WixContactLike, field: string): string | null {
  const info = contact.info ?? {};
  switch (field) {
    case 'email':
      return contact.primaryInfo?.email ?? primary(info.emails?.items)?.email ?? null;
    case 'phone':
      return contact.primaryInfo?.phone ?? primary(info.phones?.items)?.phone ?? null;
    case 'firstName':
      return info.name?.first ?? null;
    case 'lastName':
      return info.name?.last ?? null;
    case 'company':
    case 'jobTitle':
    case 'birthdate':
    case 'locale':
      return (info[field] as string | null | undefined) ?? null;
    default:
      if (field.startsWith('custom.')) {
        const v = info.extendedFields?.items?.[field];
        return v === undefined || v === null ? null : String(v);
      }
      return null;
  }
}

/**
 * Builds the `info` patch for Wix Update Contact. Array fields (emails, phones) are replaced
 * wholesale by Wix, so the existing items are carried over and only the primary one changes.
 */
export function buildWixInfoPatch(current: WixContactLike | null, values: Record<string, string | null>) {
  const info = current?.info ?? {};
  const patch: Record<string, any> = {};

  for (const [field, value] of Object.entries(values)) {
    switch (field) {
      case 'firstName':
      case 'lastName': {
        patch.name ??= { first: info.name?.first ?? null, last: info.name?.last ?? null };
        patch.name[field === 'firstName' ? 'first' : 'last'] = value;
        break;
      }
      case 'email': {
        const items = [...(info.emails?.items ?? [])].map((i) => ({ ...i }));
        const p = items.find((i) => i.primary) ?? items[0];
        if (!value) break; // never blank out the identity field
        if (p) p.email = value;
        else items.push({ tag: 'MAIN', email: value, primary: true });
        patch.emails = { items };
        break;
      }
      case 'phone': {
        const items = [...(info.phones?.items ?? [])].map((i) => ({ ...i }));
        const p = items.find((i) => i.primary) ?? items[0];
        if (!value) {
          patch.phones = { items: items.filter((i) => i !== p) };
        } else if (p) {
          p.phone = value;
          patch.phones = { items };
        } else {
          patch.phones = { items: [...items, { tag: 'MAIN', phone: value, primary: true }] };
        }
        break;
      }
      case 'company':
      case 'jobTitle':
      case 'birthdate':
      case 'locale':
        patch[field] = value;
        break;
      default:
        if (field.startsWith('custom.')) {
          patch.extendedFields ??= { items: { ...(info.extendedFields?.items ?? {}) } };
          patch.extendedFields.items[field] = value;
        }
    }
  }
  return patch;
}

export function applyTransform(value: string | null, transform: Transform): string | null {
  if (value === null || value === undefined) return null;
  let v = String(value);
  if (transform === 'trim' || transform === 'lowercase' || transform === 'uppercase') v = v.trim();
  if (transform === 'lowercase') v = v.toLowerCase();
  if (transform === 'uppercase') v = v.toUpperCase();
  return v;
}

export const wixToHubspot = (m: FieldMapping) => m.direction !== 'hubspot_to_wix';
export const hubspotToWix = (m: FieldMapping) => m.direction !== 'wix_to_hubspot';

/**
 * Canonical form used only for comparison/fingerprints, so formatting differences that the
 * two systems introduce on their own ("+1 (555) 010" vs "+1555010", trailing spaces, email case)
 * don't look like real edits and can't trigger a sync bounce.
 */
export function canonical(field: string, value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  let v = String(value).trim();
  if (field === 'email') v = v.toLowerCase();
  if (field === 'phone') v = v.replace(/[^\d+]/g, '');
  return v;
}

export const mappingKey = (m: FieldMapping) => `${m.wixField}|${m.hubspotProperty}`;

/** Mapped values as currently stored in Wix, keyed per mapping row. */
export function wixSnapshot(contact: WixContactLike, mappings: FieldMapping[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of mappings) out[mappingKey(m)] = canonical(m.wixField, readWixField(contact, m.wixField));
  return out;
}

/** Mapped values as currently stored in HubSpot, keyed per mapping row. */
export function hubspotSnapshot(props: Record<string, string | null | undefined>, mappings: FieldMapping[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of mappings) out[mappingKey(m)] = canonical(m.wixField, props[m.hubspotProperty]);
  return out;
}

export function fingerprint(snapshot: Record<string, string>): string {
  const keys = Object.keys(snapshot).sort();
  return createHash('sha256')
    .update(JSON.stringify(keys.map((k) => [k, snapshot[k]])))
    .digest('hex')
    .slice(0, 32);
}

export function validateMappings(mappings: FieldMapping[], allowDuplicateHubspot = false): string[] {
  const errors: string[] = [];
  const seenHs = new Set<string>();
  const seenWixInbound = new Set<string>();
  if (!mappings.some((m) => m.wixField === 'email' && m.hubspotProperty === 'email')) {
    errors.push('Email must be mapped to the HubSpot "email" property: it is how contacts are matched.');
  }
  mappings.forEach((m, i) => {
    const row = `Row ${i + 1}`;
    if (!m.wixField || !m.hubspotProperty) errors.push(`${row}: choose both a Wix field and a HubSpot property.`);
    if (!allowDuplicateHubspot && seenHs.has(m.hubspotProperty)) errors.push(`${row}: HubSpot property "${m.hubspotProperty}" is already mapped.`);
    seenHs.add(m.hubspotProperty);
    // Two HubSpot properties writing into the same Wix field would fight each other.
    if (hubspotToWix(m)) {
      if (seenWixInbound.has(m.wixField)) errors.push(`${row}: Wix field "${m.wixField}" already receives a value from HubSpot.`);
      seenWixInbound.add(m.wixField);
    }
  });
  return errors;
}
