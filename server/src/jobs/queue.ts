import { one, query } from '../db/pool.js';
import { applyLateAttribution, processSubmission, RetryLater } from '../forms/submission.js';
import { HubspotClient } from '../hubspot/client.js';
import { NotConnectedError } from '../hubspot/oauth.js';
import { errMessage, log } from '../lib/logger.js';
import { syncFromHubspot, syncFromWix, type SyncContext } from '../sync/engine.js';
import { getMappings } from '../sync/repo.js';
import { wixContacts } from '../wix/contacts.js';

export type JobKind = 'wix_contact' | 'hubspot_contact' | 'wix_submission' | 'apply_attribution';

interface Job {
  id: string;
  instance_id: string;
  kind: JobKind;
  payload: { id: string };
  attempts: number;
}

/**
 * Enqueue work for the worker. `dedupeKey` (the provider's event id) makes webhook retries
 * idempotent; jobs for the same entity that are still pending are coalesced, so a burst of
 * property-change events for one contact becomes a single sync.
 */
export async function enqueue(instanceId: string, kind: JobKind, id: string, dedupeKey?: string, delayMs = 0) {
  await query(
    `INSERT INTO jobs (instance_id, kind, payload, dedupe_key, run_at)
     SELECT $1, $2, $3::jsonb, $4, now() + make_interval(secs => $5)
     WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE instance_id = $1 AND kind = $2 AND payload = $3::jsonb AND status = 'pending')
     ON CONFLICT (instance_id, dedupe_key) DO NOTHING`,
    [instanceId, kind, JSON.stringify({ id }), dedupeKey ?? null, delayMs / 1000],
  );
}

async function claim(): Promise<Job | null> {
  return one<Job>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1
     WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now() ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, instance_id, kind, payload, attempts`,
  );
}

async function contextFor(instanceId: string): Promise<SyncContext> {
  return {
    instanceId,
    mappings: await getMappings(instanceId),
    hubspot: new HubspotClient(instanceId),
    wix: wixContacts(instanceId),
  };
}

async function run(job: Job): Promise<string> {
  const connected = await one('SELECT 1 FROM hubspot_connections WHERE instance_id = $1', [job.instance_id]);
  if (!connected) throw new NotConnectedError();
  switch (job.kind) {
    case 'wix_contact':
      return syncFromWix(await contextFor(job.instance_id), job.payload.id);
    case 'hubspot_contact':
      return syncFromHubspot(await contextFor(job.instance_id), job.payload.id);
    case 'wix_submission':
      return processSubmission(job.instance_id, job.payload.id, job.attempts);
    case 'apply_attribution':
      return applyLateAttribution(job.instance_id, job.payload.id);
  }
}

const MAX_ATTEMPTS = 6;

async function tick(): Promise<boolean> {
  const job = await claim();
  if (!job) return false;
  try {
    const result = await run(job);
    await query("UPDATE jobs SET status = 'done', last_error = NULL WHERE id = $1", [job.id]);
    log.debug({ jobId: job.id, kind: job.kind, result }, 'job done');
  } catch (err) {
    if (err instanceof RetryLater) {
      await query("UPDATE jobs SET status = 'pending', run_at = now() + make_interval(secs => $2) WHERE id = $1", [job.id, err.delayMs / 1000]);
    } else if (err instanceof NotConnectedError || job.attempts >= MAX_ATTEMPTS) {
      await query("UPDATE jobs SET status = 'failed', last_error = $2 WHERE id = $1", [job.id, errMessage(err)]);
      log.warn({ jobId: job.id, kind: job.kind, err: errMessage(err) }, 'job failed permanently');
    } else {
      const backoff = 5 * 2 ** (job.attempts - 1); // 5s, 10s, 20s, ...
      await query("UPDATE jobs SET status = 'pending', last_error = $2, run_at = now() + make_interval(secs => $3) WHERE id = $1", [
        job.id,
        errMessage(err),
        backoff,
      ]);
      log.warn({ jobId: job.id, kind: job.kind, attempt: job.attempts, err: errMessage(err) }, 'job failed, will retry');
    }
  }
  return true;
}

/**
 * Single in-process worker. Running jobs one at a time serialises all writes, which removes
 * create/create races between the Wix and HubSpot webhooks for the same new contact.
 * Horizontal scaling would switch this to per-instance Postgres advisory locks.
 */
export function startWorker(): () => void {
  let stopped = false;
  // Jobs left "running" by a crash/restart go back to the queue.
  void query("UPDATE jobs SET status = 'pending' WHERE status = 'running'");
  (async () => {
    while (!stopped) {
      try {
        const worked = await tick();
        if (!worked) await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        log.error({ err: errMessage(err) }, 'worker loop error');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
  const cleanup = setInterval(() => {
    void query("DELETE FROM jobs WHERE status IN ('done','failed') AND created_at < now() - interval '7 days'");
    void query("DELETE FROM attributions WHERE created_at < now() - interval '1 day'");
    void query("DELETE FROM sync_log WHERE at < now() - interval '30 days'");
  }, 3600_000);
  return () => {
    stopped = true;
    clearInterval(cleanup);
  };
}
