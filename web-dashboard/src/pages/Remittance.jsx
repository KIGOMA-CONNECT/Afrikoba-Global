import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

const COUNTRY_META = {
  KE: { name: 'Kenya', currency: 'KES' },
  UG: { name: 'Uganda', currency: 'UGX' },
  RW: { name: 'Rwanda', currency: 'RWF' },
  BI: { name: 'Burundi', currency: 'BIF' },
  TZ: { name: 'Tanzania', currency: 'TZS' },
};

function money(v) {
  return (Number(v) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export default function Remittance() {
  const { t } = useT();
  const [tab, setTab] = useState('remit');
  const [corridors, setCorridors] = useState([]);
  const [history, setHistory] = useState([]);
  const [webhooks, setWebhooks] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [sendForm, setSendForm] = useState({ recipient_phone: '', recipient_name: '', recipient_country: 'KE', from_amount: '' });
  const [pickupForm, setPickupForm] = useState({ pickup_code: '', recipient_phone: '', recipient_name: '' });
  const [whForm, setWhForm] = useState({ url: '', events: 'TRANSFER.COMPLETED' });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('remit.error') });
  const ok = (text) => { setMsg({ type: 'ok', text }); };

  const loadRemit = () => {
    api.get('/network/remittance/corridors').then((r) => setCorridors(r.data.corridors || [])).catch(() => {});
    api.get('/network/remittance/history').then((r) => setHistory(r.data.transfers || [])).catch(() => {});
    api.get('/network/webhooks').then((r) => setWebhooks(r.data.webhooks || [])).catch(() => {});
  };
  useEffect(() => { loadRemit(); }, []);

  const send = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/network/remittance/send', sendForm);
      ok(`${t('remit.sent_ok')} ${t('remit.pickup_code')}: ${res.data.result.pickup_code}`);
      setSendForm({ recipient_phone: '', recipient_name: '', recipient_country: 'KE', from_amount: '' });
      loadRemit();
    } catch (err) { error(err); }
  };

  const pickup = async (e) => {
    e.preventDefault();
    try {
      await api.post('/network/remittance/pickup', pickupForm);
      ok(t('remit.picked_ok'));
      setPickupForm({ pickup_code: '', recipient_phone: '', recipient_name: '' });
    } catch (err) { error(err); }
  };

  const createWh = async (e) => {
    e.preventDefault();
    try {
      const events = whForm.events.split(',').map((s) => s.trim()).filter(Boolean);
      await api.post('/network/webhooks', { url: whForm.url, events });
      ok(t('remit.wh_created'));
      setWhForm({ url: '', events: 'TRANSFER.COMPLETED' });
      loadRemit();
    } catch (err) { error(err); }
  };

  const testWh = async (id) => {
    try {
      await api.post(`/network/webhooks/${id}/test`);
      ok(t('remit.wh_tested'));
    } catch (err) { error(err); }
  };

  const tabs = [
    { id: 'remit', label: t('remit.remit_tab') },
    { id: 'webhooks', label: t('remit.wh_tab') },
  ];

  return (
    <div>
      <div className="page-head">
        <h2>🌍 {t('remit.title')}</h2>
        <p>{t('remit.sub')}</p>
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

      {tab === 'remit' && (
        <div>
          {/* Corridors */}
          <h3 style={{ margin: '0 0 14px' }}>{t('remit.corridors')}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14, marginBottom: 24 }}>
            {corridors.map((c) => (
              <div className="card" key={c.id} style={{ padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <strong>{COUNTRY_META[c.from_country]?.name} → {COUNTRY_META[c.to_country]?.name}</strong>
                </div>
                <p className="roles-tag" style={{ margin: '8px 0 0' }}>
                  {c.from_currency}→{c.to_currency} · {t('remit.rate')} {money(c.exchange_rate)} · {t('remit.fee')} {c.fee_percentage}%
                </p>
                <p className="roles-tag" style={{ margin: '4px 0 0' }}>{t('remit.range')} {money(c.min_amount)}–{money(c.max_amount)} {c.from_currency}</p>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 16, marginBottom: 24 }}>
            {/* Send */}
            <div className="card">
              <h3 style={{ marginBottom: 12 }}>{t('remit.send_title')}</h3>
              <form onSubmit={send} className="form">
                <label>{t('remit.recipient_country')}
                  <select value={sendForm.recipient_country} onChange={(e) => setSendForm({ ...sendForm, recipient_country: e.target.value })}>
                    <option value="KE">Kenya (KES)</option>
                    <option value="UG">Uganda (UGX)</option>
                    <option value="RW">Rwanda (RWF)</option>
                    <option value="BI">Burundi (BIF)</option>
                  </select>
                </label>
                <label>{t('remit.recipient_name')}<input value={sendForm.recipient_name} onChange={(e) => setSendForm({ ...sendForm, recipient_name: e.target.value })} required /></label>
                <label>{t('remit.recipient_phone')}<input value={sendForm.recipient_phone} onChange={(e) => setSendForm({ ...sendForm, recipient_phone: e.target.value })} required /></label>
                <label>{t('remit.amount_tzs')}<input type="number" value={sendForm.from_amount} onChange={(e) => setSendForm({ ...sendForm, from_amount: e.target.value })} required /></label>
                <button className="btn" type="submit">✈️ {t('remit.send_btn')}</button>
              </form>
            </div>

            {/* Pickup */}
            <div className="card">
              <h3 style={{ marginBottom: 12 }}>{t('remit.pickup_title')}</h3>
              <form onSubmit={pickup} className="form">
                <label>{t('remit.pickup_code')}<input value={pickupForm.pickup_code} onChange={(e) => setPickupForm({ ...pickupForm, pickup_code: e.target.value })} required /></label>
                <label>{t('remit.recipient_phone')}<input value={pickupForm.recipient_phone} onChange={(e) => setPickupForm({ ...pickupForm, recipient_phone: e.target.value })} required /></label>
                <label>{t('remit.recipient_name')}<input value={pickupForm.recipient_name} onChange={(e) => setPickupForm({ ...pickupForm, recipient_name: e.target.value })} required /></label>
                <button className="btn" type="submit">💵 {t('remit.pickup_btn')}</button>
              </form>
            </div>
          </div>

          {/* History */}
          <h3 style={{ margin: '0 0 14px' }}>{t('remit.history')}</h3>
          <div className="card">
            {history.length === 0 ? (
              <p className="roles-tag">{t('remit.no_history')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('remit.ref')}</th>
                      <th>{t('remit.recipient')}</th>
                      <th>{t('remit.country')}</th>
                      <th>{t('remit.sent')}</th>
                      <th>{t('remit.received')}</th>
                      <th>{t('remit.pickup_code')}</th>
                      <th>{t('remit.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td><strong>{h.reference}</strong></td>
                        <td>{h.recipient_name} ({h.recipient_phone})</td>
                        <td>{COUNTRY_META[h.recipient_country]?.name || h.recipient_country}</td>
                        <td>{money(h.from_amount)}</td>
                        <td>{money(h.to_amount)} {COUNTRY_META[h.recipient_country]?.currency}</td>
                        <td><code>{h.pickup_code}</code></td>
                        <td><span className={`badge ${h.status === 'PICKED_UP' ? 'success' : 'info'}`}>{h.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'webhooks' && (
        <div>
          <div className="card" style={{ marginBottom: 24, maxWidth: 640 }}>
            <h3 style={{ marginBottom: 12 }}>{t('remit.wh_create')}</h3>
            <form onSubmit={createWh} className="form" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label>Webhook URL<input type="url" value={whForm.url} onChange={(e) => setWhForm({ ...whForm, url: e.target.value })} required placeholder="https://your-app.com/hook" /></label>
              <label>{t('remit.wh_events')}<input value={whForm.events} onChange={(e) => setWhForm({ ...whForm, events: e.target.value })} required placeholder="TRANSFER.COMPLETED,DEPOSIT.CREDIT" /></label>
              <button className="btn" type="submit">{t('remit.wh_add')}</button>
            </form>
          </div>

          <h3 style={{ margin: '0 0 14px' }}>{t('remit.wh_yours')}</h3>
          <div className="card">
            {webhooks.length === 0 ? (
              <p className="roles-tag">{t('remit.wh_empty')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>URL</th>
                      <th>{t('remit.wh_events')}</th>
                      <th>{t('remit.wh_active')}</th>
                      <th>{t('remit.wh_failures')}</th>
                      <th>{t('remit.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {webhooks.map((w) => (
                      <tr key={w.id}>
                        <td style={{ wordBreak: 'break-all' }}>{w.url}</td>
                        <td><code>{Array.isArray(w.events) ? w.events.join(', ') : w.events}</code></td>
                        <td><span className={`badge ${w.is_active ? 'success' : 'danger'}`}>{w.is_active ? 'Active' : 'Inactive'}</span></td>
                        <td>{w.failure_count ?? 0}</td>
                        <td>
                          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => testWh(w.id)}>{t('remit.wh_test')}</button>
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