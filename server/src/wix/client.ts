import { AppStrategy, createClient } from '@wix/sdk';
import { contacts, extendedFields } from '@wix/crm';
import { submissions } from '@wix/forms';
import { config } from '../config.js';

function build(instanceId?: string) {
  return createClient({
    auth: AppStrategy({
      appId: config.WIX_APP_ID,
      appSecret: config.WIX_APP_SECRET,
      publicKey: config.WIX_PUBLIC_KEY,
      ...(instanceId ? { instanceId } : {}),
    }),
    modules: { contacts, extendedFields, submissions },
  });
}

export type WixClient = ReturnType<typeof build>;

// AppStrategy caches its client-credentials access token, so keep one client per site.
const clients = new Map<string, WixClient>();

export function wixFor(instanceId: string): WixClient {
  let c = clients.get(instanceId);
  if (!c) {
    c = build(instanceId);
    clients.set(instanceId, c);
  }
  return c;
}

/** Client without an instance, used only to verify incoming webhook JWTs. */
export const wixWebhooks = build();

/**
 * Activates the app's Embedded Script extension on the site with this site's attribution key
 * (the script template references it as {{siteKey}}). Best-effort: sites can also paste the
 * snippet from the dashboard into Custom Code.
 */
export async function embedTrackingScript(instanceId: string, siteKey: string): Promise<boolean> {
  const res = await wixFor(instanceId).fetchWithAuth('https://www.wixapis.com/apps/v1/scripts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: { parameters: { siteKey } } }),
  });
  return res.ok;
}
