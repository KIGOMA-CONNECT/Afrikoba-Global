import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

const PROVIDERS = ['Mpesa', 'Tigo', 'Airtel', 'Halopesa'];

const FALLBACK_CURRENCIES = ['TZS', 'USD', 'KES', 'EUR', 'GBP', 'UGX', 'RWF'];

export default function Wallet() {
  const { t } = useT();
  const [balance, setBalance] = useState(null);
  const [txs, setTxs] = useState([]);
  const [holdings, setHoldings] = useState(null);
  const [amount, setAmount] = useState('');
  const [provider, setProvider] = useState('Mpesa');
  const [toPhone, setToPhone] = useState('');
  const [note, setNote] = useState('');
  const [convFrom, setConvFrom] = useState('TZS');
  const [convTo, setConvTo] = useState('USD');
  const [convAmount, setConvAmount] = useState('');
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [currencies, setCurrencies] = useState(FALLBACK_CURRENCIES);
  const [fxPreview, setFxPreview] = useState(null);

  const refresh = () => {
    api.get('/wallet/balance').then((r) => setBalance(r.data.balance)).catch(() => {});
    api.get('/wallet/transactions').then((r) => setTxs(r.data.transactions)).catch(() => {});
    api.get('/currency/my-holdings').then((r) => setHoldings(r.data)).catch(() => {});
  };

  useEffect(refresh, []);

  useEffect(() => {
    api.get('/currency/currencies').then((r) => {
      const list = (r.data.currencies || []).map((c) => c.code).filter(Boolean);
      if (list.length > 0) setCurrencies(list);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!convFrom || !convTo || convFrom === convTo || !convAmount || Number(convAmount) <= 0) {
      setFxPreview(null);
      return;
    }
    api.get(`/currency/rates/${convFrom}/${convTo}`).then((r) => {
      setFxPreview({
        rate: r.data.rate,
        source: r.data.source,
        converted: Number(convAmount) * Number(r.data.rate),
      });
    }).catch(() => setFxPreview(null));
  }, [convFrom, convTo, convAmount]);

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 5000);
  };

  const deposit = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/wallet/deposit/initiate', { amount, provider });
      show('ok', `${res.data.message} ${t('wallet.deposit_from', { amount: formatMoney(res.data.totalCharged) })}`);
      setAmount('');
    } catch (err) {
      show('err', err.response?.data?.message || t('wallet.error_generic'));
    }
  };

  const transfer = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/wallet/transfer', { toPhoneNumber: toPhone, amount, note });
      show('ok', res.data.message);
      setAmount(''); setToPhone(''); setNote('');
      refresh();
    } catch (err) {
      show('err', err.response?.data?.message || t('wallet.error_generic'));
    }
  };

  const convert = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/currency/convert', { from: convFrom, to: convTo, amount: parseFloat(convAmount) });
      const converted = res.data.converted != null ? `${formatMoney(res.data.converted)} ${convTo}` : (res.data.message || '');
      show('ok', `${t('wallet.convert_done')} ${converted}`);
      setConvAmount('');
      setFxPreview(null);
      refresh();
    } catch (err) {
      show('err', err.response?.data?.message || t('wallet.error_generic'));
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>{t('nav.wallet')}</h2>
        <p>{t('wallet.desc')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      {balance && (
        <div className="grid grid-3" style={{ marginBottom: 20 }}>
          <div className="card stat">
            <div className="value">{formatMoney(balance.wallet_balance)}</div>
            <div className="label">{t('wallet.available')}</div>
          </div>
          <div className="card stat">
            <div className="value">{formatMoney(balance.locked_balance)}</div>
            <div className="label">{t('wallet.locked')}</div>
          </div>
          <div className="card stat">
            <div className="value">{balance.currency_code}</div>
            <div className="label">{t('wallet.currency')}</div>
          </div>
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3>{t('wallet.deposit_title')}</h3>
          <form className="form-row" onSubmit={deposit}>
            <div className="field">
              <label>{t('wallet.amount_tzs')}</label>
              <input type="number" min="1000" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </div>
            <div className="field">
              <label>{t('wallet.network')}</label>
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <button className="btn" type="submit">{t('wallet.send_prompt')}</button>
          </form>
          <p className="roles-tag">{t('wallet.fee_note')}</p>
        </div>

        <div className="card">
          <h3>{t('wallet.transfer_title')}</h3>
          <form className="form-row" onSubmit={transfer}>
            <div className="field">
              <label>{t('wallet.recipient')}</label>
              <input value={toPhone} onChange={(e) => setToPhone(e.target.value)} placeholder="255713000000" required />
            </div>
            <div className="field">
              <label>{t('wallet.amount')}</label>
              <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </div>
            <div className="field">
              <label>{t('wallet.note_optional')}</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <button className="btn" type="submit">{t('wallet.send')}</button>
          </form>
        </div>
      </div>

      <div className="grid grid-2 section">
        <div className="card">
          <h3>{t('wallet.my_holdings')}</h3>
          <table>
            <thead>
              <tr><th>{t('wallet.convert_shape_currency')}</th><th>{t('wallet.convert_shape_balance')}</th><th>{t('wallet.convert_shape_rate')}</th><th>{t('wallet.convert_shape_value')}</th></tr>
            </thead>
            <tbody>
              {holdings && (
                <tr>
                  <td><strong>{t('wallet.primary')}</strong></td>
                  <td>{formatMoney(holdings.tzs)}</td>
                  <td>1.0000</td>
                  <td>{formatMoney(holdings.tzs)}</td>
                </tr>
              )}
              {holdings && holdings.currencies && holdings.currencies.map((row) => (
                <tr key={row.currency}>
                  <td><strong>{row.currency}</strong></td>
                  <td>{formatMoney(row.balance)}</td>
                  <td>{row.rateToTzs ? Number(row.rateToTzs).toFixed(4) : '—'}</td>
                  <td>{row.tzsValue != null ? formatMoney(row.tzsValue) : '—'}</td>
                </tr>
              ))}
              {!holdings || !holdings.currencies || holdings.currencies.length === 0 ? (
                <tr><td colSpan="4" className="roles-tag">{t('wallet.holders_empty')}</td></tr>
              ) : null}
            </tbody>
            {holdings && (
              <tfoot>
                <tr>
                  <td colSpan="3"><strong>{t('wallet.convert_shape_total')}</strong></td>
                  <td><strong>{formatMoney(holdings.tzsTotal)}</strong></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <div className="card">
          <h3>{t('wallet.convert_title')}</h3>
          <form className="form-row" onSubmit={convert}>
            <div className="field">
              <label>{t('wallet.convert_from')}</label>
              <select value={convFrom} onChange={(e) => setConvFrom(e.target.value)}>
                {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="field">
              <label>{t('wallet.convert_to')}</label>
              <select value={convTo} onChange={(e) => setConvTo(e.target.value)}>
                {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="field">
              <label>{t('wallet.amount')}</label>
              <input type="number" value={convAmount} onChange={(e) => setConvAmount(e.target.value)} required />
            </div>
            <button className="btn" type="submit">{t('wallet.convert_btn')}</button>
          </form>
          {fxPreview && (
            <div className="roles-tag" style={{ marginTop: 12 }}>
              {t('wallet.fx_preview', {
                from: convFrom, to: convTo, rate: Number(fxPreview.rate).toFixed(4), amount: formatMoney(Number(fxPreview.converted).toFixed(2)),
              })} <span style={{ opacity: 0.7 }}>({fxPreview.source})</span>
            </div>
          )}
        </div>
      </div>

      <div className="card section">
        <h3>{t('wallet.transactions')}</h3>
        <table>
          <thead>
            <tr>
              <th>{t('wallet.th_ref')}</th><th>{t('wallet.th_type')}</th><th>{t('wallet.th_amount')}</th><th>{t('wallet.th_fee')}</th><th>{t('wallet.th_total')}</th><th>{t('wallet.th_status')}</th><th>{t('wallet.th_date')}</th>
            </tr>
          </thead>
          <tbody>
            {txs.map((tx) => (
              <tr key={tx.id}>
                <td>{tx.reference_id}</td>
                <td>{tx.type}</td>
                <td>{formatMoney(tx.wallet_amount)}</td>
                <td>{formatMoney(tx.commission)}</td>
                <td>{formatMoney(tx.total_charged)}</td>
                <td><StatusBadge status={tx.status} /></td>
                <td>{new Date(tx.created_at).toLocaleString('en-GB')}</td>
              </tr>
            ))}
            {txs.length === 0 && <tr><td colSpan="7" style={{ color: 'var(--muted)' }}>{t('wallet.no_tx')}</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}