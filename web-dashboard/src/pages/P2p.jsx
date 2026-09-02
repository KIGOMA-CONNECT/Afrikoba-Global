import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import ServiceLock from '../components/ServiceLock.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function P2p() {
  const { t } = useT();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const isAdmin = user.role === 'ADMIN';
  const isIssuer = user.role === 'ISSUER' || isAdmin;

  const [projects, setProjects] = useState([]);
  const [selected, setSelected] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const [title, setTitle] = useState('');
  const [sector, setSector] = useState('KILIMO');
  const [desc, setDesc] = useState('');
  const [target, setTarget] = useState('');
  const [sharePrice, setSharePrice] = useState('');
  const [roi, setRoi] = useState('');
  const [tenure, setTenure] = useState('');
  const [payback, setPayback] = useState('');

  const [shares, setShares] = useState('1');
  const [milestonesText, setMilestonesText] = useState('');
  const [revenueAmount, setRevenueAmount] = useState('');

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 5000);
  };

  const load = () => api.get('/p2p/projects').then((r) => setProjects(r.data.projects)).catch(() => {});

  useEffect(() => { load(); }, []);

  const openProject = async (id) => {
    const res = await api.get(`/p2p/projects/${id}`);
    setSelected(res.data.project);
  };

  const createProject = async (e) => {
    e.preventDefault();
    try {
      await api.post('/p2p/projects', {
        title, sector, description: desc, targetAmount: target, sharePrice,
        roiPercentage: roi, tenureMonths: tenure, paybackStartMonths: payback,
      });
      show('ok', t('p2p.created_msg'));
      setTitle(''); setDesc(''); setTarget(''); setSharePrice(''); setRoi(''); setTenure(''); setPayback('');
      load();
    } catch (err) { show('err', err.response?.data?.message || t('p2p.error')); }
  };

  const invest = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post(`/p2p/projects/${selected.id}/invest`, { shares });
      show('ok', `${res.data.message} Mkataba: ${res.data.contractPdfUrl || 'unajalishwa'}`);
      openProject(selected.id);
    } catch (err) { show('err', err.response?.data?.message || t('p2p.invest_error')); }
  };

  const auditStep = async (stepName, passed) => {
    try {
      await api.post(`/admin/projects/${selected.id}/audit`, { stepName, passed, notes: passed ? 'Imepita.' : 'Imekataliwa.' });
      show('ok', `${stepName} imewekwa.`);
      openProject(selected.id);
    } catch (err) { show('err', err.response?.data?.message || t('p2p.error')); }
  };

  const createMilestones = async () => {
    try {
      const milestones = milestonesText.split('\n').filter(Boolean).map((line) => {
        const [amt, ...rest] = line.split(' ');
        return { title: rest.join(' '), amount: amt };
      });
      await api.post(`/admin/projects/${selected.id}/milestones`, { milestones });
      show('ok', t('p2p.milestones_saved'));
      setMilestonesText('');
      openProject(selected.id);
    } catch (err) { show('err', err.response?.data?.message || t('p2p.error')); }
  };

  const releaseMilestone = async (mid) => {
    try {
      const res = await api.post(`/admin/milestones/${mid}/release`);
      show('ok', res.data.message);
      openProject(selected.id);
    } catch (err) { show('err', err.response?.data?.message || t('p2p.error')); }
  };

  const recordRevenue = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/admin/projects/${selected.id}/revenue`, { amount: revenueAmount, description: 'Mapato ya mwezi' });
      show('ok', t('p2p.revenue_recorded'));
      setRevenueAmount('');
      openProject(selected.id);
    } catch (err) { show('err', err.response?.data?.message || t('p2p.error')); }
  };

  const runSplit = async () => {
    try {
      const res = await api.post(`/admin/projects/${selected.id}/split`);
      show('ok', `Split: Mjasiriamali ${formatMoney(res.data.operationalShare)}, Wawekezaji ${formatMoney(res.data.investorShare)}, Jukwaa ${formatMoney(res.data.platformShare)}`);
      openProject(selected.id);
    } catch (err) { show('err', err.response?.data?.message || t('p2p.error')); }
  };

  return (
    <ServiceLock serviceKey="P2P">
      <div className="page-head">
        <h2>{t('p2p.title')}</h2>
        <p>{t('p2p.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="grid grid-2">
        <div className="card">
          <h3>{t('p2p.projects')}</h3>
          {projects.length === 0 && <p className="roles-tag">{t('p2p.no_projects')}</p>}
          {projects.map((p) => (
            <div key={p.id} className="inline-actions" style={{ justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div>
                <strong>{p.title}</strong>
                <div className="roles-tag">{p.sector} · {t('p2p.goal')} {formatMoney(p.target_amount)} · {t('p2p.raised')} {formatMoney(p.raised_amount)}</div>
                <div className="roles-tag">ROI {p.roi_percentage}% · {t('p2p.share_price')} {formatMoney(p.share_price)} · {p.tenure_months} miezi</div>
              </div>
              <div className="inline-actions">
                <StatusBadge status={p.status} />
                <button className="btn ghost" onClick={() => openProject(p.id)}>{t('p2p.open')}</button>
              </div>
            </div>
          ))}
        </div>

        {isIssuer && (
          <div className="card">
            <h3>{t('p2p.submit')}</h3>
            <form onSubmit={createProject}>
              <div className="field" style={{ marginBottom: 10 }}><label>{t('p2p.title_field')}</label><input value={title} onChange={(e) => setTitle(e.target.value)} required /></div>
              <div className="form-row">
                <div className="field"><label>{t('p2p.sector')}</label>
                  <select value={sector} onChange={(e) => setSector(e.target.value)}>
                    <option value="KILIMO">Kilimo</option>
                    <option value="LOGISTICS">Logistics</option>
                    <option value="MANUFACTURING">Uzalishaji</option>
                    <option value="SMES">Biashara Ndogo</option>
                  </select>
                </div>
                <div className="field"><label>{t('p2p.target')}</label><input type="number" value={target} onChange={(e) => setTarget(e.target.value)} required /></div>
                <div className="field"><label>{t('p2p.share_price')}</label><input type="number" value={sharePrice} onChange={(e) => setSharePrice(e.target.value)} required /></div>
              </div>
              <div className="form-row">
                <div className="field"><label>{t('p2p.roi')}</label><input type="number" value={roi} onChange={(e) => setRoi(e.target.value)} required /></div>
                <div className="field"><label>{t('p2p.tenure')}</label><input type="number" value={tenure} onChange={(e) => setTenure(e.target.value)} required /></div>
                <div className="field"><label>{t('p2p.payback')}</label><input type="number" value={payback} onChange={(e) => setPayback(e.target.value)} required /></div>
              </div>
              <div className="field" style={{ marginBottom: 10 }}><label>{t('p2p.desc')}</label><textarea value={desc} onChange={(e) => setDesc(e.target.value)} required /></div>
              <button className="btn" type="submit">{t('p2p.submit_btn')}</button>
            </form>
          </div>
        )}
      </div>

      {selected && (
        <div className="card section">
          <h3>{selected.title}
            <StatusBadge status={selected.status} />
          </h3>
          <p className="roles-tag" style={{ marginBottom: 14 }}>{selected.description}</p>

          <div className="grid grid-4" style={{ marginBottom: 16 }}>
            <div className="card stat"><div className="value">{formatMoney(selected.raised_amount)}</div><div className="label">{t('p2p.raised')}</div></div>
            <div className="card stat"><div className="value">{formatMoney(selected.target_amount)}</div><div className="label">{t('p2p.goal')}</div></div>
            <div className="card stat"><div className="value">{selected.roi_percentage}%</div><div className="label">ROI</div></div>
            <div className="card stat"><div className="value">{selected.investor_count || selected.investors?.length || 0}</div><div className="label">{t('p2p.investors_count')}</div></div>
          </div>

          {selected.status === 'VERIFIED_ACTIVE' && (
            <form className="form-row" onSubmit={invest}>
              <div className="field"><label>{t('p2p.shares')}</label><input type="number" min="1" value={shares} onChange={(e) => setShares(e.target.value)} required /></div>
              <button className="btn" type="submit">{t('p2p.invest_btn')}</button>
              <span className="roles-tag">{t('p2p.kyc_note')}</span>
            </form>
          )}

          {isAdmin && (
            <div className="grid grid-2 section">
              <div className="card">
                <h3>{t('p2p.audit')}</h3>
                <table>
                  <thead><tr><th>{t('p2p.th_step')}</th><th>{t('p2p.th_status')}</th><th>{t('p2p.th_actions')}</th></tr></thead>
                  <tbody>
                    {selected.auditSteps?.map((s) => (
                      <tr key={s.id}>
                        <td>{s.step_name}</td>
                        <td><StatusBadge status={s.status} /></td>
                        <td>
                          {s.status !== 'PASSED' && (
                            <div className="inline-actions">
                              <button className="btn" onClick={() => auditStep(s.step_name, true)}>{t('p2p.pass')}</button>
                              <button className="btn danger" onClick={() => auditStep(s.step_name, false)}>{t('p2p.reject')}</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h3 style={{ marginTop: 18 }}>{t('p2p.milestones')}</h3>
                <div className="inline-actions" style={{ marginBottom: 10 }}>
                  <textarea placeholder={`${t('p2p.milestones_hint')}...`} value={milestonesText} onChange={(e) => setMilestonesText(e.target.value)} style={{ flex: 1, minHeight: 60 }} />
                  <button className="btn ghost" onClick={createMilestones}>{t('p2p.save_milestones')}</button>
                </div>
                <table>
                  <thead><tr><th>{t('p2p.th_num')}</th><th>{t('p2p.th_name')}</th><th>{t('p2p.th_amount')}</th><th>{t('p2p.th_status')}</th><th></th></tr></thead>
                  <tbody>
                    {selected.milestones.map((m) => (
                      <tr key={m.id}>
                        <td>{m.milestone_number}</td>
                        <td>{m.title}</td>
                        <td>{formatMoney(m.amount)}</td>
                        <td><StatusBadge status={m.status} /></td>
                        <td>{m.status === 'LOCKED' && <button className="btn" onClick={() => releaseMilestone(m.id)}>{t('p2p.release')}</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="card">
                <h3>{t('p2p.biz_wallet')}</h3>
                {selected.businessWallet && (
                  <>
                    <table>
                      <tbody>
                        <tr><td>{t('p2p.th_rev')}</td><td><strong>{formatMoney(selected.businessWallet.total_revenue_collected)}</strong></td></tr>
                        <tr><td>{t('p2p.entrepreneur')}</td><td>{formatMoney(selected.businessWallet.operational_balance)}</td></tr>
                        <tr><td>{t('p2p.investors')}</td><td>{formatMoney(selected.businessWallet.investor_reserved_balance)}</td></tr>
                        <tr><td>{t('p2p.platform')}</td><td>{formatMoney(selected.businessWallet.platform_commission_balance)}</td></tr>
                      </tbody>
                    </table>
                    <form className="form-row" onSubmit={recordRevenue}>
                      <div className="field"><label>{t('p2p.record_rev')}</label><input type="number" value={revenueAmount} onChange={(e) => setRevenueAmount(e.target.value)} required /></div>
                      <button className="btn" type="submit">{t('p2p.record')}</button>
                      <button className="btn warn" type="button" onClick={runSplit}>{t('p2p.split')}</button>
                    </form>
                  </>
                )}
              </div>
            </div>
          )}

          <h3 style={{ margin: '22px 0 8px' }}>{t('p2p.investors_title')}</h3>
          <table>
            <thead><tr><th>{t('p2p.th_investor')}</th><th>{t('p2p.th_shares')}</th><th>{t('p2p.th_amount')}</th><th>{t('p2p.th_contract')}</th><th>{t('p2p.th_status')}</th></tr></thead>
            <tbody>
              {selected.investors?.map((i) => (
                <tr key={i.id}>
                  <td>{i.full_name}<div className="roles-tag">{i.phone_number}</div></td>
                  <td>{i.shares_bought}</td>
                  <td>{formatMoney(i.total_amount)}</td>
                  <td>{i.contract_pdf_url ? <a href={i.contract_pdf_url} target="_blank" rel="noreferrer">PDF</a> : '-'}</td>
                  <td><StatusBadge status={i.status} /></td>
                </tr>
              ))}
              {(!selected.investors || selected.investors.length === 0) && <tr><td colSpan="5" className="roles-tag">{t('p2p.no_investors')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </ServiceLock>
  );
}
