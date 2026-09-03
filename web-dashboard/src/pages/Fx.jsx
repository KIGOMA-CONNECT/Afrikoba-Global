import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function Fx() {
  const { t } = useT();
  const [currencies, setCurrencies] = useState([]);
  const [holdings, setHoldings] = useState(null);
  const [prefCurrency, setPrefCurrency] = useState('TZS');
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [showConvert, setShowConvert] = useState(false);
  const [convertForm, setConvertForm] = useState({ from_currency: 'TZS', to_currency: 'USD', amount: '' });
  const [previewRate, setPreviewRate] = useState(null);

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('fx.error') });

  const load = () => {
    api.get('/currency/currencies').then((r) => setCurrencies(r.data.currencies || r.data || [])).catch(() => {});
    api.get('/currency/my-holdings').then((r) => setHoldings(r.data)).catch(() => {});
    api.get('/currency/my-currency').then((r) => {
      if (r.data.currency) setPrefCurrency(r.data.currency);
    }).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const updatePrefCurrency = async (curr) => {
    try {
      await api.put('/currency/my-currency', { currency: curr });
      setPrefCurrency(curr);
      setMsg({ type: 'ok', text: t('fx.pref_updated') });
      load();
    } catch (err) { error(err); }
  };

  const checkRate = async (from, to) => {
    if (!from || !to || from === to) {
      setPreviewRate(null);
      return;
    }
    try {
      const res = await api.get(`/currency/rates/${from}/${to}`);
      setPreviewRate(res.data.rate);
    } catch {
      setPreviewRate(null);
    }
  };

  const convertFunds = async (e) => {
    e.preventDefault();
    try {
      await api.post('/currency/convert', {
        from_currency: convertForm.from_currency,
        to_currency: convertForm.to_currency,
        amount: Number(convertForm.amount),
      });
      setMsg({ type: 'ok', text: t('fx.converted_ok') });
      setShowConvert(false);
      setConvertForm({ from_currency: 'TZS', to_currency: 'USD', amount: '' });
      setPreviewRate(null);
      load();
    } catch (err) { error(err); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>{t('fx.title')}</h2>
        <p>{t('fx.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      {/* Holdings & Portfolio Summary */}
      {holdings && (
        <div className="card" style={{ marginBottom: 24, padding: 24, background: 'linear-gradient(135deg, #0b3d2e 0%, #115e59 100%)', color: '#fff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
            <div>
              <small style={{ opacity: 0.8, textTransform: 'uppercase', letterSpacing: 1 }}>{t('fx.total_portfolio')}</small>
              <h2 style={{ margin: '6px 0 0', fontSize: 32 }}>{formatMoney(holdings.tzsTotal || 0)}</h2>
            </div>
            <div>
              <label style={{ color: '#fff', fontSize: 13, display: 'block', marginBottom: 4 }}>{t('fx.display_currency')}</label>
              <select value={prefCurrency} onChange={(e) => updatePrefCurrency(e.target.value)} style={{ padding: '8px 12px', borderRadius: 8, background: '#fff', color: '#000', fontWeight: 'bold' }}>
                {currencies.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>{t('fx.holdings_title')}</h3>
        <button className="btn" onClick={() => setShowConvert(true)}>💱 {t('fx.convert_btn')}</button>
      </div>

      {/* Convert Modal / Form */}
      {showConvert && (
        <div className="card" style={{ marginBottom: 24, border: '2px solid var(--green)' }}>
          <h3 style={{ marginBottom: 12 }}>{t('fx.convert_title')}</h3>
          <form onSubmit={convertFunds} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <label>{t('fx.from_currency')}<select value={convertForm.from_currency} onChange={(e) => { setConvertForm({ ...convertForm, from_currency: e.target.value }); checkRate(e.target.value, convertForm.to_currency); }}>{currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></label>
              <label>{t('fx.to_currency')}<select value={convertForm.to_currency} onChange={(e) => { setConvertForm({ ...convertForm, to_currency: e.target.value }); checkRate(convertForm.from_currency, e.target.value); }}>{currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></label>
            </div>
            <label>{t('fx.amount')}<input type="number" min="1" value={convertForm.amount} onChange={(e) => setConvertForm({ ...convertForm, amount: e.target.value })} required /></label>
            {previewRate && (
              <div style={{ background: '#f8fafc', padding: 10, borderRadius: 8, fontSize: 13 }}>
                <p style={{ margin: 0 }}>{t('fx.live_rate')}: <strong>1 {convertForm.from_currency} = {Number(previewRate).toFixed(4)} {convertForm.to_currency}</strong></p>
                {convertForm.amount && <p style={{ margin: '4px 0 0' }}>{t('fx.est_receive')}: <strong>{(Number(convertForm.amount) * Number(previewRate)).toFixed(2)} {convertForm.to_currency}</strong></p>}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('fx.execute_convert')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowConvert(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      {/* Holdings Grid */}
      {holdings && holdings.currencies && (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', marginBottom: 24 }}>
          {holdings.currencies.map((row) => (
            <div key={row.currency} className="card" style={{ padding: 18, borderTop: '4px solid var(--green)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ margin: 0 }}>{row.currency}</h4>
                <span className="badge success">{row.currency === 'TZS' ? 'Primary' : 'Foreign'}</span>
              </div>
              <p style={{ fontSize: 24, fontWeight: 'bold', margin: '10px 0 4px' }}>{formatMoney(row.balance)}</p>
              <small className="roles-tag" style={{ color: '#6b7a70' }}>{t('fx.tzs_value')}: {formatMoney(row.tzsValue || 0)}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
