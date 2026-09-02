import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function Subscriptions() {
  const { t } = useT();
  const [subs, setSubs] = useState([]);
  const [summary, setSummary] = useState(null);
  const [dueSoon, setDueSoon] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', amount: '', frequency: 'MONTHLY', category: 'Utilities', next_billing: '', auto_pay: false });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('subs.error') });

  const load = () => {
    api.get('/smart/subscriptions').then((r) => setSubs(r.data.subscriptions || [])).catch(() => {});
    api.get('/smart/subscriptions/summary').then((r) => setSummary(r.data.summary || null)).catch(() => {});
    api.get('/smart/subscriptions/due-soon').then((r) => setDueSoon(r.data.dueSoon || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const createSub = async (e) => {
    e.preventDefault();
    try {
      await api.post('/smart/subscriptions', {
        name: form.name,
        amount: Number(form.amount),
        frequency: form.frequency,
        category: form.category,
        next_billing: form.next_billing || null,
        auto_pay: !!form.auto_pay,
      });
      setMsg({ type: 'ok', text: t('subs.created_ok') });
      setShowForm(false);
      setForm({ name: '', amount: '', frequency: 'MONTHLY', category: 'Utilities', next_billing: '', auto_pay: false });
      load();
    } catch (err) { error(err); }
  };

  const removeSub = async (id) => {
    try {
      await api.delete(`/smart/subscriptions/${id}`);
      setMsg({ type: 'ok', text: t('subs.deleted_ok') });
      load();
    } catch (err) { error(err); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>{t('subs.title')}</h2>
        <p>{t('subs.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      {/* Summary */}
      {summary && (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 24 }}>
          <div className="stat-card"><span className="label">{t('subs.total_active')}</span><strong>{summary.active_count || 0}</strong></div>
          <div className="stat-card"><span className="label">{t('subs.monthly_burn')}</span><strong style={{ color: '#dc2626' }}>{formatMoney(summary.monthly_total || 0)}</strong></div>
        </div>
      )}

      {/* Due Soon Alerts */}
      {dueSoon.length > 0 && (
        <div className="card" style={{ marginBottom: 24, background: '#fffbeb', border: '1px solid #fde68a' }}>
          <h4 style={{ margin: 0, marginBottom: 8, color: '#92400e' }}>⚠️ {t('subs.due_soon_title')}</h4>
          <ul style={{ margin: 0, paddingLeft: 20, color: '#b45309' }}>
            {dueSoon.map((d) => (
              <li key={d.id}><strong>{d.name}</strong> — {formatMoney(d.amount)} ({d.frequency}) · {t('subs.due_on')}: {d.next_billing ? new Date(d.next_billing).toLocaleDateString() : '—'}</li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>{t('subs.list_title')}</h3>
        <button className="btn" onClick={() => setShowForm(true)}>＋ {t('subs.add_btn')}</button>
      </div>

      {/* Form modal */}
      {showForm && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('subs.add_btn')}</h3>
          <form onSubmit={createSub} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('subs.name')}
              <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="e.g. Netflix, Rent, DSTV" />
            </label>
            <label>{t('subs.amount')}
              <input type="number" min="100" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
            </label>
            <label>{t('subs.frequency')}
              <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
                <option value="WEEKLY">{t('subs.freq_weekly')}</option>
                <option value="MONTHLY">{t('subs.freq_monthly')}</option>
                <option value="YEARLY">{t('subs.freq_yearly')}</option>
              </select>
            </label>
            <label>{t('subs.category')}
              <input type="text" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} required />
            </label>
            <label>{t('subs.next_billing')}
              <input type="date" value={form.next_billing} onChange={(e) => setForm({ ...form, next_billing: e.target.value })} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.auto_pay} onChange={(e) => setForm({ ...form, auto_pay: e.target.checked })} />
              {t('subs.auto_pay')}
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('subs.save')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowForm(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      {/* Subscriptions Table */}
      <div className="card">
        {subs.length === 0 ? (
          <p className="roles-tag">{t('subs.empty')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('subs.name')}</th>
                  <th>{t('subs.category')}</th>
                  <th>{t('subs.amount')}</th>
                  <th>{t('subs.frequency')}</th>
                  <th>{t('subs.next_billing')}</th>
                  <th>{t('subs.auto_pay')}</th>
                  <th>{t('subs.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {subs.map((s) => (
                  <tr key={s.id}>
                    <td><strong>{s.name}</strong></td>
                    <td><span className="badge info">{s.category}</span></td>
                    <td><strong>{formatMoney(s.amount)}</strong></td>
                    <td>{s.frequency}</td>
                    <td>{s.next_billing ? new Date(s.next_billing).toLocaleDateString() : '—'}</td>
                    <td><span className={`badge ${s.auto_pay ? 'success' : 'info'}`}>{s.auto_pay ? t('subs.yes') : t('subs.no')}</span></td>
                    <td>
                      <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => removeSub(s.id)}>{t('subs.delete')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
