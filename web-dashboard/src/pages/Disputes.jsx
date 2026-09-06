import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

const REASONS = ['UNAUTHORIZED', 'WRONG_AMOUNT', 'DUPLICATE', 'NOT_RECEIVED', 'FRAUD', 'OTHER'];
const STATUS_COLOR = { OPEN: '#2563eb', UNDER_REVIEW: '#d97706', MEDIATION: '#6d28d9', RESOLVED: '#0b7a41', REJECTED: '#dc2626' };

export default function Disputes() {
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const isReviewer = ['ADMIN', 'SUPPORT', 'COMPLIANCE'].includes(user.role);
  const { t } = useT();
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [tab, setTab] = useState('mine');
  const [mine, setMine] = useState([]);
  const [queue, setQueue] = useState([]);
  const [stats, setStats] = useState({});
  const [statusFilter, setStatusFilter] = useState('');
  const [form, setForm] = useState({ transaction_id: '', reason: 'OTHER', description: '', amount_disputed: '' });
  const [actionNote, setActionNote] = useState({});
  const [refundAmount, setRefundAmount] = useState({});

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('disputes.error') });
  const flash = (text) => { setMsg({ type: 'ok', text }); setTimeout(() => setMsg({ type: '', text: '' }), 3500); };

  const load = () => {
    api.get('/disputes').then((r) => setMine(r.data.disputes)).catch(() => {});
    if (isReviewer) {
      api.get(`/disputes/admin/all${statusFilter ? `?status=${statusFilter}` : ''}`).then((r) => setQueue(r.data.disputes)).catch(() => {});
      api.get('/disputes/admin/stats').then((r) => setStats(r.data)).catch(() => {});
    }
  };
  useEffect(() => { load(); }, [statusFilter, isReviewer]);

  const badge = (label, color) => (
    <span className="badge" style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}>{label}</span>
  );

  const open = async () => {
    try {
      const r = await api.post('/disputes', { ...form, transaction_id: parseInt(form.transaction_id, 10) });
      flash(`${t('disputes.opened')}`);
      setForm({ transaction_id: '', reason: 'OTHER', description: '', amount_disputed: '' });
      load();
    } catch (err) { error(err); }
  };

  const adminAction = async (id, path, extra = {}) => {
    try {
      await api.post(`/disputes/admin/${id}/${path}`, { note: actionNote[id], ...extra });
      flash(t('disputes.action_done'));
      setActionNote((n) => ({ ...n, [id]: '' }));
      load();
    } catch (err) { error(err); }
  };

  const notes = (d) => (Array.isArray(d.notes) ? d.notes : []).join('\n');

  const STAT_CARDS = [
    ['stats_total', stats.total, '#8b8b8b'],
    ['stats_open', stats.open, '#2563eb'],
    ['stats_review', stats.under_review, '#d97706'],
    ['stats_mediation', stats.mediation, '#6d28d9'],
    ['stats_resolved', stats.resolved, '#0b7a41'],
    ['stats_rejected', stats.rejected, '#dc2626'],
  ];

  return (
    <div>
      <div className="page-head">
        <h2>{t('disputes.title')}</h2>
        <p>{t('disputes.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>{msg.text}</div>
      )}

      {isReviewer && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 24, flexWrap: 'wrap' }}>
          <button className={`btn ${tab === 'mine' ? '' : 'btn-secondary'}`} style={{ fontSize: 13 }} onClick={() => setTab('mine')}>{t('disputes.tab_mine')}</button>
          <button className={`btn ${tab === 'review' ? '' : 'btn-secondary'}`} style={{ fontSize: 13 }} onClick={() => setTab('review')}>{t('disputes.tab_review')}</button>
        </div>
      )}

      {tab === 'mine' && (
        <>
          <div className="card section">
            <h3>{t('disputes.open_btn')}</h3>
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', marginTop: 10 }}>
              <input className="input" placeholder={t('disputes.tx_ph')} value={form.transaction_id} onChange={(e) => setForm({ ...form, transaction_id: e.target.value })} />
              <select className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
                {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <input className="input" placeholder={t('disputes.desc_ph')} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              <input className="input" placeholder={t('disputes.amount_ph')} value={form.amount_disputed} onChange={(e) => setForm({ ...form, amount_disputed: e.target.value })} />
            </div>
            <button className="btn" style={{ marginTop: 10, fontSize: 13 }} onClick={open}>{t('disputes.open_btn')}</button>
          </div>

          <div className="card section">
            <h3>{t('disputes.tab_mine')}</h3>
            {mine.length === 0 && <p className="roles-tag">{t('disputes.empty')}</p>}
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr><th>ID</th><th>{t('disputes.reason_col')}</th><th>{t('disputes.status')}</th><th>{t('disputes.amount')}</th><th>{t('disputes.tx_type')}</th><th>{t('disputes.resolution')}</th><th>{t('disputes.date')}</th></tr>
              </thead>
              <tbody>
                {mine.map((d) => (
                  <tr key={d.id}>
                    <td>#{d.id}</td>
                    <td>{d.reason}</td>
                    <td>{badge(d.status, STATUS_COLOR[d.status] || STATUS_COLOR.OPEN)}</td>
                    <td>{d.amount_disputed}</td>
                    <td>{d.transaction_type || '-'}</td>
                    <td>{d.resolution || '-'}</td>
                    <td>{new Date(d.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'review' && isReviewer && (
        <>
          <div className="card section">
            <h3>{t('disputes.tab_review')}</h3>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
              {STAT_CARDS.map(([key, val, color]) => (
                <div key={key} className="badge" style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}>{t(`disputes.${key}`)}: {val ?? 0}</div>
              ))}
            </div>
            <div style={{ marginBottom: 12 }}>
              <select className="input" style={{ maxWidth: 260 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All</option>
                {Object.keys(STATUS_COLOR).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {queue.length === 0 && <p className="roles-tag">{t('disputes.empty_queue')}</p>}
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr><th>ID</th><th>{t('disputes.user')}</th><th>{t('disputes.phone')}</th><th>{t('disputes.reason_col')}</th><th>{t('disputes.status')}</th><th>{t('disputes.tx_amount')}</th><th>{t('disputes.order_ref')}</th><th>{t('disputes.date')}</th></tr>
              </thead>
              <tbody>
                {queue.map((d) => (
                  <tr key={d.id}>
                    <td>#{d.id}</td>
                    <td>{d.user_name || d.user_id}</td>
                    <td>{d.user_phone || '-'}</td>
                    <td>{d.reason}</td>
                    <td>{badge(d.status, STATUS_COLOR[d.status] || STATUS_COLOR.OPEN)}</td>
                    <td>{d.transaction_amount ?? d.amount_disputed}</td>
                    <td>{d.order_reference || '-'}</td>
                    <td>{new Date(d.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {queue.length > 0 && (
            <div className="card section">
              <h3>{t('disputes.notes')}</h3>
              {queue.map((d) => (
                <div key={d.id} style={{ border: '1px solid #eee', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                    <strong>Dispute #{d.id}</strong> {badge(d.status, STATUS_COLOR[d.status] || STATUS_COLOR.OPEN)}
                  </div>
                  {notes(d) && <pre style={{ whiteSpace: 'pre-wrap', background: '#f6f6f6', borderRadius: 6, padding: 8, marginTop: 8, fontSize: 12 }}>{notes(d)}</pre>}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
                    {d.status === 'OPEN' && <button className="btn" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => adminAction(d.id, 'review')}>{t('disputes.start_review')}</button>}
                    {d.status === 'UNDER_REVIEW' && <button className="btn" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => adminAction(d.id, 'escalate')}>{t('disputes.escalate')}</button>}
                    {['OPEN', 'UNDER_REVIEW', 'MEDIATION'].includes(d.status) && (
                      <>
                        {!d.marketplace_order_id && <>
                          <input className="input" style={{ maxWidth: 160, flex: 1 }} placeholder={t('disputes.amount_to_refund')} value={refundAmount[d.id] || ''} onChange={(e) => setRefundAmount({ ...refundAmount, [d.id]: e.target.value })} />
                          <button className="btn btn-success" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => adminAction(d.id, 'decision', { action: 'REFUND', amount: refundAmount[d.id] })}>{t('disputes.refund_btn')}</button>
                        </>}
                        <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => adminAction(d.id, 'decision', { action: 'REJECT' })}>{t('disputes.reject_btn')}</button>
                      </>
                    )}
                    <input className="input" style={{ maxWidth: 320, flex: 1 }} placeholder={t('disputes.note_ph')} value={actionNote[d.id] || ''} onChange={(e) => setActionNote({ ...actionNote, [d.id]: e.target.value })} />
                    <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => {
                      if (!actionNote[d.id]) return error({ response: { data: { message: t('disputes.note_required') } } });
                      adminAction(d.id, 'notes');
                    }}>{t('disputes.add_note')}</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}