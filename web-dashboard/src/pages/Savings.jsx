import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

function money(v) {
  return Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export default function Savings() {
  const { t } = useT();
  const [tab, setTab] = useState('overview');
  const [summary, setSummary] = useState(null);
  const [goals, setGoals] = useState([]);
  const [deposits, setDeposits] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const [gForm, setGForm] = useState({ name: '', target_amount: '', deadline: '', icon: '🎯' });
  const [contribute, setContribute] = useState({ goalId: null, amount: '' });
  const [ruleForm, setRuleForm] = useState({ goalId: '', frequency: 'MONTHLY', amount: '' });
  const [dForm, setDForm] = useState({ amount: '', term_months: '', annual_rate: '' });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('savings.error') });
  const ok = (text) => { setMsg({ type: 'ok', text }); };

  const load = () => {
    api.get('/savings/summary').then((r) => setSummary(r.data.summary)).catch(() => {});
    api.get('/savings/goals').then((r) => setGoals(r.data.goals || [])).catch(() => {});
    api.get('/savings/deposits').then((r) => setDeposits(r.data.deposits || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const createGoal = async (e) => {
    e.preventDefault();
    try {
      await api.post('/savings/goals', gForm);
      ok(t('savings.goal_created'));
      setGForm({ name: '', target_amount: '', deadline: '', icon: '🎯' });
      load();
    } catch (err) { error(err); }
  };

  const doContribute = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/savings/goals/${contribute.goalId}/contribute`, { amount: contribute.amount });
      ok(t('savings.contributed'));
      setContribute({ goalId: null, amount: '' });
      load();
    } catch (err) { error(err); }
  };

  const createRule = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/savings/goals/${ruleForm.goalId}/auto-save`, { frequency: ruleForm.frequency, amount: ruleForm.amount });
      ok(t('savings.rule_created'));
      setRuleForm({ goalId: '', frequency: 'MONTHLY', amount: '' });
    } catch (err) { error(err); }
  };

  const runAutoSave = async () => {
    try {
      const r = await api.post('/savings/auto-save/run');
      ok(`${t('savings.auto_run')} ${r.data.result?.message || ''}`);
      load();
    } catch (err) { error(err); }
  };

  const createDeposit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/savings/deposits', dForm);
      ok(t('savings.deposit_created'));
      setDForm({ amount: '', term_months: '', annual_rate: '' });
      load();
    } catch (err) { error(err); }
  };

  const withdraw = async (id, allowEarly) => {
    try {
      await api.post(`/savings/deposits/${id}/withdraw`, { allow_early: allowEarly });
      ok(t(allowEarly ? 'savings.deposit_withdrawn_early' : 'savings.deposit_withdrawn'));
      load();
    } catch (err) { error(err); }
  };

  const tabs = [
    { id: 'overview', label: t('savings.overview_tab') },
    { id: 'goals', label: t('savings.goals_tab') },
    { id: 'autosave', label: t('savings.autosave_tab') },
    { id: 'deposits', label: t('savings.deposits_tab') },
  ];

  const stats = summary ? [
    { label: t('savings.total_saved'), value: money(summary.totalSavedOverall), icon: '💾' },
    { label: t('savings.goal_balance'), value: money(summary.goalBalance), icon: '🎯' },
    { label: t('savings.active_principal'), value: money(summary.activeDepositsPrincipal), icon: '🏦' },
    { label: t('savings.projected_interest'), value: money(summary.projectedInterest), icon: '📈' },
  ] : [];

  return (
    <div>
      <div className="page-head">
        <h2>🏦 {t('savings.title')}</h2>
        <p>{t('savings.sub')}</p>
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

      {tab === 'overview' && (
        <div>
          {summary && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
              {stats.map((s, i) => (
                <div className="card" key={i} style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 26 }}>{s.icon}</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{s.value}</div>
                  <div className="roles-tag" style={{ margin: '4px 0 0' }}>{s.label}</div>
                </div>
              ))}
            </div>
          )}
          <div className="card">
            <h3 style={{ margin: '0 0 14px' }}>{t('savings.your_goals')}</h3>
            {goals.length === 0 ? (
              <p className="roles-tag">{t('savings.no_goals')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('savings.name')}</th>
                      <th>{t('savings.progress')}</th>
                      <th>{t('savings.current')}</th>
                      <th>{t('savings.target')}</th>
                      <th>{t('savings.deadline')}</th>
                      <th>{t('savings.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {goals.map((g) => {
                      const pct = g.progress || (g.target_amount ? Math.min(100, (g.current_amount / g.target_amount) * 100) : 0);
                      return (
                        <tr key={g.id}>
                          <td><strong>{g.icon} {g.name}</strong></td>
                          <td style={{ minWidth: 160 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ flex: 1, height: 8, borderRadius: 6, background: '#e2e8f0', overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${pct}%`, borderRadius: 6, background: pct >= 100 ? '#22c55e' : '#0ea5e9' }} />
                              </div>
                              <span style={{ fontSize: 12 }}>{pct.toFixed(0)}%</span>
                            </div>
                          </td>
                          <td>{money(g.current_amount)}</td>
                          <td>{money(g.target_amount)}</td>
                          <td>{g.deadline ? new Date(g.deadline).toLocaleDateString() : '—'}</td>
                          <td><span className={`badge ${g.status === 'COMPLETED' ? 'success' : 'info'}`}>{g.status || 'ACTIVE'}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'goals' && (
        <div>
          <div className="card" style={{ maxWidth: 560 }}>
            <h3 style={{ margin: '0 0 12px' }}>{t('savings.new_goal')}</h3>
            <form onSubmit={createGoal} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label>{t('savings.name')}<input value={gForm.name} onChange={(e) => setGForm({ ...gForm, name: e.target.value })} required /></label>
              <div style={{ display: 'flex', gap: 12 }}>
                <label style={{ flex: 1 }}>{t('savings.target')}<input type="number" value={gForm.target_amount} onChange={(e) => setGForm({ ...gForm, target_amount: e.target.value })} required /></label>
                <label style={{ flex: 1 }}>{t('savings.deadline')}<input type="date" value={gForm.deadline} onChange={(e) => setGForm({ ...gForm, deadline: e.target.value })} /></label>
              </div>
              <label>{t('savings.icon')}<input value={gForm.icon} onChange={(e) => setGForm({ ...gForm, icon: e.target.value })} /></label>
              <button className="btn" type="submit">{t('savings.new_goal')}</button>
            </form>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h3 style={{ margin: '0 0 14px' }}>{t('savings.contrib')}</h3>
            {goals.length === 0 ? (
              <p className="roles-tag">{t('savings.no_goals')}</p>
            ) : (
              <form onSubmit={doContribute} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <label style={{ flex: 1, minWidth: 200 }}>
                  {t('savings.name')}
                  <select value={contribute.goalId || ''} onChange={(e) => setContribute({ ...contribute, goalId: e.target.value })} required>
                    <option value="">—</option>
                    {goals.filter((g) => g.status !== 'COMPLETED').map((g) => <option key={g.id} value={g.id}>{g.icon} {g.name}</option>)}
                  </select>
                </label>
                <label style={{ flex: 1, minWidth: 140 }}>
                  {t('savings.amount')}
                  <input type="number" value={contribute.amount} onChange={(e) => setContribute({ ...contribute, amount: e.target.value })} required />
                </label>
                <button className="btn" type="submit">{t('savings.contrib')}</button>
              </form>
            )}
          </div>
        </div>
      )}

      {tab === 'autosave' && (
        <div>
          <div className="card">
            <h3 style={{ margin: '0 0 12px' }}>{t('savings.new_rule')}</h3>
            <form onSubmit={createRule} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ flex: 1, minWidth: 200 }}>
                {t('savings.name')}
                <select value={ruleForm.goalId} onChange={(e) => setRuleForm({ ...ruleForm, goalId: e.target.value })} required>
                  <option value="">—</option>
                  {goals.filter((g) => g.status !== 'COMPLETED').map((g) => <option key={g.id} value={g.id}>{g.icon} {g.name}</option>)}
                </select>
              </label>
              <label style={{ minWidth: 140 }}>
                {t('savings.frequency')}
                <select value={ruleForm.frequency} onChange={(e) => setRuleForm({ ...ruleForm, frequency: e.target.value })}>
                  <option value="DAILY">Daily</option>
                  <option value="WEEKLY">Weekly</option>
                  <option value="MONTHLY">Monthly</option>
                </select>
              </label>
              <label style={{ minWidth: 140 }}>
                {t('savings.amount')}
                <input type="number" value={ruleForm.amount} onChange={(e) => setRuleForm({ ...ruleForm, amount: e.target.value })} required />
              </label>
              <button className="btn" type="submit">{t('savings.create_rule')}</button>
            </form>
          </div>
          <div className="card" style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ margin: '0 0 4px' }}>{t('savings.auto_run')}</h3>
              <p className="roles-tag" style={{ margin: 0 }}>{t('savings.auto_run_desc')}</p>
            </div>
            <button className="btn" onClick={runAutoSave}>{t('savings.run_now')}</button>
          </div>
        </div>
      )}

      {tab === 'deposits' && (
        <div>
          <div className="card" style={{ maxWidth: 560 }}>
            <h3 style={{ margin: '0 0 12px' }}>{t('savings.new_deposit')}</h3>
            <form onSubmit={createDeposit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label>{t('savings.amount')}<input type="number" value={dForm.amount} onChange={(e) => setDForm({ ...dForm, amount: e.target.value })} required /></label>
              <div style={{ display: 'flex', gap: 12 }}>
                <label style={{ flex: 1 }}>{t('savings.term_months')}<input type="number" min="1" max="24" value={dForm.term_months} onChange={(e) => setDForm({ ...dForm, term_months: e.target.value })} required /></label>
                <label style={{ flex: 1 }}>{t('savings.annual_rate')}<input type="number" step="0.1" value={dForm.annual_rate} onChange={(e) => setDForm({ ...dForm, annual_rate: e.target.value })} placeholder="10.0" /></label>
              </div>
              <button className="btn" type="submit">{t('savings.new_deposit')}</button>
            </form>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            {deposits.length === 0 ? (
              <p className="roles-tag">{t('savings.no_deposits')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('savings.amount')}</th>
                      <th>{t('savings.term_months')}</th>
                      <th>{t('savings.annual_rate')}</th>
                      <th>{t('savings.maturity')}</th>
                      <th>{t('savings.interest_accrued')}</th>
                      <th>{t('savings.status')}</th>
                      <th>{t('savings.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deposits.map((d) => (
                      <tr key={d.id}>
                        <td><strong>{money(d.amount)}</strong></td>
                        <td>{d.term_months} {t('savings.months')}</td>
                        <td>{d.annual_rate}%</td>
                        <td>{new Date(d.maturity_date).toLocaleDateString()}</td>
                        <td>{d.interest_accrued ? money(d.interest_accrued) : '—'}</td>
                        <td><span className={`badge ${d.status === 'ACTIVE' ? 'info' : d.status === 'MATURED' ? 'success' : 'warning'}`}>{d.status}</span></td>
                        <td>
                          {d.status === 'ACTIVE' && (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => withdraw(d.id, false)}>{t('savings.withdraw')}</button>
                              <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => withdraw(d.id, true)}>{t('savings.withdraw_early')}</button>
                            </div>
                          )}
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
    </div>
  );
}