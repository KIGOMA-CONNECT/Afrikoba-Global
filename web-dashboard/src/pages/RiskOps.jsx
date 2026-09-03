import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

const SEVERITY_COLOR = { CRITICAL: '#dc2626', HIGH: '#dc2626', MEDIUM: '#d97706', LOW: '#2563eb', INFO: '#059669' };

export default function RiskOps() {
  const { t } = useT();
  const [tab, setTab] = useState('approvals');
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [flows, setFlows] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [cases, setCases] = useState([]);
  const [countries, setCountries] = useState([]);
  const [kpis, setKpis] = useState(null);
  const [types, setTypes] = useState([]);
  const [selectedCase, setSelectedCase] = useState(null);
  const [showNewCase, setShowNewCase] = useState(false);
  const [caseForm, setCaseForm] = useState({ alert_id: '', user_id: '', risk_level: 'MEDIUM' });
  const [noteForm, setNoteForm] = useState('');
  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || 'Action failed.' });

  const load = () => {
    api.get('/admin/approvals').then((r) => setFlows(r.data.flows)).catch(() => {});
    api.get('/admin/fraud/alerts').then((r) => setAlerts(r.data.alerts)).catch(() => {});
    api.get('/admin/aml/cases').then((r) => setCases(r.data.cases)).catch(() => {});
    api.get('/admin/countries').then((r) => setCountries(r.data.countries)).catch(() => {});
    api.get('/admin/metrics/kpis').then((r) => setKpis(r.data.kpis)).catch(() => {});
    api.get('/admin/metrics/types').then((r) => setTypes(r.data.types)).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const decideFlow = async (id, action) => {
    try {
      await api.post(`/admin/approvals/${id}/decide`, { action });
      load();
    } catch (err) { error(err); }
  };

  const resolveAlert = async (id) => {
    try { await api.post(`/admin/fraud/alerts/${id}/resolve`); load(); } catch (err) { error(err); }
  };

  const openCase = async (e) => {
    e.preventDefault();
    try {
      await api.post('/admin/aml/cases', { ...caseForm, user_id: caseForm.user_id ? Number(caseForm.user_id) : null, alert_id: caseForm.alert_id ? Number(caseForm.alert_id) : null });
      setMsg({ type: 'ok', text: 'AML case opened.' });
      setShowNewCase(false);
      setCaseForm({ alert_id: '', user_id: '', risk_level: 'MEDIUM' });
      load();
    } catch (err) { error(err); }
  };

  const addNote = async (e) => {
    e.preventDefault();
    if (!selectedCase || !noteForm) return;
    try {
      await api.post(`/admin/aml/cases/${selectedCase.case.id}/notes`, { note: noteForm });
      const r = await api.get(`/admin/aml/cases/${selectedCase.case.id}`);
      setSelectedCase(r.data);
      setNoteForm('');
    } catch (err) { error(err); }
  };

  const updateCaseStatus = async (id, status) => {
    try {
      await api.put(`/admin/aml/cases/${id}`, { status });
      setMsg({ type: 'ok', text: `Case ${status}.` });
      setSelectedCase(null);
      load();
    } catch (err) { error(err); }
  };

  const viewCase = async (id) => {
    try {
      const r = await api.get(`/admin/aml/cases/${id}`);
      setSelectedCase(r.data);
    } catch (err) { error(err); }
  };

  const TABS = [
    { key: 'approvals', label: t('risk.tab_approvals') },
    { key: 'aml', label: t('risk.tab_aml') },
    { key: 'fraud', label: t('risk.tab_fraud') },
    { key: 'bi', label: t('risk.tab_bi') },
    { key: 'countries', label: t('risk.tab_countries') },
  ];

  return (
    <div>
      <div className="page-head">
        <h2>{t('risk.title')}</h2>
        <p>{t('risk.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>{msg.text}</div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 24, flexWrap: 'wrap' }}>
        {TABS.map((tb) => (
          <button key={tb.key} className={`btn ${tab === tb.key ? '' : 'btn-secondary'}`} onClick={() => setTab(tb.key)} style={{ fontSize: 13 }}>{tb.label}</button>
        ))}
      </div>

      {/* ===== APPROVALS ===== */}
      {tab === 'approvals' && (
        <div className="card section">
          <h3>{t('risk.approvals_title')}</h3>
          <p className="roles-tag" style={{ marginBottom: 12 }}>{t('risk.approvals_hint')}</p>
          {flows.length === 0 ? <p className="roles-tag">{t('risk.no_approvals')}</p> : (
            <table className="table">
              <thead><tr><th>ID</th><th>{t('risk.requester')}</th><th>{t('risk.action_type')}</th><th>{t('risk.ref')}</th><th>{t('risk.data')}</th><th>{t('risk.status')}</th><th>{t('risk.actions')}</th></tr></thead>
              <tbody>
                {flows.map((f) => (
                  <tr key={f.id}>
                    <td>{f.id}</td>
                    <td>{f.requester_name} <div className="roles-tag">{f.requester_phone}</div></td>
                    <td>{f.action_type}</td>
                    <td>{f.ref_type}{f.ref_id ? ` #${f.ref_id}` : '—'}</td>
                    <td style={{ fontSize: 12 }}>{JSON.stringify(f.data || {}).slice(0, 60)}</td>
                    <td><span className={`badge ${f.status === 'APPROVED' ? 'success' : f.status === 'REJECTED' ? 'danger' : 'info'}`}>{f.status}</span></td>
                    <td>
                      {f.status === 'PENDING' && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => decideFlow(f.id, 'APPROVE')}>✓ {t('risk.approve')}</button>
                          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12, color: '#dc2626' }} onClick={() => decideFlow(f.id, 'REJECT')}>✕ {t('risk.reject')}</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ===== AML CASES ===== */}
      {tab === 'aml' && (
        <div className="card section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3>{t('risk.aml_title')}</h3>
            <button className="btn" onClick={() => setShowNewCase(!showNewCase)}>＋ {t('risk.new_case')}</button>
          </div>

          {showNewCase && (
            <form onSubmit={openCase} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, padding: 14, background: '#f8faf9', borderRadius: 10 }}>
              <input type="number" placeholder={t('risk.alert_id')} value={caseForm.alert_id} onChange={(e) => setCaseForm({ ...caseForm, alert_id: e.target.value })} style={{ flex: 1, minWidth: 120 }} />
              <input type="number" placeholder={t('risk.user_id')} value={caseForm.user_id} onChange={(e) => setCaseForm({ ...caseForm, user_id: e.target.value })} style={{ flex: 1, minWidth: 120 }} />
              <select value={caseForm.risk_level} onChange={(e) => setCaseForm({ ...caseForm, risk_level: e.target.value })} style={{ padding: '6px 8px' }}>
                <option value="LOW">LOW</option><option value="MEDIUM">MEDIUM</option><option value="HIGH">HIGH</option><option value="CRITICAL">CRITICAL</option>
              </select>
              <button className="btn" type="submit">{t('risk.open')}</button>
            </form>
          )}

          {cases.length === 0 ? <p className="roles-tag">{t('risk.no_cases')}</p> : (
            <table className="table">
              <thead><tr><th>ID</th><th>{t('risk.user')}</th><th>{t('risk.type')}</th><th>{t('risk.risk')}</th><th>{t('risk.assigned')}</th><th>{t('risk.status')}</th><th>{t('risk.actions')}</th></tr></thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td>{c.id}</td>
                    <td>{c.user_name || c.user_id || '—'} <div className="roles-tag">{c.user_phone || ''}</div></td>
                    <td>{c.case_type}</td>
                    <td><span className="badge" style={{ background: `${SEVERITY_COLOR[c.risk_level]}22`, color: SEVERITY_COLOR[c.risk_level], border: `1px solid ${SEVERITY_COLOR[c.risk_level]}55` }}>{c.risk_level}</span></td>
                    <td>{c.assigned_name || '—'}</td>
                    <td><span className={`badge ${c.status === 'CLOSED' ? 'danger' : c.status === 'RESOLVED' ? 'success' : 'info'}`}>{c.status}</span></td>
                    <td><button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => viewCase(c.id)}>{t('risk.view')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {selectedCase && (
            <div className="card" style={{ marginTop: 16, padding: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>#{selectedCase.case.id} — {selectedCase.case.case_type}</h3>
                <button className="btn btn-secondary" onClick={() => setSelectedCase(null)}>✕</button>
              </div>
              <p className="roles-tag" style={{ marginTop: 8 }}>{selectedCase.case.summary || '—'}</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
                <button className="btn" style={{ fontSize: 12 }} onClick={() => updateCaseStatus(selectedCase.case.id, 'INVESTIGATING')}>{t('risk.investigate')}</button>
                <button className="btn" style={{ fontSize: 12 }} onClick={() => updateCaseStatus(selectedCase.case.id, 'RESOLVED')}>{t('risk.resolve')}</button>
                <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => updateCaseStatus(selectedCase.case.id, 'CLOSED')}>{t('risk.close')}</button>
              </div>
              <h4 style={{ margin: '12px 0 6px' }}>{t('risk.notes')}</h4>
              {selectedCase.notes.length === 0 ? <p className="roles-tag">{t('risk.no_notes')}</p> : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {selectedCase.notes.map((n) => (
                    <li key={n.id} style={{ marginBottom: 6, fontSize: 13 }}>
                      <strong>{n.author_name}:</strong> {n.note} <span className="roles-tag" style={{ fontSize: 11 }}>{new Date(n.created_at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
              <form onSubmit={addNote} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input type="text" placeholder={t('risk.add_note')} value={noteForm} onChange={(e) => setNoteForm(e.target.value)} style={{ flex: 1 }} required />
                <button className="btn" type="submit">{t('risk.post')}</button>
              </form>
            </div>
          )}
        </div>
      )}

      {/* ===== FRAUD ALERTS ===== */}
      {tab === 'fraud' && (
        <div className="card section">
          <h3>{t('risk.fraud_title')}</h3>
          {alerts.length === 0 ? <p className="roles-tag">{t('risk.no_alerts')}</p> : (
            <table className="table">
              <thead><tr><th>ID</th><th>{t('risk.user')}</th><th>{t('risk.type')}</th><th>{t('risk.severity')}</th><th>{t('risk.desc')}</th><th>{t('risk.actions')}</th></tr></thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id}>
                    <td>{a.id}</td>
                    <td>{a.user_id}</td>
                    <td>{a.alert_type}</td>
                    <td><span className="badge" style={{ background: `${SEVERITY_COLOR[a.severity]}22`, color: SEVERITY_COLOR[a.severity], border: `1px solid ${SEVERITY_COLOR[a.severity]}55` }}>{a.severity}</span></td>
                    <td style={{ fontSize: 13 }}>{a.description}</td>
                    <td><button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => resolveAlert(a.id)}>{t('risk.resolve')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ===== BI / OBSERVABILITY ===== */}
      {tab === 'bi' && kpis && (
        <div>
          <div className="grid grid-4" style={{ marginBottom: 20 }}>
            <div className="card stat"><div className="value">{kpis.users}</div><div className="label">{t('admin.users')}</div></div>
            <div className="card stat"><div className="value">{formatMoney(kpis.monthlyVolume)}</div><div className="label">{t('risk.monthly_volume')}</div></div>
            <div className="card stat"><div className="value">{formatMoney(kpis.monthlyFees)}</div><div className="label">{t('risk.monthly_fees')}</div></div>
            <div className="card stat"><div className="value">{kpis.monthlyTransactions}</div><div className="label">{t('risk.monthly_txns')}</div></div>
          </div>
          <div className="grid grid-3" style={{ marginBottom: 20 }}>
            <div className="card stat"><div className="value">{kpis.activeVaults}</div><div className="label">{t('risk.active_vaults')}</div></div>
            <div className="card stat"><div className="value">{kpis.openAmlCases}</div><div className="label">{t('risk.open_aml')}</div></div>
            <div className="card stat"><div className="value">{kpis.pendingApprovals}</div><div className="label">{t('risk.pending_approvals')}</div></div>
          </div>
          <div className="card section">
            <h3>{t('risk.txn_types')}</h3>
            {types.length === 0 ? <p className="roles-tag">{t('risk.no_data')}</p> : (
              <table className="table">
                <thead><tr><th>{t('risk.type')}</th><th>{t('risk.count')}</th><th>{t('risk.volume')}</th></tr></thead>
                <tbody>
                  {types.map((ty) => (
                    <tr key={ty.type}>
                      <td>{ty.type}</td>
                      <td>{ty.count}</td>
                      <td>{formatMoney(ty.volume)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ===== COUNTRIES / CROSS-BORDER ===== */}
      {tab === 'countries' && (
        <div className="card section">
          <h3>{t('risk.countries_title')}</h3>
          <table className="table">
            <thead><tr><th>{t('risk.code')}</th><th>{t('risk.country')}</th><th>{t('risk.region')}</th><th>{t('risk.currency')}</th><th>{t('risk.min_fee')}</th><th>{t('risk.percent_fee')}</th><th>{t('risk.status')}</th></tr></thead>
            <tbody>
              {countries.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.code}</strong></td>
                  <td>{c.name}</td>
                  <td>{c.region}</td>
                  <td>{c.currency}</td>
                  <td>{formatMoney(c.min_fee)}</td>
                  <td>{(Number(c.percent_fee) * 100).toFixed(2)}%</td>
                  <td><span className={`badge ${c.is_active ? 'success' : 'danger'}`}>{c.is_active ? 'Active' : 'Inactive'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}