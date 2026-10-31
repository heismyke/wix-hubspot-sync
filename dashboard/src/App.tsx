import { useCallback, useEffect, useState } from 'react';
import { api, hasInstance, type Activity, type Status } from './api';
import { MappingTable } from './MappingTable';

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<Status>('/api/status'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (hasInstance) void refresh();
  }, [refresh]);

  // The OAuth popup posts a message when it finishes; poll as a fallback (popup blockers, COOP).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'hubspot-connected') void refresh();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refresh]);

  async function connect() {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>('/api/hubspot/connect', { method: 'POST' });
      const popup = window.open(url, 'hubspot-oauth', 'width=640,height=760');
      if (!popup) window.location.href = url;
      const started = Date.now();
      const timer = window.setInterval(async () => {
        const s = await api<Status>('/api/status').catch(() => null);
        if (s?.connected || Date.now() - started > 180_000) {
          window.clearInterval(timer);
          if (s) setStatus(s);
          setBusy(false);
        }
      }, 2000);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect HubSpot? Syncing stops and stored tokens are revoked and deleted.')) return;
    setBusy(true);
    try {
      await api('/api/hubspot/disconnect', { method: 'POST' });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!hasInstance) {
    return (
      <main className="page">
        <div className="card">
          <h2>Open this page from your Wix dashboard</h2>
          <p className="muted">This app runs inside the Wix site dashboard, which provides the signed site instance it needs.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="header">
        <div>
          <h1>HubSpot Sync</h1>
          <p className="muted">Two-way contact sync and form lead capture between this Wix site and HubSpot.</p>
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}

      <section className="card">
        <div className="row-between">
          <div>
            <h2>Connection</h2>
            {status?.connected ? (
              <p>
                <span className="dot ok" /> Connected to HubSpot account <strong>{status.hubspot?.hubDomain ?? status.hubspot?.portalId}</strong>
                <span className="muted"> · since {new Date(status.hubspot!.connectedAt).toLocaleString()}</span>
              </p>
            ) : (
              <p>
                <span className="dot" /> Not connected
              </p>
            )}
          </div>
          {status?.connected ? (
            <button className="btn secondary" onClick={disconnect} disabled={busy}>
              Disconnect
            </button>
          ) : (
            <button className="btn primary" onClick={connect} disabled={busy || !status}>
              {busy ? 'Waiting for HubSpot…' : 'Connect HubSpot'}
            </button>
          )}
        </div>
        {status?.connected && (
          <p className="muted small">Permissions granted: {status.hubspot?.scopes.join(', ')}</p>
        )}
      </section>

      {status?.connected && (
        <>
          <MappingTable />
          <TrackingCard snippet={status.trackingSnippet} />
          <ActivityCard />
        </>
      )}
    </main>
  );
}

function TrackingCard({ snippet }: { snippet: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="card">
      <h2>Form attribution</h2>
      <p className="muted">
        Wix form submissions are sent to HubSpot automatically. To include UTM source, referrer and page URL, this script must run on the site. It is
        added by the app's embedded script; if your plan doesn't support that, paste it under <em>Settings → Custom code → Body – end</em>.
      </p>
      <pre className="code">{snippet}</pre>
      <button
        className="btn secondary"
        onClick={async () => {
          await navigator.clipboard.writeText(snippet);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy snippet'}
      </button>
      <p className="muted small">
        Stored on the HubSpot contact in the “Wix integration” property group: <code>wix_utm_source/medium/campaign/term/content</code>,{' '}
        <code>wix_first_utm_*</code>, <code>wix_form_page_url</code>, <code>wix_form_referrer</code>, <code>wix_form_submitted_at</code>.
      </p>
    </section>
  );
}

const ACTION_LABELS: Record<string, string> = {
  created_in_hubspot: 'Created in HubSpot',
  updated_hubspot: 'Updated HubSpot',
  created_in_wix: 'Created in Wix',
  updated_wix: 'Updated Wix',
  linked_no_change: 'Linked (already in sync)',
  skipped_no_change: 'Ignored: no change / own echo',
  skipped_no_email: 'Skipped: no email',
  conflict_hubspot_newer: 'Conflict: HubSpot newer, HubSpot wins',
  conflict_wix_newer: 'Conflict: Wix newer, Wix wins',
  form_created_in_hubspot: 'Form lead created in HubSpot',
  form_updated_hubspot: 'Form lead updated HubSpot',
  attribution_applied: 'Attribution applied',
};

function ActivityCard() {
  const [data, setData] = useState<Activity | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => api<Activity>('/api/activity').then(setData).catch(() => undefined), []);
  useEffect(() => {
    void load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, [load]);

  async function backfill() {
    const r = await api<{ enqueued: number }>('/api/sync/backfill', { method: 'POST' });
    setMessage(`Queued ${r.enqueued} existing Wix contacts for sync.`);
    void load();
  }

  return (
    <section className="card">
      <div className="row-between">
        <h2>Sync activity</h2>
        <button className="btn secondary" onClick={backfill}>
          Sync existing contacts
        </button>
      </div>
      {message && <div className="banner ok">{message}</div>}
      {data && (
        <div className="stats">
          <Stat label="Linked contacts" value={data.stats.linked} />
          <Stat label="Form submissions" value={data.stats.submissions} />
          <Stat label="Queued" value={data.stats.pending} />
          <Stat label="Failed (24h)" value={data.stats.failed} />
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Source</th>
            <th>Result</th>
            <th>Wix ID</th>
            <th>HubSpot ID</th>
          </tr>
        </thead>
        <tbody>
          {data?.events.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No activity yet. Edit a contact in Wix or HubSpot, or submit a form.
              </td>
            </tr>
          )}
          {data?.events.map((e, i) => (
            <tr key={i} title={e.sync_id ? `syncId ${e.sync_id}` : undefined}>
              <td className="nowrap">{new Date(e.at).toLocaleTimeString()}</td>
              <td>
                <span className={`tag ${e.source}`}>{e.source}</span>
              </td>
              <td>
                {ACTION_LABELS[e.action] ?? e.action}
                {e.detail && <span className="muted small"> · {e.detail}</span>}
              </td>
              <td className="mono">{e.wix_contact_id?.slice(0, 8) ?? '–'}</td>
              <td className="mono">{e.hubspot_contact_id ?? '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}
