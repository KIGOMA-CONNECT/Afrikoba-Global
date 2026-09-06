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
  const [links, setLinks] = useState([]);
  const [showLink, setShowLink] = useState(false);
  const [linkForm, setLinkForm] = useState({ amount: '', description: '' });
  const [copiedLink, setCopiedLink] = useState('');
  const [connected, setConnected] = useState(null);
  const [payouts, setPayouts] = useState([]);
  const [adminAccounts, setAdminAccounts] = useState([]);
  const [adminPayouts, setAdminPayouts] = useState([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [connForm, setConnForm] = useState({ payout_type: 'MNO_PHONE', payout_reference: '', bank_name: '', account_holder: '' });
  const [reqForm, setReqForm] = useState({ amount: '' });
  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('merchant.error') });

  const load = () => {
    api.get('/merchant/my').then((r) => setMerchant(r.data.merchant)).catch(() => {});
    api.get('/merchant/qr').then((r) => setCodes(r.data.codes)).catch(() => {});
    api.get('/merchant/payments').then((r) => setPayments(r.data.payments)).catch(() => {});
    api.get('/merchant/payment-links').then((r) => setLinks(r.data.links)).catch(() => {});
    api.get('/merchant/connected').then((r) => setConnected(r.data.account)).catch(() => {});
    api.get('/merchant/payouts').then((r) => setPayouts(r.data.payouts)).catch(() => {});
    api.get('/merchant/admin/connected').then((r) => { setAdminAccounts(r.data.accounts); setIsAdmin(true); }).catch(() => {});
    api.get('/merchant/admin/payouts').then((r) => setAdminPayouts(r.data.payouts)).catch(() => {});
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

  const createLink = async (e) => {
    e.preventDefault();
    try {
      await api.post('/merchant/payment-links', {
        ...(linkForm.amount ? { amount: Number(linkForm.amount) } : {}),
        description: linkForm.description || undefined,
      });
      setMsg({ type: 'ok', text: t('merchant.link_created') });
      setShowLink(false);
      setLinkForm({ amount: '', description: '' });
      load();
    } catch (err) { error(err); }
  };

  const deactivateLink = async (id) => {
    try {
      await api.delete(`/merchant/payment-links/${id}`);
      load();
    } catch (err) { error(err); }
  };

  const copyLink = (code) => {
    const url = `${window.location.origin}/pay/${code}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedLink(code);
      setTimeout(() => setCopiedLink(''), 2000);
    });
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

  const saveConnected = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/merchant/connected', connForm);
      setConnected(r.data.account);
      setMsg({ type: 'ok', text: t('merchant.connected_ok') });
      load();
    } catch (err) { error(err); }
  };

  const requestPayout = async (e) => {
    e.preventDefault();
    try {
      await api.post('/merchant/payouts', { amount: Number(reqForm.amount) });
      setMsg({ type: 'ok', text: t('merchant.payout_ok') });
      setReqForm({ amount: '' });
      load();
    } catch (err) { error(err); }
  };

  const setConnStatus = async (id, status) => {
    try {
      await api.patch(`/merchant/admin/connected/${id}`, { status });
      load();
    } catch (err) { error(err); }
  };

  const executePayout = async (id) => {
    try {
      await api.post(`/merchant/admin/payouts/${id}/execute`, {});
      setMsg({ type: 'ok', text: t('merchant.exec_ok') });
      load();
    } catch (err) { error(err); }
  };

  const connBadge = (status) => {
    const cls = status === 'ACTIVE' ? 'success' : status === 'SUSPENDED' ? 'danger' : 'neutral';
    const label = status === 'ACTIVE' ? t('merchant.status_active') : status === 'SUSPENDED' ? t('merchant.status_suspended') : t('merchant.status_pending');
    return <span className={`badge ${cls}`}>{label}</span>;
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0 }}>{t('merchant.my_qrs')}</h3>
          <button className="btn" onClick={() => setShowLink(true)}>＋ {t('merchant.new_link')}</button>
        </div>
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

      {showLink && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('merchant.new_link')}</h3>
          <p className="roles-tag" style={{ marginBottom: 14 }}>{t('merchant.link_hint')}</p>
          <form onSubmit={createLink} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('merchant.amount_optional')}<input type="number" min="0" value={linkForm.amount} onChange={(e) => setLinkForm({ ...linkForm, amount: e.target.value })} /></label>
            <label>{t('merchant.description')}<input type="text" value={linkForm.description} onChange={(e) => setLinkForm({ ...linkForm, description: e.target.value })} /></label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('merchant.create_link')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowLink(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      {links.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 14 }}>{t('merchant.my_links')}</h3>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('merchant.amount')}</th>
                  <th>{t('merchant.description')}</th>
                  <th>{t('merchant.visits')}</th>
                  <th>{t('merchant.status')}</th>
                  <th>{t('merchant.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.id}>
                    <td>{l.amount ? formatMoney(l.amount) : t('merchant.open_amount')}</td>
                    <td>{l.description || '—'}</td>
                    <td>{l.scan_count}</td>
                    <td><span className={`badge ${l.is_active ? 'success' : 'danger'}`}>{l.is_active ? t('merchant.active') : t('merchant.inactive')}</span></td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      {l.is_active && (
                        <>
                          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => copyLink(l.code)}>{copiedLink === l.code ? t('merchant.copied') : t('merchant.copy_link')}</button>
                          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12, color: '#dc2626' }} onClick={() => deactivateLink(l.id)}>{t('merchant.disable')}</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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

      {/* Connected payout account + settlements */}
      {merchant && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>{t('merchant.connected_title')}</h3>
            {connected && connBadge(connected.status)}
          </div>
          {connected ? (
            <>
              <p className="roles-tag" style={{ marginBottom: 12 }}>
                {connected.payout_type} → {connected.payout_reference}
                {connected.bank_name ? ` · ${connected.bank_name}` : ''}
                {connected.account_holder ? ` · ${connected.account_holder}` : ''}
              </p>
              <p style={{ fontWeight: 600, fontSize: 22, margin: '0 0 14px' }}>
                {formatMoney(connected.balance)} <span style={{ fontSize: 14, fontWeight: 400, color: '#6b7280' }}>{t('merchant.held_balance')}</span>
              </p>
              {connected.status !== 'ACTIVE' && (
                <p className="alert alert-ok" style={{ padding: 10, borderRadius: 8 }}>{t('merchant.connected_hint')}</p>
              )}
            </>
          ) : (
            <p className="roles-tag" style={{ marginBottom: 14 }}>{t('merchant.connect_hint')}</p>
          )}

          {(connected && connected.status !== 'ACTIVE') || !connected ? (
            <form onSubmit={saveConnected} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label>{t('merchant.payout_type')}
                <select value={connForm.payout_type} onChange={(e) => setConnForm({ ...connForm, payout_type: e.target.value })}>
                  <option value="MNO_PHONE">MNO_PHONE</option>
                  <option value="BANK_ACCOUNT">BANK_ACCOUNT</option>
                </select>
              </label>
              <label>{t('merchant.payout_reference')}<input type="text" value={connForm.payout_reference} onChange={(e) => setConnForm({ ...connForm, payout_reference: e.target.value })} required placeholder="2557... / 015..." /></label>
              {connForm.payout_type === 'BANK_ACCOUNT' && (
                <>
                  <label>{t('merchant.bank_name')}<input type="text" value={connForm.bank_name} onChange={(e) => setConnForm({ ...connForm, bank_name: e.target.value })} /></label>
                  <label>{t('merchant.account_holder')}<input type="text" value={connForm.account_holder} onChange={(e) => setConnForm({ ...connForm, account_holder: e.target.value })} /></label>
                </>
              )}
              <div>
                <button className="btn" type="submit">{t('merchant.save_connected')}</button>
              </div>
            </form>
          ) : (
            <form onSubmit={requestPayout} style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <label style={{ flex: 1 }}>{t('merchant.payout_amount')}<input type="number" min="1" value={reqForm.amount} onChange={(e) => setReqForm({ ...reqForm, amount: e.target.value })} required /></label>
              <button className="btn" type="submit">{t('merchant.request_payout')}</button>
            </form>
          )}

          {payouts.length > 0 && (
            <div style={{ overflowX: 'auto', marginTop: 14 }}>
              <h4 style={{ marginBottom: 8 }}>{t('merchant.payout_history')}</h4>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('merchant.reference')}</th>
                    <th>{t('merchant.amount')}</th>
                    <th>{t('merchant.payout_fee')}</th>
                    <th>{t('merchant.payout_net')}</th>
                    <th>{t('merchant.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.map((p) => (
                    <tr key={p.id}>
                      <td style={{ wordBreak: 'break-all' }}>{p.payout_reference}</td>
                      <td>{formatMoney(p.gross_amount)}</td>
                      <td>{formatMoney(p.fee_amount)}</td>
                      <td>{formatMoney(p.net_amount)}</td>
                      <td><span className={`badge ${p.status === 'EXECUTED' ? 'success' : 'neutral'}`}>{p.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Admin: connected accounts + payout queue */}
      {isAdmin && (
        <>
          <div className="card" style={{ marginBottom: 24 }}>
            <h3 style={{ marginBottom: 14 }}>{t('merchant.connected_merchants')}</h3>
            {adminAccounts.length === 0 ? (
              <p className="roles-tag">{t('merchant.no_connected')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('merchant.merchant_name')}</th>
                      <th>{t('merchant.payout_reference')}</th>
                      <th>{t('merchant.held_balance')}</th>
                      <th>{t('merchant.status')}</th>
                      <th>{t('merchant.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adminAccounts.map((a) => (
                      <tr key={a.id}>
                        <td>{a.merchant_name}</td>
                        <td>{a.payout_reference}</td>
                        <td>{formatMoney(a.balance)}</td>
                        <td>{connBadge(a.status)}</td>
                        <td style={{ display: 'flex', gap: 6 }}>
                          {a.status !== 'ACTIVE' && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setConnStatus(a.id, 'ACTIVE')}>{t('merchant.activate')}</button>
                          )}
                          {a.status === 'ACTIVE' && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12, color: '#dc2626' }} onClick={() => setConnStatus(a.id, 'SUSPENDED')}>{t('merchant.suspend')}</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card" style={{ marginBottom: 24 }}>
            <h3 style={{ marginBottom: 14 }}>{t('merchant.payout_queue')}</h3>
            {adminPayouts.filter((p) => p.status === 'PENDING').length === 0 ? (
              <p className="roles-tag">{t('merchant.no_pending')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('merchant.merchant_name')}</th>
                      <th>{t('merchant.payout_ref')}</th>
                      <th>{t('merchant.amount')}</th>
                      <th>{t('merchant.payout_net')}</th>
                      <th>{t('merchant.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adminPayouts.filter((p) => p.status === 'PENDING').map((p) => (
                      <tr key={p.id}>
                        <td>{p.merchant_name}</td>
                        <td style={{ wordBreak: 'break-all' }}>{p.payout_reference}</td>
                        <td>{formatMoney(p.gross_amount)}</td>
                        <td>{formatMoney(p.net_amount)}</td>
                        <td>
                          <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => executePayout(p.id)}>{t('merchant.execute_payout')}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
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
