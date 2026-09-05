import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

const SEVERITY_COLOR = { CRITICAL: '#dc2626', HIGH: '#dc2626', MEDIUM: '#d97706', LOW: '#2563eb', INFO: '#059669' };
const STATUS_BADGE = { OPEN: 'danger', INVESTIGATING: 'info', RESOLVED: 'success', CLOSED: 'danger' };

export default function FraudOps() {
  const { t } = useT();
  const [tab, setTab] = useState('overview');
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [dash, setDash] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [cases, setCases] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [selectedCase, setSelectedCase] = useState(null);
  const [noteForm, setNoteForm] = useState('');
  const [showNewCase, setShowNewCase] = useState(false);
  const [caseForm, setCaseForm] = useState({ user_id: '', alert_id: '', case_type: 'SUSPICIOUS_ACTIVITY', risk_level: 'MEDIUM', summary: '', assigned_to: '' });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('fraudops.error') });

  const load = () => {
    api.get('/fraud-ops/dashboard').then((r) => setDash(r.data.dashboard)).catch(() => {});
    api.get('/fraud-ops/alerts', { params: { open: true } }).then((r) => setAlerts(r.data.alerts)).catch(() => {});
    api.get('/fraud-ops/cases').then((r) => setCases(r.data.cases)).catch(() => {});
    api.get('/fraud-ops/risk-profiles', { params: { limit: 50 } }).then((r) => setProfiles(r.data.profiles)).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const resolveAlert = async (id) => {
    try { await api.post(`/fraud-ops/alerts/${id}/resolve`); setMsg({ type: 'ok', text: t('fraudops.resolved_ok') }); load(); } catch (err) { error(err); }
  };

  const openCase = async (e) => {
    e.preventDefault();
    try {
      await api.post('/fraud-ops/cases', {
        ...caseForm,
        user_id: caseForm.user_id ? Number(caseForm.user_id) : null,
        alert_id: caseForm.alert_id ? Number(caseForm.alert_id) : null,
        assigned_to: caseForm.assigned_to ? Number(caseForm.assigned_to) : null,
      });
      setMsg({ type: 'ok', text: t('fraudops.case_opened') });
      setShowNewCase(false);
      setCaseForm({ user_id: '', alert_id: '', case_type: 'SUSPICIOUS_ACTIVITY', risk_level: 'MEDIUM', summary: '', assigned_to: '' });
      load();
    } catch (err) { error(err); }
  };

  const viewCase = async (id) => {
    try { const r = await api.get(`/fraud-ops/cases/${id}`); setSelectedCase(r.data.case); } catch (err) { error(err); }
  };

  const updateCase = async (id, body) => {
    try { await api.put(`/fraud-ops/cases/${id}`, body); setMsg({ type: 'ok', text: t('fraudops.case_updated') }); setSelectedCase(null); load(); } catch (err) { error(err); }
  };

  const addNote = async (e) => {
    e.preventDefault();
    if (!selectedCase || !noteForm) return;
    try {
      await api.post(`/fraud-ops/cases/${selectedCase.case.id}/notes`, { note: noteForm });
      const r = await api.get(`/fraud-ops/cases/${selectedCase.case.id}`);
      setSelectedCase(r.data.case);
      setNoteForm('');
    } catch (err) { error(err); }
  };

  const openCount = (arr) => (arr || []).filter((a) => a.status === 'OPEN').length;

  const TABS = [
    { key: 'overview', label: t('fraudops.tab_overview') },
    { key: 'alerts', label: t('fraudops.tab_alerts') },
    { key: 'cases', label: t('fraudops.tab_cases') },
    { key: 'risk', label: t('fraudops.tab_risk') },
  ];

  const stat = (label, value, color) => (
    <div className="card" style={{ flex: '1 1 180px', padding: 14 }}>
      <div className="roles-tag">{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: color || '#0b7a41' }}>{value ?? '—'}</div>
    </div>
  );

  return (
    <div>
      <div className="page-head">
        <h2>{t('fraudops.title')}</h2>
        <p>{t('fraudops.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>{msg.text}</div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 24, flexWrap: 'wrap' }}>
        {TABS.map((tb) => (
          <button key={tb.key} className={`btn ${tab === tb.key ? '' : 'btn-secondary'}`} onClick={() => setTab(tb.key)} style={{ fontSize: 13 }}>{tb.label}</button>
        ))}
      </div>

      {/* ===== OVERVIEW ===== */}
      {tab === 'overview' && (
        <div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            {stat(t('fraudops.open_alerts'), dash?.alerts?.open, '#dc2626')}
            {stat(t('fraudops.open_cases'), dash?.cases?.open, '#d97706')}
            {stat(t('fraudops.critical_risk'), dash?.risk?.by_level?.find((l) => l.risk_level === 'CRITICAL')?.n || 0, '#dc2626')}
            {stat(t('fraudops.total_alerts'), dash?.alerts?.total)}
          </div>

          <div className="card section">
            <h3>{t('fraudops.severity')}</h3>
            {(dash?.alerts?.by_severity || []).length === 0 ? <p className="roles-tag">{t('fraudops.empty')}</p> : (
              dash.alerts.by_severity.map((s) => (
                <div key={s.severity} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span className="badge" style={{ minWidth: 80, background: `${SEVERITY_COLOR[s.severity] || '#888'}22`, color: SEVERITY_COLOR[s.severity] || '#888', border: `1px solid ${SEVERITY_COLOR[s.severity] || '#888'}55` }}>{s.severity}</span>
                  <div style={{ flex: 1, background: '#eef2ef', borderRadius: 6, height: 14 }}>
                    <div style={{ width: `${Math.min(100, (s.n / Math.max(1, Math.max(...dash.alerts.by_severity.map((x) => x.n)))) * 100)}%`, background: SEVERITY_COLOR[s.severity] || '#888', height: 14, borderRadius: 6 }} />
                  </div>
                  <b style={{ width: 40, textAlign: 'right' }}>{s.n}</b>
                </div>
              ))
            )}
          </div>

          <div className="card section">
            <h3>{t('fraudops.avg_risk_score')}: <b>{dash?.risk?.avg_score ?? '—'}</b> · {t('fraudops.profiled_users')}: {dash?.risk?.profiled_users ?? '—'}</h3>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {(dash?.risk?.by_level || []).map((l) => (
                <span key={l.risk_level} className="badge info">{l.risk_level}: {l.n}</span>
              ))}
            </div>
          </div>

          <div className="card section">
            <h3>{t('fraudops.priority_alerts')}</h3>
            {(dash?.priority?.alerts || []).length === 0 ? <p className="roles-tag">{t('fraudops.empty')}</p> : (
              <table className="table">
                <thead><tr><th>ID</th><th>{t('fraudops.user')}</th><th>{t('fraudops.type')}</th><th>{t('fraudops.severity')}</th><th>{t('fraudops.notice')}</th></tr></thead>
                <tbody>
                  {dash.priority.alerts.map((a) => (
                    <tr key={a.id}>
                      <td>{a.id}</td>
                      <td>{a.full_name || a.user_id} <div className="roles-tag">{a.phone_number || ''}</div></td>
                      <td>{a.alert_type}</td>
                      <td><span className="badge" style={{ background: `${SEVERITY_COLOR[a.severity]}22`, color: SEVERITY_COLOR[a.severity], border: `1px solid ${SEVERITY_COLOR[a.severity]}55` }}>{a.severity}</span></td>
                      <td style={{ fontSize: 12 }}>{a.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card section">
            <h3>{t('fraudops.priority_cases')}</h3>
            {(dash?.priority?.cases || []).length === 0 ? <p className="roles-tag">{t('fraudops.empty')}</p> : (
              <table className="table">
                <thead><tr><th>ID</th><th>{t('fraudops.user')}</th><th>{t('fraudops.type')}</th><th>{t('fraudops.risk')}</th><th>{t('fraudops.assigned')}</th><th>{t('fraudops.status')}</th></tr></thead>
                <tbody>
                  {dash.priority.cases.map((c) => (
                    <tr key={c.id}>
                      <td>{c.id}</td>
                      <td>{c.full_name || c.user_id} <div className="roles-tag">{c.phone_number || ''}</div></td>
                      <td>{c.case_type}</td>
                      <td><span className="badge" style={{ background: `${SEVERITY_COLOR[c.risk_level]}22`, color: SEVERITY_COLOR[c.risk_level], border: `1px solid ${SEVERITY_COLOR[c.risk_level]}55` }}>{c.risk_level}</span></td>
                      <td>{c.assigned_name || '—'}</td>
                      <td><span className={`badge ${STATUS_BADGE[c.status] || 'info'}`}>{c.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ===== ALERTS ===== */}
      {tab === 'alerts' && (
        <div className="card section">
          <h3>{t('fraudops.fraud_alerts')} ({alerts.length} {t('fraudops.open_only')})</h3>
          {alerts.length === 0 ? <p className="roles-tag">{t('fraudops.empty')}</p> : (
            <table className="table">
              <thead><tr><th>ID</th><th>{t('fraudops.user')}</th><th>{t('fraudops.type')}</th><th>{t('fraudops.severity')}</th><th>{t('fraudops.notice')}</th><th>{t('fraudops.created')}</th><th></th></tr></thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id}>
                    <td>{a.id}</td>
                    <td>{a.full_name || a.user_id} <div className="roles-tag">{a.phone_number || ''}</div></td>
                    <td>{a.alert_type}</td>
                    <td><span className="badge" style={{ background: `${SEVERITY_COLOR[a.severity]}22`, color: SEVERITY_COLOR[a.severity], border: `1px solid ${SEVERITY_COLOR[a.severity]}55` }}>{a.severity}</span></td>
                    <td style={{ fontSize: 12 }}>{a.description}</td>
                    <td className="roles-tag">{new Date(a.created_at).toLocaleDateString()}</td>
                    <td><button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => resolveAlert(a.id)}>✓ {t('fraudops.resolve')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ===== CASES ===== */}
      {tab === 'cases' && (
        <div className="card section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3>{t('fraudops.aml_cases')}</h3>
            <button className="btn" onClick={() => setShowNewCase(!showNewCase)}>＋ {t('fraudops.new_case')}</button>
          </div>

          {showNewCase && (
            <form onSubmit={openCase} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, padding: 14, background: '#f8faf9', borderRadius: 10 }}>
              <input type="number" placeholder="User ID" value={caseForm.user_id} onChange={(e) => setCaseForm({ ...caseForm, user_id: e.target.value })} style={{ width: 100 }} />
              <input type="number" placeholder="Alert ID" value={caseForm.alert_id} onChange={(e) => setCaseForm({ ...caseForm, alert_id: e.target.value })} style={{ width: 100 }} />
              <select value={caseForm.case_type} onChange={(e) => setCaseForm({ ...caseForm, case_type: e.target.value })} style={{ padding: '6px 8px' }}>
                <option value="SUSPICIOUS_ACTIVITY">SUSPICIOUS_ACTIVITY</option>
                <option value="STRUCTURED_DEPOSITS">STRUCTURED_DEPOSITS</option>
                <option value="SANCTIONS_MATCH">SANCTIONS_MATCH</option>
                <option value="TRAVEL_RULE">TRAVEL_RULE</option>
                <option value="OTHER">OTHER</option>
              </select>
              <select value={caseForm.risk_level} onChange={(e) => setCaseForm({ ...caseForm, risk_level: e.target.value })} style={{ padding: '6px 8px' }}>
                <option value="LOW">LOW</option><option value="MEDIUM">MEDIUM</option><option value="HIGH">HIGH</option><option value="CRITICAL">CRITICAL</option>
              </select>
              <input type="number" placeholder={t('fraudops.assign_to')} value={caseForm.assigned_to} onChange={(e) => setCaseForm({ ...caseForm, assigned_to: e.target.value })} style={{ width: 120 }} />
              <input placeholder={t('fraudops.summary')} value={caseForm.summary} onChange={(e) => setCaseForm({ ...caseForm, summary: e.target.value })} style={{ flex: 1, minWidth: 160 }} />
              <button className="btn" type="submit">{t('fraudops.open')}</button>
            </form>
          )}

          {cases.length === 0 ? <p className="roles-tag">{t('fraudops.empty')}</p> : (
            <table className="table">
              <thead><tr><th>ID</th><th>{t('fraudops.user')}</th><th>{t('fraudops.type')}</th><th>{t('fraudops.risk')}</th><th>{t('fraudops.assigned')}</th><th>{t('fraudops.disposition')}</th><th>{t('fraudops.status')}</th><th></th></tr></thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td>{c.id}</td>
                    <td>{c.full_name || c.user_id} <div className="roles-tag">{c.phone_number || ''}</div></td>
                    <td>{c.case_type}</td>
                    <td><span className="badge" style={{ background: `${SEVERITY_COLOR[c.risk_level]}22`, color: SEVERITY_COLOR[c.risk_level], border: `1px solid ${SEVERITY_COLOR[c.risk_level]}55` }}>{c.risk_level}</span></td>
                    <td>{c.assigned_name || '—'}</td>
                    <td>{c.disposition ? <span className="badge info">{c.disposition}</span> : '—'}</td>
                    <td><span className={`badge ${STATUS_BADGE[c.status] || 'info'}`}>{c.status}</span></td>
                    <td><button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => viewCase(c.id)}>{t('fraudops.view')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {selectedCase && (
            <div style={{ marginTop: 18, padding: 14, background: '#f8faf9', borderRadius: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <h4 style={{ margin: 0 }}>Case #{selectedCase.case.id} — {selectedCase.case.user_name || selectedCase.case.user_id}</h4>
                <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setSelectedCase(null)}>✕</button>
              </div>
              <p className="roles-tag">{selectedCase.case.summary || t('fraudops.no_summary')}</p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => updateCase(selectedCase.case.id, { status: 'INVESTIGATING' })}>{t('fraudops.investigate')}</button>
                <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => updateCase(selectedCase.case.id, { status: 'RESOLVED', disposition: 'FALSE_POSITIVE' })}>{t('fraudops.fp')}</button>
                <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => updateCase(selectedCase.case.id, { status: 'RESOLVED', disposition: 'CONFIRMED_FRAUD' })}>{t('fraudops.confirmed')}</button>
                <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => updateCase(selectedCase.case.id, { status: 'CLOSED' })}>{t('fraudops.close')}</button>
              </div>
              <form onSubmit={addNote} style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <input placeholder={t('fraudops.add_note_ph')} value={noteForm} onChange={(e) => setNoteForm(e.target.value)} style={{ flex: 1 }} required />
                <button className="btn" type="submit" style={{ padding: '4px 12px', fontSize: 12 }}>{t('fraudops.add_note')}</button>
              </form>
              {(selectedCase.notes || []).length === 0 ? <p className="roles-tag">{t('fraudops.no_notes')}</p> : (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                  {selectedCase.notes.map((n) => (
                    <li key={n.id} style={{ marginBottom: 4 }}><b>{n.author_name || n.author_id}</b> · {new Date(n.created_at).toLocaleString()}<div>{n.note}</div></li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* ===== RISK PROFILES ===== */}
      {tab === 'risk' && (
        <div className="card section">
          <h3>{t('fraudops.risk_profiles')}</h3>
          {profiles.length === 0 ? <p className="roles-tag">{t('fraudops.empty')}</p> : (
            <table className="table">
              <thead><tr><th>{t('fraudops.user')}</th><th>{t('fraudops.score')}</th><th>{t('fraudops.risk')}</th><th>{t('fraudops.confidence')}</th><th>Model</th><th>{t('fraudops.assessed')}</th></tr></thead>
              <tbody>
                {profiles.map((p) => (
                  <tr key={p.user_id}>
                    <td>{p.full_name || p.user_id} <div className="roles-tag">{p.phone_number || ''}</div></td>
                    <td style={{ fontWeight: 700 }}>{p.risk_score}</td>
                    <td><span className="badge" style={{ background: `${SEVERITY_COLOR[p.risk_level]}22`, color: SEVERITY_COLOR[p.risk_level], border: `1px solid ${SEVERITY_COLOR[p.risk_level]}55` }}>{p.risk_level}</span></td>
                    <td>{p.confidence}%</td>
                    <td className="roles-tag">{p.model_version}</td>
                    <td className="roles-tag">{new Date(p.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}