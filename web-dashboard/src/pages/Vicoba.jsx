import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import ServiceLock from '../components/ServiceLock.jsx';
import { useT } from '../i18n/LangProvider.jsx';

const LEADER_ROLES = ['MWENYEKITI', 'MWEKAHAZINA', 'KATIBU'];

export default function Vicoba() {
  const { t } = useT();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const [groups, setGroups] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loans, setLoans] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const [gName, setGName] = useState('');
  const [gCycle, setGCycle] = useState('MONTHLY');
  const [gShare, setGShare] = useState('');
  const [gFee, setGFee] = useState('');

  const [contributeAmt, setContributeAmt] = useState('');
  const [contributeShares, setContributeShares] = useState('1');
  const [newMemberId, setNewMemberId] = useState('');

  const [loanApplicant, setLoanApplicant] = useState('');
  const [loanAmount, setLoanAmount] = useState('');
  const [loanInterest, setLoanInterest] = useState('10');
  const [loanMonths, setLoanMonths] = useState('3');
  const [approveAmount, setApproveAmount] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [invitePhones, setInvitePhones] = useState('');

  const [pCycle, setPCycle] = useState('1');
  const [pProfit, setPProfit] = useState('');
  const [profitCalc, setProfitCalc] = useState(null);
  const [distributions, setDistributions] = useState([]);
  const [myPayouts, setMyPayouts] = useState([]);
  const [invitations, setInvitations] = useState([]);

  const [constitution, setConstitution] = useState(null);
  const [attendance, setAttendance] = useState(null);
  const [finReport, setFinReport] = useState(null);
  const [withdrawals, setWithdrawals] = useState([]);
  const [wdAmt, setWdAmt] = useState('');
  const [bonuses, setBonuses] = useState([]);
  const [bonusForm, setBonusForm] = useState({ amount: '', purpose: '' });
  const [penalties, setPenalties] = useState([]);
  const [socialFund, setSocialFund] = useState(null);
  const [shareBook, setShareBook] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [sFundMonthly, setSFundMonthly] = useState('');
  const [sMonth, setSMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [sReqType, setSReqType] = useState('FUNERAL');
  const [sReqDetail, setSReqDetail] = useState('');
  const [sReqAmount, setSReqAmount] = useState('');
  const [loanExtra, setLoanExtra] = useState({});
  const [repayMap, setRepayMap] = useState({});

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 5000);
  };

  const loadGroups = () => {
    api.get('/vicoba/groups').then((r) => setGroups(r.data.groups)).catch(() => {});
  };

  const loadInvites = () => {
    api.get('/vicoba/invitations').then((r) => setInvitations(r.data.invitations || [])).catch(() => { setInvitations([]); });
  };

  const acceptInvite = async (id) => {
    try {
      const res = await api.post(`/vicoba/invitations/${id}/accept`);
      show('ok', res.data.message || 'Umejiunga na kikundi.');
      setInvitations([]);
      loadGroups();
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const rejectInvite = async (id) => {
    try {
      await api.post(`/vicoba/invitations/${id}/reject`);
      show('ok', 'Umekataa mwaliko.');
      setInvitations((prev) => prev.filter((i) => i.id !== id));
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  useEffect(() => {
    loadGroups();
    loadInvites();
  }, []);

  const selectGroup = (g) => {
    setSelected(g);
    api.get(`/vicoba/groups/${g.id}`).then((r) => setSelected(r.data.group)).catch(() => {});
    api.get(`/vicoba/groups/${g.id}/loans`).then((r) => setLoans(r.data.loans)).catch(() => {});
    api.get(`/vicoba/groups/${g.id}/profits`).then((r) => setDistributions(r.data.distributions)).catch(() => { setDistributions([]); });
    api.get('/vicoba/profits/my').then((r) => setMyPayouts(r.data.payouts)).catch(() => setMyPayouts([]));
    api.get(`/vicoba/groups/${g.id}/constitution`).then((r) => setConstitution(r.data.constitution || r.data)).catch(() => setConstitution(null));
    api.get(`/vicoba/groups/${g.id}/attendance/report`).then((r) => setAttendance(r.data.report)).catch(() => setAttendance(null));
    api.get(`/vicoba/groups/${g.id}/reports/financial`).then((r) => setFinReport(r.data.summary)).catch(() => setFinReport(null));
    api.get(`/vicoba/groups/${g.id}/withdrawals`).then((r) => setWithdrawals(r.data.withdrawals || [])).catch(() => setWithdrawals([]));
    api.get(`/vicoba/groups/${g.id}/bonuses`).then((r) => setBonuses(r.data.bonuses || [])).catch(() => setBonuses([]));
    api.get(`/vicoba/groups/${g.id}/penalties?status=ALL`).then((r) => setPenalties(r.data.penalties || [])).catch(() => setPenalties([]));
    api.get(`/vicoba/groups/${g.id}/social-fund`).then((r) => setSocialFund(r.data.fund || r.data)).catch(() => setSocialFund(null));
    api.get(`/vicoba/groups/${g.id}/shares`).then((r) => setShareBook(r.data.purchases || r.data.shares || [])).catch(() => setShareBook([]));
    setShowArchived(false);
    loadTx(g.id, 0, false);
  };

  const loadTx = (gid, offset, archived) => {
    api.get(`/vicoba/groups/${gid}/transactions?limit=25&offset=${offset}`).then((r) => {
      setTransactions((prev) => (offset === 0 ? (r.data.transactions || []) : prev.concat(r.data.transactions || [])));
      setShowArchived(archived);
    }).catch(() => {});
  };

  const loadMoreTx = () => {
    const next = showArchived ? transactions.length : 25;
    loadTx(selected.id, next, true);
  };

  const createGroup = async (e) => {
    e.preventDefault();
    try {
      await api.post('/vicoba/groups', {
        groupName: gName, cycleType: gCycle, shareValue: gShare, monthlyMaintenanceFee: gFee || undefined,
      });
      show('ok', t('vicoba.group_created'));
      setGName(''); setGShare(''); setGFee('');
      loadGroups();
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const contribute = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post(`/vicoba/groups/${selected.id}/contribute`, {
        amount: contributeAmt, sharesCount: contributeShares,
      });
      show('ok', res.data.message);
      setContributeAmt('');
      selectGroup(selected);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const addMember = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/vicoba/groups/${selected.id}/members`, { userId: newMemberId });
      show('ok', t('vicoba.member_added'));
      setNewMemberId('');
      selectGroup(selected);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const joinByCode = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/vicoba/groups/join', { joinCode });
      show('ok', res.data.message);
      setJoinCode('');
      loadGroups();
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const invite = async (e) => {
    e.preventDefault();
    try {
      const phones = invitePhones.split(',').map((p) => p.trim()).filter(Boolean);
      const res = await api.post(`/vicoba/groups/${selected.id}/invite`, { phoneNumbers: phones });
      show('ok', `Mialiko ${res.data.invited} imetumwa kwa SMS. Msimbo wa kikundi: ${res.data.joinCode}`);
      setInvitePhones('');
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const addLoan = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/vicoba/groups/${selected.id}/loans`, {
        applicantUserId: loanApplicant, requestedAmount: loanAmount,
        interestRate: loanInterest, repaymentMonths: loanMonths,
      });
      show('ok', t('vicoba.loan_added'));
      setLoanApplicant(''); setLoanAmount('');
      api.get(`/vicoba/groups/${selected.id}/loans`).then((r) => setLoans(r.data.loans)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const approve = async (loanId) => {
    try {
      const res = await api.post(`/vicoba/loans/${loanId}/approve`, {
        approvedAmount: approveAmount || undefined,
      });
      show('ok', res.data.message);
      selectGroup(selected);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const myRole = selected?.role_in_group || '';

  const calculateProfit = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post(`/vicoba/groups/${selected.id}/profits/calculate`, {
        cycleNumber: pCycle, totalProfit: pProfit,
      });
      setProfitCalc(res.data);
      show('ok', t('vicoba.profit_calculated'));
      const dl = await api.get(`/vicoba/groups/${selected.id}/profits`).then((r) => r.data.distributions);
      setDistributions(dl);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const approveProfit = async (distId) => {
    try {
      const res = await api.post(`/vicoba/profits/${distId}/approve`);
      show('ok', res.data.message);
      setProfitCalc(null);
      const dl = await api.get(`/vicoba/groups/${selected.id}/profits`).then((r) => r.data.distributions);
      setDistributions(dl);
      api.get('/vicoba/profits/my').then((r) => setMyPayouts(r.data.payouts)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const canApprove = myRole === 'MWEKAHAZINA' || myRole === 'KATIBU';
  const canAddLoan = LEADER_ROLES.includes(myRole);
  const isLeader = LEADER_ROLES.includes(myRole);

  const requestWithdrawal = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post(`/vicoba/groups/${selected.id}/withdrawals`, { amount: wdAmt });
      show('ok', res.data.message);
      setWdAmt('');
      api.get(`/vicoba/groups/${selected.id}/withdrawals`).then((r) => setWithdrawals(r.data.withdrawals || [])).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const decideWithdrawal = async (wdId, approved) => {
    try {
      const res = await api.post(`/vicoba/withdrawals/${wdId}/approve`, { approved, note: approved ? '' : 'Imekataliwa' });
      show('ok', res.data.message);
      api.get(`/vicoba/groups/${selected.id}/withdrawals`).then((r) => setWithdrawals(r.data.withdrawals || [])).catch(() => {});
      api.get(`/vicoba/groups/${selected.id}/reports/financial`).then((r) => setFinReport(r.data.summary)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const submitBonus = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post(`/vicoba/groups/${selected.id}/bonus`, bonusForm);
      show('ok', res.data.message);
      setBonusForm({ amount: '', purpose: '' });
      api.get(`/vicoba/groups/${selected.id}/bonuses`).then((r) => setBonuses(r.data.bonuses || [])).catch(() => {});
      api.get(`/vicoba/groups/${selected.id}/reports/financial`).then((r) => setFinReport(r.data.summary)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const payPenalty = async (pid) => {
    try {
      await api.post(`/vicoba/penalties/${pid}/pay`);
      show('ok', 'Faini imelipwa.');
      api.get(`/vicoba/groups/${selected.id}/penalties?status=ALL`).then((r) => setPenalties(r.data.penalties || [])).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const waivePenalty = async (pid) => {
    try {
      await api.post(`/vicoba/penalties/${pid}/waive`);
      show('ok', 'Faini imesahaulishwa.');
      api.get(`/vicoba/groups/${selected.id}/penalties?status=ALL`).then((r) => setPenalties(r.data.penalties || [])).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const initSocialFund = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post(`/vicoba/groups/${selected.id}/social-fund`, { monthlyContribution: sFundMonthly });
      show('ok', res.data.message);
      setSFundMonthly('');
      api.get(`/vicoba/groups/${selected.id}/social-fund`).then((r) => setSocialFund(r.data.fund || r.data)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const contributeSocial = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/vicoba/groups/${selected.id}/social-fund/contribute`, { month: sMonth });
      show('ok', 'Michango ya mfuko imepokelewa.');
      api.get(`/vicoba/groups/${selected.id}/social-fund`).then((r) => setSocialFund(r.data.fund || r.data)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const requestSocial = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post(`/vicoba/groups/${selected.id}/social-fund/request`, {
        reasonType: sReqType, reasonDetail: sReqDetail, requestedAmount: sReqAmount,
      });
      show('ok', res.data.message);
      setSReqDetail(''); setSReqAmount('');
      api.get(`/vicoba/groups/${selected.id}/social-fund`).then((r) => setSocialFund(r.data.fund || r.data)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const decideSocial = async (reqId, decision, approvedAmount) => {
    try {
      const res = await api.post(`/vicoba/social-fund-requests/${reqId}/${decision}`, approvedAmount ? { approvedAmount } : {});
      show('ok', res.data.message);
      api.get(`/vicoba/groups/${selected.id}/social-fund`).then((r) => setSocialFund(r.data.fund || r.data)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const toggleLoanExtra = (loan) => {
    if (loanExtra[loan.id]) { setLoanExtra((p) => ({ ...p, [loan.id]: undefined })); return; }
    Promise.all([
      api.get(`/vicoba/loans/${loan.id}/schedule`).then((r) => r.data.schedule || []).catch(() => []),
      api.get(`/vicoba/loans/${loan.id}/repayments`).then((r) => r.data.repayments || []).catch(() => []),
    ]).then(([schedule, payments]) => setLoanExtra((p) => ({ ...p, [loan.id]: { schedule, payments } })));
  };

  const repayLoanRow = async (loanId) => {
    const amt = repayMap[loanId];
    if (!amt) { show('err', 'Weka kiasi cha malipo.'); return; }
    try {
      const res = await api.post(`/vicoba/loans/${loanId}/repay`, { amount: amt });
      show('ok', res.data.message);
      setRepayMap((p) => ({ ...p, [loanId]: '' }));
      api.get(`/vicoba/groups/${selected.id}/loans`).then((r) => setLoans(r.data.loans)).catch(() => {});
      if (loanExtra[loanId]) toggleLoanExtra({ id: loanId });
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const members = selected?.members || [];
  const leadership = LEADER_ROLES.map((r) => members.find((m) => m.role_in_group === r)).filter(Boolean);
  const totalShares = members.reduce((s, m) => s + Number(m.total_shares || 0), 0);
  const totalContrib = members.reduce((s, m) => s + Number(m.contribution_balance || 0), 0);

  const printDocs = () => {
    const win = window.open('', '_blank');
    if (!win) return;
    const roleName = selected?.role_in_group || 'MWANACHAMA';
    win.document.write(`<!doctype html><html><head><title>${selected?.group_name} - Nyaraka</title><style>body{font-family:sans-serif;max-width:720px;margin:30px auto;padding:0 16px;color:#111}table{border-collapse:collapse;width:100%;margin:14px 0}th,td{border:1px solid #999;padding:8px;font-size:13px;text-align:left}th{background:#f2f2f2}h1{font-size:22px}h2{font-size:16px;border-bottom:1px solid #ccc;padding-bottom:4px}</style></head><body><h1>${selected?.group_name}</h1><p>Mzunguko: ${selected?.cycle_type} · Msimbo: ${selected?.join_code || '-'} · Wajibu Wako: ${roleName}</p><h2>Wanachama</h2><table><tr><th>Jina</th><th>Namba</th><th>Wajibu</th><th>Hisa</th><th>Michango</th></tr>${members.map((m) => `<tr><td>${m.full_name || ''}</td><td>${m.phone_number || ''}</td><td>${m.role_in_group || ''}</td><td>${m.total_shares || 0}</td><td>${formatMoney(m.contribution_balance)}</td></tr>`).join('')}</table>${constitution && Object.keys(constitution).length > 0 ? `<h2>Katiba / Nyaraka</h2><pre style="white-space:pre-wrap;font-size:12px">${JSON.stringify(constitution, null, 2)}</pre>` : ''}</body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 350);
  };

  const sectionNav = (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const sections = [
    { id: 'vicoba-dash', key: 'vicoba.dashboard' },
    { id: 'vicoba-members', key: 'vicoba.members_section' },
    { id: 'vicoba-tx', key: 'vicoba.transactions' },
    { id: 'vicoba-books', key: 'vicoba.books' },
    { id: 'vicoba-withdraw', key: 'vicoba.withdraw_section' },
    { id: 'vicoba-penalty', key: 'vicoba.penalty_section' },
    { id: 'vicoba-loans', key: 'vicoba.loans_section' },
    { id: 'vicoba-report', key: 'vicoba.reports_section' },
    { id: 'vicoba-meetings', key: 'vicoba.meetings_section' },
    { id: 'vicoba-docs', key: 'vicoba.docs' },
    { id: 'vicoba-leadership', key: 'vicoba.leadership' },
  ];

  const txKindLabel = (kind) => {
    const map = {
      CONTRIBUTION: t('vicoba.tx_contribution'),
      LOAN_REPAYMENT: t('vicoba.tx_loan_repayment'),
      PENALTY: t('vicoba.tx_penalty'),
      SHARE_PURCHASE: t('vicoba.tx_share_purchase'),
      DIVIDEND: t('vicoba.tx_dividend'),
      SOCIAL_FUND: t('vicoba.tx_social_fund'),
      WITHDRAWAL: t('vicoba.tx_withdrawal'),
    };
    return map[kind] || kind;
  };

  const myMember = members.find((m) => Number(m.user_id) === Number(user.id));
  const filteredMembers = members.filter((m) => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return true;
    return String(m.full_name || '').toLowerCase().includes(q) || String(m.phone_number || '').includes(q);
  });
  const canSignWd = myRole === 'MWENYEKITI' || myRole === 'MWEKAHAZINA';

  return (
    <ServiceLock serviceKey="VICOBA">
      <div className="page-head">
        <h2>{t('vicoba.title')}</h2>
        <p>{t('vicoba.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      {invitations.length > 0 && (
        <div className="card section" style={{ marginBottom: 14 }}>
          <h3>Mialiko ya kujiunga (<strong>{invitations.length}</strong>)</h3>
          <div className="grid grid-2" style={{ gap: 8 }}>
            {invitations.map((i) => (
              <div key={i.id} className="list-item">
                <div>
                  <strong>{i.group_name}</strong>
                  <div className="roles-tag">{i.cycle_type} · {t('vicoba.share')} {formatMoney(i.share_value)} · Wanachama: {i.member_count}</div>
                  <div style={{ opacity: 0.7, fontSize: 12 }}>Umealikwa {String(i.created_at).slice(0, 10)}</div>
                </div>
                <div className="inline-actions">
                  <button className="btn" onClick={() => acceptInvite(i.id)}>{t('vicoba.accept')}</button>
                  <button className="btn warn" onClick={() => rejectInvite(i.id)}>{t('vicoba.reject')}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3>{t('vicoba.groups')}</h3>
          {groups.length === 0 && <p className="roles-tag">{t('vicoba.no_groups')}</p>}
          {groups.map((g) => (
            <div key={g.id} className="inline-actions" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div>
                <strong>{g.group_name}</strong>
                <div className="roles-tag">{g.cycle_type} · {t('vicoba.share')} {formatMoney(g.share_value)} · Wewe: {g.role_in_group}</div>
              </div>
              <button className="btn ghost" onClick={() => selectGroup(g)}>{t('vicoba.open')}</button>
            </div>
          ))}
        </div>

        <div className="card">
          <h3>{t('vicoba.create_group')}</h3>
          <form className="form-row" onSubmit={createGroup}>
            <div className="field"><label>{t('vicoba.name')}</label><input value={gName} onChange={(e) => setGName(e.target.value)} required /></div>
            <div className="field"><label>{t('vicoba.cycle')}</label>
              <select value={gCycle} onChange={(e) => setGCycle(e.target.value)}>
                <option value="WEEKLY">Wiki</option><option value="MONTHLY">Mwezi</option>
              </select>
            </div>
            <div className="field"><label>{t('vicoba.share')}</label><input type="number" value={gShare} onChange={(e) => setGShare(e.target.value)} required /></div>
            <div className="field"><label>{t('vicoba.fee')}</label><input type="number" value={gFee} onChange={(e) => setGFee(e.target.value)} /></div>
            <button className="btn" type="submit">{t('vicoba.create_btn')}</button>
          </form>

          <h3 style={{ marginTop: 18 }}>{t('vicoba.join_code')}</h3>
          <form className="form-row" onSubmit={joinByCode}>
            <div className="field">
              <label>{t('vicoba.join_code_prompt')}</label>
              <input value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="e.g. C9C9BDE7" required />
            </div>
            <button className="btn ghost" type="submit">{t('vicoba.join_btn')}</button>
          </form>
        </div>
      </div>

      {selected && (
        <div className="card section">
          <div className="inline-actions" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <h3 style={{ margin: 0 }}>{selected.group_name}
              {selected.join_code && <span className="roles-tag" style={{ marginLeft: 12 }}>{t('vicoba.code')}: <strong>{selected.join_code}</strong></span>}
              <span className="roles-tag" style={{ marginLeft: 8 }}>{t('vicoba.status')}: <StatusBadge status={selected.status} /></span>
            </h3>
            <div className="inline-actions" style={{ gap: 6, flexWrap: 'wrap' }}>
              {sections.map((s) => (
                <button key={s.id} className="btn ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => sectionNav(s.id)}>{t(s.key)}</button>
              ))}
            </div>
          </div>

          <section id="vicoba-dash">
            <div className="grid grid-2" style={{ margin: '14px 0', alignItems: 'stretch' }}>
              <div className="card" style={{ margin: 0 }}>
                <div className="value" style={{ fontSize: 30 }}>{formatMoney(selected.group_wallet_balance)}</div>
                <div className="label">Group Balance · {t('vicoba.balance_as_of')}</div>
                <div className="inline-actions" style={{ gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
                  <span className="roles-tag"><strong>{members.length}</strong> · {t('vicoba.members_count')}</span>
                  {myMember && <span className="roles-tag">{t('vicoba.wd_my_avail')} <strong>{formatMoney(myMember.contribution_balance)}</strong></span>}
                </div>
              </div>
              <div className="card" style={{ margin: 0 }}>
                <h3 style={{ marginTop: 0 }}>{t('vicoba.leaders_table')}</h3>
                {leadership.map((m) => (
                  <div key={m.user_id} className="list-item" style={{ padding: '4px 0' }}>
                    <div>
                      <strong>{m.full_name}</strong> — <span className="roles-tag">{m.role_in_group}</span>
                      <div className="roles-tag">{m.phone_number}</div>
                    </div>
                  </div>
                ))}
                {leadership.length === 0 && <p className="roles-tag">{t('vicoba.no_docs')}</p>}
              </div>
            </div>

            <div className="grid grid-2" style={{ margin: '14px 0', alignItems: 'stretch' }}>
              <div className="card" style={{ margin: 0 }}>
                <h3 style={{ marginTop: 0 }}>{t('vicoba.meta')}</h3>
                <table>
                  <tbody>
                    <tr><th>HISARI (MICHANGO)</th><td>{formatMoney(finReport?.total_contributions || 0)}</td></tr>
                    <tr><th>MAREJESHO</th><td>{formatMoney(finReport?.total_loan_repayments || 0)}</td></tr>
                    <tr><th>UTOAJI</th><td>{formatMoney(finReport?.total_withdrawals_disbursed || 0)}</td></tr>
                    <tr><th>MIFUKO YA JAMII</th><td>{formatMoney(finReport?.social_fund_balance || 0)}</td></tr>
                    <tr><th>FAINI ZILIZOLIPWA</th><td>{formatMoney(finReport?.penalties_collected || 0)}</td></tr>
                    <tr><th>BONUS</th><td>{formatMoney(finReport?.total_bonus || 0)}</td></tr>
                    <tr><th>MGAWO WA FAIDA</th><td>{formatMoney(finReport?.total_profits_distributed || 0)}</td></tr>
                  </tbody>
                </table>
              </div>
              <div className="card" style={{ margin: 0 }}>
                <h3 style={{ marginTop: 0 }}>{t('vicoba.settings_table')}</h3>
                <table>
                  <tbody>
                    <tr><th>{t('vicoba.name')}</th><td>{selected.group_name}</td></tr>
                    <tr><th>{t('vicoba.members_count')}</th><td>{members.length}</td></tr>
                    <tr><th>{t('vicoba.share')}</th><td>{formatMoney(selected.share_value)}</td></tr>
                    <tr><th>RIBA</th><td>{constitution?.loan_interest_rate != null ? `${constitution.loan_interest_rate}%` : '—'}</td></tr>
                    <tr><th>HISA MOJA KWA MWEZI</th><td>{formatMoney(selected.monthly_maintenance_fee)}</td></tr>
                    <tr><th>MIFUKO YA JAMII (KWA MWANACHAMA)</th><td>{socialFund?.fund?.monthly_contribution != null ? formatMoney(socialFund.fund.monthly_contribution) : '—'}</td></tr>
                    <tr><th>{t('vicoba.cycle')}</th><td>{selected.cycle_type}</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card" style={{ margin: '0 0 14px' }}>
              <h3 style={{ marginTop: 0 }}>SALIO LA JUMLA</h3>
              <div className="grid grid-3">
                <div className="card stat"><div className="value">{formatMoney(selected.group_wallet_balance)}</div><div className="label">{t('vicoba.group_wallet')}</div></div>
                <div className="card stat"><div className="value">{formatMoney(finReport?.social_fund_balance || 0)}</div><div className="label">SALIO LA MIFUKO YA JAMII</div></div>
                <div className="card stat"><div className="value">{formatMoney((Number(selected.group_wallet_balance) || 0) + (Number(finReport?.social_fund_balance) || 0))}</div><div className="label">OVERALL BALANCE</div></div>
              </div>
            </div>

            {isLeader && (
              <form className="form-row" onSubmit={submitBonus} style={{ marginBottom: 14 }}>
                <div className="field"><label>{t('vicoba.bonus_add')} (TZS)</label><input type="number" value={bonusForm.amount} onChange={(e) => setBonusForm({ ...bonusForm, amount: e.target.value })} required /></div>
                <div className="field" style={{ flex: 1 }}><label>{t('vicoba.bonus_purpose')}</label><input value={bonusForm.purpose} onChange={(e) => setBonusForm({ ...bonusForm, purpose: e.target.value })} placeholder="Mapato ya riba / malipo ya ziada" /></div>
                <button className="btn" type="submit">+ BONUS</button>
              </form>
            )}
          </section>

          <section id="vicoba-members" className="card" style={{ marginBottom: 14 }}>
            <h3>{t('vicoba.members_section')}</h3>
            <input
              placeholder={t('vicoba.member_search')}
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              style={{ marginBottom: 10, maxWidth: 300 }}
            />
            <table>
              <thead><tr><th>{t('vicoba.m_th_name')}</th><th>{t('vicoba.m_th_phone')}</th><th>{t('vicoba.m_th_role')}</th><th>{t('vicoba.m_th_shares')}</th><th>{t('vicoba.m_th_contrib')}</th></tr></thead>
              <tbody>
                {filteredMembers.map((m) => (
                  <tr key={m.user_id}>
                    <td>{m.full_name}</td>
                    <td>{m.phone_number}</td>
                    <td>{m.role_in_group}</td>
                    <td>{m.total_shares}</td>
                    <td>{formatMoney(m.contribution_balance)}</td>
                  </tr>
                ))}
                {filteredMembers.length === 0 && <tr><td colSpan="5" className="roles-tag">Hakuna mwanachama anayefanana.</td></tr>}
              </tbody>
            </table>
          </section>

          <section id="vicoba-tx" className="card" style={{ marginBottom: 14 }}>
            <h3>{t('vicoba.transactions')} <span className="roles-tag" style={{ marginLeft: 8 }}>{showArchived ? t('vicoba.tx_archive') : 'Hali ya Sasa'}</span></h3>
            <table>
              <thead><tr><th>Mwanachama</th><th>Aina</th><th>Kiasi</th><th>Mzunguko</th><th>Tarehe</th></tr></thead>
              <tbody>
                {transactions.map((tx, i) => (
                  <tr key={i}>
                    <td>{tx.full_name}</td>
                    <td>{txKindLabel(tx.kind)}</td>
                    <td>{formatMoney(tx.amount)}</td>
                    <td>{tx.cycle_number || '—'}</td>
                    <td>{tx.created_at ? String(tx.created_at).slice(0, 10) : '—'}</td>
                  </tr>
                ))}
                {transactions.length === 0 && <tr><td colSpan="5" className="roles-tag">{t('dash.no_recent')}</td></tr>}
              </tbody>
            </table>
            <button className="btn ghost" style={{ marginTop: 10 }} onClick={loadMoreTx}>{t('vicoba.load_more')}</button>
          </section>

          <section id="vicoba-books" className="card" style={{ marginBottom: 14 }}>
            <h3>{t('vicoba.books')}</h3>

            <h4 style={{ marginTop: 4 }}>1. {t('vicoba.share_book')} (HISARI) — Michango</h4>
            <form className="form-row" onSubmit={contribute}>
              <div className="field"><label>{t('vicoba.contribute')}</label><input type="number" value={contributeAmt} onChange={(e) => setContributeAmt(e.target.value)} required /></div>
              <div className="field"><label>{t('vicoba.share_count')}</label><input type="number" value={contributeShares} onChange={(e) => setContributeShares(e.target.value)} /></div>
              <button className="btn" type="submit">{t('vicoba.contribute_btn')}</button>
            </form>
            <table style={{ marginTop: 12 }}>
              <thead><tr><th>{t('vicoba.m_th_name')}</th><th>{t('vicoba.m_th_phone')}</th><th>Hisa (Unyumbaji)</th><th>{t('vicoba.m_th_contrib')}</th></tr></thead>
              <tbody>
                {shareBook.map((s) => (
                  <tr key={s.id || s.reference_id}>
                    <td>{s.full_name || s.user_name || '—'}</td>
                    <td>{s.phone_number || '—'}</td>
                    <td>{s.shares_count}</td>
                    <td>{formatMoney(s.amount)}</td>
                  </tr>
                ))}
                {shareBook.length === 0 && <tr><td colSpan="4" className="roles-tag">{t('vicoba.no_docs')}</td></tr>}
              </tbody>
            </table>

            <h4 style={{ marginTop: 18 }}>2. {t('vicoba.loan_book')}</h4>
            <table>
              <thead><tr><th>Ombi</th><th>Mkopaji</th><th>Kiasi</th><th>Salio</th><th>Hali</th><th>Malipo</th></tr></thead>
              <tbody>
                {loans.map((l) => (
                  <React.Fragment key={l.id}>
                    <tr>
                      <td>#{l.id}</td>
                      <td>{l.full_name}</td>
                      <td>{formatMoney(l.requested_amount)}</td>
                      <td>{formatMoney(l.outstanding_balance != null ? l.outstanding_balance : l.requested_amount)}</td>
                      <td><StatusBadge status={l.status} /></td>
                      <td>
                        <div className="inline-actions" style={{ gap: 6 }}>
                          <input type="number" placeholder="Kiasi" style={{ minWidth: 80 }} value={repayMap[l.id] || ''} onChange={(e) => setRepayMap((p) => ({ ...p, [l.id]: e.target.value }))} />
                          <button className="btn" onClick={() => repayLoanRow(l.id)}>{t('vicoba.repay_loan_btn')}</button>
                          <button className="btn ghost" onClick={() => toggleLoanExtra(l)}>{t('vicoba.view_schedule')}</button>
                        </div>
                      </td>
                    </tr>
                    {loanExtra[l.id] && (
                      <tr>
                        <td colSpan="6">
                          <strong>{t('vicoba.view_repay')}:</strong>
                          <table>
                            <thead><tr><th>Ratiba</th><th>Tarehe</th><th>Principali</th><th>Riba</th><th>Jumla</th><th>Hali</th></tr></thead>
                            <tbody>
                              {(loanExtra[l.id].schedule || []).map((sc) => (
                                <tr key={sc.id}>
                                  <td>#{sc.installment_number}</td>
                                  <td>{sc.due_date}</td>
                                  <td>{formatMoney(sc.principal_amount)}</td>
                                  <td>{formatMoney(sc.interest_amount)}</td>
                                  <td>{formatMoney(sc.total_amount)}</td>
                                  <td><StatusBadge status={sc.status} /></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <strong>Malipo yaliyofanyika:</strong>
                          <table>
                            <thead><tr><th>Mwanachama</th><th>Kiasi</th><th>Tarehe</th></tr></thead>
                            <tbody>
                              {(loanExtra[l.id].payments || []).map((p) => (
                                <tr key={p.id}><td>{p.full_name}</td><td>{formatMoney(p.amount)}</td><td>{String(p.created_at).slice(0, 10)}</td></tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
                {loans.length === 0 && <tr><td colSpan="6" className="roles-tag">{t('vicoba.no_loans')}</td></tr>}
              </tbody>
            </table>

            <h4 style={{ marginTop: 18 }}>3. {t('vicoba.social_book')}</h4>
            {isLeader && (
              <form className="form-row" onSubmit={initSocialFund}>
                <div className="field"><label>{t('vicoba.soc_contribute')} (kila mwanachama)</label><input type="number" value={sFundMonthly} onChange={(e) => setSFundMonthly(e.target.value)} placeholder="e.g. 5000" required /></div>
                <button className="btn" type="submit">Anzisha/Weza Mfuko</button>
              </form>
            )}
            <div className="inline-actions" style={{ gap: 14, margin: '10px 0', flexWrap: 'wrap' }}>
              <span className="roles-tag">Salio la Mfuko: <strong>{formatMoney(socialFund?.fund?.total_balance || 0)}</strong></span>
              <span className="roles-tag">Kilichokusanywa: <strong>{formatMoney(socialFund?.fund?.total_collected || 0)}</strong></span>
              <span className="roles-tag">Kilichotolewa: <strong>{formatMoney(socialFund?.fund?.total_disbursed || 0)}</strong></span>
            </div>
            <div className="grid grid-2" style={{ gap: 10 }}>
              <form className="form-row" onSubmit={contributeSocial}>
                <div className="field"><label>Weka Mwezi (YYYY-MM)</label><input value={sMonth} onChange={(e) => setSMonth(e.target.value)} required /></div>
                <button className="btn ghost" type="submit">{t('vicoba.soc_contribute')}</button>
              </form>
              <form className="form-row" onSubmit={requestSocial}>
                <div className="field"><label>{t('vicoba.soc_reason_type')}</label>
                  <select value={sReqType} onChange={(e) => setSReqType(e.target.value)}>
                    <option value="FUNERAL">Msiba</option><option value="WEDDING">Harusi</option><option value="ILLNESS">Ugonjwa</option><option value="FAMILY_EVENT">Tukio la Familia</option><option value="OTHER">Nyingine</option>
                  </select>
                </div>
                <div className="field" style={{ flex: 1 }}><label>{t('vicoba.soc_reason_detail')}</label><input value={sReqDetail} onChange={(e) => setSReqDetail(e.target.value)} required /></div>
                <div className="field"><label>{t('vicoba.soc_amount')}</label><input type="number" value={sReqAmount} onChange={(e) => setSReqAmount(e.target.value)} required /></div>
                <button className="btn warn" type="submit">{t('vicoba.soc_request')}</button>
              </form>
            </div>
            {(socialFund?.requests || []).length > 0 && (
              <table style={{ marginTop: 12 }}>
                <thead><tr><th>Aliyeomba</th><th>Aina</th><th>Kiasi</th><th>Hali</th><th></th></tr></thead>
                <tbody>
                  {socialFund.requests.map((r) => (
                    <tr key={r.id}>
                      <td>{r.requester_name}</td>
                      <td>{r.reason_type}<div className="roles-tag">{r.reason_detail}</div></td>
                      <td>{formatMoney(r.requested_amount)}</td>
                      <td><StatusBadge status={r.status} /></td>
                      <td>
                        {isLeader && r.status === 'PENDING' && (
                          <div className="inline-actions">
                            <button className="btn" onClick={() => decideSocial(r.id, 'approve', r.requested_amount)}>Idhinisha</button>
                            <button className="btn warn" onClick={() => decideSocial(r.id, 'reject')}>Kataa</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section id="vicoba-withdraw" className="card" style={{ marginBottom: 14 }}>
            <h3>{t('vicoba.withdraw_section')} <span className="roles-tag" style={{ marginLeft: 8 }}>{t('vicoba.signature_title')}</span></h3>
            <form className="form-row" onSubmit={requestWithdrawal}>
              <div className="field"><label>{t('vicoba.wd_amount')}</label><input type="number" value={wdAmt} onChange={(e) => setWdAmt(e.target.value)} required /></div>
              {myMember && <div className="field"><label>{t('vicoba.wd_my_avail')}</label><input value={formatMoney(myMember.contribution_balance)} disabled /></div>}
              <button className="btn" type="submit">{t('vicoba.request_withdraw')}</button>
            </form>
            <table style={{ marginTop: 12 }}>
              <thead><tr><th>Mwanachama</th><th>Kiasi</th><th>{t('vicoba.wd_chair')}</th><th>{t('vicoba.wd_treasurer')}</th><th>Hali</th><th></th></tr></thead>
              <tbody>
                {withdrawals.map((w) => (
                  <tr key={w.id}>
                    <td>{w.full_name}<div className="roles-tag">{w.phone_number}</div></td>
                    <td>{formatMoney(w.amount)}</td>
                    <td>{w.chairman_id ? (w.chairman_name || '✓') : '—'}</td>
                    <td>{w.treasurer_id ? (w.treasurer_name || '✓') : '—'}</td>
                    <td><StatusBadge status={w.status} /></td>
                    <td>
                      {canSignWd && w.status === 'PENDING' && (
                        <div className="inline-actions">
                          <button className="btn" onClick={() => decideWithdrawal(w.id, true)}>✓ {t('vicoba.wd_approve')}</button>
                          <button className="btn warn" onClick={() => decideWithdrawal(w.id, false)}>{t('vicoba.wd_reject')}</button>
                        </div>
                      )}
                      {w.status === 'PENDING' && !canSignWd && <span className="roles-tag">{t('vicoba.wd_pending_approval')}</span>}
                    </td>
                  </tr>
                ))}
                {withdrawals.length === 0 && <tr><td colSpan="6" className="roles-tag">{t('vicoba.no_withdrawals')}</td></tr>}
              </tbody>
            </table>
          </section>

          <section id="vicoba-penalty" className="card" style={{ marginBottom: 14 }}>
            <h3>{t('vicoba.penalty_section')}</h3>
            <table>
              <thead><tr><th>Mwanachama</th><th>Aina</th><th>Kiasi</th><th>Sababu</th><th>Hali</th><th></th></tr></thead>
              <tbody>
                {penalties.map((p) => (
                  <tr key={p.id}>
                    <td>{p.full_name || '—'}</td>
                    <td>{p.penalty_type}</td>
                    <td>{formatMoney(p.amount)}</td>
                    <td>{p.reason || '—'}</td>
                    <td><StatusBadge status={p.status} /></td>
                    <td>
                      <div className="inline-actions">
                        {p.status === 'UNPAID' && Number(p.user_id) === Number(user.id) && (
                          <button className="btn" onClick={() => payPenalty(p.id)}>{t('vicoba.penalty_pay')}</button>
                        )}
                        {isLeader && p.status === 'UNPAID' && (
                          <button className="btn warn" onClick={() => waivePenalty(p.id)}>{t('vicoba.penalty_waive')}</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {penalties.length === 0 && <tr><td colSpan="6" className="roles-tag">{t('vicoba.no_penalties')}</td></tr>}
              </tbody>
            </table>
          </section>

          <section id="vicoba-loans" className="card" style={{ marginBottom: 14 }}>
            <h3>{t('vicoba.loans_section')}</h3>
            {canAddLoan && (
              <form className="form-row" onSubmit={addLoan}>
                <div className="field"><label>{t('vicoba.loan_member')}</label><input type="number" value={loanApplicant} onChange={(e) => setLoanApplicant(e.target.value)} required /></div>
                <div className="field"><label>{t('vicoba.loan_amount')}</label><input type="number" value={loanAmount} onChange={(e) => setLoanAmount(e.target.value)} required /></div>
                <div className="field"><label>{t('vicoba.loan_interest')}</label><input type="number" value={loanInterest} onChange={(e) => setLoanInterest(e.target.value)} /></div>
                <div className="field"><label>{t('vicoba.loan_months')}</label><input type="number" value={loanMonths} onChange={(e) => setLoanMonths(e.target.value)} /></div>
                <button className="btn" type="submit">{t('vicoba.add_loan')}</button>
              </form>
            )}

            <table style={{ marginTop: 12 }}>
              <thead><tr><th>{t('vicoba.th_request')}</th><th>{t('vicoba.th_applicant')}</th><th>{t('vicoba.loan_amount')}</th><th>{t('vicoba.th_approval')}</th><th>{t('vicoba.th_loan_status')}</th><th>{t('vicoba.th_loan_actions')}</th></tr></thead>
              <tbody>
                {loans.map((l) => (
                  <tr key={l.id}>
                    <td>#{l.id}</td>
                    <td>{l.full_name}<div className="roles-tag">{l.phone_number}</div></td>
                    <td>{formatMoney(l.requested_amount)}</td>
                    <td>
                      <span className="roles-tag">
                        {t('vicoba.approvals', { c: l.chairman_approval ? '✓' : '✗', t: l.treasurer_approval ? `${String.fromCharCode(10003)}` : '✗' })}
                      </span>
                    </td>
                    <td><StatusBadge status={l.status} /></td>
                    <td>
                      {canApprove && l.status === 'APPROVED' && (
                        <div className="inline-actions">
                          <input type="number" placeholder="Kiasi" style={{ minWidth: 80 }} value={approveAmount}
                            onChange={(e) => setApproveAmount(e.target.value)} />
                          <button className="btn" onClick={() => approve(l.id)}>{t('vicoba.release_loan')}</button>
                        </div>
                      )}
                      {l.status === 'PENDING' && l.treasurer_approval === false && canApprove && (
                        <button className="btn warn" onClick={() => approve(l.id)}>{t('vicoba.approve_loan')}</button>
                      )}
                    </td>
                  </tr>
                ))}
                {loans.length === 0 && <tr><td colSpan="6" className="roles-tag">{t('vicoba.no_loans')}</td></tr>}
              </tbody>
            </table>
          </section>

          <section id="vicoba-report" className="card" style={{ marginBottom: 14 }}>
            <h3>{t('vicoba.reports_section')}</h3>
            {finReport && Object.keys(finReport).length > 0 && (
              <div className="grid grid-3">
                <div className="card stat"><div className="value">{formatMoney(finReport.total_contributions)}</div><div className="label">Michango (HISARI)</div></div>
                <div className="card stat"><div className="value">{formatMoney(finReport.total_loans_outstanding)}</div><div className="label">Mikopo Ambayo Bado</div></div>
                <div className="card stat"><div className="value">{formatMoney(finReport.penalties_collected)}</div><div className="label">Faini Zilizolipwa</div></div>
              </div>
            )}

            <h3 style={{ marginTop: 14 }}>{t('vicoba.profit_title')}</h3>
            <p className="roles-tag" style={{ marginBottom: 12 }}>{t('vicoba.profit_sub')}</p>

            {isLeader && (
              <form className="form-row" onSubmit={calculateProfit} style={{ marginBottom: 12 }}>
                <div className="field"><label>{t('vicoba.profit_cycle')}</label><input type="number" value={pCycle} onChange={(e) => setPCycle(e.target.value)} required /></div>
                <div className="field"><label>{t('vicoba.profit_total')}</label><input type="number" value={pProfit} onChange={(e) => setPProfit(e.target.value)} required /></div>
                <button className="btn" type="submit">{t('vicoba.profit_calc_btn')}</button>
              </form>
            )}

            {profitCalc && (
              <div className="card" style={{ marginBottom: 12, padding: 14 }}>
                <strong>{t('vicoba.profit_preview')}: {formatMoney(profitCalc.totalProfit)}</strong>
                <div className="roles-tag">{t('vicoba.profit_per_share', { v: formatMoney(profitCalc.perShareDividend) })} · {t('vicoba.profit_members', { c: profitCalc.payouts?.length || 0 })}</div>
                <table style={{ marginTop: 10 }}>
                  <thead><tr><th>{t('vicoba.m_th_name')}</th><th>{t('vicoba.m_th_shares')}</th><th>{t('vicoba.profit_dividend')}</th></tr></thead>
                  <tbody>
                    {(profitCalc.payouts || []).map((p, i) => (
                      <tr key={i}><td>{p.name}</td><td>{p.shares}</td><td>{formatMoney(p.dividend)}</td></tr>
                    ))}
                  </tbody>
                </table>
                {profitCalc.distribution && (
                  <div className="inline-actions" style={{ marginTop: 10 }}>
                    <button className="btn warn" onClick={() => approveProfit(profitCalc.distribution.id)}>{t('vicoba.profit_approve')}</button>
                  </div>
                )}
              </div>
            )}

            {distributions.length > 0 && (
              <>
                <h3 style={{ marginTop: 16, marginBottom: 8 }}>{t('vicoba.profit_distributions')}</h3>
                <table>
                  <thead><tr><th>{t('vicoba.profit_d_cycle')}</th><th>{t('vicoba.profit_total2')}</th><th>{t('vicoba.profit_per_share2')}</th><th>{t('vicoba.profit_d_members')}</th><th>{t('vicoba.profit_d_paid')}</th><th>{t('vicoba.th_loan_status')}</th><th></th></tr></thead>
                  <tbody>
                    {distributions.map((d) => (
                      <tr key={d.id}>
                        <td>#{d.cycle_number}</td>
                        <td>{formatMoney(d.total_profit)}</td>
                        <td>{formatMoney(d.per_share_dividend)}</td>
                        <td>{d.payout_count}</td>
                        <td>{formatMoney(d.total_paid)}</td>
                        <td><StatusBadge status={d.status} /></td>
                        <td>{isLeader && d.status === 'PENDING' && (
                          <button className="btn warn" onClick={() => approveProfit(d.id)}>{t('vicoba.profit_approve')}</button>
                        )}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>

          <section id="vicoba-meetings" className="card" style={{ marginBottom: 14 }}>
            <h3>{t('vicoba.meetings_section')}</h3>
            {attendance && Object.keys(attendance).length > 0 ? (
              <div className="grid grid-3">
                <div className="card stat"><div className="value">{attendance.total_meetings}</div><div className="label">Mikutano</div></div>
                <div className="card stat"><div className="value">{formatMoney(attendance.total_fines)}</div><div className="label">Faini</div></div>
                <div className="card stat"><div className="value">{formatMoney(attendance.total_expected_contributions)}</div><div className="label">Michango</div></div>
              </div>
            ) : <p className="roles-tag">{t('vicoba.no_docs')}</p>}
            <p style={{ opacity: 0.75, fontSize: 13, marginTop: 8 }}>Dondoo, maazimio na kumbukumbu za mikutano zitaongezwa hapa kwenye awamu ijayo.</p>
          </section>

          <section id="vicoba-docs" className="card" style={{ marginBottom: 14 }}>
            <h3>{t('vicoba.docs')}</h3>
            <div className="inline-actions" style={{ gap: 10, flexWrap: 'wrap' }}>
              <button className="btn" onClick={printDocs}>{t('vicoba.view_doc')}</button>
              <Link to="/dashboard/governance" className="btn ghost" style={{ textDecoration: 'none' }}>{t('nav.governance')}</Link>
            </div>
            {constitution && Object.keys(constitution).length > 0 && (
              <details style={{ marginTop: 10 }}>
                <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Katiba / Maagizo ya Kikundi</summary>
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: 'var(--bg)', padding: 10, borderRadius: 8, marginTop: 8 }}>{JSON.stringify(constitution, null, 2)}</pre>
              </details>
            )}
            {(!constitution || Object.keys(constitution).length === 0) && <p className="roles-tag" style={{ marginTop: 8 }}>{t('vicoba.no_docs')}</p>}

            {myPayouts.length > 0 && (
              <>
                <h3 style={{ marginTop: 14, marginBottom: 8 }}>{t('vicoba.profit_my')}</h3>
                <table>
                  <thead><tr><th>{t('vicoba.profit_d_cycle')}</th><th>{t('vicoba.profit_dividend')}</th><th>{t('vicoba.m_th_shares')}</th><th>{t('vicoba.rollover')}</th><th>{t('vicoba.profit_paid')}</th><th>{t('vicoba.th_loan_status')}</th></tr></thead>
                  <tbody>
                    {myPayouts.map((p) => (
                      <tr key={p.id}>
                        <td>#{p.cycle_number}</td>
                        <td>{formatMoney(p.dividend_amount)}</td>
                        <td>{p.shares_count}</td>
                        <td>{p.rollover_shares}</td>
                        <td>{formatMoney(p.dividend_amount)}</td>
                        <td>{p.paid ? t('vicoba.yes') : t('vicoba.no')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>

          <section id="vicoba-leadership" className="card">
            <h3>{t('vicoba.leadership')}</h3>
            {leadership.length > 0 ? (
              <table>
                <thead><tr><th>{t('vicoba.m_th_name')}</th><th>{t('vicoba.m_th_role')}</th><th>{t('vicoba.m_th_phone')}</th><th>{t('vicoba.m_th_shares')}</th></tr></thead>
                <tbody>
                  {leadership.map((m) => (
                    <tr key={m.user_id}>
                      <td>{m.full_name}</td>
                      <td><strong>{m.role_in_group}</strong></td>
                      <td>{m.phone_number}</td>
                      <td>{m.total_shares}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="roles-tag">{t('vicoba.no_docs')}</p>}

            {isLeader && (
              <>
                <form className="form-row" onSubmit={addMember} style={{ marginTop: 14 }}>
                  <div className="field"><label>{t('vicoba.add_member')}</label><input type="number" value={newMemberId} onChange={(e) => setNewMemberId(e.target.value)} required /></div>
                  <button className="btn ghost" type="submit">{t('vicoba.add')}</button>
                </form>
                <form className="form-row" onSubmit={invite} style={{ marginTop: 10 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label>{t('vicoba.invite_sms')}</label>
                    <input value={invitePhones} onChange={(e) => setInvitePhones(e.target.value)} placeholder="0712000001, 0713000002" />
                  </div>
                  <button className="btn warn" type="submit">{t('vicoba.send_invites')}</button>
                </form>
              </>
            )}
          </section>
        </div>
      )}
    </ServiceLock>
  );
}