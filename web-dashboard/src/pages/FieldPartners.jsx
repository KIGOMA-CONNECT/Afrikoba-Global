import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'];
const DEFAULT_PURPOSE = 'GENERAL';

export default function FieldPartners() {
  const { t } = useT();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const isAdmin = user.role === 'ADMIN';
  const isStaff = user.role === 'ADMIN' || user.role === 'OPERATOR';
  const isPartner = user.role === 'FIELD_PARTNER';

  const [partners, setPartners] = useState([]);
  const [my, setMy] = useState(null);            // { partner, summary } partner console
  const [book, setBook] = useState([]);          // staff-selected or linked partner book
  const [myLoans, setMyLoans] = useState([]);
  const [selected, setSelected] = useState('');  // staff partner selector
  const [summary, setSummary] = useState(null);  // staff selected summary
  const [msg, setMsg] = useState({ type: '', text: '' });

  const [np, setNp] = useState({ name: '', countryCode: 'TZ', region: '', riskRating: 'LOW', phoneNumber: '', operatorName: '' });
  const [bind, setBind] = useState({ partnerId: '', userId: '' });
  const [fund, setFund] = useState({ partnerId: '', amount: '', reference: '' });
  const [loan, setLoan] = useState({ partnerId: '', borrowerUserId: '', amount: '', interestRate: '0', termMonths: '12', purpose: DEFAULT_PURPOSE });
  const [repayAmt, setRepayAmt] = useState({});
  const [selfRepayAmt, setSelfRepayAmt] = useState({});
  const [disbursing, setDisbursing] = useState(null);

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 5000);
  };

  const load = () => {
    api.get('/field-partners/my-loans').then((r) => setMyLoans(r.data.loans || [])).catch(() => {});
    if (isPartner) {
      api.get('/field-partners/my').then((r) => setMy(r.data)).catch(() => {});
      api.get('/field-partners/loans').then((r) => setBook(r.data.loans || [])).catch(() => {});
    }
    if (isStaff) {
      api.get('/field-partners/all').then((r) => setPartners(r.data.partners || [])).catch(() => {});
    }
  };

  useEffect(() => { load(); }, []);

  const loadSelectedBook = async (partnerId) => {
    if (!partnerId) { setBook([]); setSummary(null); return; }
    api.get(`/field-partners/${partnerId}/summary`).then((r) => setSummary(r.data.summary)).catch(() => {});
    api.get(`/field-partners/loans?partnerId=${partnerId}`).then((r) => setBook(r.data.loans || [])).catch(() => {});
  };

  const handleSelected = (id) => {
    setSelected(id);
    setLoan((prev) => ({ ...prev, partnerId: id }));
    setFund((prev) => ({ ...prev, partnerId: id }));
    setBind((prev) => ({ ...prev, partnerId: id }));
    loadSelectedBook(id);
  };

  const createPartner = async (e) => {
    e.preventDefault();
    try {
      await api.post('/field-partners', {
        name: np.name, countryCode: np.countryCode, region: np.region || undefined,
        riskRating: np.riskRating, phoneNumber: np.phoneNumber || undefined, operatorName: np.operatorName || undefined,
      });
      show('ok', t('fp.created'));
      setNp({ name: '', countryCode: 'TZ', region: '', riskRating: 'LOW', phoneNumber: '', operatorName: '' });
      load();
    } catch (err) { show('err', err.response?.data?.message || t('fp.error')); }
  };

  const bindUser = async (e) => {
    e.preventDefault();
    if (!bind.partnerId) { show('err', t('fp.pick_partner')); return; }
    try {
      await api.put(`/field-partners/${bind.partnerId}/bind-user`, { userId: Number(bind.userId) });
      show('ok', t('fp.bound'));
      setBind({ partnerId: '', userId: '' });
      load();
    } catch (err) { show('err', err.response?.data?.message || t('fp.error')); }
  };

  const fundPartner = async (e) => {
    e.preventDefault();
    if (!fund.partnerId) { show('err', t('fp.pick_partner')); return; }
    try {
      await api.post(`/field-partners/${fund.partnerId}/fund`, {
        amount: Number(fund.amount),
        reference: fund.reference || `FUND-${Date.now()}`,
      });
      show('ok', t('fp.funded'));
      setFund({ partnerId: '', amount: '', reference: '' });
      load();
      loadSelectedBook(fund.partnerId);
    } catch (err) { show('err', err.response?.data?.message || t('fp.error')); }
  };

  const createLoan = async (e) => {
    e.preventDefault();
    try {
      await api.post('/field-partners/loans', {
        partnerId: isPartner ? undefined : (loan.partnerId ? Number(loan.partnerId) : undefined),
        borrowerUserId: Number(loan.borrowerUserId), amount: Number(loan.amount),
        interestRate: Number(loan.interestRate || 0), termMonths: Number(loan.termMonths || 12),
        purpose: loan.purpose || DEFAULT_PURPOSE,
      });
      show('ok', t('fp.loan_created'));
      setLoan({ partnerId: isPartner ? '' : loan.partnerId, borrowerUserId: '', amount: '', interestRate: '0', termMonths: '12', purpose: DEFAULT_PURPOSE });
      load();
      loadSelectedBook(selected);
    } catch (err) { show('err', err.response?.data?.message || t('fp.error')); }
  };

  const disburse = async (id) => {
    setDisbursing(id);
    try {
      await api.post(`/field-partners/loans/${id}/disburse`, isPartner ? {} : (selected ? { partnerId: Number(selected) } : {}));
      show('ok', t('fp.disbursed'));
      load();
      loadSelectedBook(selected);
    } catch (err) { show('err', err.response?.data?.message || t('fp.error')); }
    finally { setDisbursing(null); }
  };

  const repay = async (id) => {
    const amount = Number(repayAmt[id]);
    if (!amount) { show('err', t('fp.enter_amount')); return; }
    try {
      await api.post(`/field-partners/loans/${id}/repay`, {
        amount,
        partnerId: isPartner ? undefined : (selected ? Number(selected) : undefined),
        note: 'web dashboard',
      });
      show('ok', t('fp.repaid'));
      setRepayAmt((prev) => ({ ...prev, [id]: '' }));
      load();
      loadSelectedBook(selected);
    } catch (err) { show('err', err.response?.data?.message || t('fp.error')); }
  };

  const selfRepay = async (id) => {
    const amount = Number(selfRepayAmt[id]);
    if (!amount) { show('err', t('fp.enter_amount')); return; }
    try {
      await api.post(`/field-partners/my-loans/${id}/repay`, { amount });
      show('ok', t('fp.repaid_self'));
      setSelfRepayAmt((prev) => ({ ...prev, [id]: '' }));
      load();
    } catch (err) { show('err', err.response?.data?.message || t('fp.error')); }
  };

  const loanRows = [...book].filter((l) => l.status === 'DISBURSED' || l.status === 'PENDING' || l.status === 'REPAID' || l.status === 'DEFAULTED');

  return (
    <div>
      <div className="page-head">
        <h2>{t('fp.title')}</h2>
        <p>{t('fp.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      {isAdmin && (
        <div className="grid grid-2">
          <div className="card">
            <h3>{t('fp.create_title')}</h3>
            <form onSubmit={createPartner}>
              <div className="field" style={{ marginBottom: 10 }}><label>{t('fp.name')}</label><input value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} required /></div>
              <div className="form-row">
                <div className="field"><label>{t('fp.country')}</label><input value={np.countryCode} onChange={(e) => setNp({ ...np, countryCode: e.target.value })} /></div>
                <div className="field"><label>{t('fp.region')}</label><input value={np.region} onChange={(e) => setNp({ ...np, region: e.target.value })} /></div>
                <div className="field"><label>{t('fp.risk')}</label>
                  <select value={np.riskRating} onChange={(e) => setNp({ ...np, riskRating: e.target.value })}>
                    {RISK_LEVELS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="field"><label>{t('fp.phone')}</label><input value={np.phoneNumber} onChange={(e) => setNp({ ...np, phoneNumber: e.target.value })} /></div>
                <div className="field"><label>{t('fp.operator')}</label><input value={np.operatorName} onChange={(e) => setNp({ ...np, operatorName: e.target.value })} /></div>
              </div>
              <button className="btn" type="submit">{t('fp.create_btn')}</button>
            </form>
          </div>

          <div className="card">
            <h3>{t('fp.bind_title')}</h3>
            <form onSubmit={bindUser}>
              <div className="field" style={{ marginBottom: 10 }}>
                <label>{t('fp.partner')}</label>
                <select value={bind.partnerId} onChange={(e) => setBind({ ...bind, partnerId: e.target.value })}>
                  <option value="">-- {t('sec.select')} --</option>
                  {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="field" style={{ marginBottom: 10 }}><label>{t('fp.bind_user')}</label><input type="number" min="1" value={bind.userId} onChange={(e) => setBind({ ...bind, userId: e.target.value })} required /></div>
              <button className="btn" type="submit">{t('fp.bind_btn')}</button>
            </form>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="card section">
          <h3>{t('fp.fund_title')}</h3>
          <form onSubmit={fundPartner}>
            <div className="form-row">
              <div className="field">
                <label>{t('fp.partner')}</label>
                <select value={fund.partnerId} onChange={(e) => setFund({ ...fund, partnerId: e.target.value })}>
                  <option value="">-- {t('sec.select')} --</option>
                  {partners.map((p) => <option key={p.id} value={p.id}>{p.name} ({formatMoney(p.available_balance)})</option>)}
                </select>
              </div>
              <div className="field"><label>{t('fp.amount')}</label><input type="number" min="1" value={fund.amount} onChange={(e) => setFund({ ...fund, amount: e.target.value })} required /></div>
              <div className="field"><label>{t('fp.ref')}</label><input value={fund.reference} onChange={(e) => setFund({ ...fund, reference: e.target.value })} placeholder={t('fp.ref_ph')} /></div>
            </div>
            <button className="btn" type="submit">{t('fp.fund_btn')}</button>
          </form>
        </div>
      )}

      {(isPartner || isStaff) && (
        <>
          {(my || summary) && (
            <div className="card section">
              <h3>{t('fp.summary_title')}</h3>
              <div className="grid grid-2">
                <div className="roles-tag">{t('fp.available')}: <strong>{formatMoney((my?.summary || summary)?.available_balance)}</strong></div>
                <div className="roles-tag">{t('fp.facilitated')}: <strong>{(my?.summary || summary)?.total_loans_facilitated || 0}</strong></div>
                <div className="roles-tag">{t('fp.active')}: <strong>{(my?.summary || summary)?.active_loans || 0}</strong></div>
                <div className="roles-tag">{t('fp.repaid')}: <strong>{(my?.summary || summary)?.repaid_loans || 0}</strong></div>
                <div className="roles-tag">{t('fp.pending')}: <strong>{(my?.summary || summary)?.pending_loans || 0}</strong></div>
                <div className="roles-tag">{t('fp.defaulted')}: <strong>{(my?.summary || summary)?.defaulted_loans || 0}</strong></div>
                <div className="roles-tag">{t('fp.outstanding')}: <strong>{formatMoney((my?.summary || summary)?.outstanding_principal)}</strong></div>
              </div>
            </div>
          )}

          {isStaff && (
            <div className="card section">
              <h3>{t('fp.book_title')}</h3>
              <div className="field" style={{ marginBottom: 10 }}>
                <label>{t('fp.partner')}</label>
                <select value={selected} onChange={(e) => handleSelected(e.target.value)}>
                  <option value="">-- {t('sec.select')} --</option>
                  {partners.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.risk_rating})</option>)}
                </select>
              </div>
              {!selected && <p className="roles-tag">{t('fp.pick_partner')}</p>}
            </div>
          )}

          <div className="grid grid-2">
            <div className="card">
              <h3>{t('fp.create_loan_title')}</h3>
              <form onSubmit={createLoan}>
                {isStaff && (
                  <div className="field" style={{ marginBottom: 10 }}>
                    <label>{t('fp.partner')}</label>
                    <select value={loan.partnerId} onChange={(e) => setLoan({ ...loan, partnerId: e.target.value })}>
                      <option value="">-- {t('sec.select')} --</option>
                      {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                )}
                <div className="field" style={{ marginBottom: 10 }}><label>{t('fp.borrower')}</label><input type="number" min="1" value={loan.borrowerUserId} onChange={(e) => setLoan({ ...loan, borrowerUserId: e.target.value })} required /></div>
                <div className="form-row">
                  <div className="field"><label>{t('fp.amount')}</label><input type="number" min="1" value={loan.amount} onChange={(e) => setLoan({ ...loan, amount: e.target.value })} required /></div>
                  <div className="field"><label>{t('fp.interest')}</label><input type="number" min="0" step="0.1" value={loan.interestRate} onChange={(e) => setLoan({ ...loan, interestRate: e.target.value })} /></div>
                  <div className="field"><label>{t('fp.term')}</label><input type="number" min="1" value={loan.termMonths} onChange={(e) => setLoan({ ...loan, termMonths: e.target.value })} /></div>
                </div>
                <div className="field" style={{ marginBottom: 10 }}><label>{t('fp.purpose')}</label><input value={loan.purpose} onChange={(e) => setLoan({ ...loan, purpose: e.target.value })} /></div>
                <button className="btn" type="submit">{t('fp.create_loan_btn')}</button>
              </form>
            </div>
          </div>

          <div className="card section">
            <h3>{t('fp.loans_title')}</h3>
            {book.length === 0 && <p className="roles-tag">{t('fp.no_loans')}</p>}
            <table>
              <thead><tr><th>{t('fp.loan_ref')}</th><th>{t('fp.borrower_name')}</th><th>{t('fp.amount')}</th><th>{t('fp.due')}</th><th>{t('fp.status')}</th><th></th></tr></thead>
              <tbody>
                {book.map((l) => (
                  <tr key={l.id}>
                    <td>{l.loan_reference}</td>
                    <td>{l.borrower_name || '-'}</td>
                    <td>{formatMoney(l.amount)} <div className="roles-tag">{formatMoney(l.total_due)} {t('fp.t_due')}</div></td>
                    <td>{l.disbursed_at ? new Date(l.disbursed_at).toLocaleDateString() : '-'}</td>
                    <td><StatusBadge status={l.status} /></td>
                    <td>
                      <div className="inline-actions">
                        {(l.status === 'PENDING') && (
                          <button className="btn warn" disabled={disbursing === l.id} onClick={() => disburse(l.id)}>{t('fp.disburse')}</button>
                        )}
                        {l.status === 'DISBURSED' && (
                          <>
                            <input type="number" min="1" placeholder={t('fp.repay_amt_ph')} value={repayAmt[l.id] || ''} onChange={(e) => setRepayAmt((prev) => ({ ...prev, [l.id]: e.target.value }))} style={{ width: 110 }} />
                            <button className="btn" onClick={() => repay(l.id)}>{t('fp.repay')}</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="card section">
        <h3>{t('fp.my_loans_title')}</h3>
        {myLoans.length === 0 && <p className="roles-tag">{t('fp.no_my_loans')}</p>}
        <table>
          <thead><tr><th>{t('fp.partner')}</th><th>{t('fp.loan_ref')}</th><th>{t('fp.amount')}</th><th>{t('fp.due')}</th><th>{t('fp.status')}</th><th></th></tr></thead>
          <tbody>
            {myLoans.map((l) => (
              <tr key={l.id}>
                <td>{l.partner_name}</td>
                <td>{l.loan_reference}</td>
                <td>{formatMoney(l.amount)} <div className="roles-tag">{formatMoney(l.total_due)} {t('fp.t_due')}</div></td>
                <td>{l.disbursed_at ? new Date(l.disbursed_at).toLocaleDateString() : '-'}</td>
                <td><StatusBadge status={l.status} /></td>
                <td>
                  {l.status === 'DISBURSED' && (
                    <div className="inline-actions">
                      <input type="number" min="1" placeholder={t('fp.repay_amt_ph')} value={selfRepayAmt[l.id] || ''} onChange={(e) => setSelfRepayAmt((prev) => ({ ...prev, [l.id]: e.target.value }))} style={{ width: 110 }} />
                      <button className="btn" onClick={() => selfRepay(l.id)}>{t('fp.repay_btn')}</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}