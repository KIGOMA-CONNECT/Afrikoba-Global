import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

const STATUS_COLOR = { PENDING: '#d97706', APPROVED: '#2563eb', REJECTED: '#dc2626', EXECUTED: '#0b7a41', FAILED: '#dc2626', CANCELLED: '#8b8b8b' };

const EMPTY_ACTION = { userId: '', role: 'ADMIN', amount: '' };

export default function FourEyes() {
  const { t } = useT();
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [tab, setTab] = useState('policies');
  const [policies, setPolicies] = useState([]);
  const [requests, setRequests] = useState([]);
  const [selected, setSelected] = useState(null);
  const [action, setAction] = useState(EMPTY_ACTION);

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('four_eyes.error') });
  const flash = (text) => { setMsg({ type: 'ok', text }); setTimeout(() => setMsg({ type: '', text: '' }), 3500); };

  const load = () => {
    api.get('/admin/four-eyes/policies').then((r) => setPolicies(r.data.policies)).catch(() => {});
    api.get('/admin/four-eyes/requests').then((r) => setRequests(r.data.requests)).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const badge = (label, color) => (
    <span className="badge" style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}>{label}</span>
  );

  const updatePolicy = async (code, body) => {
    try { await api.put(`/admin/four-eyes/policies/${code}`, body); flash(t('four_eyes.policy_updated')); load(); } catch (err) { error(err); }
  };

  const view = async (id) => {
    try { const r = await api.get(`/admin/four-eyes/requests/${id}`); setSelected({ ...r.data, id }); } catch (err) { error(err); }
  };

  const decide = async (id, decision) => {
    const note = window.prompt(t('four_eyes.note_ph'), '') || null;
    try {
      await api.post(`/admin/four-eyes/requests/${id}/${decision}`, { note });
      flash(decision === 'approve' ? t('four_eyes.approved') : t('four_eyes.rejected'));
      setSelected(null);
      load();
    } catch (err) { error(err); }
  };

  const launch = async (actionCode) => {
    try {
      const body = actionCode === 'ADMIN_LARGE_REFUND'
        ? { userId: action.userId, amount: action.amount }
        : { userId: action.userId, role: action.role };
      const r = await api.post(`/admin/four-eyes/actions/${actionCode === 'ADMIN_PROMOTE_ROLE' ? 'promote-role' : actionCode === 'ADMIN_DEMOTE_ROLE' ? 'demote-role' : 'large-refund'}`, body);
      setSelected({ request: r.data.request, approvals: [], id: r.data.request.id });
      flash(t('four_eyes.requested'));
      setAction(EMPTY_ACTION);
      load();
    } catch (err) { error(err); }
  };

  const TABS = [
    { key: 'policies', label: t('four_eyes.tab_policies') },
    { key: 'requests', label: t('four_eyes.tab_requests') },
    { key: 'actions', label: t('four_eyes.tab_actions') },
  ];

  return (
    <div>
      <div className="page-head">
        <h2>{t('four_eyes.title')}</h2>
        <p>{t('four_eyes.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>{msg.text}</div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 24, flexWrap: 'wrap' }}>
        {TABS.map((tb) => (
          <button key={tb.key} className={`btn ${tab === tb.key ? '' : 'btn-secondary'}`} onClick={() => setTab(tb.key)} style={{ fontSize: 13 }}>{tb.label}</button>
        ))}
      </div>

      {tab === 'policies' && (
        <div className="card section">
          <h3>{t('four_eyes.tab_policies')}</h3>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr><th>Action</th><th>{t('four_eyes.desc_col')}</th><th>{t('four_eyes.approvers')}</th><th>{t('four_eyes.need')}</th><th>{t('four_eyes.status')}</th><th>{t('four_eyes.actions')}</th></tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td><code>{p.action_code}</code></td>
                  <td>{p.description}</td>
                  <td>{(p.approver_roles || []).join(', ')}</td>
                  <td>{p.required_approvers}</td>
                  <td>{badge(p.enabled ? 'ON' : 'OFF', p.enabled ? '#0b7a41' : '#dc2626')}</td>
                  <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn btn-secondary" onClick={() => updatePolicy(p.action_code, { requiredApprovers: (p.required_approvers % 3) + 1 })} style={{ fontSize: 12, padding: '4px 10px' }}>{t('four_eyes.cycles')}</button>
                    <button className="btn btn-secondary" onClick={() => updatePolicy(p.action_code, { enabled: !p.enabled })} style={{ fontSize: 12, padding: '4px 10px' }}>{p.enabled ? t('four_eyes.disable') : t('four_eyes.enable')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'requests' && (
        <div className="card section">
          <h3>{t('four_eyes.tab_requests')}</h3>
          {requests.length === 0 && <p className="roles-tag">{t('four_eyes.empty')}</p>}
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr><th>ID</th><th>Action</th><th>{t('four_eyes.maker')}</th><th>{t('four_eyes.payload')}</th><th>{t('four_eyes.status')}</th><th>{t('four_eyes.at')}</th></tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => view(r.id)}>
                  <td>#{r.id}</td>
                  <td><code>{r.action_code}</code></td>
                  <td>{r.requester_name}</td>
                  <td style={{ fontSize: 12, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{JSON.stringify(r.payload)}</td>
                  <td>{badge(r.status, STATUS_COLOR[r.status] || STATUS_COLOR.PENDING)}</td>
                  <td>{new Date(r.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {selected && (
            <div style={{ marginTop: 18, border: '1px solid #e2e8e4', borderRadius: 10, padding: 14 }}>
              <h4>#{selected.id} · <code>{selected.request.action_code}</code></h4>
              <p className="roles-tag">{t('four_eyes.maker')}: {selected.request.requester_name} · {t('four_eyes.policy_need')}: {selected.request.required_approvers} · {t('four_eyes.allowed_roles')}: {selected.request.approver_roles?.join(', ')}</p>
              <pre style={{ background: '#f4f6f5', padding: 10, borderRadius: 8, fontSize: 12 }}>{JSON.stringify(selected.request.payload, null, 2)}</pre>
              {selected.request.error && <p className="alert alert-err" style={{ padding: 8, borderRadius: 8 }}>{selected.request.error}</p>}
              {(selected.approvals || []).map((a) => (
                <div key={a.id} className="roles-tag">{a.approver_name} ({a.approver_role}) · {a.decision} {a.note ? `· "${a.note}"` : ''} · {new Date(a.created_at).toLocaleString()}</div>
              ))}
              {selected.request.status === 'PENDING' && (
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <button className="btn btn-success" onClick={() => decide(selected.id, 'approve')} style={{ fontSize: 13 }}>✓ {t('four_eyes.approve_btn')}</button>
                  <button className="btn btn-secondary" onClick={() => decide(selected.id, 'reject')} style={{ fontSize: 13 }}>✕ {t('four_eyes.reject_btn')}</button>
                </div>
              )}
              {selected.request.status === 'FAILED' && (
                <button className="btn" onClick={async () => { try { await api.post(`/admin/four-eyes/requests/${selected.id}/retry`); flash(t('four_eyes.retried')); setSelected(null); load(); } catch (err) { error(err); } }} style={{ marginTop: 12, fontSize: 13 }}>{t('four_eyes.retry_btn')}</button>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'actions' && (
        <div className="card section">
          <h3>{t('four_eyes.tab_actions')}</h3>
          <p className="roles-tag">{t('four_eyes.actions_hint')}</p>
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', marginTop: 10 }}>
            <div className="card" style={{ padding: 12 }}>
              <strong>{t('four_eyes.promote')}</strong>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <input className="input" type="number" placeholder="User ID" value={action.userId} onChange={(e) => setAction({ ...action, userId: e.target.value })} />
                <select className="input" value={action.role} onChange={(e) => setAction({ ...action, role: e.target.value })}>
                  <option value="ADMIN">ADMIN</option><option value="OPS">OPS</option><option value="COMPLIANCE">COMPLIANCE</option><option value="SUPPORT">SUPPORT</option>
                </select>
              </div>
              <button className="btn btn-secondary" style={{ marginTop: 8, fontSize: 12 }} onClick={() => launch('ADMIN_PROMOTE_ROLE')}>{t('four_eyes.launch')}</button>
            </div>
            <div className="card" style={{ padding: 12 }}>
              <strong>{t('four_eyes.demote')}</strong>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <input className="input" type="number" placeholder="User ID" value={action.userId} onChange={(e) => setAction({ ...action, userId: e.target.value })} />
                <select className="input" value={action.role} onChange={(e) => setAction({ ...action, role: e.target.value })}>
                  <option value="MJUMBE">MJUMBE</option><option value="SUPPORT">SUPPORT</option>
                </select>
              </div>
              <button className="btn btn-secondary" style={{ marginTop: 8, fontSize: 12 }} onClick={() => launch('ADMIN_DEMOTE_ROLE')}>{t('four_eyes.launch')}</button>
            </div>
            <div className="card" style={{ padding: 12 }}>
              <strong>{t('four_eyes.refund')}</strong>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <input className="input" type="number" placeholder="User ID" value={action.userId} onChange={(e) => setAction({ ...action, userId: e.target.value })} />
                <input className="input" type="number" placeholder="TZS" value={action.amount} onChange={(e) => setAction({ ...action, amount: e.target.value })} />
              </div>
              <button className="btn btn-secondary" style={{ marginTop: 8, fontSize: 12 }} onClick={() => launch('ADMIN_LARGE_REFUND')}>{t('four_eyes.launch')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}