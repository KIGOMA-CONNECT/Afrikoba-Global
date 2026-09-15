import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

function money(v) {
  return Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export default function Projects() {
  const { t } = useT();
  const [tab, setTab] = useState('marketplace');
  const [projects, setProjects] = useState([]);
  const [mine, setMine] = useState([]);
  const [investments, setInvestments] = useState([]);
  const [queue, setQueue] = useState([]);
  const [transparency, setTransparency] = useState([]);
  const [transDetail, setTransDetail] = useState(null);
  const [capTable, setCapTable] = useState(null);
  const [performance, setPerformance] = useState(null);
  const [settlement, setSettlement] = useState(null);
  const [closeOut, setCloseOut] = useState(null);
  const [statement, setStatement] = useState(null);
  const [liquidation, setLiquidation] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [role, setRole] = useState('');
  const [expandedForm, setExpandedForm] = useState(false);

  const [form, setForm] = useState({
    name: '', description: '', category: '', location: '', capital_required: '',
    min_investment: '', duration_days: '', expected_revenue: '', expected_costs: '',
    projected_profit: '', reinvestment_pct: 30, reserve_pct: 10, owner_equity_pct: 20,
    distribution_method: 'PROPORTIONAL', funding_deadline: '',
    business_model: '', market_analysis: '', competition_analysis: '', management_team: '',
    use_of_funds: '', exit_timeline: '', compliance_certifications: '',
  });

  const [selected, setSelected] = useState(null);

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('projects.error') });
  const ok = (text) => { setMsg({ type: 'ok', text }); setSelected(null); };

  const load = () => {
    api.get('/projects', { params: { status: 'PUBLISHED' } }).then((r) => setProjects(r.data.projects || [])).catch(() => {});
    api.get('/projects', { params: { status: '' } }).then((r) => setMine(r.data.projects || [])).catch(() => {});
    api.get('/projects/mine/investments').then((r) => setInvestments(r.data.investments || [])).catch(() => {});
    api.get('/projects/mine/transparency').then((r) => setTransparency(r.data.investments || [])).catch(() => {});
    api.get('/projects/mine/performance').then((r) => setPerformance(r.data)).catch(() => {});
  };
  useEffect(() => {
    try { const u = JSON.parse(localStorage.getItem('afrikoba_user') || '{}'); setRole(u.role || ''); } catch (e) {}
    load();
  }, []);

  const loadQueue = () => {
    api.get('/projects/review-queue').then((r) => setQueue(r.data.queue || [])).catch(() => setQueue([]));
  };
  useEffect(() => { if (['ADMIN', 'MODERATOR', 'EXPERT'].includes(role)) loadQueue(); }, [role]);

  const createProject = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/projects', form);
      ok(t('projects.submitted'));
      setForm({ name: '', description: '', category: '', location: '', capital_required: '', min_investment: '', duration_days: '', expected_revenue: '', expected_costs: '', projected_profit: '', reinvestment_pct: 30, reserve_pct: 10, owner_equity_pct: 20, distribution_method: 'PROPORTIONAL', funding_deadline: '', business_model: '', market_analysis: '', competition_analysis: '', management_team: '', use_of_funds: '', exit_timeline: '', compliance_certifications: '' });
      load();
      setSelected(r.data.project.id);
    } catch (err) { error(err); }
  };

  const submitProject = async (id) => {
    try {
      await api.post(`/projects/${id}/submit`);
      ok(t('projects.submitted'));
      load();
      if (['ADMIN', 'MODERATOR', 'EXPERT'].includes(role)) loadQueue();
    } catch (err) { error(err); }
  };

  const payConsultation = async (id) => {
    try {
      await api.post(`/projects/${id}/consultation/pay`, { unique_reference: `pcf-${Date.now()}` });
      ok(t('projects.fee_paid'));
      load();
      if (['ADMIN', 'MODERATOR', 'EXPERT'].includes(role)) loadQueue();
    } catch (err) { error(err); }
  };

  const runAiReview = async (id) => {
    try {
      const r = await api.post(`/projects/${id}/ai-review/re-run`);
      const s = r.data.review?.review?.score;
      ok(`${t('projects.ai_score')}: ${s ?? '—'} (${r.data.review?.review?.recommended_action || ''})`);
      loadQueue();
    } catch (err) { error(err); }
  };

  const workflow = async (id, stage, decision) => {
    const reason = decision === 'APPROVED' ? null : prompt(t('projects.reason'));
    try {
      await api.post(`/projects/${id}/workflow`, { stage, decision, reason: reason || undefined });
      ok(`${stage}: ${decision}`);
      load(); loadQueue();
    } catch (err) { error(err); }
  };

  const expertPublish = async (id) => {
    try {
      await api.post(`/projects/${id}/publish`);
      ok(t('projects.published'));
      load(); loadQueue();
    } catch (err) { error(err); }
  };

  const invest = async (id) => {
    const amount = prompt(t('projects.amount'));
    if (!amount) return;
    try {
      const r = await api.post(`/projects/${id}/invest`, { amount, unique_reference: `web-${Date.now()}` });
      ok(`${t('projects.invested')} ${r.data.investment_id}`);
      load();
    } catch (err) { error(err); }
  };

  const showFinancials = async (id) => {
    try {
      const r = await api.get(`/projects/${id}/financials`);
      setSelected(r.data.financials);
    } catch (err) { error(err); }
  };

  const disburse = async (id) => {
    const amount = prompt(t('projects.amount'));
    if (!amount) return;
    try {
      await api.post(`/projects/${id}/disbursement`, { amount, unique_reference: `pd-${Date.now()}` });
      ok(t('projects.disburse'));
    } catch (err) { error(err); }
  };

  const recordRevenue = async (id) => {
    const amount = prompt(t('projects.revenue'));
    if (!amount) return;
    try {
      await api.post(`/projects/${id}/revenue`, { revenue_type: 'SALES', amount, unique_reference: `pr-${Date.now()}` });
      ok(t('projects.record_revenue'));
    } catch (err) { error(err); }
  };

  const distribute = async (id) => {
    const gp = prompt(t('projects.gross_profit'));
    if (!gp) return;
    try {
      await api.post(`/projects/${id}/distribution`, { gross_profit: gp });
      ok(t('projects.distributed'));
    } catch (err) { error(err); }
  };

  const viewTransparency = async (id) => {
    try {
      const r = await api.get(`/projects/${id}/transparency`);
      setTransDetail(r.data.transparency);
    } catch (err) { error(err); }
  };

  const viewCapTable = async (id) => {
    try {
      const r = await api.get(`/projects/${id}/cap-table`);
      setCapTable(r.data.capTable);
    } catch (err) { error(err); }
  };

  const refundInvestment = async (investmentId, projectId, projectName) => {
    if (!window.confirm(`${t('projects.refund_confirm')} ${projectName}?`)) return;
    try {
      const r = await api.post(`/projects/${projectId}/investments/${investmentId}/refund`);
      ok(`${t('projects.refunded')}${r.data.amount != null ? ` ${fmt(r.data.amount)}` : ''}`);
      load();
    } catch (err) { error(err); }
  };

  const payDividends = async (id) => {
    try {
      const r = await api.post(`/projects/${id}/dividend/payout`);
      ok(`${t('projects.dividend_paid')} (wawekezaji: ${(r.data.paid || []).length})`);
      if (transDetail) viewTransparency(transDetail.project.id);
      load();
    } catch (err) { error(err); }
  };

  const completeProject = async (id, name) => {
    if (!window.confirm(`${t('projects.complete_confirm')} "${name}"?`)) return;
    try {
      const r = await api.post(`/projects/${id}/complete`);
      const s = r.data.settlement || {};
      ok(`${t('projects.completed')} · ${t('projects.returned_to_investors')}: ${fmt(s.returned_to_investors || 0)}, ${t('projects.owner_received')}: ${fmt(s.owner_received || 0)}`);
      setSettlement(null);
      load();
    } catch (err) { error(err); }
  };

  const viewSettlement = async (id) => {
    try {
      const r = await api.get(`/projects/${id}/settlement`);
      setSettlement(r.data);
    } catch (err) { error(err); }
  };

  const releaseReserve = async (fund) => {
    if (!settlement || !settlement.project) return;
    const fundType = fund === 'OWNER_RESIDUAL' ? t('projects.residual_payout') : t('projects.reserve_payout');
    if (!window.confirm(`${fundType} "${settlement.project.name}"?`)) return;
    try {
      const r = await api.post(`/projects/${settlement.project.id}/close-out/${fund === 'OWNER_RESIDUAL' ? 'residual' : 'reserve'}`);
      if (r.data.already_released) {
        ok(t('projects.reserve_already'));
      } else {
        ok(`${t('projects.reserve_released_ok')} ${fmt(r.data.amount)}`);
      }
      viewSettlement(settlement.project.id);
      load();
    } catch (err) { error(err); }
  };

  const viewCloseOut = async (id) => {
    try {
      const r = await api.get(`/projects/${id}/close-out`);
      setCloseOut(r.data);
    } catch (err) { error(err); }
  };

  const viewStatement = async (id) => {
    try {
      const r = await api.get(`/projects/${id}/statement`);
      setStatement(r.data);
      setSettlement(null);
      setCloseOut(null);
    } catch (err) { error(err); }
  };

  const downloadStatement = (id) => {
    const token = localStorage.getItem('afrikoba_token');
    fetch(`/api/projects/${id}/statement/export`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.blob();
      })
      .then((blob) => {
        const u = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = u;
        a.download = `project-${id}-statement.csv`;
        a.click();
        URL.revokeObjectURL(u);
      })
      .catch(() => ok(t('projects.error')));
  };

  const viewLiquidation = async (id) => {
    try {
      const r = await api.get(`/projects/${id}/liquidation`);
      setLiquidation(r.data);
      setStatement(null);
      setCloseOut(null);
    } catch (err) { error(err); }
  };

  const liquidate = async (id) => {
    if (!window.confirm(t('projects.liquidation_confirm'))) return;
    try {
      const r = await api.post(`/projects/${id}/liquidate`);
      ok(`${t('projects.liquidated_ok')} ${t('projects.liq_reference')}: ${r.data.reference}`);
      load();
      viewLiquidation(id);
    } catch (err) { error(err); }
  };

  const viewReceipt = async (id) => {
    try {
      const r = await api.get(`/projects/${id}/receipt`);
      setReceipt(r.data);
      setStatement(null);
      setCloseOut(null);
      setLiquidation(null);
    } catch (err) { error(err); }
  };

  const downloadReceipt = (id) => {
    const token = localStorage.getItem('afrikoba_token');
    fetch(`/api/projects/${id}/receipt/export`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.blob();
      })
      .then((blob) => {
        const u = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = u;
        a.download = `project-${id}-receipt.csv`;
        a.click();
        URL.revokeObjectURL(u);
      })
      .catch(() => ok(t('projects.error')));
  };

  const downloadPortfolio = () => {
    const token = localStorage.getItem('afrikoba_token');
    fetch('/api/projects/mine/performance/export', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.blob();
      })
      .then((blob) => {
        const u = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = u;
        a.download = 'my-project-portfolio.csv';
        a.click();
        URL.revokeObjectURL(u);
      })
      .catch(() => ok(t('projects.error')));
  };

  const viewLedger = async (id) => {
    try {
      const r = await api.get(`/projects/${id}/ledger`);
      setLedger(r.data);
      setStatement(null);
      setCloseOut(null);
      setLiquidation(null);
      setReceipt(null);
    } catch (err) { error(err); }
  };

  const tabs = [
    { id: 'marketplace', label: t('projects.marketplace_tab') },
    { id: 'myprojects', label: t('projects.myprojects_tab') },
    { id: 'myinvest', label: t('projects.myinvest_tab') },
    { id: 'transparency', label: t('projects.transparency_tab') },
  ];
  if (['ADMIN', 'MODERATOR', 'EXPERT'].includes(role)) {
    tabs.push({ id: 'review', label: `${t('projects.review_queue')} (${queue.length})` });
  }

  const fmt = (v) => money(v);

  return (
    <div>
      <div className="page-head">
        <h2>🚀 {t('projects.title')}</h2>
        <p>{t('projects.sub')}</p>
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

      {tab === 'marketplace' && (
        <div>
          <div className="card" style={{ maxWidth: 720 }}>
            <h3 style={{ margin: '0 0 12px' }}>{t('projects.new_project')}</h3>
            <form onSubmit={createProject} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 12 }}>
                <label style={{ flex: 2 }}>{t('projects.name')}<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
                <label style={{ flex: 1 }}>{t('projects.category')}<input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></label>
              </div>
              <label>{t('projects.description')}<textarea rows="2" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
              <div style={{ display: 'flex', gap: 12 }}>
                <label style={{ flex: 1 }}>{t('projects.location')}<input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></label>
                <label style={{ flex: 1 }}>{t('projects.duration_days')}<input type="number" value={form.duration_days} onChange={(e) => setForm({ ...form, duration_days: e.target.value })} /></label>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: 12 }}>
                <label>{t('projects.capital_required')}<input type="number" value={form.capital_required} onChange={(e) => setForm({ ...form, capital_required: e.target.value })} required /></label>
                <label>{t('projects.min_investment')}<input type="number" value={form.min_investment} onChange={(e) => setForm({ ...form, min_investment: e.target.value })} /></label>
                <label>{t('projects.expected_revenue')}<input type="number" value={form.expected_revenue} onChange={(e) => setForm({ ...form, expected_revenue: e.target.value })} /></label>
                <label>{t('projects.expected_costs')}<input type="number" value={form.expected_costs} onChange={(e) => setForm({ ...form, expected_costs: e.target.value })} /></label>
                <label>{t('projects.projected_profit')}<input type="number" value={form.projected_profit} onChange={(e) => setForm({ ...form, projected_profit: e.target.value })} /></label>
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <label style={{ minWidth: 220 }}>{t('projects.funding_deadline')}<input type="datetime-local" value={form.funding_deadline} onChange={(e) => setForm({ ...form, funding_deadline: e.target.value })} /></label>
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <label style={{ minWidth: 130 }}>{t('projects.reinvestment_pct')}<input type="number" value={form.reinvestment_pct} onChange={(e) => setForm({ ...form, reinvestment_pct: e.target.value })} /></label>
                <label style={{ minWidth: 130 }}>{t('projects.reserve_pct')}<input type="number" value={form.reserve_pct} onChange={(e) => setForm({ ...form, reserve_pct: e.target.value })} /></label>
                <label style={{ minWidth: 130 }}>{t('projects.owner_equity_pct')}<input type="number" value={form.owner_equity_pct} onChange={(e) => setForm({ ...form, owner_equity_pct: e.target.value })} /></label>
                <label style={{ minWidth: 180 }}>{t('projects.distribution_method')}
                  <select value={form.distribution_method} onChange={(e) => setForm({ ...form, distribution_method: e.target.value })}>
                    <option value="PROPORTIONAL">Proportional</option>
                    <option value="PREFERRED">Preferred</option>
                  </select>
                </label>
              </div>
              <button type="button" className="btn btn-secondary" style={{ justifySelf: 'start' }} onClick={() => setExpandedForm(!expandedForm)}>
                {expandedForm ? '− ' : '+ '}{t('projects.standard_form')}
              </button>
              {expandedForm && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <label>{t('projects.business_model')}<textarea rows="2" value={form.business_model} onChange={(e) => setForm({ ...form, business_model: e.target.value })} /></label>
                  <label>{t('projects.market_analysis')}<textarea rows="2" value={form.market_analysis} onChange={(e) => setForm({ ...form, market_analysis: e.target.value })} /></label>
                  <label>{t('projects.competition_analysis')}<textarea rows="2" value={form.competition_analysis} onChange={(e) => setForm({ ...form, competition_analysis: e.target.value })} /></label>
                  <label>{t('projects.management_team')}<textarea rows="2" value={form.management_team} onChange={(e) => setForm({ ...form, management_team: e.target.value })} /></label>
                  <label>{t('projects.use_of_funds')}<textarea rows="2" value={form.use_of_funds} onChange={(e) => setForm({ ...form, use_of_funds: e.target.value })} /></label>
                  <label>{t('projects.exit_timeline')}<textarea rows="2" value={form.exit_timeline} onChange={(e) => setForm({ ...form, exit_timeline: e.target.value })} /></label>
                  <label>{t('projects.compliance_certifications')}<textarea rows="2" value={form.compliance_certifications} onChange={(e) => setForm({ ...form, compliance_certifications: e.target.value })} /></label>
                </div>
              )}
              <button className="btn" type="submit">{t('projects.submit')}</button>
            </form>
          </div>

          <div className="card" style={{ marginTop: 18 }}>
            <h3 style={{ margin: '0 0 14px' }}>{t('projects.marketplace_tab')}</h3>
            {projects.length === 0 ? (
              <p className="roles-tag">{t('projects.error')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('projects.name')}</th>
                      <th>{t('projects.category')}</th>
                      <th>{t('projects.raised')}</th>
                      <th>{t('projects.funded')}</th>
                      <th>{t('projects.min_investment')}</th>
                      <th>{t('projects.funding_deadline')}</th>
                      <th>{t('projects.status')}</th>
                      <th>{t('projects.invest')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((p) => {
                      const pct = p.capital_required ? Math.min(100, (p.amount_raised / p.capital_required) * 100) : 0;
                      return (
                        <tr key={p.id}>
                          <td><strong>{p.name}</strong>{p.location ? <div className="roles-tag" style={{ margin: 0 }}>{p.location}</div> : null}</td>
                          <td>{p.category || '—'}</td>
                          <td>{fmt(p.amount_raised)}</td>
                          <td style={{ minWidth: 150 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ flex: 1, height: 8, borderRadius: 6, background: '#e2e8f0', overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${pct}%`, background: pct >= 100 ? '#22c55e' : '#0ea5e9' }} />
                              </div>
                              <span style={{ fontSize: 12 }}>{pct.toFixed(0)}%</span>
                            </div>
                          </td>
                          <td>{fmt(p.min_investment)}</td>
                          <td>{p.funding_deadline ? new Date(p.funding_deadline).toLocaleDateString() : '—'}</td>
                          <td><span className="badge info">{p.status}</span></td>
                          <td><button className="btn" style={{ padding: '4px 12px' }} onClick={() => invest(p.id)}>{t('projects.invest')}</button></td>
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

      {tab === 'myprojects' && (
        <div className="card">
          <h3 style={{ margin: '0 0 14px' }}>{t('projects.myprojects_tab')}</h3>
          {mine.length === 0 ? (
            <p className="roles-tag">{t('projects.error')}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('projects.name')}</th>
                    <th>{t('projects.raised')}</th>
                    <th>{t('projects.funded')}</th>
                    <th>{t('projects.status')}</th>
                    <th>{t('projects.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((p) => (
                    <tr key={p.id}>
                      <td><strong>{p.name}</strong>{p.ai_score != null ? <div className="roles-tag" style={{ margin: 0 }}>AI: {p.ai_score} (x{p.ai_review_count ?? 0})</div> : null}</td>
                      <td>{fmt(p.amount_raised)}</td>
                      <td>{fmt(p.capital_required)}</td>
                      <td><span className="badge info">{p.status}</span></td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {p.status === 'DRAFT' && <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => submitProject(p.id)}>{t('projects.submit')}</button>}
                          {p.consultation_paid_at == null && ['DRAFT', 'SUBMITTED', 'INITIAL_REVIEW', 'DUE_DILIGENCE', 'RISK_ASSESSMENT', 'GOVERNANCE_REVIEW'].includes(p.status) && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => payConsultation(p.id)}>{t('projects.pay_fee')}</button>
                          )}
                          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => runAiReview(p.id)}>{t('projects.ai_rereun')}</button>
                          {['PUBLISHED', 'FUNDING', 'APPROVED', 'ACTIVE', 'COMPLETED', 'LIQUIDATED'].includes(p.status) && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => viewStatement(p.id)}>{t('projects.statement')}</button>
                          )}
                          {['COMPLETED', 'LIQUIDATED'].includes(p.status) && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => viewReceipt(p.id)}>{t('projects.receipt')}</button>
                          )}
                          {['PUBLISHED', 'FUNDING', 'APPROVED', 'ACTIVE', 'COMPLETED', 'LIQUIDATED'].includes(p.status) && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => viewLedger(p.id)}>{t('projects.ledger')}</button>
                          )}
                          {['PUBLISHED', 'FUNDING', 'ACTIVE', 'APPROVED'].includes(p.status) && (
                            <>
                              <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => disburse(p.id)}>{t('projects.disburse')}</button>
                              <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => recordRevenue(p.id)}>{t('projects.revenue')}</button>
                              <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => distribute(p.id)}>{t('projects.distribute')}</button>
                              <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => showFinancials(p.id)}>{t('projects.financials')}</button>
                            </>
                          )}
                          {p.status === 'ACTIVE' && (
                            <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => completeProject(p.id, p.name)}>{t('projects.complete')}</button>
                          )}
                          {p.status === 'COMPLETED' && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => viewSettlement(p.id)}>{t('projects.settlement')}</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selected && selected.financials && (
            <div style={{ marginTop: 18 }}>
              <h4>{t('projects.financials')}</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 12 }}>
                <div className="card"><div className="roles-tag">{t('projects.target')}</div><b>{fmt(selected.totalBudget)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.expenditure')}</div><b>{fmt(selected.totalActual)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.progress')}</div><b>{selected.revenue ? fmt(selected.revenue.reduce((s, x) => s + Number(x.amount), 0)) : 0}</b></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                <div>
                  <h5>{t('projects.milestone')}</h5>
                  {selected.milestones.length === 0 ? <p className="roles-tag">{t('projects.error')}</p> : (
                    <ul style={{ paddingLeft: 18 }}>
                      {selected.milestones.map((m) => <li key={m.id}>{m.name} — {fmt(m.budget)} <span className="roles-tag">({m.status})</span></li>)}
                    </ul>
                  )}
                </div>
                <div>
                  <h5>{t('projects.distribute')}</h5>
                  {selected.distributions.length === 0 ? <p className="roles-tag">{t('projects.error')}</p> : (
                    <ul style={{ paddingLeft: 18 }}>
                      {selected.distributions.map((d) => <li key={d.id}>#{d.id} — {fmt(d.amount)} <span className="roles-tag">({d.status})</span></li>)}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
        {settlement && settlement.completed && (
            <div style={{ marginTop: 18 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                <h4 style={{ margin: 0 }}>{t('projects.settlement_report')}: {settlement.project.name}</h4>
                <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => releaseReserve('DISTRIBUTION_RESERVE')}>{t('projects.reserve_payout')}</button>
                <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => releaseReserve('OWNER_RESIDUAL')}>{t('projects.residual_payout')}</button>
                <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => viewCloseOut(settlement.project.id)}>{t('projects.close_out')}</button>
                <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => viewLiquidation(settlement.project.id)}>{t('projects.liquidation')}</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px,1fr))', gap: 12 }}>
                <div className="card"><div className="roles-tag">{t('projects.invested_total')}</div><b>{fmt(settlement.settlement.invested_total)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.escrow')}</div><b>{fmt(settlement.settlement.escrow_balance)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.returned_to_investors')}</div><b>{fmt(settlement.settlement.returned_to_investors)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.owner_received')}</div><b>{fmt(settlement.settlement.owner_received)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.reserve_released')}</div><b>{fmt(settlement.settlement.reserve_released)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.dividend_allocated')}</div><b>{fmt(settlement.settlement.dividend_allocated)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.dividend_pending')}</div><b>{fmt(settlement.settlement.dividend_pending)}</b></div>
              </div>
              {Array.isArray(settlement.settlement.summary) === false && settlement.settlement.summary && typeof settlement.settlement.summary === 'object' && Array.isArray(settlement.settlement.summary.returned_to_investors) && (
                <div style={{ marginTop: 12, overflowX: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr><th>{t('projects.investor')}</th><th>{t('projects.amount')}</th></tr>
                    </thead>
                    <tbody>
                      {settlement.settlement.summary.returned_to_investors.map((d, idx) => (
                        <tr key={idx}><td>{d.investor_user_id}</td><td>{fmt(d.amount)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          {closeOut && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                <h4 style={{ margin: 0 }}>{t('projects.close_out')}: {closeOut.project.name}</h4>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px,1fr))', gap: 12 }}>
                <div className="card"><div className="roles-tag">{t('projects.returned_to_investors')}</div><b>{fmt(closeOut.funds_out.escrow_returned_to_investors)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.disbursed_to_owner')}</div><b>{fmt(closeOut.funds_out.disbursed_to_owner)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.reserve_to_owner')}</div><b>{fmt(closeOut.funds_out.reserve_released_to_owner)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.residual_to_owner')}</div><b>{fmt(closeOut.funds_out.residual_released_to_owner)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.close_out_paid_to_owner')}</div><b>{fmt(closeOut.funds_out.close_out_paid_to_owner)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.dividend_paid_inv')}</div><b>{fmt(closeOut.funds_out.dividends_paid_to_investors)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.dividend_pending')}</div><b>{fmt(closeOut.funds_out.dividends_pending)}</b></div>
              </div>
              <div style={{ marginTop: 12, overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('projects.investor')}</th>
                      <th>{t('projects.invested_amount')}</th>
                      <th>{t('projects.escrow_return')}</th>
                      <th>{t('projects.dividend_paid_inv')}</th>
                      <th>{t('projects.received')}</th>
                      <th>ROI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closeOut.investors.map((inv) => (
                      <tr key={inv.investor_user_id}>
                        <td>{inv.full_name || `+${inv.phone_number}`}</td>
                        <td>{fmt(inv.invested)}</td>
                        <td>{fmt(inv.escrow_return)}</td>
                        <td>{fmt(inv.dividends_paid)}</td>
                        <td>{fmt(inv.received)}</td>
                        <td style={{ color: inv.roi_percent >= 0 ? '#15803d' : '#dc2626', fontWeight: 600 }}>{inv.roi_percent}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="roles-tag" style={{ marginTop: 8 }}>
                {t('projects.owner_received')}: {fmt(closeOut.owner_position.total_received)} ({t('projects.disbursed_to_owner')}: {fmt(closeOut.owner_position.from_disbursements)} · {t('projects.reserve_to_owner')}: {fmt(closeOut.owner_position.from_reserve)} · {t('projects.residual_to_owner')}: {fmt(closeOut.owner_position.from_residual)})
              </div>
            </div>
          )}
          {statement && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                <h4 style={{ margin: 0 }}>{t('projects.statement')}: {statement.project.name}</h4>
                <span className="badge info">{statement.project.status}</span>
                {statement.completed && <span className="badge info">✓ {t('projects.complete')}</span>}
                <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => downloadStatement(statement.project.id)}>{t('projects.statement_csv')}</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px,1fr))', gap: 12 }}>
                <div className="card"><div className="roles-tag">{t('projects.invested_total')}</div><b>{fmt(statement.funds.invested_confirmed)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.escrow')}</div><b>{fmt(statement.funds.escrow_held)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.disbursed_to_owner')}</div><b>{fmt(statement.funds.disbursed_to_owner)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.dividend_paid_inv')}</div><b>{fmt(statement.funds.dividends_paid_to_investors)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.dividend_pending')}</div><b>{fmt(statement.funds.dividends_pending)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.escrow_return')}</div><b>{fmt(statement.funds.escrow_returned_to_investors)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.reserve_to_owner')}</div><b>{fmt(statement.funds.reserve_released_to_owner)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.residual_to_owner')}</div><b>{fmt(statement.funds.residual_released_to_owner)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.revenue_processed')}</div><b>{fmt(statement.funds.revenue_total)}</b></div>
              </div>
              <div style={{ marginTop: 12, overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('projects.investor')}</th>
                      <th>{t('projects.invested_amount')}</th>
                      <th>%</th>
                      <th>{t('projects.escrow_return')}</th>
                      <th>{t('projects.dividend_paid_inv')}</th>
                      <th>{t('projects.refund')}</th>
                      <th>{t('projects.received')}</th>
                      <th>ROI</th>
                      <th>{t('projects.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statement.investors.map((inv) => (
                      <tr key={inv.investor_user_id}>
                        <td>{inv.full_name || `+${inv.phone_number}`}</td>
                        <td>{fmt(inv.invested)}</td>
                        <td>{Number(inv.participation_pct).toFixed(2)}%</td>
                        <td>{fmt(inv.escrow_return)}</td>
                        <td>{fmt(inv.dividends_paid)}</td>
                        <td>{fmt(inv.refunded)}</td>
                        <td>{fmt(inv.received)}</td>
                        <td style={{ color: inv.roi_percent >= 0 ? '#15803d' : '#dc2626', fontWeight: 600 }}>{inv.roi_percent}%</td>
                        <td><span className="badge info">{inv.investment_status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {statement.releases.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <h5>{t('projects.close_out_payout')}</h5>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="table">
                      <thead>
                        <tr><th>{t('projects.reserve_type')}</th><th>{t('projects.amount')}</th><th>To</th><th>Ref</th><th>{t('projects.status')}</th><th>Date</th></tr>
                      </thead>
                      <tbody>
                        {statement.releases.map((r, idx) => (
                          <tr key={idx}>
                            <td>{r.reserve_type}</td>
                            <td>{fmt(r.amount)}</td>
                            <td>{r.released_to}</td>
                            <td style={{ fontSize: 11 }}>{r.reference}</td>
                            <td><span className="badge info">{r.status}</span></td>
                            <td>{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {statement.waterfall.length > 0 && (
                <div className="roles-tag" style={{ marginTop: 8 }}>
                  {t('projects.waterfall_runs')}: {statement.waterfall.map((w) => `${w.allocation_step} ×${w.runs} (${fmt(w.total)})`).join(' · ')}
                </div>
              )}
              {statement.milestones.length > 0 && (
                <div className="roles-tag" style={{ marginTop: 4 }}>
                  {t('projects.milestone')}: {statement.milestone_completed}/{statement.milestone_total}
                </div>
              )}
            </div>
          )}
          {liquidation && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                <h4 style={{ margin: 0 }}>{t('projects.liquidation')}: {liquidation.project.name}</h4>
                {liquidation.liquidated
                  ? <span className="badge success">✓ {t('projects.already_liquidated')}</span>
                  : (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span className={`badge ${liquidation.ready ? 'success' : 'warning'}`}>
                        {liquidation.ready ? t('projects.liquidation_ready') : t('projects.liquidation_blocked')}
                      </span>
                      {liquidation.ready && (
                        <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => liquidate(liquidation.project.id)}>{t('projects.liquidate')}</button>
                      )}
                    </div>
                  )}
              </div>
              {!liquidation.liquidated && liquidation.missing.length > 0 && (
                <p className="roles-tag" style={{ marginTop: 4 }}>{t('projects.liq_missing')}: {liquidation.missing.join(', ')}</p>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px,1fr))', gap: 12 }}>
                <div className="card"><div className="roles-tag">{t('projects.invested_total')}</div><b>{fmt(liquidation.snapshot.funds.invested_confirmed)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.revenue_processed')}</div><b>{fmt(liquidation.snapshot.funds.revenue_total)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.disbursed_to_owner')}</div><b>{fmt(liquidation.snapshot.funds.disbursed_to_owner)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.reserve_to_owner')}</div><b>{fmt(liquidation.snapshot.funds.reserve_released_to_owner)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.residual_to_owner')}</div><b>{fmt(liquidation.snapshot.funds.residual_released_to_owner)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.owner_received')}</div><b>{fmt(liquidation.snapshot.owner_received_total)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.escrow_return')}</div><b>{fmt(liquidation.snapshot.funds.escrow_returned_to_investors)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.dividend_paid_inv')}</div><b>{fmt(liquidation.snapshot.funds.dividends_paid_to_investors)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.investor_received_total')}</div><b>{fmt(liquidation.snapshot.investor_received_total)}</b></div>
                <div className="card"><div className="roles-tag">Investor Net</div><b style={{ color: liquidation.snapshot.investor_net >= 0 ? '#15803d' : '#dc2626' }}>{fmt(liquidation.snapshot.investor_net)} ({liquidation.snapshot.investor_net_pct}%)</b></div>
              </div>
              {liquidation.liquidated && (
                <div className="roles-tag" style={{ marginTop: 8 }}>{t('projects.liq_reference')}: {liquidation.liquidation.reference}</div>
              )}
            </div>
          )}
          {receipt && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                <h4 style={{ margin: 0 }}>{t('projects.receipt')}: {receipt.project.name}</h4>
                <span className="badge info">{receipt.project.status}</span>
                {receipt.state.completed && <span className="badge success">✓ {t('projects.complete')}</span>}
                {receipt.state.liquidated && <span className="badge success">✓ {t('projects.already_liquidated')}</span>}
                <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => downloadReceipt(receipt.project.id)}>{t('projects.receipt_csv')}</button>
              </div>
              <div className="roles-tag" style={{ marginBottom: 8 }}>{t('projects.liq_reference')}: {receipt.receipt_reference}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 12 }}>
                <div className="card"><div className="roles-tag">{t('projects.role')}</div><b>{receipt.position.role}</b></div>
                {receipt.position.role === 'INVESTOR' && (
                  <>
                    <div className="card"><div className="roles-tag">{t('projects.invested_amount')}</div><b>{fmt(receipt.position.invested)}</b></div>
                    <div className="card"><div className="roles-tag">{t('projects.escrow_return')}</div><b>{fmt(receipt.position.escrow_return)}</b></div>
                    <div className="card"><div className="roles-tag">{t('projects.dividend_paid_inv')}</div><b>{fmt(receipt.position.dividends_paid)}</b></div>
                    <div className="card"><div className="roles-tag">{t('projects.dividend_pending')}</div><b>{fmt(receipt.position.dividends_pending)}</b></div>
                    <div className="card"><div className="roles-tag">{t('projects.refund')}</div><b>{fmt(receipt.position.refunded)}</b></div>
                    <div className="card"><div className="roles-tag">{t('projects.received')}</div><b>{fmt(receipt.position.received)}</b></div>
                    <div className="card"><div className="roles-tag">ROI</div><b style={{ color: receipt.position.roi_percent >= 0 ? '#15803d' : '#dc2626' }}>{receipt.position.roi_percent}%</b></div>
                  </>
                )}
                {receipt.position.role === 'OWNER' && (
                  <>
                    <div className="card"><div className="roles-tag">{t('projects.disbursed_to_owner')}</div><b>{fmt(receipt.position.from_disbursements)}</b></div>
                    <div className="card"><div className="roles-tag">{t('projects.reserve_to_owner')}</div><b>{fmt(receipt.position.from_reserve)}</b></div>
                    <div className="card"><div className="roles-tag">{t('projects.residual_to_owner')}</div><b>{fmt(receipt.position.from_residual)}</b></div>
                    <div className="card"><div className="roles-tag">{t('projects.owner_received')}</div><b>{fmt(receipt.position.received_total)}</b></div>
                  </>
                )}
              </div>
              {receipt.state.settlement_reference && (
                <div className="roles-tag" style={{ marginTop: 8 }}>Settlement: {receipt.state.settlement_reference}</div>
              )}
              {receipt.state.liquidated && (
                <div className="roles-tag" style={{ marginTop: 4 }}>{t('projects.liquidation')}: {receipt.state.liquidation_reference}</div>
              )}
            </div>
          )}

          {ledger && (
            <div className="card" style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <h4 style={{ margin: 0 }}>{t('projects.ledger')}: {ledger.project.name}</h4>
                <span className="badge info">{ledger.project.status}</span>
              </div>
              <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px,1fr))', gap: 12 }}>
                <div className="card"><div className="roles-tag">{t('projects.total_invested')}</div><b>{ledger.revenue.length + ledger.disbursements.length + ledger.waterfall_allocations.length + ledger.ledger_postings.length}</b></div>
              </div>
              {[
                { label: t('projects.ledger_revenue'), rows: ledger.revenue, cols: ['unique_reference', 'revenue_type', 'amount', 'created_at'] },
                { label: t('projects.ledger_disbursements'), rows: ledger.disbursements, cols: ['unique_reference', 'amount', 'status', 'created_at'] },
                { label: t('projects.ledger_waterfall'), rows: ledger.waterfall_allocations, cols: ['allocation_step', 'amount', 'revenue_reference', 'created_at'] },
                { label: t('projects.ledger_postings'), rows: ledger.ledger_postings, cols: ['account_code', 'debit', 'credit', 'description', 'posted_at'] },
              ].map((sec) => (
                <div key={sec.label} style={{ marginTop: 14 }}>
                  <h5 style={{ margin: '0 0 6px' }}>{sec.label} ({sec.rows.length})</h5>
                  {sec.rows.length === 0 ? <p className="roles-tag">{t('projects.error')}</p> : (
                    <div style={{ overflowX: 'auto', maxHeight: 260, overflowY: 'auto' }}>
                      <table className="table">
                        <thead>
                          <tr>{sec.cols.map((c) => <th key={c}>{c}</th>)}</tr>
                        </thead>
                        <tbody>
                          {sec.rows.map((row, idx) => (
                            <tr key={idx}>
                              {sec.cols.map((c) => {
                                const v = row[c];
                                return <td key={c}>{v === null || v === undefined ? '—' : c === 'amount' || c === 'debit' || c === 'credit' ? fmt(v) : String(v)}</td>;
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'myinvest' && (
        <div className="card">
          <h3 style={{ margin: '0 0 14px' }}>{t('projects.myinvest_tab')}</h3>
          {performance && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px,1fr))', gap: 12 }}>
                <div className="card"><div className="roles-tag">{t('projects.total_invested')}</div><b>{fmt(performance.totals.invested)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.received')}</div><b>{fmt(performance.totals.received)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.escrow_return')}</div><b>{fmt(performance.totals.escrow_return)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.pending_payout')}</div><b>{fmt(performance.totals.pending)}</b></div>
                <div className="card"><div className="roles-tag">ROI</div><b style={{ color: performance.totals.roi_percent >= 0 ? '#15803d' : '#dc2626' }}>{performance.totals.roi_percent}%</b></div>
              </div>
              <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12, marginTop: 8 }} onClick={downloadPortfolio}>{t('projects.portfolio_csv')}</button>
            </div>
          )}
          {performance && performance.investments.length > 0 && (
            <div style={{ overflowX: 'auto', marginBottom: 18 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('projects.name')}</th>
                    <th>{t('projects.invested_amount')}</th>
                    <th>{t('projects.escrow_return')}</th>
                    <th>{t('projects.received')}</th>
                    <th>{t('projects.pending_payout')}</th>
                    <th>ROI</th>
                    <th>{t('projects.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {performance.investments.map((i) => (
                    <tr key={i.investment_id}>
                      <td>{i.name}</td>
                      <td>{fmt(i.invested)}</td>
                      <td>{fmt(i.escrow_return)}</td>
                      <td>{fmt(i.received)}</td>
                      <td>{fmt(i.pending_total)}</td>
                      <td style={{ color: i.roi_percent >= 0 ? '#15803d' : '#dc2626', fontWeight: 600 }}>{i.roi_percent}%</td>
                      <td><span className="badge info">{i.project_status}</span>{i.completed ? <span className="badge info">✓</span> : null}{i.liquidated ? <span className="badge success">LIQ</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {investments.length === 0 ? (
            <p className="roles-tag">{t('projects.error')}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('projects.name')}</th>
                    <th>{t('projects.amount')}</th>
                    <th>%</th>
                    <th>{t('projects.status')}</th>
                    <th>{t('projects.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {investments.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <strong>{i.project_name}</strong>
                        {i.project_status === 'EXPIRED' && <div className="roles-tag" style={{ margin: 0 }}>{t('projects.expired')}</div>}
                      </td>
                      <td>{fmt(i.amount)}</td>
                      <td>{i.participation_pct != null ? Number(i.participation_pct).toFixed(2) : '—'}%</td>
                      <td><span className="badge info">{i.status}</span></td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {['PUBLISHED', 'FUNDING', 'APPROVED', 'ACTIVE', 'COMPLETED', 'LIQUIDATED'].includes(i.project_status) && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => viewStatement(i.project_id)}>{t('projects.statement')}</button>
                          )}
                          {['COMPLETED', 'LIQUIDATED'].includes(i.project_status) && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => viewReceipt(i.project_id)}>{t('projects.receipt')}</button>
                          )}
                          {['PUBLISHED', 'FUNDING', 'APPROVED', 'ACTIVE', 'COMPLETED', 'LIQUIDATED'].includes(i.project_status) && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => viewLedger(i.project_id)}>{t('projects.ledger')}</button>
                          )}
                          {i.project_status === 'EXPIRED' && i.status === 'CONFIRMED' && (
                            <button className="btn btn-success" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => refundInvestment(i.id, i.project_id, i.project_name)}>{t('projects.refund')}</button>
                          )}
                          {i.refund_reference && <span className="roles-tag" style={{ margin: 0 }}>✓ {t('projects.refunded')}</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    {tab === 'review' && (
        <div className="card">
          <h3 style={{ margin: '0 0 14px' }}>{t('projects.review_queue')}</h3>
          <button className="btn btn-secondary" style={{ marginBottom: 12 }} onClick={loadQueue}>{t('projects.refresh')}</button>
          {queue.length === 0 ? (
            <p className="roles-tag">{t('projects.error')}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('projects.name')}</th>
                    <th>{t('projects.owner')}</th>
                    <th>{t('projects.status')}</th>
                    <th>AI</th>
                    <th>{t('projects.fee')}</th>
                    <th>{t('projects.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((p) => {
                    const flags = p.risk_flags && Array.isArray(p.risk_flags) ? p.risk_flags : (typeof p.risk_flags === 'string' ? JSON.parse(p.risk_flags || '[]') : []);
                    return (
                      <tr key={p.id}>
                        <td>
                          <strong>{p.name}</strong>
                          {flags.length > 0 && <div className="roles-tag" style={{ margin: 0 }}>⚠ {flags.join('; ')}</div>}
                        </td>
                        <td>{p.owner_name || p.owner_user_id}</td>
                        <td><span className="badge info">{p.status}</span></td>
                        <td>
                          {p.ai_latest_score != null
                            ? <b style={{ color: p.ai_latest_score >= 75 ? '#22c55e' : p.ai_latest_score >= 50 ? '#f59e0b' : '#ef4444' }}>{p.ai_latest_score}</b>
                            : '—'}
                          {p.recommended_action ? <div className="roles-tag" style={{ margin: 0 }}>{p.recommended_action}</div> : null}
                        </td>
                        <td>{p.consultation_fee != null && p.consultation_fee > 0 ? (p.consultation_paid_at ? '✓' : fmt(p.consultation_fee)) : '—'}</td>
                        <td>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {p.status === 'SUBMITTED' && <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => workflow(p.id, 'INITIAL_REVIEW', 'APPROVED')}>{t('projects.initial_review')}</button>}
                            {p.status === 'INITIAL_REVIEW' && <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => workflow(p.id, 'DUE_DILIGENCE', 'APPROVED')}>{t('projects.due_diligence')}</button>}
                            {p.status === 'DUE_DILIGENCE' && <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => workflow(p.id, 'RISK_ASSESSMENT', 'APPROVED')}>{t('projects.risk_assessment')}</button>}
                            {p.status === 'RISK_ASSESSMENT' && <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => workflow(p.id, 'GOVERNANCE_REVIEW', 'APPROVED')}>{t('projects.governance_review')}</button>}
                            {p.status === 'APPROVED' && <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => expertPublish(p.id)}>{t('projects.publish')}</button>}
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => runAiReview(p.id)}>AI↺</button>
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => workflow(p.id, p.status === 'SUBMITTED' ? 'INITIAL_REVIEW' : p.status === 'INITIAL_REVIEW' ? 'DUE_DILIGENCE' : p.status === 'DUE_DILIGENCE' ? 'RISK_ASSESSMENT' : 'GOVERNANCE_REVIEW', 'REJECTED')}>{t('projects.reject')}</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'transparency' && (
        <div>
          <div className="card">
            <h3 style={{ margin: '0 0 14px' }}>{t('projects.transparency_tab')}</h3>
            {transparency.length === 0 ? (
              <p className="roles-tag">{t('projects.error')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('projects.name')}</th>
                      <th>{t('projects.invested_amount')}</th>
                      <th>{t('projects.participation')}</th>
                      <th>{t('projects.pending_payout')}</th>
                      <th>{t('projects.paid_payout')}</th>
                      <th>{t('projects.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transparency.map((i) => (
                      <tr key={i.investment_id}>
                        <td>
                          <strong>{i.name}</strong>
                          <div className="roles-tag" style={{ margin: 0 }}>{i.status}{i.category ? ` · ${i.category}` : ''}</div>
                        </td>
                        <td>{fmt(i.invested_amount)}</td>
                        <td>{i.participation_pct != null ? Number(i.participation_pct).toFixed(2) : '—'}%</td>
                        <td>{fmt(i.pending_payout_total)}</td>
                        <td>{fmt(i.paid_payout_total)}</td>
                        <td>
                          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => viewTransparency(i.project_id)}>{t('projects.details')}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {transDetail && (
            <div className="card" style={{ marginTop: 16 }}>
              <h3 style={{ margin: '0 0 6px' }}>{transDetail.project.name} — {t('projects.details')}</h3>
              <div className="roles-tag" style={{ marginBottom: 12 }}>
                {transDetail.project.status} · {t('projects.investors')}: {transDetail.project.investor_count} · {fmt(transDetail.project.amount_raised)} / {fmt(transDetail.project.capital_required)} {transDetail.project.currency_code}
              </div>

              <h4>{t('projects.funds')}</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px,1fr))', gap: 12 }}>
                <div className="card"><div className="roles-tag">{t('projects.raised')}</div><b>{fmt(transDetail.funds.raised)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.escrow')}</div><b>{fmt(transDetail.funds.escrow_balance)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.disbursed_total')}</div><b>{fmt(transDetail.funds.disbursed_total)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.revenue_total')}</div><b>{fmt(transDetail.funds.revenue_total)}</b></div>
                <div className="card"><div className="roles-tag">{t('projects.dividend_allocated')}</div><b>{fmt(transDetail.funds.dividend_allocated_total)}</b></div>
              </div>

              {transDetail.my_position && (
                <div style={{ marginTop: 14 }}>
                  <h4>{t('projects.my_position')}</h4>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <span className="badge info">{t('projects.invested_amount')}: {fmt(transDetail.my_position.invested)}</span>
                    <span className="badge info">{t('projects.participation')}: {transDetail.my_position.participation_pct != null ? Number(transDetail.my_position.participation_pct).toFixed(2) : '—'}%</span>
                    <span className="badge" style={{ background: '#fef3c7', color: '#b45309' }}>{t('projects.pending_payout')}: {fmt(transDetail.my_position.pending_payout)}</span>
                    <span className="badge" style={{ background: '#dcfce7', color: '#15803d' }}>{t('projects.paid_payout')}: {fmt(transDetail.my_position.paid_payout)}</span>
                  </div>
                </div>
              )}

              <div style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <h4 style={{ margin: 0 }}>{t('projects.cap_table')}</h4>
                  <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => viewCapTable(transDetail.project.id)}>{t('projects.load_cap_table')}</button>
                </div>
                {capTable && (
                  <div style={{ overflowX: 'auto', marginTop: 8 }}>
                    <div className="roles-tag" style={{ marginBottom: 8 }}>
                      {fmt(capTable.project.amount_raised)} / {fmt(capTable.project.capital_required)} · {t('projects.investors')}: {capTable.total_investors}
                      {capTable.project.funding_deadline ? ` · ${t('projects.funding_deadline')}: ${new Date(capTable.project.funding_deadline).toLocaleString()}` : ''}
                    </div>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>{t('projects.investor')}</th>
                          <th>{t('projects.amount')}</th>
                          <th>%</th>
                          <th>{t('projects.paid_payout')}</th>
                          <th>{t('projects.status')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {capTable.investors.map((inv, idx) => (
                          <tr key={inv.investment_id}>
                            <td>{idx + 1}</td>
                            <td>{inv.full_name || `+${inv.phone_number}`}</td>
                            <td>{fmt(inv.amount)}</td>
                            <td>{inv.participation_pct != null ? Number(inv.participation_pct).toFixed(2) : '—'}%</td>
                            <td>{fmt(inv.total_payouts)}</td>
                            <td><span className="badge info">{inv.status}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {transDetail.roles.authorized_view && transDetail.all_pending_payouts.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <h4>{t('projects.waterfall')}</h4>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    {transDetail.all_pending_payouts.map((x) => (
                      <span key={x.investor_user_id} className="badge info">u{x.investor_user_id}: {fmt(x.pending_total)}</span>
                    ))}
                    {transDetail.roles.expert && (
                      <button className="btn" style={{ padding: '6px 14px', fontSize: 13 }} onClick={() => payDividends(transDetail.project.id)}>{t('projects.pay_dividends')}</button>
                    )}
                  </div>
                </div>
              )}

              {transDetail.waterfall_by_step.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <h5>{t('projects.waterfall')}</h5>
                  <ul style={{ paddingLeft: 18, margin: 0 }}>
                    {transDetail.waterfall_by_step.map((s) => (
                      <li key={s.allocation_step}><b>{s.allocation_step}</b>: {fmt(s.total)} ({s.count}x)</li>
                    ))}
                  </ul>
                </div>
              )}

              {transDetail.recent_events.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <h5>{t('projects.recent_events')}</h5>
                  <ul style={{ paddingLeft: 18, margin: 0, maxHeight: 160, overflowY: 'auto' }}>
                    {transDetail.recent_events.map((e, idx) => (
                      <li key={idx}><b>{e.action}</b> — {new Date(e.created_at).toLocaleString()}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
