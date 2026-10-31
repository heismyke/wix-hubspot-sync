// Wix opens the dashboard page with ?instance=<signed token>. Every API call forwards it,
// and the server verifies the signature before doing anything for that site.
const instance = new URLSearchParams(window.location.search).get('instance') ?? '';

export const hasInstance = instance.length > 0;

export class ApiError extends Error {
  constructor(
    public status: number,
    public errors: string[],
  ) {
    super(errors[0] ?? `Request failed (${status})`);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Instance ${instance}`, ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.errors ?? [body.error ?? `Request failed (${res.status})`]);
  return body as T;
}

export type Direction = 'wix_to_hubspot' | 'hubspot_to_wix' | 'bidirectional';
export type Transform = 'none' | 'trim' | 'lowercase' | 'uppercase';

export interface Mapping {
  wixField: string;
  hubspotProperty: string;
  direction: Direction;
  transform: Transform;
}

export interface Status {
  connected: boolean;
  hubspot: { portalId: number; hubDomain: string | null; scopes: string[]; connectedAt: string } | null;
  siteKey: string;
  trackingSnippet: string;
}

export interface Fields {
  wixFields: Array<{ key: string; label: string }>;
  hubspotProperties: Array<{ name: string; label: string; group: string }>;
}

export interface Activity {
  events: Array<{ at: string; source: string; action: string; wix_contact_id: string | null; hubspot_contact_id: string | null; sync_id: string | null; detail: string | null }>;
  stats: { linked: number; submissions: number; pending: number; failed: number };
}
