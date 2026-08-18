import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import ServiceLock from '../components/ServiceLock.jsx';

export default function P2p() {
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
      show('ok', 'Mradi umeundwa (unahitaji uhakiki wa Admin).');
      setTitle(''); setDesc(''); setTarget(''); setSharePrice(''); setRoi(''); setTenure(''); setPayback('');
      load();
    } catch (err) { show('err', err.response?.data?.message || 'Hitilafu.'); }
  };

  const invest = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post(`/p2p/projects/${selected.id}/invest`, { shares });
      show('ok', `${res.data.message} Mkataba: ${res.data.contractPdfUrl || 'unajalishwa'}`);
      openProject(selected.id);
    } catch (err) { show('err', err.response?.data?.message || 'Hitilafu. (Angalia KYC Level 2)'); }
  };

  const auditStep = async (stepName, passed) => {
    try {
      await api.post(`/admin/projects/${selected.id}/audit`, { stepName, passed, notes: passed ? 'Imepita.' : 'Imekataliwa.' });
      show('ok', `${stepName} imewekwa.`);
      openProject(selected.id);
    } catch (err) { show('err', err.response?.data?.message || 'Hitilafu.'); }
  };

  const createMilestones = async () => {
    try {
      const milestones = milestonesText.split('\n').filter(Boolean).map((line) => {
        const [amt, ...rest] = line.split(' ');
        return { title: rest.join(' '), amount: amt };
      });
      await api.post(`/admin/projects/${selected.id}/milestones`, { milestones });
      show('ok', 'Milestones zimehifadhiwa.');
      setMilestonesText('');
      openProject(selected.id);
    } catch (err) { show('err', err.response?.data?.message || 'Hitilafu.'); }
  };

  const releaseMilestone = async (mid) => {
    try {
      const res = await api.post(`/admin/milestones/${mid}/release`);
      show('ok', res.data.message);
      openProject(selected.id);
    } catch (err) { show('err', err.response?.data?.message || 'Hitilafu.'); }
  };

  const recordRevenue = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/admin/projects/${selected.id}/revenue`, { amount: revenueAmount, description: 'Mapato ya mwezi' });
      show('ok', 'Mapato yamerekodiwa.');
      setRevenueAmount('');
      openProject(selected.id);
    } catch (err) { show('err', err.response?.data?.message || 'Hitilafu.'); }
  };

  const runSplit = async () => {
    try {
      const res = await api.post(`/admin/projects/${selected.id}/split`);
      show('ok', `Split: Mjasiriamali ${formatMoney(res.data.operationalShare)}, Wawekezaji ${formatMoney(res.data.investorShare)}, Jukwaa ${formatMoney(res.data.platformShare)}`);
      openProject(selected.id);
    } catch (err) { show('err', err.response?.data?.message || 'Hitilafu.'); }
  };

  return (
    <ServiceLock serviceKey="P2P">
      <div className="page-head">
        <h2>Uwekezaji (P2P Crowdfunding)</h2>
        <p>Wekeza kwenye miradi iliyohakikiwa - Faida hurudishwa kiotomatiki</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="grid grid-2">
        <div className="card">
          <h3>Miradi Iliyopo</h3>
          {projects.map((p) => (
            <div key={p.id} className="inline-actions" style={{ justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div>
                <strong>{p.title}</strong>
                <div className="roles-tag">{p.sector} · Lengo {formatMoney(p.target_amount)} · Imekusanywa {formatMoney(p.raised_amount)}</div>
                <div className="roles-tag">ROI {p.roi_percentage}% · Hisa {formatMoney(p.share_price)} · {p.tenure_months} miezi</div>
              </div>
              <div className="inline-actions">
                <StatusBadge status={p.status} />
                <button className="btn ghost" onClick={() => openProject(p.id)}>Fungua</button>
              </div>
            </div>
          ))}
        </div>

        {isIssuer && (
          <div className="card">
            <h3>Wasilisha Mradi</h3>
            <form onSubmit={createProject}>
              <div className="field" style={{ marginBottom: 10 }}><label>Jina la Mradi</label><input value={title} onChange={(e) => setTitle(e.target.value)} required /></div>
              <div className="form-row">
                <div className="field"><label>Sekta</label>
                  <select value={sector} onChange={(e) => setSector(e.target.value)}>
                    <option value="KILIMO">Kilimo</option>
                    <option value="LOGISTICS">Logistics</option>
                    <option value="MANUFACTURING">Uzalishaji</option>
                    <option value="SMES">Biashara Ndogo</option>
                  </select>
                </div>
                <div className="field"><label>Lengo (TZS)</label><input type="number" value={target} onChange={(e) => setTarget(e.target.value)} required /></div>
                <div className="field"><label>Bei ya Hisa</label><input type="number" value={sharePrice} onChange={(e) => setSharePrice(e.target.value)} required /></div>
              </div>
              <div className="form-row">
                <div className="field"><label>ROI %</label><input type="number" value={roi} onChange={(e) => setRoi(e.target.value)} required /></div>
                <div className="field"><label>Muda (Miezi)</label><input type="number" value={tenure} onChange={(e) => setTenure(e.target.value)} required /></div>
                <div className="field"><label>Faida bada ya (miezi)</label><input type="number" value={payback} onChange={(e) => setPayback(e.target.value)} required /></div>
              </div>
              <div className="field" style={{ marginBottom: 10 }}><label>Maelezo</label><textarea value={desc} onChange={(e) => setDesc(e.target.value)} required /></div>
              <button className="btn" type="submit">Wasilisha</button>
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
            <div className="card stat"><div className="value">{formatMoney(selected.raised_amount)}</div><div className="label">Imekusanywa</div></div>
            <div className="card stat"><div className="value">{formatMoney(selected.target_amount)}</div><div className="label">Lengo</div></div>
            <div className="card stat"><div className="value">{selected.roi_percentage}%</div><div className="label">ROI</div></div>
            <div className="card stat"><div className="value">{selected.investor_count || selected.investors?.length || 0}</div><div className="label">Wawekezaji</div></div>
          </div>

          {selected.status === 'VERIFIED_ACTIVE' && (
            <form className="form-row" onSubmit={invest}>
              <div className="field"><label>Idadi ya Hisa</label><input type="number" min="1" value={shares} onChange={(e) => setShares(e.target.value)} required /></div>
              <button className="btn" type="submit">Wekeza</button>
              <span className="roles-tag">Inahitaji KYC Level 2 (NIDA). Mkataba wa PDF utazalishwa papo hapo.</span>
            </form>
          )}

          {isAdmin && (
            <div className="grid grid-2 section">
              <div className="card">
                <h3>Uhakiki (Due Diligence - Hatua 4)</h3>
                <table>
                  <thead><tr><th>Hatua</th><th>Hali</th><th>Vitendo</th></tr></thead>
                  <tbody>
                    {selected.auditSteps?.map((s) => (
                      <tr key={s.id}>
                        <td>{s.step_name}</td>
                        <td><StatusBadge status={s.status} /></td>
                        <td>
                          {s.status !== 'PASSED' && (
                            <div className="inline-actions">
                              <button className="btn" onClick={() => auditStep(s.step_name, true)}>Pitisha</button>
                              <button className="btn danger" onClick={() => auditStep(s.step_name, false)}>Kataa</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h3 style={{ marginTop: 18 }}>Escrow Milestones</h3>
                <div className="inline-actions" style={{ marginBottom: 10 }}>
                  <textarea placeholder="Kiasi Jina...&#10;2000000 Awamu ya 1 - Malighafi" value={milestonesText} onChange={(e) => setMilestonesText(e.target.value)} style={{ flex: 1, minHeight: 60 }} />
                  <button className="btn ghost" onClick={createMilestones}>Hifadhi Milestones</button>
                </div>
                <table>
                  <thead><tr><th>#</th><th>Jina</th><th>Kiasi</th><th>Hali</th><th></th></tr></thead>
                  <tbody>
                    {selected.milestones.map((m) => (
                      <tr key={m.id}>
                        <td>{m.milestone_number}</td>
                        <td>{m.title}</td>
                        <td>{formatMoney(m.amount)}</td>
                        <td><StatusBadge status={m.status} /></td>
                        <td>{m.status === 'LOCKED' && <button className="btn" onClick={() => releaseMilestone(m.id)}>Toa Fedha</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="card">
                <h3>Business Wallet & Split Payment (70/28/2)</h3>
                {selected.businessWallet && (
                  <>
                    <table>
                      <tbody>
                        <tr><td>Mapato ya Kugawanya</td><td><strong>{formatMoney(selected.businessWallet.total_revenue_collected)}</strong></td></tr>
                        <tr><td>Mjasiriamali (70%)</td><td>{formatMoney(selected.businessWallet.operational_balance)}</td></tr>
                        <tr><td>Wawekezaji (28%)</td><td>{formatMoney(selected.businessWallet.investor_reserved_balance)}</td></tr>
                        <tr><td>Jukwaa (2%)</td><td>{formatMoney(selected.businessWallet.platform_commission_balance)}</td></tr>
                      </tbody>
                    </table>
                    <form className="form-row" onSubmit={recordRevenue}>
                      <div className="field"><label>Rekodi Mapato (TZS)</label><input type="number" value={revenueAmount} onChange={(e) => setRevenueAmount(e.target.value)} required /></div>
                      <button className="btn" type="submit">Rekodi</button>
                      <button className="btn warn" type="button" onClick={runSplit}>Gawa Mapato (Split)</button>
                    </form>
                  </>
                )}
              </div>
            </div>
          )}

          <h3 style={{ margin: '22px 0 8px' }}>Wawekezaji</h3>
          <table>
            <thead><tr><th>Mwekezaji</th><th>Hisa</th><th>Kiasi</th><th>Mkataba</th><th>Hali</th></tr></thead>
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
              {(!selected.investors || selected.investors.length === 0) && <tr><td colSpan="5" className="roles-tag">Hakuna wawekezaji bado.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </ServiceLock>
  );
}
