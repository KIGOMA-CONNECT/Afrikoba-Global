import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function Merchant() {
  const { t } = useT();
  const [merchant, setMerchant] = useState(null);
  const [codes, setCodes] = useState([]);
  const [payments, setPayments] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [showReg, setShowReg] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [showPay, setShowPay] = useState(false);
  const [showPayQr, setShowPayQr] = useState(false);
  const [regForm, setRegForm] = useState({ name: '', business_type: 'RETAIL', phone: '', email: '' });
  const [qrForm, setQrForm] = useState({ amount: '', description: '' });
  const [payForm, setPayForm] = useState({ merchant_id: '', amount: '' });
  const [payQrForm, setPayQrForm] = useState({ qr_code_id: '', amount: '' });
  const [qrDataUri, setQrDataUri] = useState(null);
  const [qrCode, setQrCode] = useState(null);
  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('merchant.error') });

  const load = () => {
    api.get('/merchant/my').then((r) => setMerchant(r.data.merchant)).catch(() => {});
    api.get('/merchant/qr').then((r) => setCodes(r.data.codes)).catch(() => {});
    api.get('/merchant/payments').then((r) => setPayments(r.data.payments)).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const register = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/merchant/register', regForm);
      setMerchant(r.data.merchant);
      setMsg({ type: 'ok', text: t('merchant.registered') });
      setShowReg(false);
    } catch (err) { error(err); }
  };

  const createQr = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/merchant/qr', {
        ...(qrForm.amount ? { amount: Number(qrForm.amount), type: 'STATIC' } : { type: 'DYNAMIC' }),
        description: qrForm.description || undefined,
      });
      const code = r.data.code;
      setQrCode(code);
      const dataUri = await QRCode.toDataURL(code.code, { width: 260, margin: 2, color: { dark: '#0b3d2e', light: '#ffffff' } });
      setQrDataUri(dataUri);
      setMsg({ type: 'ok', text: t('merchant.qr_created') });
      setShowQr(false);
      setQrForm({ amount: '', description: '' });
      load();
    } catch (err) { error(err); }
  };

  const disableQr = async (id) => {
    try {
      await api.delete(`/merchant/qr/${id}`);
      load();
    } catch (err) { error(err); }
  };

  const payMerchant = async (e) => {
    e.preventDefault();
    try {
      await api.post('/merchant/pay', { merchant_id: Number(payForm.merchant_id), amount: Number(payForm.amount) });
      setMsg({ type: 'ok', text: t('merchant.paid') });
      setShowPay(false);
      setPayForm({ merchant_id: '', amount: '' });
    } catch (err) { error(err); }
  };

  const payQr = async (e) => {
    e.preventDefault();
    try {
      await api.post('/merchant/qr/pay', { qr_code_id: Number(payQrForm.qr_code_id), amount: Number(payQrForm.amount) });
      setMsg({ type: 'ok', text: t('merchant.paid') });
      setShowPayQr(false);
      setPayQrForm({ qr_code_id: '', amount: '' });
    } catch (err) { error(err); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>{t('merchant.title')}</h2>
        <p>{t('merchant.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      {/* Merchant profile */}
      <div className="card" style={{ marginBottom: 24, padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0, marginBottom: 4 }}>
              {merchant ? `🏪 ${merchant.name}` : t('merchant.not_registered')}
            </h3>
            {merchant ? (
              <p className="roles-tag" style={{ margin: 0 }}>
                {merchant.business_type} · {merchant.phone}{merchant.is_active ? ` · ${t('merchant.active')}` : ` · ${t('merchant.inactive')}`}
              </p>
            ) : (
              <p className="roles-tag" style={{ margin: 0 }}>{t('merchant.reg_hint')}</p>
            )}
          </div>
          {merchant ? (
            <button className="btn" onClick={() => { setShowQr(true); setQrDataUri(null); setQrCode(null); }}>＋ {t('merchant.new_qr')}</button>
          ) : (
            <button className="btn" onClick={() => setShowReg(true)}>{t('merchant.register')}</button>
          )}
        </div>
      </div>

      {showReg && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('merchant.register')}</h3>
          <form onSubmit={register} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('merchant.name')}<input type="text" value={regForm.name} onChange={(e) => setRegForm({ ...regForm, name: e.target.value })} required /></label>
            <label>{t('merchant.biz_type')}
              <select value={regForm.business_type} onChange={(e) => setRegForm({ ...regForm, business_type: e.target.value })}>
                {['RETAIL', 'SERVICES', 'FOOD', 'AGRICULTURE', 'TRANSPORT', 'OTHER'].map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            <label>{t('merchant.phone')}<input type="text" value={regForm.phone} onChange={(e) => setRegForm({ ...regForm, phone: e.target.value })} required placeholder="2557..." /></label>
            <label>{t('merchant.email')}<input type="email" value={regForm.email} onChange={(e) => setRegForm({ ...regForm, email: e.target.value })} /></label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('merchant.register')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowReg(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      {showQr && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('merchant.new_qr')}</h3>
          <p className="roles-tag" style={{ marginBottom: 14 }}>{t('merchant.qr_hint')}</p>
          <form onSubmit={createQr} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('merchant.amount_optional')}<input type="number" min="0" value={qrForm.amount} onChange={(e) => setQrForm({ ...qrForm, amount: e.target.value })} /></label>
            <label>{t('merchant.description')}<input type="text" value={qrForm.description} onChange={(e) => setQrForm({ ...qrForm, description: e.target.value })} /></label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('merchant.generate')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowQr(false)}>✕</button>
            </div>
          </form>
          {qrDataUri && qrCode && (
            <div style={{ marginTop: 16, textAlign: 'center', padding: 16, background: '#f8faf9', borderRadius: 12 }}>
              <img src={qrDataUri} alt="QR" style={{ width: 220, height: 220 }} />
              <p className="roles-tag" style={{ marginTop: 10, wordBreak: 'break-all' }}>{qrCode.code}</p>
              {qrCode.amount && <p><strong>{formatMoney(qrCode.amount)}</strong></p>}
              <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => disableQr(qrCode.id)}>{t('merchant.disable')}</button>
            </div>
          )}
        </div>
      )}

      {/* My QR codes */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginBottom: 14 }}>{t('merchant.my_qrs')}</h3>
        {codes.length === 0 ? (
          <p className="roles-tag">{t('merchant.no_qrs')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('merchant.code')}</th>
                  <th>{t('merchant.type')}</th>
                  <th>{t('merchant.amount')}</th>
                  <th>{t('merchant.scans')}</th>
                  <th>{t('merchant.status')}</th>
                  <th>{t('merchant.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {codes.map((c) => (
                  <tr key={c.id}>
                    <td style={{ wordBreak: 'break-all' }}>{c.code}</td>
                    <td>{c.type}</td>
                    <td>{c.amount ? formatMoney(c.amount) : '—'}</td>
                    <td>{c.scan_count}</td>
                    <td><span className={`badge ${c.is_active ? 'success' : 'danger'}`}>{c.is_active ? t('merchant.active') : t('merchant.inactive')}</span></td>
                    <td>
                      {c.is_active && (
                        <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => disableQr(c.id)}>{t('merchant.disable')}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pay merchant */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => setShowPay(true)}>{t('merchant.pay_merchant')}</button>
        <button className="btn btn-secondary" onClick={() => setShowPayQr(true)}>{t('merchant.pay_qr')}</button>
      </div>

      {showPay && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('merchant.pay_merchant')}</h3>
          <form onSubmit={payMerchant} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('merchant.merchant_id')}<input type="number" value={payForm.merchant_id} onChange={(e) => setPayForm({ ...payForm, merchant_id: e.target.value })} required /></label>
            <label>{t('merchant.amount')}<input type="number" min="1" value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} required /></label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('merchant.pay')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowPay(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      {showPayQr && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('merchant.pay_qr')}</h3>
          <form onSubmit={payQr} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('merchant.qr_code_id')}<input type="number" value={payQrForm.qr_code_id} onChange={(e) => setPayQrForm({ ...payQrForm, qr_code_id: e.target.value })} required /></label>
            <label>{t('merchant.amount')}<input type="number" min="1" value={payQrForm.amount} onChange={(e) => setPayQrForm({ ...payQrForm, amount: e.target.value })} required /></label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('merchant.pay')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowPayQr(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      {/* Payment history */}
      <div className="card">
        <h3 style={{ marginBottom: 14 }}>{t('merchant.payment_history')}</h3>
        {payments.length === 0 ? (
          <p className="roles-tag">{t('merchant.no_payments')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('merchant.date')}</th>
                  <th>{t('merchant.payer')}</th>
                  <th>{t('merchant.amount')}</th>
                  <th>{t('merchant.reference')}</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td>{new Date(p.created_at).toLocaleDateString()}</td>
                    <td>{p.payer_name || p.payer_phone}</td>
                    <td><strong>{formatMoney(p.amount)}</strong></td>
                    <td style={{ wordBreak: 'break-all' }}>{p.reference}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
