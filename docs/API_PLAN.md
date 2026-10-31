# API Plan — Wix ↔ HubSpot Integration

This document lists the APIs used for each feature and why. The app is a **self-hosted Wix app**: a Node.js/TypeScript backend plus a React dashboard page that Wix loads in an iframe.

```
 Wix site ──(webhooks: contacts, form submissions)──►┐
    ▲                                                  │      ┌──────────────┐
    │ Wix Contacts API (SDK, client-credentials token) │      │  Postgres    │
    │                                                  ▼      │  - links     │
 ┌──┴────────────────────────────────────────────────────┐   │  - mappings  │
 │ App backend (Node/TS)                                  │◄─►│  - tokens    │
 │  webhooks → durable job queue → sync engine            │   │    (AES-GCM) │
 │  reconciliation poller (both sides)                    │   │  - jobs/log  │
 └──┬────────────────────────────────────────────────────┘   └──────────────┘
    │ HubSpot CRM Contacts / Properties API (OAuth 2.0 bearer)
    ▼                                                  ▲
 HubSpot portal ──(webhooks: contact.creation / propertyChange, signed v3)──┘
```

---

## Connection & security (prerequisite for #1 and #2)

| Need | API | Why |
|---|---|---|
| Connect HubSpot | **HubSpot OAuth 2.0**: `GET app.hubspot.com/oauth/authorize`, `POST /oauth/v1/token` (`authorization_code`, `refresh_token`), `GET /oauth/v1/access-tokens/{token}` (portal id), `DELETE /oauth/v1/refresh-tokens/{token}` (disconnect) | The standard for a multi-tenant marketplace app: no API keys anywhere, per-portal consent, revocable. |
| Scopes | `oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.schemas.contacts.read`, `crm.schemas.contacts.write` | Least privilege. Contacts read/write for #1 and #2; schema read for the mapping dropdown; schema write only to create the attribution properties once. No forms, marketing or other object scopes. |
| Identify the Wix site in the dashboard | Signed **Wix `instance`** query parameter (HMAC-SHA256 with the app secret) | Every dashboard API call carries it as `Authorization: Instance …` and is verified server-side. The browser never sees a HubSpot token. |
| Call Wix APIs | **Wix OAuth client-credentials** (`AppStrategy` in `@wix/sdk`: app id + secret + instance id → 4h access token) | No Wix refresh tokens to store; the token is minted per site on demand. |
| Token storage | Encrypted at rest (AES-256-GCM, key only in the server env) behind a `SecretStore` interface | Same contract as a Secret Manager: the database alone never reveals a token. Swapping in GCP Secret Manager / AWS Secrets Manager means implementing `seal/open`. |
| Token rotation | Refresh when < 2 min from expiry, and once on any 401; per-site mutex so concurrent jobs share one refresh | HubSpot access tokens live 30 minutes. |

---

## Feature #1 — Bi-directional contact sync

### Wix → HubSpot

| Step | API |
|---|---|
| Trigger | **Wix webhooks** `wix.contacts.v4.contact_created`, `wix.contacts.v4.contact_updated` (JWT, verified with the app's public key) |
| Read source | **Wix Contacts v4** `getContact` |
| Find target | **HubSpot CRM** `POST /crm/v3/objects/contacts/search` (email EQ) when not yet linked, else `GET /crm/v3/objects/contacts/{id}` |
| Write | `POST /crm/v3/objects/contacts` / `PATCH /crm/v3/objects/contacts/{id}`, **changed properties only** |

### HubSpot → Wix

| Step | API |
|---|---|
| Trigger | **HubSpot Webhooks API** app subscriptions `contact.creation`, `contact.propertyChange` (for mapped properties), `contact.restore`, `contact.merge`; request signature **v3** verified |
| Read source | `GET /crm/v3/objects/contacts/{id}?properties=<mapped>` |
| Find target | Wix `queryContacts().eq('primaryInfo.email', …)` when not yet linked |
| Write | Wix `createContact` / `updateContact(id, info, revision)` (optimistic concurrency, one refetch-and-retry) |

### Safety net: polling

Webhooks are the fast path. A reconciliation poll every 60s (`POST /crm/v3/objects/contacts/search` on `lastmodifieddate`, and Wix `queryContacts().ge('_updatedDate', …)`) catches missed deliveries and properties that have no `propertyChange` subscription. If webhook setup isn't possible, the poll on its own is the documented fallback.

### Property mapping

- **HubSpot Properties API** `GET /crm/v3/properties/contacts` fills the HubSpot dropdown (writable, non-calculated properties only).
- **Wix Extended Fields API** `queryExtendedFields` adds the site's custom contact fields (`custom.*`) next to the standard fields.
- Mappings are stored per site, with a direction (Wix→HubSpot, HubSpot→Wix, both) and a transform (trim, lowercase, uppercase). The sync engine reads them on every job, so a change applies without a deploy.

### Conflict rule: last updated wins

When an event arrives for a linked pair, the engine checks whether the *other* side holds mapped changes that were never synced (its fingerprint differs from the stored one). If it does **and** its modification time is newer, the other side wins and the sync runs in the opposite direction. Otherwise the event's side wins. When two existing records are linked for the first time by email, the sync **merges**: an empty value never clears a filled one.

### Loop prevention

| Mechanism | Where |
|---|---|
| External ID mapping `WixContactId ↔ HubSpotContactId` | `contact_links` table |
| Sync source + correlation id (`source = wix\|hubspot\|form`, `syncId` UUID) | `contact_links.last_sync_*`, every `sync_log` row |
| Ignore our own writes | After each write, the fingerprint (SHA-256 of the mapped values, normalised) of **both** sides is stored. The webhook our own write triggers fingerprints to the stored value and is dropped as `skipped_no_change`. This is an origin tag based on content, so it needs no timing window. |
| Idempotency | Only properties whose normalised value differs are written. Webhook event ids are a unique dedupe key in the job queue, and bursts of events for the same contact coalesce into one job. |
| Normalisation | Comparison ignores case for email, formatting for phone and surrounding whitespace, so a system reformatting a value can't cause a bounce. |

`test/engine.test.ts` wires in-memory Wix and HubSpot fakes so that every write emits an event that is fed straight back into the engine. The suite fails if a change doesn't settle.

---

## Feature #2 — Form & lead capture (approach 2: Wix Forms → HubSpot)

| Step | API |
|---|---|
| Trigger | **Wix webhook** `wix.forms.v4.submission_created` |
| Read submission | **Wix Forms Submissions** `getSubmission(id)` → fields, `formId`, `contactId`, created date |
| Attribution | Site script `utm.js` (Wix **Embedded Script** extension, or Custom Code) stores first-touch and latest `utm_source/medium/campaign/term/content`, landing page and referrer in localStorage, and on submit sends a beacon to `POST /api/public/attribution`. The server stores it keyed by a **SHA-256 of the email** (the email itself isn't stored) and joins it to the submission. Hidden form fields named `utm_*` are also honoured. |
| Ensure properties | **HubSpot Properties API** `POST /crm/v3/properties/contacts/groups` and `POST /crm/v3/properties/contacts` (idempotent, 409 = exists) |
| Upsert lead | `POST /crm/v3/objects/contacts/search` by email → `POST` or `PATCH /crm/v3/objects/contacts` |

**Where attribution shows up in HubSpot**: on the contact record, in the property group **“Wix integration”**:

| Property | Meaning |
|---|---|
| `wix_utm_source`, `wix_utm_medium`, `wix_utm_campaign`, `wix_utm_term`, `wix_utm_content` | Latest touch, overwritten on each submission |
| `wix_first_utm_source`, `wix_first_utm_medium`, `wix_first_utm_campaign`, `wix_first_landing_page` | First touch, written once |
| `wix_form_page_url`, `wix_form_referrer` | Page the form was submitted on, and the external referrer |
| `wix_form_submitted_at` (datetime), `wix_form_id` | When and which form |
| `wix_form_fields` | Custom form fields (key: value), last submission |

Stored URLs keep only `utm_*`, `gclid` and `fbclid` query parameters, so tokens or emails in query strings never reach HubSpot. Because the beacon and the webhook race, a submission that arrives first waits up to about 9 seconds for its beacon. If the beacon arrives late, the attribution is patched onto the contact afterwards.

---

## Rate limits and failure handling

- Webhook handlers only verify, enqueue and return 200. API calls run in a durable Postgres job queue with exponential backoff (5s → 160s, 6 attempts).
- The HubSpot client honours `429` + `Retry-After` and retries 5xx responses.
- A single worker serialises writes. This removes create/create races between the two webhooks for the same new contact. To scale out, the worker would take per-site Postgres advisory locks instead.
