import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

const DECISION_LABELS = {
  ON: 'ON',
  DISABLED: 'DISABLED',
  EXPIRED: 'EXPIRED',
  MISSING: 'MISSING',
  ROLE_BLOCKED: 'ROLE_BLOCKED',
  ROLLOUT_OFF: 'ROLLOUT_OFF',
  OVERRIDE_ON: 'OVERRIDE_ON',
  NO_BUCKET: 'NO_BUCKET',
};

export default function FeatureFlags() {
  const { t } = useT();
  const [flags, setFlags] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [evals, setEvals] = useState([]);
  const [form, setForm] = useState({
    flag_key: '', label: '', description: '', enabled: true,
    rollout_percent: 100, audience: '', override_user_ids: '', expires_at: '',
  });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('features.error') });

  const load = () => {
    api.get('/features/admin').then((r) => setFlags(r.data.flags)).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const startEdit = (f) => {
    setEditing(f.flag_key);
    setForm({
      flag_key: f.flag_key, label: f.label, description: f.description, enabled: f.enabled,
      rollout_percent: f.rollout_percent, audience: (f.audience || []).join(','),
      override_user_ids: (f.override_user_ids || []).join(','),
      expires_at: f.expires_at ? String(f.expires_at).slice(0, 16) : '',
    });
  };

  const startAdd = () => {
    setAdding(true);
    setForm({ flag_key: '', label: '', description: '', enabled: true, rollout_percent: 100, audience: '', override_user_ids: '', expires_at: '' });
  };

  const submit = async (e) => {
    e.preventDefault();
    const body = {
      ...form,
      enabled: !!form.enabled,
      rollout_percent: Number(form.rollout_percent || 100),
      audience: form.audience ? form.audience.split(',').map((s) => s.trim()).filter(Boolean) : [],
      override_user_ids: form.override_user_ids ? form.override_user_ids.split(',').map((s) => Number(s.trim())).filter(Boolean) : [],
      expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
    };
    try {
      if (adding) {
        await api.post('/features/admin', body);
        setMsg({ type: 'ok', text: t('features.created') });
        setAdding(false);
      } else {
        await api.put(`/features/admin/${form.flag_key}`, body);
        setMsg({ type: 'ok', text: t('features.updated') });
        setEditing(null);
      }
      load();
    } catch (err) { error(err); }
  };

  const toggle = async (f, on) => {
    try {
      await api.put(`/features/admin/${f.flag_key}`, { enabled: on });
      setMsg({ type: 'ok', text: `${f.flag_key} ${on ? t('features.enabled') : t('features.disabled')}.` });
      load();
    } catch (err) { error(err); }
  };

  const remove = async (f) => {
    if (!window.confirm(`${t('features.delete_confirm')} ${f.flag_key}?`)) return;
    try {
      await api.delete(`/features/admin/${f.flag_key}`);
      setMsg({ type: 'ok', text: t('features.deleted') });
      if (analytics?.flagKey === f.flag_key) setAnalytics(null);
      load();
    } catch (err) { error(err); }
  };

  const showAnalytics = async (f) => {
    try {
      const a = await api.get(`/features/admin/${f.flag_key}/analytics`);
      const e = await api.get(`/features/admin/${f.flag_key}/evaluations`, { params: { limit: 25 } });
      setAnalytics(a.data.analytics);
      setEvals(e.data.evaluations);
    } catch (err) { error(err); }
  };

  const cancelEdit = () => { setEditing(null); setAdding(false); };

  return (
    <div>
      <div className="page-head">
        <h2>{t('features.title')}</h2>
        <p>{t('features.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>{msg.text}</div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>{t('features.manage')}</h3>
        {!adding && <button className="btn" onClick={startAdd}>＋ {t('features.add')}</button>}
      </div>

      {(adding || editing) && (
        <form onSubmit={submit} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, padding: 14, background: '#f8faf9', borderRadius: 10 }}>
          {adding && <input placeholder={t('features.flag_key_ph')} value={form.flag_key} onChange={(e) => setForm({ ...form, flag_key: e.target.value })} style={{ flex: 1, minWidth: 140, textTransform: 'uppercase' }} required />}
          <input placeholder={t('features.name')} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} style={{ flex: 1, minWidth: 140 }} required />
          <input placeholder={t('features.description')} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ flex: 2, minWidth: 200 }} />
          <input placeholder={t('features.rollout')} type="number" min="0" max="100" value={form.rollout_percent} onChange={(e) => setForm({ ...form, rollout_percent: e.target.value })} style={{ width: 90 }} />
          <input placeholder={t('features.audience_ph')} value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} style={{ flex: 1, minWidth: 140 }} />
          <input placeholder={t('features.overrides_ph')} value={form.override_user_ids} onChange={(e) => setForm({ ...form, override_user_ids: e.target.value })} style={{ flex: 1, minWidth: 140 }} />
          <input type="datetime-local" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} style={{ width: 200 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            {t('features.active')}
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn" type="submit">{adding ? t('features.add') : t('features.save')}</button>
            <button type="button" className="btn btn-secondary" onClick={cancelEdit}>{t('features.cancel')}</button>
          </div>
        </form>
      )}

      {flags.length === 0 ? <p className="roles-tag">{t('features.empty')}</p> : (
        <table className="table">
          <thead><tr><th>Flag</th><th>{t('features.name')}</th><th>{t('features.status')}</th><th>{t('features.rollout')}</th><th>{t('features.audience')}</th><th>{t('features.expiry')}</th><th>{t('features.actions')}</th></tr></thead>
          <tbody>
            {flags.map((f) => (
              <tr key={f.flag_key}>
                <td><code>{f.flag_key}</code></td>
                <td>{f.label}<div className="roles-tag">{f.description}</div></td>
                <td>
                  <span className={`badge ${f.enabled ? 'success' : 'danger'}`}>{f.enabled ? t('features.enabled') : t('features.disabled')}</span>
                </td>
                <td>{f.rollout_percent}%</td>
                <td className="roles-tag">{(f.audience || []).length ? (f.audience || []).join(', ') : t('features.all_roles')}</td>
                <td>{f.expires_at ? String(f.expires_at).slice(0, 10) : '—'}</td>
                <td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => toggle(f, !f.enabled)}>{f.enabled ? t('features.kill') : t('features.activate')}</button>
                    <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => startEdit(f)}>{t('features.edit')}</button>
                    <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => showAnalytics(f)}>{t('features.analytics')}</button>
                    <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12, color: '#dc2626' }} onClick={() => remove(f)}>{t('features.delete')}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {analytics && (
        <div className="card section" style={{ marginTop: 16 }}>
          <h3>{t('features.analytics')} — {analytics.flagKey}</h3>
          <p className="roles-tag">{t('features.total_eval')}: <b>{analytics.total}</b> · {t('features.window')}: {analytics.windowDays}d</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {analytics.decisions.map((d) => (
              <span key={d.decision} className="badge info">{DECISION_LABELS[d.decision] || d.decision}: {d.n}</span>
            ))}
          </div>
          {analytics.dailyTrend.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 90, marginBottom: 12 }}>
              {analytics.dailyTrend.map((d) => (
                <div key={d.day} title={`${d.day}: ${d.n}`} style={{ background: '#0b7a41', width: 22, height: `${Math.max(4, Math.round((d.n / Math.max(...analytics.dailyTrend.map((x) => x.n))) * 80))}px`, borderRadius: 3 }} />
              ))}
            </div>
          )}
          {evals.length > 0 ? (
            <table className="table">
              <thead><tr><th>{t('features.when')}</th><th>{t('features.user')}</th><th>{t('features.decision')}</th><th>{t('features.context')}</th></tr></thead>
              <tbody>
                {evals.map((e) => (
                  <tr key={e.id}>
                    <td>{new Date(e.created_at).toLocaleString()}</td>
                    <td>{e.full_name || e.user_id || '—'} <span className="roles-tag">{e.phone_number || ''}</span></td>
                    <td><span className="badge info">{DECISION_LABELS[e.decision] || e.decision}</span></td>
                    <td style={{ fontSize: 12 }}>{JSON.stringify(e.context || {})}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="roles-tag">{t('features.no_evals')}</p>}
        </div>
      )}
    </div>
  );
}