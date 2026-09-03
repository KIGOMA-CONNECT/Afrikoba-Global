import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

const STATUS_BADGE = {
  PENDING: 'warning',
  APPROVED: 'info',
  ACTIVE: 'success',
  REPAID: 'success',
  REJECTED: 'danger',
};

function formatMoney(v) {
  const n = Number(v) || 0;
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export default function Loans() {
  const { t } = useT();
  const [loans, setLoans] = useState([]);
  const [score, setScore] = useState(null);
  const [showApply, setShowApply] = useState(false);
  const [showGuarantor, setShowGuarantor] = useState(false);
  const [guarantorLoan, setGuarantorLoan] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [scheduleLoan, setScheduleLoan] = useState(null);
  const [form, setForm] = useState({ amount: '', term_months: '12', interest_rate: '5' });
  const [gPhone, setGPhone] = useState('');
  const [msg, setMsg] = useState({ type: '', text: '' });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('loans.error') });

  const load = () => {
    api.get('/credit/loans').then((r) => setLoans(r.data.loans || [])).catch(() => {});
    api.get('/credit/score').then((r) => setScore(r.data.result || null)).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const apply = async (e) => {
    e.preventDefault();
    try {
      await api.post('/credit/loans', { amount: form.amount, term_months: form.term_months, interest_rate: form.interest_rate });
      setMsg({ type: 'ok', text: t('loans.applied_ok') });
      setShowApply(false);
      setForm({ amount: '', term_months: '12', interest_rate: '5' });
      load();
    } catch (err) { error(err); }
  };

  const viewSchedule = async (loanId) => {
    try {
      const r = await api.get(`/credit/loans/${loanId}/schedule`);
      setSchedule(r.data.schedule || []);
      setScheduleLoan(loanId);
    } catch (err) { error(err); }
  };

  const payInstallment = async (loanId, iid) => {
    try {
      await api.post(`/credit/loans/${loanId}/installments/${iid}/pay`);
      setMsg({ type: 'ok', text: t('loans.installment_ok') });
      setSchedule(null);
      setScheduleLoan(null);
      load();
    } catch (err) { error(err); }
  };

  const payoff = async (loanId) => {
    try {
      await api.post(`/credit/loans/${loanId}/payoff`);
      setMsg({ type: 'ok', text: t('loans.payoff_ok') });
      setSchedule(null);
      setScheduleLoan(null);
      load();
    } catch (err) { error(err); }
  };

  const openGuarantor = (loanId) => {
    setGuarantorLoan(loanId);
    setGPhone('');
    setShowGuarantor(true);
  };

  const addGuarantor = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/credit/loans/${guarantorLoan}/guarantors`, { phone: gPhone });
      setMsg({ type: 'ok', text: t('loans.guarantor_ok') });
      setShowGuarantor(false);
    } catch (err) { error(err); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>{t('loans.title')}</h2>
        <p>{t('loans.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      {/* Credit limit card */}
      <div className="card" style={{ marginBottom: 24, background: 'linear-gradient(135deg,#0f172a,#1e293b)', color: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <p style={{ margin: 0, opacity: 0.8 }}>{t('loans.available_credit')}</p>
            <h2 style={{ margin: '4px 0 0', fontSize: 30 }}>{formatMoney(score?.credit_limit || 0)} TSh</h2>
          </div>
          <div>
            <p style={{ margin: 0, opacity: 0.8 }}>{t('loans.credit_score')}</p>
            <h2 style={{ margin: '4px 0 0', fontSize: 30 }}>{score?.score ?? '—'}</h2>
          </div>
          <button className="btn" onClick={() => setShowApply(true)}>＋ {t('loans.apply_btn')}</button>
        </div>
      </div>

      {showApply && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('loans.apply_title')}</h3>
          <form onSubmit={apply} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('loans.amount')}
              <input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required placeholder="e.g. 500000" />
            </label>
            <label>{t('loans.term')}
              <select value={form.term_months} onChange={(e) => setForm({ ...form, term_months: e.target.value })}>
                {[1, 3, 6, 9, 12, 18, 24].map((m) => <option key={m} value={m}>{m} {t('loans.months')}</option>)}
              </select>
            </label>
            <label>{t('loans.interest')}
              <input type="number" step="0.1" value={form.interest_rate} onChange={(e) => setForm({ ...form, interest_rate: e.target.value })} />
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('loans.submit')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowApply(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      {showGuarantor && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('loans.guarantor_title')}</h3>
          <form onSubmit={addGuarantor} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('loans.guarantor_phone')}
              <input type="text" value={gPhone} onChange={(e) => setGPhone(e.target.value)} required placeholder="255700000000" />
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('loans.submit')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowGuarantor(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      {/* Loans list */}
      <h3 style={{ margin: '0 0 14px' }}>{t('loans.my_loans')}</h3>
      <div className="card" style={{ marginBottom: 24 }}>
        {loans.length === 0 ? (
          <p className="roles-tag">{t('loans.no_loans')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{t('loans.amount')}</th>
                  <th>{t('loans.interest')}</th>
                  <th>{t('loans.term')}</th>
                  <th>{t('loans.status')}</th>
                  <th>{t('loans.due')}</th>
                  <th>{t('loans.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {loans.map((l) => (
                  <tr key={l.id}>
                    <td><strong>#{l.id}</strong></td>
                    <td>{formatMoney(l.amount)}</td>
                    <td>{l.interest_rate}%</td>
                    <td>{l.term_months} {t('loans.months')}</td>
                    <td><span className={`badge ${STATUS_BADGE[l.status] || 'info'}`}>{l.status}</span></td>
                    <td>{l.status === 'ACTIVE' ? formatMoney(l.due_amount) : '—'}</td>
                    <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => viewSchedule(l.id)}>{t('loans.schedule_btn')}</button>
                      {l.status === 'ACTIVE' && (
                        <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => payoff(l.id)}>{t('loans.payoff_btn')}</button>
                      )}
                      {l.status === 'PENDING' && (
                        <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => openGuarantor(l.id)}>{t('loans.guarantor_btn')}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Schedule */}
      {scheduleLoan && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>{t('loans.schedule_title')} #{scheduleLoan}</h3>
            <button className="btn btn-secondary" onClick={() => setSchedule(null)}>✕</button>
          </div>
          {!schedule || schedule.length === 0 ? (
            <p className="roles-tag">{t('loans.no_schedule')}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t('loans.due_date')}</th>
                    <th>{t('loans.amount')}</th>
                    <th>{t('loans.status')}</th>
                    <th>{t('loans.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((s) => (
                    <tr key={s.id}>
                      <td>{s.sequence}</td>
                      <td>{new Date(s.due_date).toLocaleDateString()}</td>
                      <td>{formatMoney(s.amount)}</td>
                      <td><span className={`badge ${s.status === 'PAID' ? 'success' : 'warning'}`}>{s.status}</span></td>
                      <td>
                        {s.status === 'PENDING' ? (
                          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => payInstallment(scheduleLoan, s.id)}>{t('loans.pay_btn')}</button>
                        ) : <span style={{ fontSize: 12, color: '#16a34a' }}>✓</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}