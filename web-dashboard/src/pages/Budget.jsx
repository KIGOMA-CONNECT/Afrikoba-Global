import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function Budget() {
  const { t } = useT();
  const [budgets, setBudgets] = useState([]);
  const [overview, setOverview] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ category_id: '', amount: '', notes: '' });

  const load = () => {
    api.get('/budget').then((r) => setBudgets(r.data.budgets)).catch(() => {});
    api.get('/budget/overview').then((r) => setOverview(r.data.overview)).catch(() => {});
    api.get('/budget/alerts').then((r) => setAlerts(r.data.alerts)).catch(() => setAlerts([]));
  };

  useEffect(() => {
    load();
    api.get('/budget/categories').then((r) => setCategories(r.data.categories)).catch(() => {});
  }, []);

  const save = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/budget', {
        category_id: Number(form.category_id),
        amount: Number(form.amount),
        notes: form.notes,
      });
      setBudgets(res.data.budgets);
      setMsg({ type: 'ok', text: t('budget.saved') });
      setShowForm(false);
      setForm({ category_id: '', amount: '', notes: '' });
      load();
    } catch (err) {
      setMsg({ type: 'err', text: err.response?.data?.message || t('budget.error') });
    }
  };

  const remove = async (id) => {
    try {
      await api.delete(`/budget/${id}`);
      load();
    } catch (err) {
      setMsg({ type: 'err', text: err.response?.data?.message || t('budget.error') });
    }
  };

  const ack = async (id) => {
    try {
      await api.post(`/budget/alerts/${id}/ack`);
      setAlerts((a) => a.filter((x) => x.id !== id));
    } catch (err) {
      setMsg({ type: 'err', text: err.response?.data?.message || t('budget.error') });
    }
  };

  const barColor = (b) => (b.over ? '#dc2626' : b.progress_pct >= 80 ? '#d97706' : '#059669');

  return (
    <div>
      <div className="page-head">
        <h2>{t('budget.title')}</h2>
        <p>{t('budget.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      {/* Overview */}
      {overview && (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 24 }}>
          <div className="stat-card"><span className="label">{t('budget.income')}</span><strong>{formatMoney(overview.income)}</strong></div>
          <div className="stat-card"><span className="label">{t('budget.total_budget')}</span><strong>{formatMoney(overview.total_budget)}</strong></div>
          <div className="stat-card"><span className="label">{t('budget.total_spent')}</span><strong style={{ color: 'var(--green)' }}>{formatMoney(overview.total_spent)}</strong></div>
          <div className="stat-card"><span className="label">{t('budget.over_categories')}</span><strong style={{ color: overview.over_count > 0 ? '#dc2626' : 'var(--green)' }}>{overview.over_count}</strong></div>
          <div className="stat-card"><span className="label">{t('budget.savings_rate')}</span><strong>{overview.savings_rate}%</strong></div>
        </div>
      )}

      {overview && overview.income > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 24, background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
          <strong>{t('budget.recommend')}:</strong> {t('budget.recommend_text', { amount: formatMoney(Math.round(overview.income * 0.05)) })}
        </div>
      )}

      {/* Alerts */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginBottom: 12 }}>{t('budget.alerts')}</h3>
        {alerts.length === 0 ? (
          <p className="roles-tag">{t('budget.alerts_empty')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {alerts.map((a) => (
              <div key={a.id} className="alert" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 10, background: '#fef2f2', border: '1px solid #fecaca' }}>
                <span>{a.category_icon} {t('budget.alert_text', { name: a.category_name, pct: Math.round((a.spent / a.budget_amount) * 100), spent: formatMoney(a.spent), limit: formatMoney(a.budget_amount) })}</span>
                <button className="btn" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => ack(a.id)}>{t('budget.ack')}</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Budget form */}
      {showForm ? (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('budget.set_new')}</h3>
          <p className="roles-tag" style={{ marginBottom: 14 }}>{t('budget.set_hint')}</p>
          <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('budget.category_label')}
              <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })} required>
                <option value="">--</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
              </select>
            </label>
            <label>{t('budget.amount_label')}
              <input type="number" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
            </label>
            <label>{t('budget.notes')}
              <input type="text" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('budget.create')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowForm(false)}>✕</button>
            </div>
          </form>
        </div>
      ) : (
        <button className="btn" style={{ marginBottom: 24 }} onClick={() => setShowForm(true)}>＋ {t('budget.set_new')}</button>
      )}

      {/* Budgets table */}
      <div className="card">
        <h3 style={{ marginBottom: 14 }}>{t('budget.table')}</h3>
        {budgets.length === 0 ? (
          <p className="roles-tag">{t('budget.empty')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('budget.category')}</th>
                  <th>{t('budget.limit')}</th>
                  <th>{t('budget.spent')}</th>
                  <th>{t('budget.progress')}</th>
                  <th>{t('budget.status')}</th>
                  <th>{t('budget.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {budgets.map((b) => (
                  <tr key={b.id}>
                    <td>{b.category_icon} {b.category_name}</td>
                    <td><strong>{formatMoney(b.amount)}</strong></td>
                    <td>{formatMoney(b.spent)}</td>
                    <td style={{ minWidth: 180 }}>
                      <div className="progress-bar-bg" style={{ height: 8, borderRadius: 4, overflow: 'hidden', background: '#e2e8f0' }}>
                        <div className="progress-bar-fill" style={{ width: `${Math.min(100, b.progress_pct)}%`, background: barColor(b), height: '100%' }} />
                      </div>
                      <small>{b.progress_pct}% · {t('budget.remaining')}: {formatMoney(b.remaining)}</small>
                    </td>
                    <td>
                      <span className={`badge ${b.over ? 'danger' : 'success'}`}>{b.over ? t('budget.over') : t('budget.on_track')}</span>
                    </td>
                    <td>
                      <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => remove(b.id)}>{t('budget.delete')}</button>
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
