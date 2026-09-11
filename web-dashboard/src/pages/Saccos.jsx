import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

function toDate(v) {
  if (!v) return '-';
  if (v instanceof Date) return v.toLocaleDateString('en-CA');
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toLocaleDateString('en-CA');
}

function Stat({ value = '-', label }) {
  return (
    <div className="stat">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

export default function Saccos() {
  const { t } = useT();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const [orgs, setOrgs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loans, setLoans] = useState([]);
  const [openInst, setOpenInst] = useState({});
  const [instData, setInstData] = useState({});
  const [statement, setStatement] = useState(null);
  const [chips, setChips] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [busy, setBusy] = useState({});

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 5000);
  };

  const loadOrgs = () => {
    api.get('/saccos').then((r) => setOrgs(r.data.result || r.data.saccos || [])).catch(() => {});
  };

  useEffect(() => {
    loadOrgs();
  }, []);

  const isGoverning = () => {
    const role = selected ? (selected.membership_role || selected.role || '') : '';
    const platformAdmin = user.role === 'ADMIN';
    return platformAdmin || role === 'OWNER' || role === 'BOARD';
  };

  const loadChips = (id, role) => {
    setChips(null);
    if (role !== 'OWNER' && role !== 'BOARD' && user.role !== 'ADMIN') return;
    const picks = {
      loans: '/loans/summary',
      savings: '/savings/summary',
      dividends: '/dividends/summary',
      funds: '/funds/summary',
      accounting: '/accounting/summary',
      arrears: '/loans/arrears',
    };
    const out = {};
    Promise.all(Object.entries(picks).map(([k, p]) =>
      api.get(`/saccos/${id}${p}`).then((r) => { out[k] = r.data.result || r.data; })
        .catch(() => { out[k] = null; })
    )).then(() => setChips(out));
  };

  const selectOrg = (org) => {
    setSelected(org);
    setLoans([]);
    setOpenInst({});
    setInstData({});
    setStatement(null);
    setChips(null);
    api.get(`/saccos/${org.id}/loans/mine`).then((r) => {
      setLoans(r.data.result.loans || []);
      if (r.data.result.loans && r.data.result.loans.length) {
        const first = r.data.result.loans[0];
        fetchInstallments(org.id, first.id);
      }
    }).catch(() => {});
    api.get(`/saccos/${org.id}/statements/mine`).then((r) => setStatement(r.data.result)).catch(() => {});
    loadChips(org.id, org.membership_role);
  };

  const fetchInstallments = (orgId, loanId) => {
    api.get(`/saccos/${orgId}/loans/${loanId}/installments`)
      .then((r) => {
        setInstData((prev) => ({ ...prev, [loanId]: r.data.result }));
        setOpenInst((prev) => ({ ...prev, [loanId]: true }));
      })
      .catch(() => setOpenInst((prev) => ({ ...prev, [loanId]: false })));
  };

  const toggleInst = (loanId) => {
    if (openInst[loanId]) {
      setOpenInst((prev) => ({ ...prev, [loanId]: false }));
      return;
    }
    fetchInstallments(selected.id, loanId);
  };

  const payInstallment = async (loanId, instId) => {
    setBusy((prev) => ({ ...prev, [instId]: true }));
    try {
      const res = await api.post(`/saccos/${selected.id}/loans/${loanId}/installments/${instId}/pay`);
      show('ok', res.data.message || 'Awamu imelipwa.');
      fetchInstallments(selected.id, loanId);
      api.get(`/saccos/${selected.id}/loans/mine`).then((r) => setLoans(r.data.result.loans || [])).catch(() => {});
      api.get(`/saccos/${selected.id}/statements/mine`).then((r) => setStatement(r.data.result)).catch(() => {});
      if (isGoverning()) loadChips(selected.id, selected.membership_role || selected.role);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, [instId]: false }));
    }
  };

  const recomputeArrears = async () => {
    setBusy((prev) => ({ ...prev, arrears: true }));
    try {
      const res = await api.post(`/saccos/${selected.id}/loans/recompute-arrears`);
      const r = res.data.result || {};
      show('ok', `${r.overdue || 0} ${t('saccos.arrears_overdue')} · ${formatMoney(r.arrears_total)}`);
      loadChips(selected.id, selected.membership_role || selected.role);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, arrears: false }));
    }
  };

  const renderInstallments = (loan) => {
    const data = instData[loan.id];
    if (!data) return null;
    const firstUnpaid = data.installments.findIndex((inst) => inst.status !== 'PAID');
    return (
      <div style={{ padding: '10px 0 4px' }}>
        <div className="grid grid-3" style={{ marginBottom: 10 }}>
          <Stat value={formatMoney(data.total)} label={t('saccos.loan_total')} />
          <Stat value={formatMoney(data.outstanding)} label={t('saccos.outstanding')} />
          <Stat value={`${data.summary.paidCount}/${data.summary.total}`} label={t('saccos.paid')} />
        </div>
        {data.summary.overdue > 0 ? (
          <div className="msg err" style={{ marginBottom: 10 }}>
            {data.summary.overdue} {t('saccos.arrears_overdue')} · {t('saccos.fine')}: {formatMoney(data.summary.lateFees)}
          </div>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>{t('saccos.due')}</th>
              <th>{t('saccos.p_principal')}</th>
              <th>{t('saccos.p_interest')}</th>
              <th>{t('saccos.p_total')}</th>
              <th>{t('saccos.fine')}</th>
              <th>{t('saccos.status')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.installments.map((inst, idx) => {
              const can = loan.status === 'ACTIVE' && inst.status !== 'PAID' && idx === firstUnpaid;
              const hasFee = Number(inst.late_fee || 0) > 0;
              return (
                <tr key={inst.id}>
                  <td>{inst.installment_no}</td>
                  <td>{toDate(inst.due_date)}</td>
                  <td>{formatMoney(inst.principal_part)}</td>
                  <td>{formatMoney(inst.interest_part)}</td>
                  <td>{formatMoney(inst.total)}</td>
                  <td style={hasFee ? { color: 'var(--danger, #c0392b)', fontWeight: 600 } : {}}>
                    {hasFee ? formatMoney(inst.late_fee) : '-'}
                  </td>
                  <td><StatusBadge status={inst.status} /></td>
                  <td>
                    {can ? (
                      <>
                        {inst.status === 'OVERDUE' ? (
                          <span className="muted" style={{ marginRight: 8 }}>
                            {t('saccos.pay_with_fee')}: {formatMoney(Number(inst.total) + Number(inst.late_fee || 0))}
                          </span>
                        ) : null}
                        <button className="btn" disabled={!!busy[inst.id]} onClick={() => payInstallment(loan.id, inst.id)}>
                          {busy[inst.id] ? t('saccos.paying') : hasFee ? t('saccos.pay_with_fee') : t('saccos.pay')}
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div>
      <h2>{t('saccos.title')}</h2>
      <p className="muted">{t('saccos.sub')}</p>
      {msg.text ? <div className={`msg ${msg.type}`}>{msg.text}</div> : null}

      {!orgs.length ? (
        <div className="card"><p>{t('saccos.none')}</p></div>
      ) : (
        <div className="grid grid-3">
          {orgs.map((org) => (
            <div key={org.id} className={`card${selected && selected.id === org.id ? ' locked' : ''}`}>
              <h3>{org.name}</h3>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '8px 0' }}>
                <span className="muted">{org.code}</span>
                <StatusBadge status={org.status} />
              </div>
              <div className="muted" style={{ marginBottom: 10 }}>
                {t('saccos.member_role')}: {org.membership_role || '-'}&nbsp;·&nbsp;
                {t('saccos.member_no')}: {org.member_number || '-'}
              </div>
              {selected && selected.id === org.id ? (
                <div className="muted">{t('saccos.selected')}</div>
              ) : (
                <button className="btn" onClick={() => selectOrg(org)}>{t('saccos.open')}</button>
              )}
            </div>
          ))}
        </div>
      )}

      {selected && (
        <>
          {isGoverning() && (
            <div className="card">
              <h3>{t('saccos.overview')}</h3>
              {!chips ? (
                <div className="muted">{t('saccos.loading')}</div>
              ) : (
                <>
                  <div className="grid grid-2">
                    <Stat value={chips.loans ? `${chips.loans.active_loans || 0}` : '-'} label={t('saccos.chips_l_loans')} />
                    <Stat value={chips.loans ? formatMoney(chips.loans.outstanding) : '-'} label={t('saccos.chips_l_out')} />
                    <Stat value={chips.savings ? formatMoney(chips.savings.liability || chips.savings.total_deposits) : '-'} label={t('saccos.chips_savings')} />
                    <Stat value={chips.funds ? formatMoney(chips.funds.total_balance) : '-'} label={t('saccos.chips_funds')} />
                    <Stat value={chips.dividends ? formatMoney(chips.dividends.distributed || 0) : '-'} label={t('saccos.chips_dividends')} />
                    <Stat value={chips.arrears ? `${chips.arrears.overdue || 0}` : '-'} label={t('saccos.chips_arrears_o')} />
                    <Stat value={chips.arrears ? formatMoney(chips.arrears.arrears_total) : '-'} label={t('saccos.chips_arrears_t')} />
                    <Stat value={chips.arrears ? formatMoney(chips.arrears.late_fees_total) : '-'} label={t('saccos.chips_arrears_f')} />
                  </div>
                  {chips.arrears && Number(chips.arrears.overdue || 0) > 0 ? (
                    <div className="msg err" style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                      <span>{chips.arrears.overdue} {t('saccos.arrears_overdue')} · {formatMoney(chips.arrears.arrears_total)}</span>
                      <button className="btn" disabled={!!busy.arrears} onClick={recomputeArrears}>
                        {busy.arrears ? t('saccos.recomputing') : t('saccos.recompute')}
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          )}

          <div className="card">
            <h3>{t('saccos.my_loans')}</h3>
            {!loans.length ? (
              <div className="muted">{t('saccos.no_loans')}</div>
            ) : (
              loans.map((loan) => (
                <div key={loan.id} style={{ borderTop: '1px solid var(--border, #e5e5e5)', padding: '12px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <div>
                      <strong>{formatMoney(loan.principal)}</strong>
                      <span className="muted"> · {loan.term_months} {t('saccos.months')} @ {loan.interest_rate}%</span>
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <span className="muted">{t('saccos.outstanding')}: <strong>{formatMoney(loan.amount_outstanding)}</strong></span>
                      <StatusBadge status={loan.status} />
                      <button className="btn ghost" onClick={() => toggleInst(loan.id)}>
                        {openInst[loan.id] ? t('saccos.hide') : t('saccos.schedule')}
                      </button>
                    </div>
                  </div>
                  {openInst[loan.id] ? renderInstallments(loan) : null}
                </div>
              ))
            )}
          </div>

          <div className="card">
            <h3>{t('saccos.my_statement')}</h3>
            {!statement ? (
              <div className="muted">{t('saccos.loading')}</div>
            ) : (
              <>
                <div className="grid grid-4">
                  <Stat value={formatMoney(statement.savings ? statement.savings.balance : 0)} label={t('saccos.st_savings')} />
                  <Stat value={statement.shares ? `${statement.shares.share_count}` : '0'} label={t('saccos.st_shares')} />
                  <Stat value={formatMoney(statement.shares ? statement.shares.total_value : 0)} label={t('saccos.st_share_value')} />
                  <Stat value={formatMoney(statement.member ? statement.member.wallet_balance : 0)} label={t('saccos.st_wallet')} />
                </div>
                <div className="muted" style={{ marginTop: 12 }}>
                  {t('saccos.member_status')}: {statement.member ? statement.member.status : '-'}
                  {statement.member_number ? ` · ${t('saccos.member_no')}: ${statement.member_number}` : ''}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}