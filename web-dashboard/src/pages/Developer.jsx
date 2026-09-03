import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

export default function Developer() {
  const { t } = useT();
  const [tab, setTab] = useState('keys');
  const [keys, setKeys] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', scopes: 'read' });
  const [newKeyRaw, setNewKeyRaw] = useState('');
  const [showSim, setShowSim] = useState(false);
  const [simForm, setSimForm] = useState({ url: '', event: 'payment.received', payload: '{"amount":1000}' });
  const [pingResult, setPingResult] = useState(null);
  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('dev.error') });

  const load = () => {
    api.get('/developer/api-keys').then((r) => setKeys(r.data.keys)).catch(() => {});
    api.get('/developer/webhook/deliveries').then((r) => setDeliveries(r.data.deliveries)).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const createKey = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/developer/api-keys', { name: createForm.name, scopes: createForm.scopes.split(',').map((s) => s.trim()) });
      setNewKeyRaw(r.data.key.key);
      setMsg({ type: 'ok', text: t('dev.key_created') });
      setShowCreate(false);
      setCreateForm({ name: '', scopes: 'read' });
      load();
    } catch (err) { error(err); }
  };

  const revokeKey = async (id) => {
    try { await api.delete(`/developer/api-keys/${id}`); load(); } catch (err) { error(err); }
  };

  const deleteKey = async (id) => {
    if (!window.confirm(t('dev.confirm_delete'))) return;
    try { await api.delete(`/developer/api-keys/${id}/permanent`); load(); } catch (err) { error(err); }
  };

  const simulateWebhook = async (e) => {
    e.preventDefault();
    try {
      await api.post('/developer/webhook/simulate', { ...simForm, payload: JSON.parse(simForm.payload || '{}') });
      setMsg({ type: 'ok', text: t('dev.webhook_sent') });
      setShowSim(false);
      setSimForm({ url: '', event: 'payment.received', payload: '{"amount":1000}' });
      load();
    } catch (err) { error(err); }
  };

  const pingSandbox = async () => {
    try {
      const r = await api.get('/developer/sandbox/ping');
      setPingResult(r.data);
    } catch (err) { error(err); }
  };

  const TABS = [
    { key: 'keys', label: t('dev.tab_keys') },
    { key: 'sandbox', label: t('dev.tab_sandbox') },
    { key: 'webhooks', label: t('dev.tab_webhooks') },
  ];

  return (
    <div>
      <div className="page-head">
        <h2>{t('dev.title')}</h2>
        <p>{t('dev.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 24 }}>
        {TABS.map((tb) => (
          <button key={tb.key} className={`btn ${tab === tb.key ? '' : 'btn-secondary'}`} onClick={() => setTab(tb.key)} style={{ fontSize: 13 }}>
            {tb.label}
          </button>
        ))}
      </div>

      {/* API Keys Tab */}
      {tab === 'keys' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h3 style={{ margin: 0 }}>{t('dev.my_keys')}</h3>
            <button className="btn" onClick={() => { setShowCreate(true); setNewKeyRaw(''); }}>＋ {t('dev.new_key')}</button>
          </div>

          {newKeyRaw && (
            <div className="card" style={{ marginBottom: 24, border: '2px solid #059669', background: '#f0fdf4' }}>
              <h3 style={{ marginBottom: 8, color: '#059669' }}>{t('dev.save_key')}</h3>
              <p className="roles-tag" style={{ marginBottom: 10 }}>{t('dev.key_once')}</p>
              <code style={{ display: 'block', padding: 12, background: '#fff', borderRadius: 8, wordBreak: 'break-all', fontSize: 13, border: '1px solid #d1fae5' }}>{newKeyRaw}</code>
              <button className="btn" style={{ marginTop: 10 }} onClick={() => { navigator.clipboard.writeText(newKeyRaw); }}>{t('dev.copy')}</button>
            </div>
          )}

          {showCreate && !newKeyRaw && (
            <div className="card" style={{ marginBottom: 24 }}>
              <h3 style={{ marginBottom: 12 }}>{t('dev.new_key')}</h3>
              <form onSubmit={createKey} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>{t('dev.key_name')}<input type="text" value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} required placeholder={t('dev.key_name_ph')} /></label>
                <label>{t('dev.scopes')}<input type="text" value={createForm.scopes} onChange={(e) => setCreateForm({ ...createForm, scopes: e.target.value })} placeholder="read, write" /></label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="btn" type="submit">{t('dev.create')}</button>
                  <button className="btn btn-secondary" type="button" onClick={() => setShowCreate(false)}>✕</button>
                </div>
              </form>
            </div>
          )}

          {keys.length === 0 ? (
            <div className="card" style={{ padding: 20, textAlign: 'center' }}>
              <p className="roles-tag" style={{ fontSize: 30, marginBottom: 8 }}>🔑</p>
              <p className="roles-tag">{t('dev.no_keys')}</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('dev.name')}</th>
                    <th>{t('dev.prefix')}</th>
                    <th>{t('dev.scopes')}</th>
                    <th>{t('dev.last_used')}</th>
                    <th>{t('dev.status')}</th>
                    <th>{t('dev.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id}>
                      <td>{k.name}</td>
                      <td><code style={{ fontSize: 12 }}>{k.key_prefix}</code></td>
                      <td>{Array.isArray(k.scopes) ? k.scopes.join(', ') : k.scopes}</td>
                      <td>{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : '—'}</td>
                      <td><span className={`badge ${k.is_active ? 'success' : 'danger'}`}>{k.is_active ? t('dev.active') : t('dev.revoked')}</span></td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        {k.is_active && <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => revokeKey(k.id)}>{t('dev.revoke')}</button>}
                        <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12, color: '#dc2626' }} onClick={() => deleteKey(k.id)}>{t('dev.delete')}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Sandbox Tab */}
      {tab === 'sandbox' && (
        <div className="card" style={{ padding: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('dev.sandbox_title')}</h3>
          <p className="roles-tag" style={{ marginBottom: 16 }}>{t('dev.sandbox_hint')}</p>
          <button className="btn" onClick={pingSandbox}>{t('dev.ping')}</button>
          {pingResult && (
            <pre style={{ marginTop: 14, padding: 14, background: '#f8faf9', borderRadius: 10, fontSize: 13, overflowX: 'auto' }}>
              {JSON.stringify(pingResult, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* Webhook Simulator Tab */}
      {tab === 'webhooks' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h3 style={{ margin: 0 }}>{t('dev.webhook_sim')}</h3>
            <button className="btn" onClick={() => setShowSim(true)}>＋ {t('dev.simulate')}</button>
          </div>

          {showSim && (
            <div className="card" style={{ marginBottom: 24 }}>
              <h3 style={{ marginBottom: 12 }}>{t('dev.simulate')}</h3>
              <form onSubmit={simulateWebhook} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>{t('dev.webhook_url')}<input type="url" value={simForm.url} onChange={(e) => setSimForm({ ...simForm, url: e.target.value })} required placeholder="https://your-app.com/webhook" /></label>
                <label>{t('dev.event')}<input type="text" value={simForm.event} onChange={(e) => setSimForm({ ...simForm, event: e.target.value })} required /></label>
                <label>{t('dev.payload')}<textarea value={simForm.payload} onChange={(e) => setSimForm({ ...simForm, payload: e.target.value })} rows={4} style={{ fontFamily: 'monospace', fontSize: 13 }} /></label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="btn" type="submit">{t('dev.send')}</button>
                  <button className="btn btn-secondary" type="button" onClick={() => setShowSim(false)}>✕</button>
                </div>
              </form>
            </div>
          )}

          {deliveries.length === 0 ? (
            <div className="card" style={{ padding: 20, textAlign: 'center' }}>
              <p className="roles-tag" style={{ fontSize: 30, marginBottom: 8 }}>📡</p>
              <p className="roles-tag">{t('dev.no_deliveries')}</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('dev.date')}</th>
                    <th>{t('dev.event')}</th>
                    <th>{t('dev.webhook_url')}</th>
                    <th>{t('dev.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((d) => (
                    <tr key={d.id}>
                      <td>{new Date(d.delivered_at).toLocaleString()}</td>
                      <td>{d.event}</td>
                      <td style={{ wordBreak: 'break-all', fontSize: 12, maxWidth: 260 }}>{d.url}</td>
                      <td><span className={`badge ${d.response_status < 400 ? 'success' : 'danger'}`}>{d.response_status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}