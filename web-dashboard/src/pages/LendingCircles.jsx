import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

const IMPACT_CATEGORIES = ['COMMUNITY', 'WOMEN_EMPOWERMENT', 'SMALL_FARMER', 'YOUTH'];

export default function LendingCircles() {
  const { t } = useT();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const isAdmin = user.role === 'ADMIN';

  const [partners, setPartners] = useState([]);
  const [circles, setCircles] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const [circleName, setCircleName] = useState('');
  const [circlePartner, setCirclePartner] = useState('');
  const [circleDesc, setCircleDesc] = useState('');
  const [circleLocation, setCircleLocation] = useState('');
  const [circleImpact, setCircleImpact] = useState('COMMUNITY');

  const [joinId, setJoinId] = useState('');

  const [campTitle, setCampTitle] = useState('');
  const [campStory, setCampStory] = useState('');
  const [campTarget, setCampTarget] = useState('');
  const [campTerm, setCampTerm] = useState('12');
  const [joining, setJoining] = useState(null);

  const [contributeAmt, setContributeAmt] = useState({});
  const [disbursing, setDisbursing] = useState(null);

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 5000);
  };

  const load = () => {
    api.get('/circles/partners').then((r) => setPartners(r.data.partners)).catch(() => {});
    api.get('/circles/circles').then((r) => setCircles(r.data.circles)).catch(() => {});
    api.get('/circles/campaigns').then((r) => setCampaigns(r.data.campaigns)).catch(() => {});
  };

  useEffect(() => { load(); }, []);

  const createCircle = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/circles/circles', {
        name: circleName, fieldPartnerId: circlePartner ? Number(circlePartner) : undefined,
        description: circleDesc, location: circleLocation, impactCategory: circleImpact,
      });
      show('ok', `${t('circles.created')} (ID: ${res.data.circle.id})`);
      setCircleName(''); setCirclePartner(''); setCircleDesc(''); setCircleLocation(''); setCircleImpact('COMMUNITY');
      load();
    } catch (err) { show('err', err.response?.data?.message || t('circles.error')); }
  };

  const joinCircleById = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/circles/circles/${joinId}/join`);
      show('ok', t('circles.joined'));
      setJoinId('');
      load();
    } catch (err) { show('err', err.response?.data?.message || t('circles.error')); }
  };

  const joinCircle = async (id) => {
    setJoining(id);
    try {
      const res = await api.post(`/circles/circles/${id}/join`);
      show(res.data.member ? 'ok' : 'warn', res.data.member ? t('circles.joined') : t('circles.already_member'));
      load();
    } catch (err) { show('err', err.response?.data?.message || t('circles.error')); }
    finally { setJoining(null); }
  };

  const createCampaign = async (e) => {
    e.preventDefault();
    try {
      await api.post('/circles/campaigns', {
        title: campTitle, story: campStory, targetAmount: Number(campTarget), termMonths: Number(campTerm),
      });
      show('ok', t('circles.campaign_created'));
      setCampTitle(''); setCampStory(''); setCampTarget(''); setCampTerm('12');
      load();
    } catch (err) { show('err', err.response?.data?.message || t('circles.error')); }
  };

  const contribute = async (id) => {
    const amount = Number(contributeAmt[id]);
    if (!amount) { show('err', t('circles.enter_amount')); return; }
    try {
      const res = await api.post(`/circles/campaigns/${id}/contribute`, { amount });
      show('ok', `${t('circles.contributed')} ${formatMoney(amount)}${res.data.result.status === 'FULLY_FUNDED' ? ' - ' + t('circles.fully_funded') : ''}`);
      setContributeAmt((prev) => ({ ...prev, [id]: '' }));
      load();
    } catch (err) { show('err', err.response?.data?.message || t('circles.error')); }
  };

  const disburse = async (id) => {
    setDisbursing(id);
    try {
      await api.post(`/circles/admin/campaigns/${id}/disburse`);
      show('ok', t('circles.disbursed'));
      load();
    } catch (err) { show('err', err.response?.data?.message || t('circles.error')); }
    finally { setDisbursing(null); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>{t('circles.title')}</h2>
        <p>{t('circles.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="card">
        <h3>{t('circles.partners')}</h3>
        {partners.length === 0 && <p className="roles-tag">{t('circles.no_partners')}</p>}
        <table>
          <thead><tr><th>{t('circles.partner_name')}</th><th>{t('circles.country')}</th><th>{t('circles.region')}</th><th>{t('circles.risk')}</th><th>{t('circles.trust')}</th></tr></thead>
          <tbody>
            {partners.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.country_code}</td>
                <td>{p.region}</td>
                <td><StatusBadge status={p.risk_rating} /></td>
                <td>{p.trust_score}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>{t('circles.create')}</h3>
          <form onSubmit={createCircle}>
            <div className="field" style={{ marginBottom: 10 }}><label>{t('circles.name')}</label><input value={circleName} onChange={(e) => setCircleName(e.target.value)} required /></div>
            <div className="form-row">
              <div className="field"><label>{t('circles.partner_select')}</label>
                <select value={circlePartner} onChange={(e) => setCirclePartner(e.target.value)}>
                  <option value="">-- {t('sec.select')} --</option>
                  {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="field"><label>{t('circles.impact')}</label>
                <select value={circleImpact} onChange={(e) => setCircleImpact(e.target.value)}>
                  {IMPACT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 10 }}><label>{t('circles.location')}</label><input value={circleLocation} onChange={(e) => setCircleLocation(e.target.value)} /></div>
            <div className="field" style={{ marginBottom: 10 }}><label>{t('circles.desc')}</label><textarea value={circleDesc} onChange={(e) => setCircleDesc(e.target.value)} /></div>
            <button className="btn" type="submit">{t('circles.create_btn')}</button>
          </form>
          <form onSubmit={joinCircleById} className="section">
            <div className="inline-actions">
              <div className="field" style={{ flex: 1 }}><label>{t('circles.join_label')}</label><input type="number" value={joinId} onChange={(e) => setJoinId(e.target.value)} required /></div>
              <button className="btn ghost" type="submit">{t('circles.join')}</button>
            </div>
          </form>
        </div>

        <div className="card">
          <h3>{t('circles.new_campaign')}</h3>
          <form onSubmit={createCampaign}>
            <div className="field" style={{ marginBottom: 10 }}><label>{t('circles.campaign_title')}</label><input value={campTitle} onChange={(e) => setCampTitle(e.target.value)} required /></div>
            <div className="field" style={{ marginBottom: 10 }}><label>{t('circles.story')}</label><textarea value={campStory} onChange={(e) => setCampStory(e.target.value)} /></div>
            <div className="form-row">
              <div className="field"><label>{t('circles.target')}</label><input type="number" min="1" value={campTarget} onChange={(e) => setCampTarget(e.target.value)} required /></div>
              <div className="field"><label>{t('circles.term')}</label>
                <select value={campTerm} onChange={(e) => setCampTerm(e.target.value)}>
                  {[6, 12, 18, 24].map((m) => <option key={m} value={m}>{m} miezi</option>)}
                </select>
              </div>
            </div>
            <button className="btn" type="submit">{t('circles.create_campaign_btn')}</button>
          </form>
        </div>
      </div>

      <div className="card section">
        <h3>{t('circles.all_circles')}</h3>
        {circles.length === 0 && <p className="roles-tag">{t('circles.no_circles')}</p>}
        {circles.map((c) => (
          <div key={c.id} className="inline-actions" style={{ justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
            <div>
              <strong>{c.name}</strong>
              <div className="roles-tag">{t('circles.leader')}: {c.leader_name} · {t('circles.members_count')}: {c.member_count}</div>
              <div className="roles-tag">{c.location || '-'} · {c.impact_category} · {c.field_partner_name || '-'}</div>
            </div>
            <button className="btn ghost" disabled={joining === c.id} onClick={() => joinCircle(c.id)}>{t('circles.join')}</button>
          </div>
        ))}
      </div>

      <div className="card section">
        <h3>{t('circles.campaigns')}</h3>
        {campaigns.length === 0 && <p className="roles-tag">{t('circles.no_campaigns')}</p>}
        <table>
          <thead><tr><th>{t('circles.campaign_title')}</th><th>{t('circles.circle')}</th><th>{t('circles.borrower')}</th><th>{t('circles.raised')}</th><th>{t('circles.th_status')}</th><th></th></tr></thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id}>
                <td>{c.title}<div className="roles-tag">{c.story}</div></td>
                <td>{c.circle_name || '-'}</td>
                <td>{c.borrower_name}</td>
                <td>{formatMoney(c.raised_amount)} / {formatMoney(c.target_amount)}</td>
                <td><StatusBadge status={c.status} /></td>
                <td>
                  <div className="inline-actions">
                    {c.status === 'FUNDING' && (
                      <>
                        <input type="number" min="1" placeholder={t('circles.amount_ph')} value={contributeAmt[c.id] || ''} onChange={(e) => setContributeAmt((prev) => ({ ...prev, [c.id]: e.target.value }))} style={{ width: 110 }} />
                        <button className="btn" onClick={() => contribute(c.id)}>{t('circles.contribute')}</button>
                      </>
                    )}
                    {isAdmin && c.status === 'FULLY_FUNDED' && (
                      <button className="btn warn" disabled={disbursing === c.id} onClick={() => disburse(c.id)}>{t('circles.disburse')}</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}