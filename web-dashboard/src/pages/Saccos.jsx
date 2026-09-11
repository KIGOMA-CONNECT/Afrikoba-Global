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
  const [meetings, setMeetings] = useState([]);
  const [meetForm, setMeetForm] = useState({ show: false, title: '', when: '', where: '', quorum: '50', agenda: '' });
  const [meetDetailId, setMeetDetailId] = useState(null);
  const [meetDetail, setMeetDetail] = useState({});
  const [minutesDraft, setMinutesDraft] = useState({});
  const [minutesDone, setMinutesDone] = useState({});
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
      meetings: '/meetings/summary',
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
    setMeetings([]);
    setMeetDetailId(null);
    setMeetDetail({});
    setMinutesDraft({});
    setMinutesDone({});
    api.get(`/saccos/${org.id}/loans/mine`).then((r) => {
      setLoans(r.data.result.loans || []);
      if (r.data.result.loans && r.data.result.loans.length) {
        const first = r.data.result.loans[0];
        fetchInstallments(org.id, first.id);
      }
    }).catch(() => {});
    api.get(`/saccos/${org.id}/statements/mine`).then((r) => setStatement(r.data.result)).catch(() => {});
    loadMeetings(org.id);
    loadChips(org.id, org.membership_role);
  };

  const loadMeetings = (id) => {
    api.get(`/saccos/${id}/meetings`)
      .then((r) => setMeetings(r.data.result || []))
      .catch(() => setMeetings([]));
  };

  const reloadMeetings = () => loadMeetings(selected.id);

  const meetAction = async (meetingId, action, extra) => {
    const key = `m${meetingId}${action}`;
    setBusy((prev) => ({ ...prev, [key]: true }));
    try {
      const res = await api.post(`/saccos/${selected.id}/meetings/${meetingId}/${action}`, extra);
      show('ok', res.data.message || t('saccos.saved'));
      reloadMeetings();
      if (isGoverning()) loadChips(selected.id, selected.membership_role || selected.role);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
    }
  };

  const createMeeting = async () => {
    if (!meetForm.title.trim()) { show('err', t('saccos.meet_title')); return; }
    setBusy((prev) => ({ ...prev, meetNew: true }));
    try {
      const agenda = meetForm.agenda.split('\n').map((l) => l.trim()).filter(Boolean).map((title) => ({ title }));
      await api.post(`/saccos/${selected.id}/meetings`, {
        title: meetForm.title,
        scheduledAt: new Date(meetForm.when).toISOString(),
        location: meetForm.where,
        quorumPct: Number(meetForm.quorum) || 50,
        agenda,
      });
      show('ok', t('saccos.meet_created'));
      setMeetForm({ show: false, title: '', when: '', where: '', quorum: '50', agenda: '' });
      reloadMeetings();
      if (isGoverning()) loadChips(selected.id, selected.membership_role || selected.role);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, meetNew: false }));
    }
  };

  const toggleMeetDetail = (meetingId) => {
    if (meetDetailId === meetingId) { setMeetDetailId(null); return; }
    setMeetDetailId(meetingId);
    api.get(`/saccos/${selected.id}/meetings/${meetingId}`)
      .then((r) => setMeetDetail((prev) => ({ ...prev, [meetingId]: r.data.result })))
      .catch(() => {});
  };

  const toggleDone = (meetingId, itemId) => {
    setMinutesDone((prev) => {
      const s = new Set(prev[meetingId] || []);
      if (s.has(itemId)) s.delete(itemId); else s.add(itemId);
      return { ...prev, [meetingId]: s };
    });
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
                    <Stat value={chips.meetings ? `${chips.meetings.total || 0}` : '-'} label={t('saccos.chips_meetings')} />
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

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <h3 style={{ margin: 0 }}>{t('saccos.meetings')}</h3>
              {isGoverning() ? (
                <button className="btn ghost" onClick={() => setMeetForm((f) => ({ ...f, show: !f.show }))}>
                  {t('saccos.meet_new')}
                </button>
              ) : null}
            </div>

            {meetForm.show && isGoverning() ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, margin: '12px 0', alignItems: 'center' }}>
                <label className="muted">{t('saccos.meet_title')}
                  <input value={meetForm.title} onChange={(e) => setMeetForm((f) => ({ ...f, title: e.target.value }))} placeholder={t('saccos.meet_title')} />
                </label>
                <label className="muted">{t('saccos.meet_when')}
                  <input type="datetime-local" value={meetForm.when} onChange={(e) => setMeetForm((f) => ({ ...f, when: e.target.value }))} />
                </label>
                <label className="muted">{t('saccos.meet_where')}
                  <input value={meetForm.where} onChange={(e) => setMeetForm((f) => ({ ...f, where: e.target.value }))} placeholder={t('saccos.meet_where')} />
                </label>
                <label className="muted">{t('saccos.meet_quorum')}
                  <input type="number" min="1" max="100" value={meetForm.quorum} onChange={(e) => setMeetForm((f) => ({ ...f, quorum: e.target.value }))} />
                </label>
                <label className="muted" style={{ gridColumn: '1 / -1' }}>{t('saccos.meet_agenda')}
                  <textarea rows={3} value={meetForm.agenda} onChange={(e) => setMeetForm((f) => ({ ...f, agenda: e.target.value }))} />
                </label>
                <div style={{ gridColumn: '1 / -1' }}>
                  <button className="btn" disabled={!!busy.meetNew} onClick={createMeeting}>
                    {busy.meetNew ? t('saccos.loading') : t('saccos.meet_create')}
                  </button>
                </div>
              </div>
            ) : null}

            {!meetings.length ? (
              <div className="muted" style={{ marginTop: 10 }}>{t('saccos.meetings_none')}</div>
            ) : (
              meetings.map((m) => {
                const detail = meetDetail[m.id];
                const open = meetDetailId === m.id;
                const depKey = (a) => `m${m.id}${a}`;
                const mins = minutesDraft[m.id] || '';
                return (
                  <div key={m.id} style={{ borderTop: '1px solid var(--border, #e5e5e5)', padding: '12px 0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <strong>{m.title}</strong>
                        <span className="muted"> · {toDate(m.scheduled_at)}</span>
                        {m.location ? <span className="muted"> · {m.location}</span> : null}
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        {m.present_count !== undefined ? (
                          <span className="muted">{m.present_count} {t('saccos.meet_present')}</span>
                        ) : null}
                        <StatusBadge status={m.status} />
                        {m.status === 'CLOSED' ? (
                          m.quorum_met ? (
                            <span className="badge success">{t('saccos.meet_q_met')}</span>
                          ) : (
                            <span className="badge failed">{t('saccos.meet_q_missed')}</span>
                          )
                        ) : null}
                        {m.status === 'OPEN' ? (
                          <button
                            className="btn"
                            disabled={!!busy[depKey('checkin')]}
                            onClick={() => meetAction(m.id, 'checkin')}
                          >
                            {busy[depKey('checkin')] ? t('saccos.loading') : (m.my_status ? t('saccos.meet_checked') : t('saccos.meet_checkin'))}
                          </button>
                        ) : null}
                        {isGoverning() && m.status === 'DRAFT' ? (
                          <button className="btn" disabled={!!busy[depKey('open')]} onClick={() => meetAction(m.id, 'open')}>
                            {busy[depKey('open')] ? t('saccos.loading') : t('saccos.meet_open')}
                          </button>
                        ) : null}
                        {isGoverning() && m.status === 'OPEN' ? (
                          <button className="btn" disabled={!!busy[depKey('close')]} onClick={() => meetAction(m.id, 'close')}>
                            {busy[depKey('close')] ? t('saccos.loading') : t('saccos.meet_close')}
                          </button>
                        ) : null}
                        {isGoverning() && m.status === 'CLOSED' ? (
                          <button className="btn ghost" onClick={() => toggleMeetDetail(m.id)}>
                            {t('saccos.meet_minutes')}
                          </button>
                        ) : (
                          <button className="btn ghost" onClick={() => toggleMeetDetail(m.id)}>
                            {open ? t('saccos.hide') : t('saccos.meet_attendance')}
                          </button>
                        )}
                      </div>
                    </div>

                    {open && detail ? (
                      <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                        <div>
                          <div className="muted" style={{ marginBottom: 6 }}>{t('saccos.meet_agenda_items')}</div>
                          {detail.agenda.length ? (
                            <ul>
                              {detail.agenda.map((a) => (
                                <li key={a.id} style={a.is_complete ? { textDecoration: 'line-through', color: 'var(--muted, #999)' } : {}}>
                                  {a.title}{a.notes ? <span className="muted"> — {a.notes}</span> : null}
                                </li>
                              ))}
                            </ul>
                          ) : <div className="muted">-</div>}
                        </div>
                        <div>
                          <div className="muted" style={{ marginBottom: 6 }}>{t('saccos.meet_attendance')} ({detail.attendance.length})</div>
                          {detail.attendance.length ? (
                            <ul>
                              {detail.attendance.map((a) => (
                                <li key={a.member_id}>
                                  {a.name} <span className="muted">· {a.member_number}</span> {a.is_me ? <span className="muted">({t('saccos.meet_my')})</span> : null}
                                  <StatusBadge status={a.status} />
                                </li>
                              ))}
                            </ul>
                          ) : <div className="muted">-</div>}
                        </div>
                      </div>
                    ) : null}

                    {open && isGoverning() && m.status === 'CLOSED' && detail ? (
                      <div style={{ marginTop: 12, borderTop: '1px solid var(--border, #e5e5e5)', paddingTop: 10 }}>
                        <div className="muted" style={{ marginBottom: 6 }}>{t('saccos.meet_agenda_items')} → {t('saccos.meet_minutes')}</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
                          {detail.agenda.map((a) => (
                            <label key={a.id} className="btn ghost" style={{ margin: 0 }}>
                              <input
                                type="checkbox"
                                checked={(minutesDone[m.id] || new Set()).has(a.id)}
                                onChange={() => toggleDone(m.id, a.id)}
                              />
                              {' '}{a.title}
                            </label>
                          ))}
                        </div>
                        <textarea
                          rows={3}
                          placeholder={t('saccos.meet_minutes')}
                          value={mins}
                          onChange={(e) => setMinutesDraft((prev) => ({ ...prev, [m.id]: e.target.value }))}
                          style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8 }}
                        />
                        <button
                          className="btn"
                          disabled={!!busy[depKey('minutes')] || !mins.trim()}
                          onClick={() => meetAction(m.id, 'minutes', { minutes: mins, agenda: [...(minutesDone[m.id] || [])] })}
                        >
                          {busy[depKey('minutes')] ? t('saccos.meet_publishing') : t('saccos.meet_minutes')}
                        </button>
                      </div>
                    ) : null}

                    {open && m.status === 'MINUTES_PUBLISHED' && detail && detail.meeting.minutes ? (
                      <div className="msg ok" style={{ marginTop: 10 }}>{detail.meeting.minutes}</div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}