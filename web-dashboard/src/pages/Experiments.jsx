import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

const STATUS_COLOR = { DRAFT: '#6b7a70', RUNNING: '#0b7a41', PAUSED: '#d97706', STOPPED: '#dc2626', ARCHIVED: '#8b8b8b' };
const VERDICT_COLOR = { WIN: '#0b7a41', LOSS: '#dc2626', NEUTRAL: '#d97706', CONTROL: '#6b7a70' };

const EMPTY_FORM = {
  key: '', flag_key: '', name: '', description: '', start_at: '', end_at: '',
  variants: 'control:50,treatment:50', audience_roles: '', audience_users: '',
  primary_metric: '', secondary_metrics: '',
};

export default function Experiments() {
  const { t } = useT();
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [items, setItems] = useState([]);
  const [flags, setFlags] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [report, setReport] = useState(null);
  const [reportKey, setReportKey] = useState(null);
  const [events, setEvents] = useState([]);

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('experiments.error') });

  const load = () => {
    api.get('/experiments/admin').then((r) => setItems(r.data.experiments)).catch(() => {});
    api.get('/features/admin').then((r) => setFlags(r.data.flags.map((f) => f.flag_key))).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const flash = (text) => { setMsg({ type: 'ok', text }); setTimeout(() => setMsg({ type: '', text: '' }), 3500); };

  const parseVariants = (s) => (s || '').split(',').map((p) => {
    const [key, weight] = p.trim().split(':');
    return { key: key?.trim() || 'v', weight: Number(weight) || 1 };
  }).filter((v) => v.key);

  const createExp = async (e) => {
    e.preventDefault();
    try {
      const body = {
        key: form.key, flag_key: form.flag_key, name: form.name, description: form.description,
        start_at: form.start_at || null, end_at: form.end_at || null,
        variants: parseVariants(form.variants),
        audience: {
          roles: form.audience_roles.split(',').map((s) => s.trim()).filter(Boolean),
          user_ids: form.audience_users.split(',').map(Number).filter(Boolean),
        },
        metrics: { primary: form.primary_metric || null, secondary: form.secondary_metrics.split(',').map((s) => s.trim()).filter(Boolean) },
      };
      await api.post('/experiments/admin', body);
      flash(t('experiments.created'));
      setShowCreate(false);
      setForm(EMPTY_FORM);
      load();
    } catch (err) { error(err); }
  };

  const transition = async (key, action, okText) => {
    try { await api.post(`/experiments/admin/${key}/${action}`); flash(t(okText)); load(); } catch (err) { error(err); }
  };

  const openReport = async (key) => {
    try {
      const r = await api.get(`/experiments/admin/${key}/report`);
      setReport(r.data.report);
      setReportKey(key);
      const ev = await api.get(`/experiments/admin/${key}/events`);
      setEvents(ev.data.events);
    } catch (err) { error(err); }
  };

  const badge = (label, color) => (
    <span className="badge" style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}>{label}</span>
  );

  return (
    <div>
      <div className="page-head">
        <h2>{t('experiments.title')}</h2>
        <p>{t('experiments.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>{msg.text}</div>
      )}

      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn" onClick={() => setShowCreate(!showCreate)} style={{ fontSize: 13 }}>{showCreate ? t('experiments.cancel') : t('experiments.new')}</button>
      </div>

      {showCreate && (
        <div className="card section">
          <h3>{t('experiments.new')}</h3>
          <form onSubmit={createExp} style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <input className="input" placeholder="KEY (A-Z0-9_)" value={form.key} onChange={(ev) => setForm({ ...form, key: ev.target.value })} required />
            <select className="input" value={form.flag_key} onChange={(ev) => setForm({ ...form, flag_key: ev.target.value })} required>
              <option value="">{t('experiments.flag_ph')}</option>
              {(flags || []).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <input className="input" placeholder={t('experiments.name')} value={form.name} onChange={(ev) => setForm({ ...form, name: ev.target.value })} required />
            <input className="input" placeholder={t('experiments.variants_ph')} value={form.variants} onChange={(ev) => setForm({ ...form, variants: ev.target.value })} />
            <input className="input" type="datetime-local" value={form.start_at} onChange={(ev) => setForm({ ...form, start_at: ev.target.value })} />
            <input className="input" type="datetime-local" value={form.end_at} onChange={(ev) => setForm({ ...form, end_at: ev.target.value })} />
            <input className="input" placeholder={t('experiments.roles_ph')} value={form.audience_roles} onChange={(ev) => setForm({ ...form, audience_roles: ev.target.value })} />
            <input className="input" placeholder={t('experiments.users_ph')} value={form.audience_users} onChange={(ev) => setForm({ ...form, audience_users: ev.target.value })} />
            <input className="input" placeholder={t('experiments.primary_ph')} value={form.primary_metric} onChange={(ev) => setForm({ ...form, primary_metric: ev.target.value })} />
            <input className="input" placeholder={t('experiments.secondary_ph')} value={form.secondary_metrics} onChange={(ev) => setForm({ ...form, secondary_metrics: ev.target.value })} />
            <input className="input" placeholder={t('experiments.desc')} value={form.description} onChange={(ev) => setForm({ ...form, description: ev.target.value })} />
            <button className="btn" type="submit" style={{ fontSize: 13 }}>{t('experiments.create_btn')}</button>
          </form>
        </div>
      )}

      <div className="card section">
        <h3>{t('experiments.list')}</h3>
        {items.length === 0 && <p className="roles-tag">{t('experiments.empty')}</p>}
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Key</th><th>{t('experiments.name')}</th><th>Flag</th><th>{t('experiments.status')}</th>
              <th>{t('experiments.variants')}</th><th>{t('experiments.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td><strong>{it.key}</strong></td>
                <td>{it.name}</td>
                <td>{it.flag_key}</td>
                <td>{badge(it.status, STATUS_COLOR[it.status] || STATUS_COLOR.DRAFT)}</td>
                <td>{(it.variants || []).map((v) => `${v.key}:${v.weight}%`).join(', ')}</td>
                <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {['RUNNING', 'PAUSED', 'DRAFT'].includes(it.status) && it.status !== 'RUNNING' &&
                    <button className="btn btn-success" onClick={() => transition(it.key, 'start', 'experiments.started')} style={{ fontSize: 12, padding: '4px 10px' }}>{t('experiments.start')}</button>}
                  {it.status === 'RUNNING' &&
                    <button className="btn btn-secondary" onClick={() => transition(it.key, 'pause', 'experiments.paused')} style={{ fontSize: 12, padding: '4px 10px' }}>{t('experiments.pause')}</button>}
                  {['RUNNING', 'PAUSED'].includes(it.status) &&
                    <button className="btn btn-secondary" onClick={() => transition(it.key, 'stop', 'experiments.stopped')} style={{ fontSize: 12, padding: '4px 10px' }}>{t('experiments.stop')}</button>}
                  <button className="btn btn-secondary" onClick={() => openReport(it.key)} style={{ fontSize: 12, padding: '4px 10px' }}>{t('experiments.report')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report && (
        <div className="card section">
          <h3>{t('experiments.report')} — {report.experiment.name} <small>({report.experiment.key})</small></h3>
          {report.primaryMetric ? (
            <>
              <p className="roles-tag"><strong>{t('experiments.primary_metric')}:</strong> {report.primaryMetric}</p>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {(report.variants || []).map((v) => (
                  <div className="card" key={v.key} style={{ flex: '1 1 180px', padding: 14 }}>
                    <div className="roles-tag">{v.key} {v.key === report.controlKey ? `(${t('experiments.control')})` : ''}</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: VERDICT_COLOR[v.verdict] || '#0b7a41' }}>
                      {v.rate != null ? `${(v.rate * 100).toFixed(2)}%` : '—'}
                    </div>
                    <div className="roles-tag">{t('experiments.assigned')}: {v.assigned} · {t('experiments.events_n')}: {v.events}</div>
                    {v.key !== report.controlKey && (
                      <div className="roles-tag">
                        {t('experiments.uplift')}: <strong>{Number(v.uplift) > 0 ? '+' : ''}{v.uplift}%</strong> · z={v.zScore}
                        &nbsp;{badge(v.verdict, VERDICT_COLOR[v.verdict])}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {(report.dailyTrend || []).length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <h4>{t('experiments.daily_trend')}</h4>
                  {(report.dailyTrend || []).map((d) => (
                    <div key={`${d.variant}-${d.day}`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ minWidth: 110 }}>{d.variant}</span>
                      <span style={{ minWidth: 90, color: '#6b7a70', fontSize: 12 }}>{d.day}</span>
                      <div style={{ flex: 1, background: '#eef2ef', borderRadius: 6, height: 12 }}>
                        <div style={{ width: `${Math.min(100, (d.n / Math.max(1, Math.max(...report.dailyTrend.map((x) => x.n)))) * 100)}%`, background: '#0b7a41', height: 12, borderRadius: 6 }} />
                      </div>
                      <span>{d.n}</span>
                    </div>
                  ))}
                </div>
              )}
              {events.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <h4>{t('experiments.events_list')}</h4>
                  <table className="table" style={{ width: '100%' }}>
                    <thead><tr><th>Event</th><th>Variant</th><th>{t('experiments.value')}</th><th>{t('experiments.at')}</th></tr></thead>
                    <tbody>
                      {events.slice(0, 20).map((ev) => (
                        <tr key={ev.id}><td>{ev.event_name}</td><td>{ev.variant}</td><td>{Number(ev.value)}</td><td>{new Date(ev.created_at).toLocaleString()}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <p className="roles-tag">{t('experiments.no_metric')}</p>
          )}
        </div>
      )}
    </div>
  );
}