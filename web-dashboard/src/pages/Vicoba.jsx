import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import ServiceLock from '../components/ServiceLock.jsx';
import { useT } from '../i18n/LangProvider.jsx';

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

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 5000);
  };

  const loadGroups = () => {
    api.get('/vicoba/groups').then((r) => setGroups(r.data.groups)).catch(() => {});
  };

  useEffect(() => {
    loadGroups();
  }, []);

  const selectGroup = (g) => {
    setSelected(g);
    api.get(`/vicoba/groups/${g.id}`).then((r) => setSelected(r.data.group)).catch(() => {});
    api.get(`/vicoba/groups/${g.id}/loans`).then((r) => setLoans(r.data.loans)).catch(() => {});
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
  const canApprove = myRole === 'MWEKAHAZINA' || myRole === 'KATIBU';
  const canAddLoan = ['MWENYEKITI', 'MWEKAHAZINA', 'KATIBU'].includes(myRole);
  const isLeader = canAddLoan;

  return (
    <ServiceLock serviceKey="VICOBA">
      <div className="page-head">
        <h2>{t('vicoba.title')}</h2>
        <p>{t('vicoba.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

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
          <h3>{selected.group_name}
            <span className="roles-tag" style={{ marginLeft: 12 }}>{t('vicoba.group_wallet')}: <strong>{formatMoney(selected.group_wallet_balance)}</strong></span>
            {selected.join_code && (
              <span className="roles-tag" style={{ marginLeft: 12 }}>{t('vicoba.code')}: <strong>{selected.join_code}</strong></span>
            )}
          </h3>

          <div className="grid grid-2" style={{ marginBottom: 16 }}>
            <form className="form-row" onSubmit={contribute}>
              <div className="field"><label>{t('vicoba.contribute')}</label><input type="number" value={contributeAmt} onChange={(e) => setContributeAmt(e.target.value)} required /></div>
              <div className="field"><label>{t('vicoba.share_count')}</label><input type="number" value={contributeShares} onChange={(e) => setContributeShares(e.target.value)} /></div>
              <button className="btn" type="submit">{t('vicoba.contribute_btn')}</button>
            </form>
            <form className="form-row" onSubmit={addMember}>
              <div className="field"><label>{t('vicoba.add_member')}</label><input type="number" value={newMemberId} onChange={(e) => setNewMemberId(e.target.value)} required /></div>
              <button className="btn ghost" type="submit">{t('vicoba.add')}</button>
            </form>
          </div>

          {isLeader && (
            <form className="form-row" onSubmit={invite} style={{ marginBottom: 16 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>{t('vicoba.invite_sms')}</label>
                <input value={invitePhones} onChange={(e) => setInvitePhones(e.target.value)} placeholder="0712000001, 0713000002" />
              </div>
              <button className="btn warn" type="submit">{t('vicoba.send_invites')}</button>
            </form>
          )}

          <h3 style={{ marginTop: 18 }}>{t('vicoba.members')}</h3>
          <table>
            <thead><tr><th>{t('vicoba.m_th_name')}</th><th>{t('vicoba.m_th_phone')}</th><th>{t('vicoba.m_th_role')}</th><th>{t('vicoba.m_th_shares')}</th><th>{t('vicoba.m_th_contrib')}</th></tr></thead>
            <tbody>
              {selected.members.map((m) => (
                <tr key={m.user_id}>
                  <td>{m.full_name}</td>
                  <td>{m.phone_number}</td>
                  <td>{m.role_in_group}</td>
                  <td>{m.total_shares}</td>
                  <td>{formatMoney(m.contribution_balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={{ marginTop: 22 }}>{t('vicoba.loans')}</h3>
          {canAddLoan && (
            <form className="form-row" onSubmit={addLoan}>
              <div className="field"><label>{t('vicoba.loan_member')}</label><input type="number" value={loanApplicant} onChange={(e) => setLoanApplicant(e.target.value)} required /></div>
              <div className="field"><label>{t('vicoba.loan_amount')}</label><input type="number" value={loanAmount} onChange={(e) => setLoanAmount(e.target.value)} required /></div>
              <div className="field"><label>{t('vicoba.loan_interest')}</label><input type="number" value={loanInterest} onChange={(e) => setLoanInterest(e.target.value)} /></div>
              <div className="field"><label>{t('vicoba.loan_months')}</label><input type="number" value={loanMonths} onChange={(e) => setLoanMonths(e.target.value)} /></div>
              <button className="btn" type="submit">{t('vicoba.add_loan')}</button>
            </form>
          )}

          <table>
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
        </div>
      )}
    </ServiceLock>
  );
}
