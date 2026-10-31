// Mints a signed Wix dashboard instance for local testing:
//   WIX_APP_SECRET=... npx tsx scripts/dev-instance.ts <instanceId>
// then open http://localhost:5173/dashboard/?instance=<output>
import { createHmac } from 'node:crypto';

const secret = process.env.WIX_APP_SECRET;
if (!secret) throw new Error('WIX_APP_SECRET is required');
const payload = Buffer.from(JSON.stringify({ instanceId: process.argv[2] ?? 'dev-instance', signDate: new Date().toISOString(), permissions: 'OWNER' })).toString('base64url');
console.log(`${createHmac('sha256', secret).update(payload).digest('base64url')}.${payload}`);
