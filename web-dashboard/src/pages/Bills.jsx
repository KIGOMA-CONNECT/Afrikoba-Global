import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

const PROVIDERS = ['VODACOM', 'TIGO', 'AIRTEL', 'HALOTEL', 'TTCL'];

function money(v) {
  return (Number(v) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export default function Bills() {
  const { t } = useT();
  const [tab, setTab] = useState('bills');
  const [billers, setBillers] = useState([]);
  const [billHist, setBillHist] = useState([]);
  const [airHist, setAirHist] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [billForm, setBillForm] = useState({ biller_id: '', account_number: '', amount: '' });
  const [airForm, setAirForm] = useState({ phone: '', provider: 'VODACOM', product_id: '', amount: '' });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('bills.error') });
  const ok = (text) => { setMsg({ type: 'ok', text }); };

  const load = () => {
    api.get('/eco/bills/billers').then((r) => setBillers(r.data.billers || [])).catch(() => {});
    api.get('/eco/bills/history').then((r) => setBillHist(r.data.payments || [])).catch(() => {});
    api.get('/eco/airtime/history').then((r) => setAirHist(r.data.purchases || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const payBill = async (e) => {
    e.preventDefault();
    try {
      await api.post('/eco/bills/pay', billForm);
      ok(t('bills.paid_ok'));
      setBillForm({ biller_id: '', account_number: '', amount: '' });
      load();
    } catch (err) { error(err); }
  };

  const buyAirtime = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/eco/airtime/purchase', airForm);
      ok(`${t('bills.airtime_ok')} ${t('bills.ref')}: ${res.data.result.reference}`);
      setAirForm({ phone: '', provider: 'VODACOM', product_id: '', amount: '' });
      load();
    } catch (err) { error(err); }
  };

  const tabs = [
    { id: 'bills', label: t('bills.bills_tab') },
    { id: 'airtime', label: t('bills.airtime_tab') },
  ];

  return (
    <div>
      <div className="page-head">
        <h2>{t('bills.title')}</h2>
        <p>{t('bills.sub')}</p>
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

      {tab === 'bills' && (
        <div>
          <div className="card" style={{ marginBottom: 24, maxWidth: 640 }}>
            <h3 style={{ marginBottom: 12 }}>{t('bills.pay_title')}</h3>
            <form onSubmit={payBill} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label>{t('bills.biller')}
                <select value={billForm.biller_id} onChange={(e) => setBillForm({ ...billForm, biller_id: e.target.value })} required>
                  <option value="">{t('bills.select')}</option>
                  {billers.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}{b.category ? ` — ${b.category}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>{t('bills.account')}<input value={billForm.account_number} onChange={(e) => setBillForm({ ...billForm, account_number: e.target.value })} required /></label>
              <label>{t('bills.amount')}<input type="number" value={billForm.amount} onChange={(e) => setBillForm({ ...billForm, amount: e.target.value })} required /></label>
              <button className="btn" type="submit">{t('bills.pay_btn')}</button>
            </form>
          </div>

          <h3 style={{ margin: '0 0 14px' }}>{t('bills.history')}</h3>
          <div className="card">
            {billHist.length === 0 ? (
              <p className="roles-tag">{t('bills.no_history')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('bills.biller')}</th>
                      <th>{t('bills.account')}</th>
                      <th>{t('bills.amount')}</th>
                      <th>{t('bills.fee')}</th>
                      <th>{t('bills.ref')}</th>
                      <th>{t('bills.date')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {billHist.map((p) => (
                      <tr key={p.id}>
                        <td><strong>{p.biller_name}</strong></td>
                        <td>{p.account_number}</td>
                        <td>{money(p.amount)}</td>
                        <td>{money(p.fee)}</td>
                        <td><code>{p.reference}</code></td>
                        <td>{new Date(p.created_at).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'airtime' && (
        <div>
          <div className="card" style={{ marginBottom: 24, maxWidth: 640 }}>
            <h3 style={{ marginBottom: 12 }}>{t('bills.airtime_buy')}</h3>
            <form onSubmit={buyAirtime} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label>{t('bills.phone')}<input value={airForm.phone} onChange={(e) => setAirForm({ ...airForm, phone: e.target.value })} required /></label>
              <label>{t('bills.provider')}
                <select value={airForm.provider} onChange={(e) => setAirForm({ ...airForm, provider: e.target.value })}>
                  {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label>{t('bills.airtime_amount')}<input type="number" value={airForm.amount} onChange={(e) => setAirForm({ ...airForm, amount: e.target.value })} required /></label>
              <button className="btn" type="submit">{t('bills.airtime_buy')}</button>
            </form>
          </div>

          <h3 style={{ margin: '0 0 14px' }}>{t('bills.history')}</h3>
          <div className="card">
            {airHist.length === 0 ? (
              <p className="roles-tag">{t('bills.no_history')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('bills.phone')}</th>
                      <th>{t('bills.provider')}</th>
                      <th>{t('bills.amount')}</th>
                      <th>{t('bills.ref')}</th>
                      <th>{t('bills.status')}</th>
                      <th>{t('bills.date')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {airHist.map((a) => (
                      <tr key={a.id}>
                        <td>{a.phone}</td>
                        <td>{a.provider}</td>
                        <td>{money(a.amount)}</td>
                        <td><code>{a.reference}</code></td>
                        <td><span className={`badge ${a.status === 'SUCCESS' ? 'success' : 'danger'}`}>{a.status}</span></td>
                        <td>{new Date(a.created_at).toLocaleString()}</td>
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