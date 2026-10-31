import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeHubspot, FakeWix, tick } from './fakes.js';

// In-memory replacement for the Postgres-backed link/log repository.
const links = new Map<string, any>();
const syncLog: Array<{ source: string; action: string }> = [];
vi.mock('../src/sync/repo.js', () => ({
  linkByWix: async (_i: string, wixId: string) => links.get(`w:${wixId}`) ?? null,
  linkByHubspot: async (_i: string, hsId: string) => links.get(`h:${hsId}`) ?? null,
  dropLink: async (_i: string, wixId: string) => {
    const l = links.get(`w:${wixId}`);
    if (l) {
      links.delete(`w:${wixId}`);
      links.delete(`h:${l.hubspot_contact_id}`);
    }
  },
  saveLink: async (_i: string, l: any) => {
    const row = { wix_contact_id: l.wixId, hubspot_contact_id: l.hubspotId, wix_hash: l.wixHash, hubspot_hash: l.hubspotHash, last_sync_source: l.source, last_synced_at: new Date() };
    links.set(`w:${l.wixId}`, row);
    links.set(`h:${l.hubspotId}`, row);
  },
  logSync: async (_i: string, e: any) => {
    syncLog.push({ source: e.source, action: e.action });
  },
}));

const { syncFromHubspot, syncFromWix } = await import('../src/sync/engine.js');
const { DEFAULT_MAPPINGS } = await import('../src/sync/fields.js');

/**
 * Wires the fakes together the way production is wired: every write on either side emits a
 * webhook-like event, and the event is fed back into the engine. If loop prevention were
 * broken, this would ping-pong until the safety cap trips.
 */
function harness(mappings = DEFAULT_MAPPINGS) {
  const events: Array<['wix' | 'hubspot', string]> = [];
  const emit = (s: 'wix' | 'hubspot', id: string) => events.push([s, id]);
  const wix = new FakeWix(emit);
  const hubspot = new FakeHubspot(emit);
  const ctx = { instanceId: 'site-1', mappings, wix, hubspot: hubspot as any };

  async function drain() {
    let processed = 0;
    while (events.length) {
      if (++processed > 50) throw new Error('sync did not settle: infinite loop');
      const [system, id] = events.shift()!;
      if (system === 'wix') await syncFromWix(ctx, id);
      else await syncFromHubspot(ctx, id);
    }
    return processed;
  }
  return { wix, hubspot, ctx, drain, events };
}

const person = (email: string, first = 'Ada', last = 'Lovelace') => ({
  name: { first, last },
  emails: { items: [{ tag: 'MAIN', email, primary: true }] },
});

beforeEach(() => {
  links.clear();
  syncLog.length = 0;
});

describe('bi-directional sync', () => {
  it('creates a Wix contact in HubSpot exactly once and ignores the echo', async () => {
    const h = harness();
    h.wix.userCreate({ ...person('ada@example.com'), company: 'Analytical Engines' });
    await h.drain();

    expect(h.hubspot.writes).toBe(1);
    expect(h.wix.writes).toBe(0);
    const [hs] = [...h.hubspot.contacts.values()];
    expect(hs!.properties).toMatchObject({ email: 'ada@example.com', firstname: 'Ada', lastname: 'Lovelace', company: 'Analytical Engines' });
    expect(syncLog.map((e) => e.action)).toEqual(['created_in_hubspot', 'skipped_no_change']);
  });

  it('creates a HubSpot contact in Wix exactly once', async () => {
    const h = harness();
    h.hubspot.userCreate({ email: 'grace@example.com', firstname: 'Grace', lastname: 'Hopper', jobtitle: 'Rear Admiral' });
    await h.drain();

    expect(h.wix.writes).toBe(1);
    expect(h.hubspot.writes).toBe(0);
    const [w] = [...h.wix.contacts.values()];
    expect(w!.info).toMatchObject({ name: { first: 'Grace', last: 'Hopper' }, jobTitle: 'Rear Admiral' });
    expect(w!.primaryInfo?.email).toBe('grace@example.com');
  });

  it('propagates updates both ways without ping-pong', async () => {
    const h = harness();
    const wixId = h.wix.userCreate(person('ada@example.com'));
    await h.drain();
    const hsId = [...h.hubspot.contacts.keys()][0]!;

    h.wix.userEdit(wixId, { company: 'Babbage & Co' });
    await h.drain();
    expect(h.hubspot.contacts.get(hsId)!.properties.company).toBe('Babbage & Co');
    expect(h.hubspot.writes).toBe(2);

    h.hubspot.userEdit(hsId, { jobtitle: 'Mathematician' });
    await h.drain();
    expect(h.wix.contacts.get(wixId)!.info?.jobTitle).toBe('Mathematician');
    expect(h.wix.writes).toBe(1);
    expect(h.hubspot.writes).toBe(2); // the Wix write's echo did not bounce back
  });

  it('does not write when nothing mapped changed (idempotency)', async () => {
    const h = harness();
    const wixId = h.wix.userCreate(person('ada@example.com'));
    await h.drain();
    const before = h.hubspot.writes;

    h.wix.userEdit(wixId, { locale: 'en-GB' }); // not a mapped field
    await h.drain();
    expect(h.hubspot.writes).toBe(before);
  });

  it('settles when HubSpot reformats a value we wrote', async () => {
    const h = harness();
    h.hubspot.normalizePhone = true;
    const wixId = h.wix.userCreate({ ...person('ada@example.com'), phones: { items: [{ tag: 'MAIN', phone: '+44 (20) 7946-0000', primary: true }] } });
    const processed = await h.drain();

    expect(processed).toBeLessThanOrEqual(3);
    expect(h.wix.contacts.get(wixId)!.primaryInfo?.phone).toBe('+44 (20) 7946-0000');
  });

  it('links existing contacts by email instead of duplicating', async () => {
    const h = harness();
    h.hubspot.userCreate({ email: 'ada@example.com', firstname: 'Ada', phone: '+1 555 0100' });
    h.events.length = 0; // pretend that contact pre-dates the integration
    h.wix.userCreate(person('ADA@example.com', 'Ada', 'Lovelace'));
    await h.drain();

    expect(h.hubspot.contacts.size).toBe(1);
    expect(h.wix.contacts.size).toBe(1);
    const hs = [...h.hubspot.contacts.values()][0]!;
    expect(hs.properties.lastname).toBe('Lovelace');
    expect(hs.properties.phone).toBe('+1 555 0100'); // first link merges, never blanks
  });

  it('respects mapping direction', async () => {
    const h = harness([
      { wixField: 'email', hubspotProperty: 'email', direction: 'bidirectional', transform: 'lowercase' },
      { wixField: 'company', hubspotProperty: 'company', direction: 'wix_to_hubspot', transform: 'none' },
      { wixField: 'jobTitle', hubspotProperty: 'jobtitle', direction: 'hubspot_to_wix', transform: 'none' },
    ]);
    const wixId = h.wix.userCreate({ ...person('ada@example.com'), company: 'A', jobTitle: 'Wix title' });
    await h.drain();
    const hsId = [...h.hubspot.contacts.keys()][0]!;
    expect(h.hubspot.contacts.get(hsId)!.properties.jobtitle).toBeUndefined();

    h.hubspot.userEdit(hsId, { company: 'B', jobtitle: 'HS title' });
    await h.drain();
    const w = h.wix.contacts.get(wixId)!;
    expect(w.info?.company).toBe('A'); // HubSpot → Wix not allowed for company
    expect(w.info?.jobTitle).toBe('HS title');
  });

  it('applies transforms on the way out', async () => {
    const h = harness([
      { wixField: 'email', hubspotProperty: 'email', direction: 'bidirectional', transform: 'lowercase' },
      { wixField: 'company', hubspotProperty: 'company', direction: 'wix_to_hubspot', transform: 'uppercase' },
    ]);
    h.wix.userCreate({ ...person('ada@example.com'), company: '  acme ' });
    await h.drain();
    expect([...h.hubspot.contacts.values()][0]!.properties.company).toBe('ACME');
  });

  it('resolves conflicts with last-updated-wins', async () => {
    const h = harness();
    const wixId = h.wix.userCreate(person('ada@example.com'));
    await h.drain();
    const hsId = [...h.hubspot.contacts.keys()][0]!;

    // Both sides edited before either event is processed; HubSpot's edit is later.
    h.wix.userEdit(wixId, { company: 'From Wix' });
    tick(5000);
    h.hubspot.userEdit(hsId, { company: 'From HubSpot' });
    await h.drain();

    expect(h.wix.contacts.get(wixId)!.info?.company).toBe('From HubSpot');
    expect(h.hubspot.contacts.get(hsId)!.properties.company).toBe('From HubSpot');
    expect(syncLog.some((e) => e.action === 'conflict_hubspot_newer')).toBe(true);
  });
});
