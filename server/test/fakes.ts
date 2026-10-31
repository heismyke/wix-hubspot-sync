import type { HubspotContact } from '../src/hubspot/client.js';
import type { WixContacts } from '../src/sync/engine.js';
import type { WixContactLike } from '../src/sync/fields.js';

let clock = Date.parse('2026-11-01T10:00:00Z');
export const tick = (ms = 1000) => new Date((clock += ms));

type Listener = (system: 'wix' | 'hubspot', id: string) => void;

/** In-memory Wix contacts store that, like the real one, emits an event for every write. */
export class FakeWix implements WixContacts {
  contacts = new Map<string, WixContactLike>();
  writes = 0;
  private seq = 0;
  constructor(private emit: Listener) {}

  /** Simulates a site owner editing a contact in the Wix dashboard. */
  userEdit(id: string, info: Partial<NonNullable<WixContactLike['info']>>) {
    const c = this.contacts.get(id)!;
    this.contacts.set(id, this.normalize({ ...c, info: { ...c.info, ...info }, revision: (c.revision ?? 0) + 1, _updatedDate: tick() }));
    this.emit('wix', id);
  }

  userCreate(info: NonNullable<WixContactLike['info']>) {
    const id = `wix-${++this.seq}`;
    this.contacts.set(id, this.normalize({ _id: id, info, revision: 1, _updatedDate: tick() }));
    this.emit('wix', id);
    return id;
  }

  private normalize(c: WixContactLike): WixContactLike {
    const emails = c.info?.emails?.items ?? [];
    const phones = c.info?.phones?.items ?? [];
    return {
      ...c,
      primaryInfo: { email: (emails.find((e) => e.primary) ?? emails[0])?.email ?? null, phone: (phones.find((p) => p.primary) ?? phones[0])?.phone ?? null },
    };
  }

  async get(id: string) {
    return structuredClone(this.contacts.get(id) ?? null);
  }
  async findByEmail(email: string) {
    return structuredClone([...this.contacts.values()].find((c) => c.primaryInfo?.email?.toLowerCase() === email.toLowerCase()) ?? null);
  }
  async create(info: Record<string, any>) {
    this.writes++;
    const id = `wix-${++this.seq}`;
    const c = this.normalize({ _id: id, info, revision: 1, _updatedDate: tick() });
    this.contacts.set(id, c);
    this.emit('wix', id);
    return structuredClone(c);
  }
  async update(id: string, info: Record<string, any>, revision: number) {
    const cur = this.contacts.get(id)!;
    if (cur.revision !== revision) throw new Error('revision mismatch');
    this.writes++;
    const c = this.normalize({ ...cur, info: { ...cur.info, ...info }, revision: revision + 1, _updatedDate: tick() });
    this.contacts.set(id, c);
    this.emit('wix', id);
    return structuredClone(c);
  }
}

/** In-memory HubSpot contacts API. `normalizePhone` mimics HubSpot reformatting a value we wrote. */
export class FakeHubspot {
  contacts = new Map<string, HubspotContact>();
  writes = 0;
  normalizePhone = false;
  private seq = 100;
  constructor(private emit: Listener) {}

  private store(id: string, properties: Record<string, string | null>) {
    if (this.normalizePhone && properties.phone) properties.phone = properties.phone.replace(/[^\d+]/g, '');
    if (properties.email) properties.email = properties.email.toLowerCase();
    const now = tick();
    const c = { id, properties: { ...properties, lastmodifieddate: now.toISOString() }, updatedAt: now.toISOString() };
    this.contacts.set(id, c);
    this.emit('hubspot', id);
    return structuredClone(c);
  }

  userEdit(id: string, props: Record<string, string>) {
    this.store(id, { ...this.contacts.get(id)!.properties, ...props });
  }
  userCreate(props: Record<string, string>) {
    const id = String(++this.seq);
    this.store(id, props);
    return id;
  }

  async getContact(id: string) {
    return structuredClone(this.contacts.get(id) ?? null);
  }
  async findContactByEmail(email: string) {
    return structuredClone([...this.contacts.values()].find((c) => c.properties.email === email.toLowerCase()) ?? null);
  }
  async createContact(properties: Record<string, string>) {
    this.writes++;
    return this.store(String(++this.seq), properties);
  }
  async updateContact(id: string, properties: Record<string, string>) {
    this.writes++;
    return this.store(id, { ...this.contacts.get(id)!.properties, ...properties });
  }
}
