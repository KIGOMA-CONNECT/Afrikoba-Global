import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

const VAULT_COLORS = ['#7C3AED', '#2563EB', '#059669', '#D97706', '#DB2777', '#0D9488', '#4F46E5', '#C026D3'];
const VAULT_ICONS = ['🏦', '🎯', '🚗', '🏠', '✈️', '🎓', '💍', '📱', '🛡️', '🌴', '🎁', '🧳'];

export default function Vaults() {
  const { t } = useT();
  const [vaults, setVaults] = useState([]);
  const [deposits, setDeposits] = useState([]);
  const [summary, setSummary] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [showVault, setShowVault] = useState(false);
  const [showDeposit, setShowDeposit] = useState(false);
  const [form, setForm] = useState({ name: '', target_amount: '', deadline: '', icon: '🎯', color: '#7C3AED' });
  const [depForm, setDepForm] = useState({ amount: '', term_months: '6' });
  const [fundVault, setFundVault] = useState(null);
  const [fundAmt, setFundAmt] = useState('');
  const [autoSaveGoal, setAutoSaveGoal] = useState(null);
  const [autoSaveForm, setAutoSaveForm] = useState({ amount: '', frequency: 'WEEKLY' });
  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('vaults.error') });

  const load = () => {
    api.get('/vaults').then((r) => setVaults(r.data.vaults)).catch(() => {});
    api.get('/vaults/deposits').then((r) => setDeposits(r.data.deposits)).catch(() => {});
    api.get('/vaults/summary').then((r) => setSummary(r.data.summary)).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const createVault = async (e) => {
    e.preventDefault();
    try {
      await api.post('/vaults', {
        name: form.name,
        target_amount: Number(form.target_amount),
        deadline: form.deadline || null,
        icon: form.icon,
        color: form.color,
      });
      setMsg({ type: 'ok', text: t('vaults.created') });
      setShowVault(false);
      setForm({ name: '', target_amount: '', deadline: '', icon: '🎯', color: '#7C3AED' });
      load();
    } catch (err) { error(err); }
  };

  const createDeposit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/vaults/deposits', { amount: Number(depForm.amount), term_months: Number(depForm.term_months) });
      setMsg({ type: 'ok', text: t('vaults.deposit_created') });
      setShowDeposit(false);
      setDepForm({ amount: '', term_months: '6' });
      load();
    } catch (err) { error(err); }
  };

  const depositInto = async (id) => {
    try {
      await api.post(`/vaults/${id}/deposit`, { amount: Number(fundAmt) });
      setMsg({ type: 'ok', text: t('vaults.funded') });
      setFundVault(null);
      setFundAmt('');
      load();
    } catch (err) { error(err); }
  };

  const withdrawFrom = async (id) => {
    const amt = prompt(t('vaults.withdraw_prompt'));
    if (!amt) return;
    try {
      await api.post(`/vaults/${id}/withdraw`, { amount: Number(amt) });
      load();
    } catch (err) { error(err); }
  };

  const enableAutoSave = async () => {
    try {
      await api.post(`/savings/goals/${autoSaveGoal}/auto-save`, {
        amount: Number(autoSaveForm.amount),
        frequency: autoSaveForm.frequency,
      });
      setMsg({ type: 'ok', text: t('vaults.auto_save_on') });
      setAutoSaveGoal(null);
      setAutoSaveForm({ amount: '', frequency: 'WEEKLY' });
      load();
    } catch (err) { error(err); }
  };

  const withdrawDeposit = async (id, matured) => {
    try {
      await api.post(`/vaults/deposits/${id}/withdraw`, matured ? {} : { allow_early: true });
      setMsg({ type: 'ok', text: t('vaults.withdrawn') });
      load();
    } catch (err) { error(err); }
  };

  const pct = (v) => Math.min(100, Math.round((Number(v.current_amount) / Number(v.target_amount)) * 100) || 0);

  return (
    <div>
      <div className="page-head">
        <h2>{t('vaults.title')}</h2>
        <p>{t('vaults.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      {/* Summary */}
      {summary && (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 24 }}>
          <div className="stat-card"><span className="label">{t('vaults.total_saved')}</span><strong style={{ color: 'var(--green)' }}>{formatMoney(summary.totalSavedOverall)}</strong></div>
          <div className="stat-card"><span className="label">{t('vaults.vaults_count')}</span><strong>{summary.totalGoals}</strong></div>
          <div className="stat-card"><span className="label">{t('vaults.vault_balance')}</span><strong>{formatMoney(summary.goalBalance)}</strong></div>
          <div className="stat-card"><span className="label">{t('vaults.locked')}</span><strong>{formatMoney(summary.activeDepositsPrincipal)}</strong></div>
          <div className="stat-card"><span className="label">{t('vaults.projected')}</span><strong style={{ color: 'var(--green)' }}>{formatMoney(summary.projectedInterest)}</strong></div>
        </div>
      )}

      {/* Vaults grid */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>{t('vaults.my_vaults')}</h3>
        <button className="btn" onClick={() => setShowVault(true)}>＋ {t('vaults.new_vault')}</button>
      </div>

      {vaults.length === 0 && !showVault ? (
        <div className="card" style={{ padding: 20, marginBottom: 24, textAlign: 'center' }}>
          <p className="roles-tag" style={{ fontSize: 34, marginBottom: 8 }}>🛡️</p>
          <p className="roles-tag">{t('vaults.empty')}</p>
          <button className="btn" style={{ marginTop: 10 }} onClick={() => setShowVault(true)}>{t('vaults.new_vault')}</button>
        </div>
      ) : (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', marginBottom: 24 }}>
          {vaults.map((v) => (
            <div key={v.id} className="card" style={{ borderTop: `4px solid ${v.color || '#7C3AED'}`, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 30 }}>{v.icon || '🎯'}</span>
                {v.is_completed && <span className="badge success">✓ {t('vaults.complete')}</span>}
              </div>
              <div>
                <h4 style={{ margin: 0, fontSize: 16 }}>{v.name}</h4>
                <small className="roles-tag" style={{ color: '#6b7a70' }}>{v.deadline ? `${t('vaults.deadline')}: ${v.deadline}` : t('vaults.no_deadline')}</small>
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <strong>{formatMoney(v.current_amount)}</strong>
                  <small className="roles-tag">/ {formatMoney(v.target_amount)}</small>
                </div>
                <div className="progress-bar-bg" style={{ height: 10, borderRadius: 6, overflow: 'hidden', background: '#e2e8f0' }}>
                  <div className="progress-bar-fill" style={{ width: `${pct(v)}%`, background: v.color || '#7C3AED', height: '100%' }} />
                </div>
                <small className="roles-tag" style={{ color: '#6b7a70' }}>{pct(v)}%</small>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                <button className="btn" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => { setFundVault(v.id); setFundAmt(''); }}>{t('vaults.fund')}</button>
                <button className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => withdrawFrom(v.id)}>{t('vaults.withdraw')}</button>
                <button className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: 12, color: v.auto_save_amount ? '#059669' : undefined }} onClick={() => { setAutoSaveGoal(v.id); setAutoSaveForm({ amount: v.auto_save_amount || '', frequency: v.auto_save_frequency || 'WEEKLY' }); }}>
                  {v.auto_save_amount ? `🔄 ${t('vaults.auto_save')}: ${formatMoney(v.auto_save_amount)}` : `🔄 ${t('vaults.auto_save')}`}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {fundVault && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('vaults.fund_vault')}</h3>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input type="number" min="0" placeholder={t('vaults.amount_ph')} value={fundAmt} onChange={(e) => setFundAmt(e.target.value)} style={{ flex: 1 }} />
            <button className="btn" onClick={() => depositInto(fundVault)}>{t('vaults.fund')}</button>
            <button className="btn btn-secondary" onClick={() => setFundVault(null)}>✕</button>
          </div>
        </div>
      )}

      {autoSaveGoal && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('vaults.auto_save')}</h3>
          <p className="roles-tag" style={{ marginBottom: 14 }}>{t('vaults.auto_save_hint')}</p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="number" min="1" placeholder={t('vaults.amount_ph')} value={autoSaveForm.amount} onChange={(e) => setAutoSaveForm({ ...autoSaveForm, amount: e.target.value })} style={{ flex: 1, minWidth: 140 }} />
            <select value={autoSaveForm.frequency} onChange={(e) => setAutoSaveForm({ ...autoSaveForm, frequency: e.target.value })} style={{ padding: '8px 10px', borderRadius: 8 }}>
              <option value="DAILY">{t('vaults.freq_daily')}</option>
              <option value="WEEKLY">{t('vaults.freq_weekly')}</option>
              <option value="MONTHLY">{t('vaults.freq_monthly')}</option>
            </select>
            <button className="btn" onClick={enableAutoSave}>{t('vaults.auto_save')}</button>
            <button className="btn btn-secondary" onClick={() => setAutoSaveGoal(null)}>✕</button>
          </div>
        </div>
      )}

      {/* New vault form */}
      {showVault && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('vaults.new_vault')}</h3>
          <form onSubmit={createVault} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('vaults.name')}
              <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder={t('vaults.name_ph')} />
            </label>
            <label>{t('vaults.target')}
              <input type="number" min="1" value={form.target_amount} onChange={(e) => setForm({ ...form, target_amount: e.target.value })} required />
            </label>
            <label>{t('vaults.deadline')}
              <input type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
            </label>
            <label>{t('vaults.icon')}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {VAULT_ICONS.map((ic) => (
                  <button key={ic} type="button" onClick={() => setForm({ ...form, icon: ic })} style={{ fontSize: 20, padding: '6px 8px', borderRadius: 8, border: form.icon === ic ? '2px solid var(--green)' : '1px solid #d1d5db', background: form.icon === ic ? '#f0fdf4' : '#fff', cursor: 'pointer' }}>{ic}</button>
                ))}
              </div>
            </label>
            <label>{t('vaults.color')}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {VAULT_COLORS.map((c) => (
                  <button key={c} type="button" onClick={() => setForm({ ...form, color: c })} style={{ width: 26, height: 26, borderRadius: '50%', background: c, border: form.color === c ? '3px solid #000' : '1px solid #d1d5db', cursor: 'pointer' }} />
                ))}
              </div>
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('vaults.create')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowVault(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      {/* Fixed deposits */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, marginTop: 10 }}>
        <h3 style={{ margin: 0 }}>{t('vaults.locked_title')}</h3>
        <button className="btn" onClick={() => setShowDeposit(true)}>＋ {t('vaults.lock_money')}</button>
      </div>

      {showDeposit && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('vaults.lock_money')}</h3>
          <p className="roles-tag" style={{ marginBottom: 14 }}>{t('vaults.lock_hint', { rate: 10 })}</p>
          <form onSubmit={createDeposit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('vaults.amount')}
              <input type="number" min="1" value={depForm.amount} onChange={(e) => setDepForm({ ...depForm, amount: e.target.value })} required />
            </label>
            <label>{t('vaults.term')}
              <select value={depForm.term_months} onChange={(e) => setDepForm({ ...depForm, term_months: e.target.value })}>
                {[3, 6, 9, 12, 18, 24].map((m) => <option key={m} value={m}>{m} {t('vaults.months')}</option>)}
              </select>
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('vaults.create')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowDeposit(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginBottom: 14 }}>{t('vaults.deposits_list')}</h3>
        {deposits.length === 0 ? (
          <p className="roles-tag">{t('vaults.no_deposits')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('vaults.amount')}</th>
                  <th>{t('vaults.term')}</th>
                  <th>{t('vaults.rate')}</th>
                  <th>{t('vaults.maturity')}</th>
                  <th>{t('vaults.status')}</th>
                  <th>{t('vaults.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {deposits.map((d) => {
                  const matured = new Date(d.maturity_date) <= new Date();
                  return (
                    <tr key={d.id}>
                      <td><strong>{formatMoney(d.amount)}</strong></td>
                      <td>{d.term_months} {t('vaults.months')}</td>
                      <td>{d.annual_rate}%</td>
                      <td>{d.maturity_date}</td>
                      <td><span className={`badge ${d.status === 'ACTIVE' ? (matured ? 'success' : 'info') : 'danger'}`}>{d.status}</span></td>
                      <td>
                        {d.status === 'ACTIVE' && (
                          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => withdrawDeposit(d.id, matured)}>
                            {matured ? t('vaults.withdraw') : t('vaults.withdraw_early')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
