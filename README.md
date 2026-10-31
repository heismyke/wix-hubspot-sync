# Wix ↔ HubSpot Sync

A self-hosted Wix app that connects a Wix site to HubSpot:

1. **Bi-directional contact sync**, with a user-configurable field mapping, last-updated-wins conflict handling and loop prevention.
2. **Form lead capture**: Wix Forms submissions are created or updated as HubSpot contacts with UTM, page and referrer attribution.
3. **Secure connection**: HubSpot OAuth 2.0 with least-privilege scopes. Tokens are encrypted at rest and rotated automatically, and never reach the browser.

The API plan (deliverable A) is in **[docs/API_PLAN.md](docs/API_PLAN.md)**.

## Stack

| | |
|---|---|
| Backend | Node.js 22, TypeScript, Express 5, `@wix/sdk` (`@wix/crm`, `@wix/forms`), HubSpot CRM v3 REST |
| Dashboard | React 19 + Vite, served by the backend and loaded by Wix as a dashboard page |
| Data | Postgres. Works with plain Postgres or Supabase (`DATABASE_URL`) |
| Ops | Docker / docker-compose, GitHub Actions (typecheck, tests, build, image), pino structured logs with PII/token redaction |

## How it works

```
server/src
├── auth/wixInstance.ts     verify the signed Wix `instance` that guards every dashboard API call
├── hubspot/oauth.ts        authorize URL (signed state), code exchange, refresh rotation, revoke
├── hubspot/client.ts       CRM contacts/properties client, 401 refresh + 429 backoff
├── wix/                    Wix SDK client (client-credentials per site), contacts adapter
├── sync/fields.ts          Wix field catalogue, transforms, normalisation, fingerprints, validation
├── sync/engine.ts          syncFromWix / syncFromHubspot: linking, LWW conflicts, loop prevention
├── forms/                  submission → HubSpot lead, attribution join, HubSpot property setup
├── jobs/queue.ts           durable Postgres job queue (dedupe, coalescing, backoff)
├── jobs/poller.ts          reconciliation poll for anything webhooks missed
├── routes/                 webhooks (Wix JWT / HubSpot v3 signature), dashboard API, OAuth callback, beacon
└── lib/secretStore.ts      AES-256-GCM token sealing behind a Secret-Manager-style interface
server/public/utm.js        site script: captures UTM/referrer, beacons it on form submit
dashboard/src               connection card, field-mapping table, attribution snippet, live activity log
```

**Loop prevention, briefly.** Every linked pair stores a fingerprint of the mapped values on *each* side after each sync, along with the `syncId` and source. When we write to HubSpot, the webhook HubSpot sends back for that write fingerprints to exactly the stored value, so it's dropped (`skipped_no_change`). Only properties that actually differ are written, and webhook event ids dedupe retries. See `test/engine.test.ts`, which feeds every write back into the engine as a webhook and asserts that each change settles.

**Security.**
- No HubSpot credential is ever sent to the browser. The dashboard only holds Wix's signed instance, which the server verifies with HMAC.
- OAuth `state` is HMAC-signed and bound to the Wix site.
- Webhooks are verified: Wix uses an RS256 JWT, HubSpot uses the v3 HMAC signature with a 5-minute replay window.
- The logger redacts tokens, emails, names, phones and payload bodies. Logs carry ids and a one-way email hash only.
- The public beacon endpoint is rate-limited and schema-validated, and stores only a hash of the email.
- `frame-ancestors` lets only Wix frame the dashboard.

## Run locally

```bash
docker run -d --name whs-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=whs -p 5432:5432 postgres:17-alpine
cp .env.example server/.env   # fill in; DATABASE_URL=postgres://postgres:pw@localhost:5432/whs
cd server && npm ci && npm test && npm run dev        # API on :3000, runs migrations
cd dashboard && npm ci && npm run dev                 # UI on :5173/dashboard (proxies /api)

# open the dashboard outside Wix with a locally signed instance:
WIX_APP_SECRET=<secret> npx tsx server/scripts/dev-instance.ts my-site
# → http://localhost:5173/dashboard/?instance=<printed value>
```

Webhooks need a public HTTPS URL (deploy, or use a tunnel such as `cloudflared`).

## Deploy (self-hosted)

```bash
cp .env.example .env    # set PUBLIC_BASE_URL, secrets, POSTGRES_PASSWORD
docker compose up -d --build
```

The compose file joins the reverse proxy's network. For TLS, point a Caddy/nginx site at `app:3000`.

## Configure the apps

**Wix** (dev.wix.com → Create app → *Self-hosted*):

1. **OAuth**: copy the App ID and App Secret.
2. **Extensions → Dashboard page**: set the iframe URL to `https://<host>/dashboard/`.
3. **Extensions → Embedded script** (optional, for UTM capture): `<script src="https://<host>/utm.js" data-site-key="{{siteKey}}" async></script>`. Site owners can also paste the snippet shown in the dashboard into *Settings → Custom code*.
4. **Permissions**: *Manage Contacts* (read/write contacts and extended fields) and *Read Submissions* (Wix Forms).
5. **Webhooks**: callback `https://<host>/webhooks/wix` for *Contact Created*, *Contact Updated*, *Submission Created* and *App Removed*. Copy the **public key** into `WIX_PUBLIC_KEY`.
6. Install the app on a test site from *Test your app*.

**HubSpot** (developer account → Apps → Create app):

1. **Auth**: set the redirect URL to `https://<host>/oauth/hubspot/callback` and the scopes to those listed above. Copy the Client ID and Secret.
2. **Webhooks**: target URL `https://<host>/webhooks/hubspot`. Subscribe to `contact.creation`, plus `contact.propertyChange` for `email`, `firstname`, `lastname`, `phone`, `company`, `jobtitle` and any other property you map. Anything not subscribed is still picked up by the 60s poll.
3. Use a **developer test account** to connect.

## Testing it end to end

1. In the Wix dashboard, open **HubSpot Sync** → **Connect HubSpot** → approve. The card shows the portal and the granted scopes.
2. **Field mapping**: change a row (for example *Company → company, Wix → HubSpot, Uppercase*) → **Save mapping**.
3. Edit a contact in Wix → the HubSpot contact updates within seconds. Edit it in HubSpot → Wix updates. The activity log shows one write and one `Ignored: no change / own echo` row, with no ping-pong.
4. Visit the site with `?utm_source=test&utm_campaign=demo` and submit a Wix form → the HubSpot contact appears with the values in the **Wix integration** property group.
5. **Disconnect** revokes the refresh token at HubSpot and deletes the stored tokens.

## Tests

```bash
cd server && npm test
```

The suite covers: sync create/update both ways, no ping-pong, idempotency, a value reformatted by HubSpot settling, linking by email with merge, direction and transform rules, the last-updated-wins conflict rule, token encryption and tamper detection, OAuth state, Wix instance verification, the HubSpot v3 signature and replay window, form field extraction, first-touch vs latest attribution, and URL sanitising.

## Known limitations and next steps

- Deletes aren't propagated, deliberately: an accidental delete on one side shouldn't wipe the CRM. This could be added as an opt-in.
- A single worker serialises all writes. Scaling horizontally would need per-site advisory locks or a per-site queue partition.
- Conflict resolution is per record. Per-field LWW would need per-property timestamps (HubSpot property history and Wix revisions).
- Built with Claude Code as a pair-programmer. Design decisions, review and testing are mine.
