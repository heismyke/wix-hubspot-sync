// Deterministic test environment; nothing here talks to a real Wix/HubSpot/Postgres.
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  PUBLIC_BASE_URL: 'https://app.example.com',
  DATABASE_URL: 'postgres://unused/unused',
  WIX_APP_ID: 'test-app',
  WIX_APP_SECRET: 'wix-secret',
  WIX_PUBLIC_KEY: 'unused',
  HUBSPOT_CLIENT_ID: 'hs-client',
  HUBSPOT_CLIENT_SECRET: 'hs-secret',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
});
