import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

function money(v) {
  return (Number(v) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export default function Banking() {
  const { t } = useT();
  const [tab, setTab] = useState('limits');
  const [limits, setLimits] = useState([]);
  const [beneficiaries, setBeneficiaries] = useState([]);
  const [devices, setDevices] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [bForm, setBForm] = useState({ phone: '', name: '', nickname: '' });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('banking.error') });
  const ok = (text) => { setMsg({ type: 'ok', text }); };

  const load = () => {
    api.get('/banking/limits').then((r) => setLimits(r.data.limits || [])).catch(() => {});
    api.get('/banking/beneficiaries').then((r) => setBeneficiaries(r.data.beneficiaries || [])).catch(() => {});
    api.get('/banking/devices').then((r) => setDevices(r.data.devices || [])).catch(() => {});
    api.get('/banking/sessions').then((r) => setSessions(r.data.sessions || [])).catch(() => {});
    api.get('/banking/fraud/alerts').then((r) => setAlerts(r.data.alerts || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const addBeneficiary = async (e) => {
    e.preventDefault();
    try {
      await api.post('/banking/beneficiaries', bForm);
      ok(t('banking.beneficiary_added'));
      setBForm({ phone: '', name: '', nickname: '' });
      load();
    } catch (err) { error(err); }
  };

  const deleteBeneficiary = async (id) => {
    try { await api.delete(`/banking/beneficiaries/${id}`); ok(t('banking.beneficiary_removed')); load(); }
    catch (err) { error(err); }
  };

  const trustDevice = async () => {
    try {
      await api.post('/banking/devices/trust', { name: 'Current Device' });
      ok(t('banking.device_trusted'));
      load();
    } catch (err) { error(err); }
  };

  const removeDevice = async (id) => {
    try { await api.delete(`/banking/devices/${id}`); ok(t('banking.device_removed')); load(); }
    catch (err) { error(err); }
  };

  const terminateSession = async (id) => {
    try { await api.delete(`/banking/sessions/${id}`); ok(t('banking.session_ended')); load(); }
    catch (err) { error(err); }
  };

  const terminateAll = async () => {
    try { await api.delete('/banking/sessions'); ok(t('banking.all_sessions_ended')); load(); }
    catch (err) { error(err); }
  };

  const tabs = [
    { id: 'limits', label: t('banking.limits_tab') },
    { id: 'benef', label: t('banking.benef_tab') },
    { id: 'devices', label: t('banking.devices_tab') },
    { id: 'fraud', label: t('banking.fraud_tab') },
  ];

  return (
    <div>
      <div className="page-head">
        <h2>{t('banking.title')}</h2>
        <p>{t('banking.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {tabs.map((tb) => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            style={{ padding: '9px 18px', borderRadius: 10, border: '1px solid #cbd5e1', cursor: 'pointer', fontWeight: 600, background: tab === tb.id ? '#0ea5e9' : '#fff', color: tab === tb.id ? '#fff' : '#334155' }}>
            {tb.label}
          </button>
        ))}
      </div>

      {tab === 'limits' && (
        <div className="card">
          <h3 style={{ margin: '0 0 14px' }}>{t('banking.limits_tab')}</h3>
          {limits.length === 0 ? (
            <p className="roles-tag">{t('banking.limits_empty')}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('banking.limit_type')}</th>
                    <th>{t('banking.txn_type')}</th>
                    <th>{t('banking.max_amount')}</th>
                    <th>{t('banking.used')}</th>
                    <th>{t('banking.remaining')}</th>
                    <th>{t('banking.period')}</th>
                  </tr>
                </thead>
                <tbody>
                  {limits.map((l, i) => {
                    const used = Number(l.used_amount) || 0;
                    const max = Number(l.max_amount) || 0;
                    const rem = Math.max(0, max - used);
                    const pct = max ? Math.min(100, (used / max) * 100) : 0;
                    return (
                      <tr key={l.id || i}>
                        <td><span className="badge info">{l.limit_type}</span></td>
                        <td>{l.transaction_type}</td>
                        <td>{money(max)}</td>
                        <td>{money(used)}</td>
                        <td>{money(rem)}</td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 140 }}>
                            <div style={{ flex: 1, height: 8, borderRadius: 6, background: '#e2e8f0', overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${pct}%`, borderRadius: 6, background: pct >= 80 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#22c55e' }} />
                            </div>
                            <span style={{ fontSize: 12 }}>{pct.toFixed(0)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'benef' && (
        <div>
          <div className="card" style={{ marginBottom: 24, maxWidth: 560 }}>
            <h3 style={{ marginBottom: 12 }}>{t('banking.benef_add')}</h3>
            <form onSubmit={addBeneficiary} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label>{t('banking.name')}<input value={bForm.name} onChange={(e) => setBForm({ ...bForm, name: e.target.value })} required /></label>
              <label>{t('banking.phone')}<input value={bForm.phone} onChange={(e) => setBForm({ ...bForm, phone: e.target.value })} required /></label>
              <label>{t('banking.nickname')}<input value={bForm.nickname} onChange={(e) => setBForm({ ...bForm, nickname: e.target.value })} /></label>
              <button className="btn" type="submit">{t('banking.benef_add')}</button>
            </form>
          </div>

          <div className="card">
            {beneficiaries.length === 0 ? (
              <p className="roles-tag">{t('banking.benef_empty')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('banking.name')}</th>
                      <th>{t('banking.phone')}</th>
                      <th>{t('banking.nickname')}</th>
                      <th>{t('banking.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {beneficiaries.map((b) => (
                      <tr key={b.id}>
                        <td><strong>{b.name}</strong></td>
                        <td>{b.phone}</td>
                        <td>{b.nickname || '—'}</td>
                        <td>
                          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => deleteBeneficiary(b.id)}>{t('banking.remove')}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'devices' && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <button className="btn" onClick={trustDevice}>＋ {t('banking.device_trust_btn')}</button>
            <button className="btn btn-secondary" onClick={terminateAll}>🔒 {t('banking.end_all_btn')}</button>
          </div>

          <h3 style={{ margin: '0 0 14px' }}>{t('banking.devices')}</h3>
          <div className="card" style={{ marginBottom: 24 }}>
            {devices.length === 0 ? (
              <p className="roles-tag">{t('banking.devices_empty')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('banking.device')}</th>
                      <th>{t('banking.last_used')}</th>
                      <th>{t('banking.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((d) => (
                      <tr key={d.id}>
                        <td><strong>{d.device_name || d.name || d.device_fingerprint || 'Device'}</strong> {d.is_trusted && <span className="badge success">Trusted</span>}</td>
                        <td>{d.last_used_at ? new Date(d.last_used_at).toLocaleString() : '—'}</td>
                        <td><button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => removeDevice(d.id)}>{t('banking.remove')}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <h3 style={{ margin: '0 0 14px' }}>{t('banking.sessions')}</h3>
          <div className="card">
            {sessions.length === 0 ? (
              <p className="roles-tag">{t('banking.sessions_empty')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('banking.device')}</th>
                      <th>IP</th>
                      <th>{t('banking.last_active')}</th>
                      <th>{t('banking.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr key={s.id}>
                        <td>{s.device_name || s.device || 'Session'} {s.os ? `(${s.os})` : ''}</td>
                        <td>{s.ip_address || '—'}</td>
                        <td>{s.last_active_at ? new Date(s.last_active_at).toLocaleString() : '—'}</td>
                        <td><button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => terminateSession(s.id)}>{t('banking.end')}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'fraud' && (
        <div className="card">
          <h3 style={{ margin: '0 0 14px' }}>{t('banking.fraud_alerts')}</h3>
          {alerts.length === 0 ? (
            <p className="roles-tag">{t('banking.fraud_empty')}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('banking.severity')}</th>
                    <th>{t('banking.reason')}</th>
                    <th>{t('banking.date')}</th>
                    <th>{t('banking.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((a) => (
                    <tr key={a.id}>
                      <td><span className={`badge ${a.severity === 'HIGH' ? 'danger' : a.severity === 'MEDIUM' ? 'warning' : 'info'}`}>{a.severity}</span></td>
                      <td>{a.reason || a.description || '—'}</td>
                      <td>{new Date(a.created_at).toLocaleString()}</td>
                      <td><span className={`badge ${a.is_resolved ? 'success' : 'warning'}`}>{a.is_resolved ? 'Resolved' : 'Open'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}