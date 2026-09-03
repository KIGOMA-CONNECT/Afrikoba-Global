import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function Business() {
  const { t } = useT();
  const [businesses, setBusinesses] = useState([]);
  const [selectedBiz, setSelectedBiz] = useState(null);
  const [details, setDetails] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [showReg, setShowReg] = useState(false);
  const [showFund, setShowFund] = useState(false);
  const [showPayLink, setShowPayLink] = useState(false);
  const [showPayroll, setShowPayroll] = useState(false);
  const [showStaff, setShowStaff] = useState(false);

  const [regForm, setRegForm] = useState({ name: '', registration_number: '', tax_id: '', business_type: 'RETAIL', phone: '', email: '' });
  const [fundAmount, setFundAmount] = useState('');
  const [linkForm, setLinkForm] = useState({ title: '', amount: '', currency: 'TZS' });
  const [payrollForm, setPayrollForm] = useState({ period: '2026-09', employeesJson: '[{"name":"Employee 1","phone":"255700000001","amount":300000}]' });
  const [staffForm, setStaffForm] = useState({ phone: '', role: 'CASHIER' });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('business.error') });

  const load = () => {
    api.get('/business/accounts').then((r) => setBusinesses(r.data.businesses || r.data || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const loadBizDetails = async (id) => {
    try {
      const res = await api.get(`/business/accounts/${id}`);
      setDetails(res.data);
      setSelectedBiz(id);
    } catch (err) { error(err); }
  };

  const registerBusiness = async (e) => {
    e.preventDefault();
    try {
      await api.post('/business/accounts', regForm);
      setMsg({ type: 'ok', text: t('business.registered_ok') });
      setShowReg(false);
      setRegForm({ name: '', registration_number: '', tax_id: '', business_type: 'RETAIL', phone: '', email: '' });
      load();
    } catch (err) { error(err); }
  };

  const fundBiz = async (e) => {
    e.preventDefault();
    if (!selectedBiz) return;
    try {
      await api.post(`/business/accounts/${selectedBiz}/fund`, { amount: Number(fundAmount) });
      setMsg({ type: 'ok', text: t('business.funded_ok') });
      setShowFund(false);
      setFundAmount('');
      load();
      loadBizDetails(selectedBiz);
    } catch (err) { error(err); }
  };

  const createPaymentLink = async (e) => {
    e.preventDefault();
    if (!selectedBiz) return;
    try {
      await api.post(`/business/accounts/${selectedBiz}/payment-links`, {
        title: linkForm.title,
        amount: Number(linkForm.amount),
        currency: linkForm.currency,
      });
      setMsg({ type: 'ok', text: t('business.link_created') });
      setShowPayLink(false);
      setLinkForm({ title: '', amount: '', currency: 'TZS' });
      loadBizDetails(selectedBiz);
    } catch (err) { error(err); }
  };

  const runPayroll = async (e) => {
    e.preventDefault();
    if (!selectedBiz) return;
    try {
      const parsedEmployees = JSON.parse(payrollForm.employeesJson);
      await api.post(`/business/accounts/${selectedBiz}/payroll`, {
        period: payrollForm.period,
        employees: parsedEmployees,
      });
      setMsg({ type: 'ok', text: t('business.payroll_ok') });
      setShowPayroll(false);
      loadBizDetails(selectedBiz);
    } catch (err) { error(err); }
  };

  const addStaff = async (e) => {
    e.preventDefault();
    if (!selectedBiz) return;
    try {
      await api.post(`/business/accounts/${selectedBiz}/staff`, staffForm);
      setMsg({ type: 'ok', text: t('business.staff_added') });
      setShowStaff(false);
      setStaffForm({ phone: '', role: 'CASHIER' });
      loadBizDetails(selectedBiz);
    } catch (err) { error(err); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>{t('business.title')}</h2>
        <p>{t('business.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>{t('business.my_businesses')}</h3>
        <button className="btn" onClick={() => setShowReg(true)}>＋ {t('business.register_btn')}</button>
      </div>

      {showReg && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('business.register_btn')}</h3>
          <form onSubmit={registerBusiness} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('business.name')}<input type="text" value={regForm.name} onChange={(e) => setRegForm({ ...regForm, name: e.target.value })} required /></label>
            <label>{t('business.reg_no')}<input type="text" value={regForm.registration_number} onChange={(e) => setRegForm({ ...regForm, registration_number: e.target.value })} required /></label>
            <label>{t('business.tax_id')}<input type="text" value={regForm.tax_id} onChange={(e) => setRegForm({ ...regForm, tax_id: e.target.value })} required /></label>
            <label>{t('business.type')}<select value={regForm.business_type} onChange={(e) => setRegForm({ ...regForm, business_type: e.target.value })}><option value="RETAIL">Retail</option><option value="SERVICES">Services</option><option value="MANUFACTURING">Manufacturing</option><option value="TECHNOLOGY">Technology</option><option value="OTHER">Other</option></select></label>
            <label>{t('business.phone')}<input type="text" value={regForm.phone} onChange={(e) => setRegForm({ ...regForm, phone: e.target.value })} required placeholder="2557..." /></label>
            <label>{t('business.email')}<input type="email" value={regForm.email} onChange={(e) => setRegForm({ ...regForm, email: e.target.value })} /></label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('business.save')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowReg(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      {businesses.length === 0 && !showReg ? (
        <div className="card" style={{ padding: 24, textAlign: 'center', marginBottom: 24 }}>
          <p style={{ fontSize: 36, marginBottom: 8 }}>🏢</p>
          <p className="roles-tag">{t('business.empty')}</p>
          <button className="btn" style={{ marginTop: 10 }} onClick={() => setShowReg(true)}>{t('business.register_btn')}</button>
        </div>
      ) : (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', marginBottom: 24 }}>
          {businesses.map((b) => (
            <div key={b.id} className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', borderTop: '4px solid var(--green)', padding: 20 }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4 style={{ margin: 0 }}>{b.name}</h4>
                  <span className="badge success">{b.business_type}</span>
                </div>
                <p style={{ fontSize: 22, fontWeight: 'bold', marginTop: 12, marginBottom: 4 }}>{formatMoney(b.balance)}</p>
                <small className="roles-tag">TAX ID: {b.tax_id}</small>
              </div>
              <button className="btn" style={{ marginTop: 16 }} onClick={() => loadBizDetails(b.id)}>{t('business.manage')}</button>
            </div>
          ))}
        </div>
      )}

      {/* Selected Business Management View */}
      {selectedBiz && details && (
        <div className="card" style={{ marginBottom: 24, border: '2px solid var(--green)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ margin: 0 }}>{details.business.name} — {formatMoney(details.business.balance)}</h3>
            <button className="btn btn-secondary" onClick={() => setSelectedBiz(null)}>✕</button>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            <button className="btn" onClick={() => setShowFund(true)}>📥 {t('business.fund_btn')}</button>
            <button className="btn" onClick={() => setShowPayLink(true)}>🔗 {t('business.link_btn')}</button>
            <button className="btn" onClick={() => setShowPayroll(true)}>💸 {t('business.payroll_btn')}</button>
            <button className="btn" onClick={() => setShowStaff(true)}>👥 {t('business.staff_btn')}</button>
          </div>

          {showFund && (
            <div className="card" style={{ background: '#f8fafc', marginBottom: 16 }}>
              <h4>{t('business.fund_btn')}</h4>
              <form onSubmit={fundBiz} style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
                <input type="number" min="1000" placeholder={t('business.amount_ph')} value={fundAmount} onChange={(e) => setFundAmount(e.target.value)} required style={{ flex: 1 }} />
                <button className="btn" type="submit">{t('business.save')}</button>
                <button className="btn btn-secondary" type="button" onClick={() => setShowFund(false)}>✕</button>
              </form>
            </div>
          )}

          {showPayLink && (
            <div className="card" style={{ background: '#f8fafc', marginBottom: 16 }}>
              <h4>{t('business.link_btn')}</h4>
              <form onSubmit={createPaymentLink} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                <input type="text" placeholder={t('business.title_ph')} value={linkForm.title} onChange={(e) => setLinkForm({ ...linkForm, title: e.target.value })} required />
                <input type="number" min="100" placeholder={t('business.amount_ph')} value={linkForm.amount} onChange={(e) => setLinkForm({ ...linkForm, amount: e.target.value })} required />
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="btn" type="submit">{t('business.save')}</button>
                  <button className="btn btn-secondary" type="button" onClick={() => setShowPayLink(false)}>✕</button>
                </div>
              </form>
            </div>
          )}

          {showPayroll && (
            <div className="card" style={{ background: '#f8fafc', marginBottom: 16 }}>
              <h4>{t('business.payroll_btn')}</h4>
              <form onSubmit={runPayroll} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                <input type="text" placeholder="2026-09" value={payrollForm.period} onChange={(e) => setPayrollForm({ ...payrollForm, period: e.target.value })} required />
                <textarea rows={4} value={payrollForm.employeesJson} onChange={(e) => setPayrollForm({ ...payrollForm, employeesJson: e.target.value })} required style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontFamily: 'monospace' }} />
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="btn" type="submit">{t('business.run_payroll')}</button>
                  <button className="btn btn-secondary" type="button" onClick={() => setShowPayroll(false)}>✕</button>
                </div>
              </form>
            </div>
          )}

          {showStaff && (
            <div className="card" style={{ background: '#f8fafc', marginBottom: 16 }}>
              <h4>{t('business.staff_btn')}</h4>
              <form onSubmit={addStaff} style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
                <input type="text" placeholder="2557..." value={staffForm.phone} onChange={(e) => setStaffForm({ ...staffForm, phone: e.target.value })} required style={{ flex: 1 }} />
                <select value={staffForm.role} onChange={(e) => setStaffForm({ ...staffForm, role: e.target.value })}><option value="CASHIER">Cashier</option><option value="MANAGER">Manager</option><option value="ACCOUNTANT">Accountant</option></select>
                <button className="btn" type="submit">{t('business.save')}</button>
                <button className="btn btn-secondary" type="button" onClick={() => setShowStaff(false)}>✕</button>
              </form>
            </div>
          )}

          <h4>{t('business.links_title')}</h4>
          <div style={{ overflowX: 'auto', marginBottom: 20 }}>
            {(!details.paymentLinks || details.paymentLinks.length === 0) ? (
              <p className="roles-tag">{t('business.no_links')}</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('business.link_title')}</th>
                    <th>{t('business.amount')}</th>
                    <th>{t('business.reference')}</th>
                    <th>{t('business.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {details.paymentLinks.map((pl) => (
                    <tr key={pl.id}>
                      <td><strong>{pl.title}</strong></td>
                      <td>{formatMoney(pl.amount)} {pl.currency}</td>
                      <td style={{ wordBreak: 'break-all' }}>{pl.reference}</td>
                      <td><span className={`badge ${pl.status === 'PAID' ? 'success' : 'info'}`}>{pl.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
