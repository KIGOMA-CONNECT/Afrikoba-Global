import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

function money(v) {
  return (Number(v) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

const CAT_COLORS = ['#0ea5e9', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#ec4899', '#64748b'];

export default function Insights() {
  const { t } = useT();
  const [tab, setTab] = useState('analytics');
  const [byCategory, setByCategory] = useState([]);
  const [trend, setTrend] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [averages, setAverages] = useState(null);
  const [stmt, setStmt] = useState({ transactions: [], summary: {} });
  const [stmtFilter, setStmtFilter] = useState({ type: '', limit: '50' });
  const [debts, setDebts] = useState([]);
  const [debtSummary, setDebtSummary] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [dForm, setDForm] = useState({ direction: 'OWED', counterparty_name: '', counterparty_phone: '', amount: '', description: '', due_date: '' });
  const [payAmt, setPayAmt] = useState({});
  const [ai, setAi] = useState({ insights: [], healthScore: 0 });
  const [cf, setCf] = useState({ forecast: [], balance: 0 });
  const [aiLoading, setAiLoading] = useState(true);

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('insights.error') });
  const ok = (text) => { setMsg({ type: 'ok', text }); };

  const loadAnalytics = () => {
    api.get('/banking/analytics/spending').then((r) => setByCategory(r.data.byCategory || [])).catch(() => {});
    api.get('/banking/analytics/trend').then((r) => setTrend(r.data.trend || [])).catch(() => {});
    api.get('/banking/analytics/top-recipients').then((r) => setRecipients(r.data.recipients || [])).catch(() => {});
    api.get('/banking/analytics/averages').then((r) => setAverages(r.data.averages || null)).catch(() => {});
  };

  const loadStmt = () => {
    api.get('/banking/statements', { params: stmtFilter }).then((r) => {
      setStmt({ transactions: r.data.transactions || [], summary: r.data.summary || {} });
    }).catch(() => {});
  };

  const loadDebts = () => {
    api.get('/smart/debts').then((r) => setDebts(r.data.debts || [])).catch(() => {});
    api.get('/smart/debts/summary').then((r) => setDebtSummary(r.data.summary || null)).catch(() => {});
  };

  const loadAI = () => {
    setAiLoading(true);
    api.get('/ai/insights').then((r) => setAi({ insights: r.data.insights || [], healthScore: r.data.healthScore || 0 })).catch(() => {});
    api.get('/ai/cashflow', { params: { months: 3 } }).then((r) => setCf(r.data || { forecast: [], balance: 0 })).catch(() => {});
    setAiLoading(false);
  };

  const refreshAI = async () => {
    setAiLoading(true);
    try {
      const r = await api.post('/ai/insights/refresh');
      setAi({ insights: r.data.insights || [], healthScore: r.data.healthScore || 0 });
      ok(t('insights.ai_refreshed'));
    } catch (err) { error(err); }
    api.get('/ai/cashflow', { params: { months: 3 } }).then((r) => setCf(r.data || { forecast: [], balance: 0 })).catch(() => {});
    setAiLoading(false);
  };

  const dismissAI = async (id) => {
    try {
      await api.post(`/ai/insights/${id}/dismiss`);
      ok(t('insights.ai_dismissed'));
      loadAI();
    } catch (err) { error(err); }
  };

  useEffect(() => {
    loadAnalytics();
    loadStmt();
    loadDebts();
    loadAI();
    // eslint-disable-next-line
  }, []);

  useEffect(() => { if (tab === 'statements') loadStmt(); }, [tab]);

  const createDebt = async (e) => {
    e.preventDefault();
    try {
      await api.post('/smart/debts', dForm);
      ok(t('insights.debt_created'));
      setDForm({ direction: 'OWED', counterparty_name: '', counterparty_phone: '', amount: '', description: '', due_date: '' });
      loadDebts();
    } catch (err) { error(err); }
  };

  const payDebt = async (id) => {
    const amount = Number(payAmt[id]);
    if (!amount || amount <= 0) return;
    try {
      await api.post(`/smart/debts/${id}/pay`, { amount });
      ok(t('insights.paid_ok'));
      setPayAmt((p) => ({ ...p, [id]: '' }));
      loadDebts();
    } catch (err) { error(err); }
  };

  const writeOff = async (id) => {
    try {
      await api.post(`/smart/debts/${id}/write-off`);
      ok(t('insights.writeoff_ok'));
      loadDebts();
    } catch (err) { error(err); }
  };

  const tabs = [
    { id: 'analytics', label: t('insights.analytics_tab') },
    { id: 'ai', label: t('insights.ai_tab') },
    { id: 'statements', label: t('insights.stmt_tab') },
    { id: 'debts', label: t('insights.debts_tab') },
  ];

  const maxCat = Math.max(1, ...byCategory.map((c) => Number(c.total)));
  const maxTrend = Math.max(1, ...trend.map((x) => Number(x.total)));

  return (
    <div>
      <div className="page-head">
        <h2>{t('insights.title')}</h2>
        <p>{t('insights.sub')}</p>
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

      {tab === 'analytics' && (
        <div>
          {/* Averages stats */}
          {averages && (
            <div className="stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, marginBottom: 24 }}>
              <div className="card" style={{ padding: 18 }}><p className="roles-tag" style={{ margin: 0 }}>{t('insights.avg_income')}</p><h3 style={{ margin: 0, marginTop: 4 }}>{money(averages.avg_income)}</h3></div>
              <div className="card" style={{ padding: 18 }}><p className="roles-tag" style={{ margin: 0 }}>{t('insights.avg_expense')}</p><h3 style={{ margin: 0, marginTop: 4 }}>{money(averages.avg_expense)}</h3></div>
              <div className="card" style={{ padding: 18 }}><p className="roles-tag" style={{ margin: 0 }}>{t('insights.avg_net')}</p><h3 style={{ margin: 0, marginTop: 4 }}>{money(averages.avg_net)}</h3></div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 16, marginBottom: 24 }}>
            {/* Spending by category */}
            <div className="card">
              <h3 style={{ margin: '0 0 14px' }}>{t('insights.by_category')}</h3>
              {byCategory.length === 0 ? (
                <p className="roles-tag">{t('insights.empty')}</p>
              ) : (
                byCategory.map((c, i) => (
                  <div key={c.category} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                      <span>{c.category}</span><strong>{money(c.total)}</strong>
                    </div>
                    <div style={{ height: 8, borderRadius: 6, background: '#e2e8f0', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${(Number(c.total) / maxCat) * 100}%`, borderRadius: 6, background: CAT_COLORS[i % CAT_COLORS.length] }} />
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Top recipients */}
            <div className="card">
              <h3 style={{ margin: '0 0 14px' }}>{t('insights.top_recipients')}</h3>
              {recipients.length === 0 ? (
                <p className="roles-tag">{t('insights.empty')}</p>
              ) : (
                <table className="table">
                  <thead><tr><th>{t('insights.recipient')}</th><th>{t('insights.amount')}</th></tr></thead>
                  <tbody>
                    {recipients.map((r, i) => (
                      <tr key={i}><td>{r.recipient || r.name || r.phone || '—'}</td><td>{money(r.total)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Monthly trend */}
          <div className="card">
            <h3 style={{ margin: '0 0 14px' }}>{t('insights.trend')}</h3>
            {trend.length === 0 ? (
              <p className="roles-tag">{t('insights.empty')}</p>
            ) : (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, minHeight: 160, paddingTop: 10, overflowX: 'auto' }}>
                {trend.map((x) => (
                  <div key={x.month} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '1 0 48px' }}>
                    <strong style={{ fontSize: 12 }}>{money(x.total)}</strong>
                    <div style={{ width: 34, height: `${Math.max(4, (Number(x.total) / maxTrend) * 120)}px`, borderRadius: '6px 6px 0 0', background: 'linear-gradient(180deg,#22d3ee,#0ea5e9)' }} />
                    <span style={{ fontSize: 11, marginTop: 6, color: '#64748b' }}>{x.month}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'ai' && (
        <div>
          <div className="card" style={{ marginBottom: 24, padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <h3 style={{ margin: 0 }}>{t('insights.ai_tab')} · {t('insights.ai_engine')}</h3>
                <p className="roles-tag" style={{ margin: '6px 0 0' }}>{t('insights.ai_model')} <strong>afri-ai-1.0</strong> — {t('insights.ai_selfhosted')}</p>
              </div>
              <button className="btn" onClick={refreshAI} disabled={aiLoading}>{aiLoading ? t('insights.ai_loading') : t('insights.ai_refresh')}</button>
            </div>
            <div className="stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14, marginTop: 18 }}>
              <div className="card" style={{ padding: 18, textAlign: 'center', background: ai.healthScore >= 70 ? '#f0fdf4' : ai.healthScore >= 45 ? '#fffbeb' : '#fef2f2', border: `2px solid ${ai.healthScore >= 70 ? '#22c55e' : ai.healthScore >= 45 ? '#f59e0b' : '#ef4444'}` }}>
                <p className="roles-tag" style={{ margin: 0 }}>{t('insights.ai_health')}</p>
                <h2 style={{ margin: '4px 0 0', fontSize: 40 }}>{ai.healthScore}%</h2>
              </div>
            </div>
          </div>

          {/* Cashflow forecast */}
          <div className="card" style={{ marginBottom: 24 }}>
            <h3 style={{ margin: '0 0 6px' }}>{t('insights.ai_cashflow')}</h3>
            <p className="roles-tag" style={{ margin: '0 0 10px' }}>{t('insights.ai_balance')}: <strong>{money(cf.balance)}</strong></p>
            {cf.forecast && cf.forecast.length > 0 ? (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {cf.forecast.map((f) => (
                  <div key={f.month} className="card" style={{ padding: 14, textAlign: 'center', minWidth: 120 }}>
                    <p className="roles-tag" style={{ margin: 0 }}>{t('insights.ai_month')} {f.month}</p>
                    <strong style={{ color: f.projected_balance < 0 ? '#dc2626' : '#16a34a' }}>{money(f.projected_balance)}</strong>
                    <p className="roles-tag" style={{ margin: '6px 0 0' }}>{t('insights.ai_net')} {money(f.net_flow)}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="roles-tag">{t('insights.empty')}</p>
            )}
          </div>

          {/* Insights list */}
          <div className="card">
            <h3 style={{ margin: '0 0 12px' }}>{t('insights.ai_insights')}</h3>
            {!aiLoading && ai.insights.length === 0 && <p className="roles-tag">{t('insights.ai_empty')}</p>}
            {ai.insights.map((ins) => (
              <div key={ins.id} className="card" style={{ marginBottom: 12, border: '1px solid #e2e8f0', borderLeft: `4px solid ${ins.severity === 'alert' ? '#ef4444' : ins.severity === 'warning' ? '#f59e0b' : ins.severity === 'good' ? '#22c55e' : '#0ea5e9'}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                  <div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span className={`badge ${ins.severity === 'good' ? 'success' : ins.severity === 'alert' ? 'danger' : ins.severity === 'warning' ? 'warning' : 'info'}`}>{ins.severity}</span>
                      <strong>{ins.title}</strong>
                    </div>
                    <p style={{ margin: '8px 0 0', fontSize: 13 }}>{ins.body}</p>
                    <p className="roles-tag" style={{ margin: '6px 0 0' }}>{ins.insight_type} · {ins.model_version} · {new Date(ins.created_at).toLocaleString()}</p>
                  </div>
                  <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => dismissAI(ins.id)}>{t('insights.ai_dismiss')}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'statements' && (
        <div>
          <div className="card" style={{ marginBottom: 24 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, alignItems: 'end' }}>
              <label>{t('insights.stmt_type')}
                <select value={stmtFilter.type} onChange={(e) => setStmtFilter({ ...stmtFilter, type: e.target.value })}>
                  <option value="">{t('insights.all')}</option>
                  <option value="DEPOSIT">Deposit</option>
                  <option value="TRANSFER">Transfer</option>
                  <option value="WITHDRAWAL">Withdrawal</option>
                  <option value="PAYMENT">Payment</option>
                </select>
              </label>
              <label>{t('insights.limit')}
                <input type="number" value={stmtFilter.limit} onChange={(e) => setStmtFilter({ ...stmtFilter, limit: e.target.value })} />
              </label>
              <button className="btn" onClick={loadStmt}>{t('insights.filter')}</button>
            </div>
            {stmt.summary && (stmt.summary.total_in || stmt.summary.total_out) && (
              <div className="stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginTop: 16 }}>
                <div><p className="roles-tag" style={{ margin: 0 }}>{t('insights.total_in')}</p><strong>{money(stmt.summary.total_in)}</strong></div>
                <div><p className="roles-tag" style={{ margin: 0 }}>{t('insights.total_out')}</p><strong>{money(stmt.summary.total_out)}</strong></div>
                <div><p className="roles-tag" style={{ margin: 0 }}>{t('insights.net_flow')}</p><strong>{money((Number(stmt.summary.total_in) || 0) - (Number(stmt.summary.total_out) || 0))}</strong></div>
              </div>
            )}
          </div>

          <div className="card">
            {!stmt.transactions || stmt.transactions.length === 0 ? (
              <p className="roles-tag">{t('insights.stmt_empty')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('insights.date')}</th>
                      <th>{t('insights.type')}</th>
                      <th>{t('insights.desc')}</th>
                      <th>{t('insights.amount')}</th>
                      <th>{t('insights.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stmt.transactions.map((tx) => (
                      <tr key={tx.id}>
                        <td>{new Date(tx.created_at).toLocaleString()}</td>
                        <td><span className="badge info">{tx.type}</span></td>
                        <td>{tx.description || tx.reference_id || '—'}</td>
                        <td style={{ color: String(tx.type).includes('DEPOSIT') || String(tx.type) === 'CASHBACK' ? '#16a34a' : '#dc2626' }}>
                          {String(tx.type).includes('DEPOSIT') || String(tx.type) === 'CASHBACK' ? '+' : '-'}{money(tx.wallet_amount ?? tx.total_charged)}
                        </td>
                        <td><span className={`badge ${tx.status === 'SUCCESS' ? 'success' : 'danger'}`}>{tx.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'debts' && (
        <div>
          {debtSummary && (
            <div className="stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, marginBottom: 24 }}>
              <div className="card" style={{ padding: 18 }}><p className="roles-tag" style={{ margin: 0 }}>{t('insights.lent_out')}</p><h3 style={{ margin: 0, marginTop: 4 }}>{money(debtSummary.LENT?.outstanding)}</h3></div>
              <div className="card" style={{ padding: 18 }}><p className="roles-tag" style={{ margin: 0 }}>{t('insights.owed_out')}</p><h3 style={{ margin: 0, marginTop: 4 }}>{money(debtSummary.OWED?.outstanding)}</h3></div>
              <div className="card" style={{ padding: 18 }}><p className="roles-tag" style={{ margin: 0 }}>{t('insights.net')}</p><h3 style={{ margin: 0, marginTop: 4, color: (debtSummary.net || 0) >= 0 ? '#16a34a' : '#dc2626' }}>{money(debtSummary.net)}</h3></div>
            </div>
          )}

          <div className="card" style={{ marginBottom: 24 }}>
            <h3 style={{ margin: '0 0 12px' }}>{t('insights.debt_new')}</h3>
            <form onSubmit={createDebt} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 12 }}>
              <label>{t('insights.direction')}
                <select value={dForm.direction} onChange={(e) => setDForm({ ...dForm, direction: e.target.value })}>
                  <option value="OWED">I owe</option>
                  <option value="LENT">Lent out</option>
                </select>
              </label>
              <label>{t('insights.party')}<input value={dForm.counterparty_name} onChange={(e) => setDForm({ ...dForm, counterparty_name: e.target.value })} required /></label>
              <label>{t('insights.phone')}<input value={dForm.counterparty_phone} onChange={(e) => setDForm({ ...dForm, counterparty_phone: e.target.value })} /></label>
              <label>{t('insights.amount')}<input type="number" value={dForm.amount} onChange={(e) => setDForm({ ...dForm, amount: e.target.value })} required /></label>
              <label>{t('insights.due_date')}<input type="date" value={dForm.due_date} onChange={(e) => setDForm({ ...dForm, due_date: e.target.value })} /></label>
              <label style={{ gridColumn: '1 / -1' }}>{t('insights.desc')}<input value={dForm.description} onChange={(e) => setDForm({ ...dForm, description: e.target.value })} /></label>
              <div style={{ gridColumn: '1 / -1' }}><button className="btn" type="submit">{t('insights.debt_add')}</button></div>
            </form>
          </div>

          <div className="card">
            {debts.length === 0 ? (
              <p className="roles-tag">{t('insights.debt_empty')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('insights.direction')}</th>
                      <th>{t('insights.party')}</th>
                      <th>{t('insights.amount')}</th>
                      <th>{t('insights.outstanding')}</th>
                      <th>{t('insights.due_date')}</th>
                      <th>{t('insights.status')}</th>
                      <th>{t('insights.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {debts.map((d) => (
                      <tr key={d.id}>
                        <td><span className={`badge ${d.direction === 'LENT' ? 'success' : 'warning'}`}>{d.direction}</span></td>
                        <td>{d.counterparty_name || d.counterparty_phone || '—'}</td>
                        <td>{money(d.amount)}</td>
                        <td>{money((Number(d.amount) || 0) - (Number(d.amount_paid) || 0))}</td>
                        <td>{d.due_date ? new Date(d.due_date).toLocaleDateString() : '—'}</td>
                        <td><span className={`badge ${d.status === 'WRITTEN_OFF' ? 'danger' : d.status === 'PAID' ? 'success' : 'warning'}`}>{d.status}</span></td>
                        <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <input type="number" placeholder={t('insights.amount')} value={payAmt[d.id] || ''} onChange={(e) => setPayAmt({ ...payAmt, [d.id]: e.target.value })}
                            style={{ width: 90, padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1' }} />
                          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => payDebt(d.id)}>{t('insights.pay')}</button>
                          {d.direction === 'LENT' && d.status !== 'WRITTEN_OFF' && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => writeOff(d.id)}>{t('insights.writeoff')}</button>
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