import { describe, expect, it } from 'vitest';
import { hmac } from '../src/lib/crypto.js';
import { decrypt, encrypt, signState, verifyState } from '../src/lib/crypto.js';
import { verifyWixInstance } from '../src/auth/wixInstance.js';
import { verifyHubspotSignature } from '../src/routes/webhooks.js';
import { applyTransform, buildWixInfoPatch, canonical, validateMappings, DEFAULT_MAPPINGS } from '../src/sync/fields.js';
import { extractLead } from '../src/forms/submission.js';
import { attributionToProperties, cleanUrl } from '../src/forms/attribution.js';

const key = Buffer.alloc(32, 1);

describe('token encryption', () => {
  it('round-trips and detects tampering', () => {
    const sealed = encrypt('secret-token', key);
    expect(sealed).not.toContain('secret-token');
    expect(decrypt(sealed, key)).toBe('secret-token');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => decrypt(parts.join('.'), key)).toThrow();
  });

  it('signs OAuth state and rejects forgeries', () => {
    const s = signState({ instanceId: 'abc' }, key);
    expect(verifyState<{ instanceId: string }>(s, key).instanceId).toBe('abc');
    expect(() => verifyState(s.replace(/.$/, 'x'), key)).toThrow();
    expect(() => verifyState(signState({ instanceId: 'abc' }, key, -1), key)).toThrow('expired');
  });
});

describe('wix instance verification', () => {
  const make = (payload: object, secret = 'wix-secret') => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${hmac(secret, body)}.${body}`;
  };
  it('accepts a correctly signed instance', () => {
    expect(verifyWixInstance(make({ instanceId: 'i-1', signDate: new Date().toISOString() })).instanceId).toBe('i-1');
  });
  it('rejects a wrong signature or stale instance', () => {
    expect(() => verifyWixInstance(make({ instanceId: 'i-1' }, 'other'))).toThrow();
    expect(() => verifyWixInstance(make({ instanceId: 'i-1', signDate: '2020-01-01T00:00:00Z' }))).toThrow('expired');
  });
});

describe('hubspot webhook signature v3', () => {
  const base = { method: 'POST', uri: 'https://app.example.com/webhooks/hubspot', body: '[{"eventId":1}]', secret: 'hs-secret' };
  it('validates', () => {
    const timestamp = String(Date.now());
    const signature = hmac('hs-secret', `${base.method}${base.uri}${base.body}${timestamp}`, 'base64');
    expect(verifyHubspotSignature({ ...base, timestamp, signature })).toBe(true);
    expect(verifyHubspotSignature({ ...base, body: '[]', timestamp, signature })).toBe(false);
  });
  it('rejects replays older than 5 minutes', () => {
    const timestamp = String(Date.now() - 6 * 60_000);
    const signature = hmac('hs-secret', `${base.method}${base.uri}${base.body}${timestamp}`, 'base64');
    expect(verifyHubspotSignature({ ...base, timestamp, signature })).toBe(false);
  });
});

describe('field mapping', () => {
  it('transforms', () => {
    expect(applyTransform('  Hi ', 'trim')).toBe('Hi');
    expect(applyTransform(' A@B.COM ', 'lowercase')).toBe('a@b.com');
    expect(applyTransform('x', 'uppercase')).toBe('X');
    expect(applyTransform(null, 'trim')).toBeNull();
  });

  it('compares phones/emails canonically', () => {
    expect(canonical('phone', '+1 (555) 010-0000')).toBe(canonical('phone', '+15550100000'));
    expect(canonical('email', 'A@B.com ')).toBe('a@b.com');
  });

  it('keeps secondary emails when changing the primary one', () => {
    const patch = buildWixInfoPatch(
      { info: { emails: { items: [{ email: 'old@x.com', primary: true, tag: 'MAIN' }, { email: 'work@x.com', tag: 'WORK' }] } } },
      { email: 'new@x.com' },
    );
    expect(patch.emails.items.map((i: any) => i.email)).toEqual(['new@x.com', 'work@x.com']);
  });

  it('validates duplicates and the email key', () => {
    expect(validateMappings(DEFAULT_MAPPINGS)).toEqual([]);
    expect(validateMappings([...DEFAULT_MAPPINGS, { wixField: 'company', hubspotProperty: 'firstname', direction: 'wix_to_hubspot', transform: 'none' }])[0]).toMatch(/already mapped/);
    expect(validateMappings(DEFAULT_MAPPINGS.slice(1))[0]).toMatch(/Email must be mapped/);
  });
});

describe('form capture', () => {
  it('extracts contact fields from Wix form keys', () => {
    const lead = extractLead({ first_name_4b2c: 'Ada', last_name_1a2b: 'Lovelace', email_9f8e: 'ADA@Example.com', phone_77aa: '+44 1', message_aa11: 'Hello', utm_source: 'newsletter' });
    expect(lead).toMatchObject({ email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace', phone: '+44 1', utmFromFields: { source: 'newsletter' }, other: { message: 'Hello' } });
  });

  it('writes latest UTM every time but first touch only once', () => {
    const a = { utm: { source: 'google', campaign: 'fall' }, firstTouch: { utm: { source: 'facebook' }, landingPage: 'https://s.com/' }, pageUrl: 'https://s.com/contact' };
    const fresh = attributionToProperties(a, {}, new Date(0), 'form-1');
    expect(fresh).toMatchObject({ wix_utm_source: 'google', wix_utm_campaign: 'fall', wix_first_utm_source: 'facebook', wix_form_id: 'form-1', wix_form_page_url: 'https://s.com/contact' });
    const repeat = attributionToProperties(a, { wix_first_utm_source: 'linkedin' }, new Date(0));
    expect(repeat.wix_first_utm_source).toBeUndefined();
  });

  it('strips non-attribution query params from stored URLs', () => {
    expect(cleanUrl('https://s.com/p?utm_source=x&token=secret&email=a@b.c#frag')).toBe('https://s.com/p?utm_source=x');
  });
});
