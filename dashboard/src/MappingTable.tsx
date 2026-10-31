import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Direction, type Fields, type Mapping, type Transform } from './api';

const DIRECTIONS: Array<{ value: Direction; label: string }> = [
  { value: 'bidirectional', label: 'Wix ⇄ HubSpot' },
  { value: 'wix_to_hubspot', label: 'Wix → HubSpot' },
  { value: 'hubspot_to_wix', label: 'HubSpot → Wix' },
];

const TRANSFORMS: Array<{ value: Transform; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'trim', label: 'Trim' },
  { value: 'lowercase', label: 'Lowercase' },
  { value: 'uppercase', label: 'Uppercase' },
];

/** Same rules as the server, so mistakes show up before saving. */
function validate(rows: Mapping[]): Map<number, string> {
  const errors = new Map<number, string>();
  const seenHs = new Map<string, number>();
  const seenInbound = new Map<string, number>();
  rows.forEach((r, i) => {
    if (!r.wixField || !r.hubspotProperty) return errors.set(i, 'Choose both fields');
    if (seenHs.has(r.hubspotProperty)) errors.set(i, 'HubSpot property already mapped');
    seenHs.set(r.hubspotProperty, i);
    if (r.direction !== 'wix_to_hubspot') {
      if (seenInbound.has(r.wixField)) errors.set(i, 'Wix field already receives a HubSpot value');
      seenInbound.set(r.wixField, i);
    }
  });
  return errors;
}

export function MappingTable() {
  const [fields, setFields] = useState<Fields | null>(null);
  const [rows, setRows] = useState<Mapping[]>([]);
  const [saved, setSaved] = useState<string>('');
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([api<Fields>('/api/fields'), api<{ mappings: Mapping[] }>('/api/mappings')]).then(([f, m]) => {
      setFields(f);
      setRows(m.mappings);
      setSaved(JSON.stringify(m.mappings));
    });
  }, []);

  const errors = useMemo(() => validate(rows), [rows]);
  const hasEmail = rows.some((r) => r.wixField === 'email' && r.hubspotProperty === 'email');
  const dirty = JSON.stringify(rows) !== saved;

  const update = (i: number, patch: Partial<Mapping>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function save() {
    setSaving(true);
    setServerErrors([]);
    try {
      const res = await api<{ mappings: Mapping[] }>('/api/mappings', { method: 'PUT', body: JSON.stringify({ mappings: rows }) });
      setRows(res.mappings);
      setSaved(JSON.stringify(res.mappings));
      setNotice('Mapping saved. New rules apply to the next change on either side.');
      setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      setServerErrors(e instanceof ApiError ? e.errors : [(e as Error).message]);
    } finally {
      setSaving(false);
    }
  }

  if (!fields) return <section className="card muted">Loading fields…</section>;

  const hsOptions = fields.hubspotProperties;
  const hsLabel = (name: string) => hsOptions.find((p) => p.name === name)?.label ?? name;

  return (
    <section className="card">
      <div className="row-between">
        <div>
          <h2>Field mapping</h2>
          <p className="muted">Choose which Wix contact fields sync to which HubSpot properties, and in which direction. Contacts are matched by email.</p>
        </div>
      </div>

      <table className="table mapping">
        <thead>
          <tr>
            <th>Wix field</th>
            <th>HubSpot property</th>
            <th>Sync direction</th>
            <th>Transform</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={errors.has(i) ? 'invalid' : undefined}>
              <td>
                <select value={r.wixField} onChange={(e) => update(i, { wixField: e.target.value })}>
                  <option value="">Select…</option>
                  {fields.wixFields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select value={r.hubspotProperty} onChange={(e) => update(i, { hubspotProperty: e.target.value })}>
                  <option value="">Select…</option>
                  {!hsOptions.some((p) => p.name === r.hubspotProperty) && r.hubspotProperty && <option value={r.hubspotProperty}>{hsLabel(r.hubspotProperty)}</option>}
                  {hsOptions.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.label} ({p.name})
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select value={r.direction} onChange={(e) => update(i, { direction: e.target.value as Direction })}>
                  {DIRECTIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select value={r.transform} onChange={(e) => update(i, { transform: e.target.value as Transform })}>
                  {TRANSFORMS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                {errors.has(i) && <div className="field-error">{errors.get(i)}</div>}
              </td>
              <td>
                <button className="icon-btn" aria-label="Remove row" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!hasEmail && <div className="banner error">Map “Email (primary)” to the HubSpot “email” property: it is used to match contacts.</div>}
      {serverErrors.map((e) => (
        <div key={e} className="banner error">
          {e}
        </div>
      ))}
      {notice && <div className="banner ok">{notice}</div>}

      <div className="row-between">
        <button className="btn secondary" onClick={() => setRows((rs) => [...rs, { wixField: '', hubspotProperty: '', direction: 'bidirectional', transform: 'none' }])}>
          + Add field
        </button>
        <div className="actions">
          {dirty && (
            <button className="btn link" onClick={() => setRows(JSON.parse(saved))}>
              Discard changes
            </button>
          )}
          <button className="btn primary" onClick={save} disabled={!dirty || saving || errors.size > 0 || !hasEmail}>
            {saving ? 'Saving…' : 'Save mapping'}
          </button>
        </div>
      </div>
    </section>
  );
}
