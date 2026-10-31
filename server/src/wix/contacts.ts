import type { WixContacts } from '../sync/engine.js';
import type { WixContactLike } from '../sync/fields.js';
import { wixFor } from './client.js';

const isNotFound = (err: any) => err?.details?.applicationError?.code === 'CONTACT_NOT_FOUND' || err?.response?.status === 404 || /not.?found/i.test(String(err?.message));

export function wixContacts(instanceId: string): WixContacts {
  const wix = wixFor(instanceId);
  return {
    async get(id) {
      try {
        return (await wix.contacts.getContact(id)) as WixContactLike;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async findByEmail(email) {
      const res = await wix.contacts.queryContacts().eq('primaryInfo.email', email.trim().toLowerCase()).limit(1).find();
      return (res.items[0] as WixContactLike | undefined) ?? null;
    },
    async create(info) {
      const res = await wix.contacts.createContact(info, { allowDuplicates: false });
      return res.contact as WixContactLike;
    },
    async update(id, info, revision) {
      const res = await wix.contacts.updateContact(id, info, revision);
      return res.contact as WixContactLike;
    },
  };
}

/** Contacts updated since `since` (unsorted API → page through, caller tracks max date). */
export async function wixContactsUpdatedSince(instanceId: string, since: Date, max = 500): Promise<WixContactLike[]> {
  const wix = wixFor(instanceId);
  const out: WixContactLike[] = [];
  for (let skip = 0; skip < max; skip += 100) {
    const res = await wix.contacts.queryContacts().ge('_updatedDate', since).limit(100).skip(skip).find();
    out.push(...(res.items as WixContactLike[]));
    if (res.items.length < 100) break;
  }
  return out;
}

export async function listWixCustomFields(instanceId: string): Promise<Array<{ key: string; label: string }>> {
  const res = await wixFor(instanceId).extendedFields.queryExtendedFields().limit(100).find();
  return res.items
    .filter((f) => f.key?.startsWith('custom.'))
    .map((f) => ({ key: f.key!, label: `${f.displayName ?? f.key} (custom)` }));
}
