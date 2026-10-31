import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_BASE_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.string().default('info'),

  // Wix app (Dev Center → OAuth / Webhooks)
  WIX_APP_ID: z.string().min(1),
  WIX_APP_SECRET: z.string().min(1),
  // PEM; env files can't hold newlines, so literal "\n" escapes are accepted too.
  WIX_PUBLIC_KEY: z
    .string()
    .min(1)
    .transform((v) => v.replace(/\\n/g, '\n')),

  // HubSpot app (Developer account → app → Auth)
  HUBSPOT_CLIENT_ID: z.string().min(1),
  HUBSPOT_CLIENT_SECRET: z.string().min(1),

  // 32 random bytes, base64. Used for envelope encryption of OAuth tokens and signing OAuth state.
  TOKEN_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
    message: 'TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded',
  }),

  // How long a signed Wix dashboard instance token is accepted.
  WIX_INSTANCE_MAX_AGE_HOURS: z.coerce.number().default(48),
  // Reconciliation poll interval (catches anything webhooks missed). 0 disables.
  POLL_INTERVAL_SECONDS: z.coerce.number().default(60),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment:\n  ${missing}`);
  }
  return parsed.data;
}

export const config = load();

// Least-privilege HubSpot scopes: contacts read/write for sync and lead capture,
// schema read for the mapping dropdown, schema write to create the attribution properties once.
export const HUBSPOT_SCOPES = [
  'oauth',
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.schemas.contacts.read',
  'crm.schemas.contacts.write',
];
