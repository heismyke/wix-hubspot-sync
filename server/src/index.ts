import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { startPoller } from './jobs/poller.js';
import { startWorker } from './jobs/queue.js';
import { errMessage, log } from './lib/logger.js';
import { api } from './routes/api.js';
import { publicRoutes } from './routes/public.js';
import { webhooks } from './routes/webhooks.js';

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = join(here, '..', 'public');
const dashboardDir = process.env.DASHBOARD_DIR ?? join(here, '..', '..', 'dashboard', 'dist');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((_req, res, next) => {
  // The dashboard runs inside the Wix dashboard iframe; nothing else may frame it.
  res.set({
    'Content-Security-Policy': "frame-ancestors https://*.wix.com https://*.wixapps.net https://*.editorx.com",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  next();
});

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use(webhooks);
app.use(publicRoutes);
app.use(api);

app.use(express.static(staticDir, { maxAge: '1h' }));
if (existsSync(dashboardDir)) {
  app.use('/dashboard', express.static(dashboardDir));
  app.get('/dashboard/*splat', (_req, res) => res.sendFile(join(dashboardDir, 'index.html')));
}
app.get('/', (_req, res) => res.redirect('/dashboard/'));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err: errMessage(err) }, 'request failed');
  res.status(500).json({ error: 'internal_error' });
});

async function main() {
  await migrate();
  const stopWorker = startWorker();
  const stopPoller = startPoller();
  const server = app.listen(config.PORT, () => log.info({ port: config.PORT }, 'listening'));

  const shutdown = () => {
    log.info('shutting down');
    stopPoller();
    stopWorker();
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.fatal({ err: errMessage(err) }, 'startup failed');
  process.exit(1);
});
