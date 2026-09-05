import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

const SECTORS = ['AGRICULTURE', 'TECHNOLOGY', 'RETAIL', 'ENERGY', 'LOGISTICS', 'MANUFACTURING'];

export default function SecondaryMarket() {
  const { t } = useT();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const isAdmin = user.role === 'ADMIN';

  const [portfolio, setPortfolio] = useState(null);
  const [listings, setListings] = useState([]);
  const [rule, setRule] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const [sellInvId, setSellInvId] = useState('');
  const [sharesForSale, setSharesForSale] = useState('1');
  const [pricePerShare, setPricePerShare] = useState('');

  const [buyingId, setBuyingId] = useState(null);

  const [enableRule, setEnableRule] = useState(true);
  const [minRoi, setMinRoi] = useState('10');
  const [prefSectors, setPrefSectors] = useState(['AGRICULTURE']);
  const [maxAmount, setMaxAmount] = useState('100000');
  const [budget, setBudget] = useState('1000000');

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 5000);
  };

  const load = () => {
    api.get('/p2p/portfolio').then((r) => setPortfolio(r.data)).catch(() => {});
    api.get('/secondary/listings').then((r) => setListings(r.data.listings)).catch(() => {});
    api.get('/secondary/auto-invest').then((r) => {
      if (r.data.rule) {
        setRule(r.data.rule);
        setEnableRule(r.data.rule.enabled);
        setMinRoi(String(r.data.rule.min_roi_percentage));
        setPrefSectors(r.data.rule.preferred_sectors || []);
        setMaxAmount(String(r.data.rule.max_amount_per_project));
        setBudget(String(r.data.rule.budget_cap));
      }
    }).catch(() => {});
  };

  useEffect(() => { load(); }, []);

  const toggleSector = (s) => {
    setPrefSectors((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  const createListing = async (e) => {
    e.preventDefault();
    if (!sellInvId) { show('err', t('sec.pick_investment')); return; }
    try {
      await api.post('/secondary/listings', {
        investmentId: Number(sellInvId), sharesForSale: Number(sharesForSale), pricePerShare: Number(pricePerShare),
      });
      show('ok', t('sec.listed'));
      setSellInvId(''); setSharesForSale('1'); setPricePerShare('');
      load();
    } catch (err) { show('err', err.response?.data?.message || t('sec.error')); }
  };

  const buy = async (id) => {
    setBuyingId(id);
    try {
      await api.post(`/secondary/listings/${id}/buy`, {});
      show('ok', t('sec.bought'));
      load();
    } catch (err) { show('err', err.response?.data?.message || t('sec.error')); }
    finally { setBuyingId(null); }
  };

  const saveRule = async (e) => {
    e.preventDefault();
    try {
      await api.post('/secondary/auto-invest', {
        enabled: enableRule,
        minRoiPercentage: Number(minRoi),
        preferredSectors: prefSectors,
        maxAmountPerProject: Number(maxAmount),
        budgetCap: Number(budget),
      });
      show('ok', t('sec.rule_saved'));
      load();
    } catch (err) { show('err', err.response?.data?.message || t('sec.error')); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>{t('sec.title')}</h2>
        <p>{t('sec.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="grid grid-2">
        <div className="card">
          <h3>{t('sec.my_investments')}</h3>
          {(!portfolio || portfolio.investments.length === 0) && <p className="roles-tag">{t('sec.no_investments')}</p>}
          <form onSubmit={createListing} className="section">
            <div className="field" style={{ marginBottom: 10 }}>
              <label>{t('sec.pick_investment')}</label>
              <select value={sellInvId} onChange={(e) => setSellInvId(e.target.value)}>
                <option value="">-- {t('sec.select')} --</option>
                {portfolio?.investments.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.title} - {inv.shares_bought} hisa ({formatMoney(inv.total_amount)})
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <div className="field"><label>{t('sec.shares_for_sale')}</label><input type="number" min="1" value={sharesForSale} onChange={(e) => setSharesForSale(e.target.value)} required /></div>
              <div className="field"><label>{t('sec.price_per_share')}</label><input type="number" min="1" value={pricePerShare} onChange={(e) => setPricePerShare(e.target.value)} required /></div>
            </div>
            <button className="btn" type="submit">{t('sec.sell_btn')}</button>
          </form>
        </div>

        <div className="card">
          <h3>{t('sec.auto_invest')}</h3>
          <form onSubmit={saveRule} className="section">
            <label className="inline-actions" style={{ marginBottom: 10 }}>
              <input type="checkbox" checked={enableRule} onChange={(e) => setEnableRule(e.target.checked)} />
              <span>{t('sec.enabled')}</span>
            </label>
            <div className="form-row">
              <div className="field"><label>{t('sec.min_roi')}</label><input type="number" step="0.5" value={minRoi} onChange={(e) => setMinRoi(e.target.value)} required /></div>
              <div className="field"><label>{t('sec.max_amount')}</label><input type="number" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} required /></div>
              <div className="field"><label>{t('sec.budget')}</label><input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} required /></div>
            </div>
            <div className="section">
              {SECTORS.map((s) => (
                <label key={s} className="inline-actions" style={{ marginRight: 12 }}>
                  <input type="checkbox" checked={prefSectors.includes(s)} onChange={() => toggleSector(s)} />
                  <span>{s}</span>
                </label>
              ))}
            </div>
            <button className="btn" type="submit">{t('sec.save_rule')}</button>
            {rule && rule.total_auto_invested > 0 && <span className="roles-tag" style={{ marginLeft: 10 }}>{t('sec.invested_tot')}: {formatMoney(rule.total_auto_invested)}</span>}
          </form>
        </div>
      </div>

      <div className="card section">
        <h3>{t('sec.active_listings')}</h3>
        {listings.length === 0 && <p className="roles-tag">{t('sec.no_listings')}</p>}
        <table>
          <thead>
            <tr>
              <th>{t('sec.project')}</th><th>{t('sec.seller')}</th><th>{t('sec.shares')}</th>
              <th>{t('sec.price_per_share')}</th><th>{t('sec.total')}</th><th>{t('sec.th_status')}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {listings.map((l) => (
              <tr key={l.id}>
                <td>{l.title}<div className="roles-tag">{l.sector}</div></td>
                <td>{l.seller_name}</td>
                <td>{l.shares_for_sale}</td>
                <td>{formatMoney(l.price_per_share)}</td>
                <td>{formatMoney(Number(l.shares_for_sale) * Number(l.price_per_share))}</td>
                <td><StatusBadge status={l.status} /></td>
                <td>
                  <div className="inline-actions">
                    {user.role !== 'SELLER' && l.seller_user_id !== user.id && (
                      <button className="btn" disabled={buyingId === l.id} onClick={() => buy(l.id)}>{t('sec.buy')}</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {isAdmin && <p className="roles-tag" style={{ marginTop: 10 }}>{t('sec.admin_note')}</p>}
      </div>
    </div>
  );
}