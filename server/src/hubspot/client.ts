import { getAccessToken } from './oauth.js';

const BASE = 'https://api.hubapi.com';

export interface HubspotContact {
  id: string;
  properties: Record<string, string | null>;
  updatedAt: string;
}

export interface HubspotProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName: string;
  hidden?: boolean;
  calculated?: boolean;
  modificationMetadata?: { readOnlyValue?: boolean };
}

export class HubspotApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly category: string,
  ) {
    super(`HubSpot API ${status} ${category}`);
  }
}

/** Thin HubSpot CRM client bound to one connected site. Handles token refresh and 429 backoff. */
export class HubspotClient {
  constructor(private readonly instanceId: string) {}

  private async request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const token = await getAccessToken(this.instanceId, { force: attempt > 0 && attempt < 2 });
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 401 && attempt === 0) return this.request(method, path, body, 1);
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10) * 1000));
      return this.request(method, path, body, attempt + 2);
    }
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new HubspotApiError(res.status, json?.category ?? 'UNKNOWN');
    return json as T;
  }

  getContact(id: string, properties: string[]): Promise<HubspotContact | null> {
    const qs = new URLSearchParams({ properties: properties.join(','), archived: 'false' });
    return this.request<HubspotContact>('GET', `/crm/v3/objects/contacts/${encodeURIComponent(id)}?${qs}`).catch((err) => {
      if (err instanceof HubspotApiError && err.status === 404) return null;
      throw err;
    });
  }

  async findContactByEmail(email: string, properties: string[]): Promise<HubspotContact | null> {
    const res = await this.request<{ results: HubspotContact[] }>('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email.trim().toLowerCase() }] }],
      properties,
      limit: 1,
    });
    return res.results[0] ?? null;
  }

  createContact(properties: Record<string, string>): Promise<HubspotContact> {
    return this.request('POST', '/crm/v3/objects/contacts', { properties });
  }

  updateContact(id: string, properties: Record<string, string>): Promise<HubspotContact> {
    return this.request('PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(id)}`, { properties });
  }

  /** Contacts modified at or after `since`, oldest first (reconciliation poll). */
  async contactsModifiedSince(since: Date, properties: string[], limit = 100): Promise<HubspotContact[]> {
    const res = await this.request<{ results: HubspotContact[] }>('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'lastmodifieddate', operator: 'GTE', value: String(since.getTime()) }] }],
      sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
      properties,
      limit,
    });
    return res.results;
  }

  async listContactProperties(): Promise<HubspotProperty[]> {
    const res = await this.request<{ results: HubspotProperty[] }>('GET', '/crm/v3/properties/contacts');
    return res.results;
  }

  async ensurePropertyGroup(name: string, label: string) {
    try {
      await this.request('POST', '/crm/v3/properties/contacts/groups', { name, label });
    } catch (err) {
      if (!(err instanceof HubspotApiError && err.status === 409)) throw err;
    }
  }

  async ensureProperty(def: { name: string; label: string; type: string; fieldType: string; groupName: string; description?: string }) {
    try {
      await this.request('POST', '/crm/v3/properties/contacts', def);
    } catch (err) {
      if (!(err instanceof HubspotApiError && err.status === 409)) throw err;
    }
  }
}
