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
  const [msg, setMsg] = useState({ type: '', text: '' });

  const [form, setForm] = useState({
    name: '', description: '', category: '', location: '', capital_required: '',
    min_investment: '', duration_days: '', expected_revenue: '', expected_costs: '',
    projected_profit: '', reinvestment_pct: 30, reserve_pct: 10, owner_equity_pct: 20,
    distribution_method: 'PROPORTIONAL',
  });

  const [selected, setSelected] = useState(null);

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('projects.error') });
  const ok = (text) => { setMsg({ type: 'ok', text }); setSelected(null); };

  const load = () => {
    api.get('/projects', { params: { status: 'PUBLISHED' } }).then((r) => setProjects(r.data.projects || [])).catch(() => {});
    api.get('/projects', { params: { status: '' } }).then((r) => setMine(r.data.projects || [])).catch(() => {});
    api.get('/projects/mine/investments').then((r) => setInvestments(r.data.investments || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const createProject = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/projects', form);
      ok(t('projects.submitted'));
      setForm({ name: '', description: '', category: '', location: '', capital_required: '', min_investment: '', duration_days: '', expected_revenue: '', expected_costs: '', projected_profit: '', reinvestment_pct: 30, reserve_pct: 10, owner_equity_pct: 20, distribution_method: 'PROPORTIONAL' });
      load();
      setSelected(r.data.project.id);
    } catch (err) { error(err); }
  };

  const submitProject = async (id) => {
    try {
      await api.post(`/projects/${id}/submit`);
      ok(t('projects.submitted'));
      load();
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

  const tabs = [
    { id: 'marketplace', label: t('projects.marketplace_tab') },
    { id: 'myprojects', label: t('projects.myprojects_tab') },
    { id: 'myinvest', label: t('projects.myinvest_tab') },
  ];

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
                      <td><strong>{p.name}</strong></td>
                      <td>{fmt(p.amount_raised)}</td>
                      <td>{fmt(p.capital_required)}</td>
                      <td><span className="badge info">{p.status}</span></td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {p.status === 'DRAFT' && <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => submitProject(p.id)}>{t('projects.submit')}</button>}
                          {['PUBLISHED', 'FUNDING', 'ACTIVE', 'APPROVED'].includes(p.status) && (
                            <>
                              <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => disburse(p.id)}>{t('projects.disburse')}</button>
                              <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => recordRevenue(p.id)}>{t('projects.revenue')}</button>
                              <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => distribute(p.id)}>{t('projects.distribute')}</button>
                              <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => showFinancials(p.id)}>{t('projects.financials')}</button>
                            </>
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
        </div>
      )}

      {tab === 'myinvest' && (
        <div className="card">
          <h3 style={{ margin: '0 0 14px' }}>{t('projects.myinvest_tab')}</h3>
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
                  </tr>
                </thead>
                <tbody>
                  {investments.map((i) => (
                    <tr key={i.id}>
                      <td><strong>{i.project_name}</strong></td>
                      <td>{fmt(i.amount)}</td>
                      <td>{i.participation_pct != null ? Number(i.participation_pct).toFixed(2) : '—'}%</td>
                      <td><span className="badge info">{i.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
