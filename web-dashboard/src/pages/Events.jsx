import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

const EVENT_TYPES = [
  'HARUSI', 'SEND_OFF', 'BIRTHDAY', 'GRADUATION', 'MAHAFALI', 'KIPAIMARA',
  'COMMUNION', 'KITCHEN_PARTY', 'BABY_SHOWER', 'FAMILY', 'UKOO', 'MTAJI',
  'REUNION', 'TAASISI', 'KIUNDU', 'COMMUNITY', 'OTHER',
];
const OWNER_TYPES = ['INDIVIDUAL', 'COUPLE', 'FAMILY', 'CLAN', 'GROUP', 'ORGANIZATION'];
const SAVINGS_CADENCE = ['', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM'];
const SURPLUS_RULES = ['DONOR_CHOICE', 'EVENT_SURPLUS_RETURN', 'KEEP_FOR_OWNER', 'CHARITY'];

export default function Events() {
  const { t } = useT();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');

  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [contributions, setContributions] = useState([]);
  const [budgetItems, setBudgetItems] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const [name, setName] = useState('');
  const [eventType, setEventType] = useState('HARUSI');
  const [desc, setDesc] = useState('');
  const [ownerType, setOwnerType] = useState('INDIVIDUAL');
  const [target, setTarget] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [deadline, setDeadline] = useState('');
  const [cadence, setCadence] = useState('');
  const [sessionAmt, setSessionAmt] = useState('');
  const [suggested, setSuggested] = useState('');
  const [minimum, setMinimum] = useState('');
  const [surplus, setSurplus] = useState('DONOR_CHOICE');

  const [contributeAmt, setContributeAmt] = useState('');
  const [contributeMode, setContributeMode] = useState('FUNDRAISING');
  const [budgetCat, setBudgetCat] = useState('');
  const [budgetDesc, setBudgetDesc] = useState('');
  const [budgetAmt, setBudgetAmt] = useState('');

  const [commitments, setCommitments] = useState([]);
  const [plans, setPlans] = useState([]);
  const [commitAmt, setCommitAmt] = useState('');
  const [commitNote, setCommitNote] = useState('');
  const [conPlanId, setConPlanId] = useState('');
  const [conCommitmentId, setConCommitmentId] = useState('');
  const [planName, setPlanName] = useState('');
  const [planTarget, setPlanTarget] = useState('');
  const [planCadence, setPlanCadence] = useState('WEEKLY');
  const [planSession, setPlanSession] = useState('');

  const [withdrawals, setWithdrawals] = useState([]);
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [withdrawAmt, setWithdrawAmt] = useState('');
  const [withdrawMode, setWithdrawMode] = useState('FUNDRAISING');
  const [withdrawTo, setWithdrawTo] = useState('');
  const [memberPhone, setMemberPhone] = useState('');

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 5000);
  };

  const load = () => {
    api.get('/events').then((r) => setEvents(r.data.events)).catch(() => {});
  };

  useEffect(() => { load(); }, []);

  const selectEvent = async (ev) => {
    setSelected(ev);
    try {
      const d = await api.get(`/events/${ev.id}/dashboard`);
      setDashboard(d.data.dashboard);
    } catch { setDashboard(null); }
    try {
      const c = await api.get(`/events/${ev.id}/contributions?limit=50`);
      setContributions(c.data.contributions);
    } catch { setContributions([]); }
    try {
      const b = await api.get(`/events/${ev.id}/budget`);
      setBudgetItems(b.data.items);
    } catch { setBudgetItems([]); }
    try {
      const cm = await api.get(`/events/${ev.id}/commitments`);
      setCommitments(cm.data.commitments);
    } catch { setCommitments([]); }
    try {
      const sp = await api.get(`/events/${ev.id}/savings-plans`);
      setPlans(sp.data.plans);
    } catch { setPlans([]); }
    try {
      const wd = await api.get(`/events/${ev.id}/withdrawals`);
      setWithdrawals(wd.data.withdrawals);
    } catch { setWithdrawals([]); }
    try {
      const mb = await api.get(`/events/${ev.id}/members`);
      setMembers(mb.data.members);
    } catch { setMembers([]); }
    try {
      const iv = await api.get(`/events/${ev.id}/invites`);
      setInvites(iv.data.invites);
    } catch { setInvites([]); }
    try {
      const rm = await api.get(`/events/${ev.id}/reminders`);
      setReminders(rm.data.reminders);
    } catch { setReminders([]); }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const resetForm = () => {
    setName(''); setEventType('HARUSI'); setDesc(''); setOwnerType('INDIVIDUAL');
    setTarget(''); setEventDate(''); setDeadline(''); setCadence(''); setSessionAmt('');
    setSuggested(''); setMinimum(''); setSurplus('DONOR_CHOICE');
  };

  const rules = () => {
    const r = { surplusRule: surplus };
    if (suggested) r.suggested = Number(suggested);
    if (minimum) r.minimum = Number(minimum);
    return r;
  };

  const createEvent = async (e) => {
    e.preventDefault();
    try {
      const ev = await api.post('/events', {
        name, eventType, description: desc || undefined, ownerType,
        targetAmount: Number(target), eventDate: eventDate || undefined,
        contributionDeadline: deadline || undefined,
        savingsCadence: cadence || undefined,
        savingsSessionAmount: sessionAmt ? Number(sessionAmt) : undefined,
        rules: rules(),
      });
      show('ok', t('events.created'));
      resetForm();
      load();
      selectEvent(ev.data.event);
    } catch (err) { show('err', err.response?.data?.message || t('events.error')); }
  };

  const contribute = async (e) => {
    e.preventDefault();
    if (!contributeAmt) { show('err', t('events.enter_amount')); return; }
    try {
      const res = await api.post(`/events/${selected.id}/contributions`, {
        amount: Number(contributeAmt), mode: contributeMode,
        planId: conPlanId ? Number(conPlanId) : undefined,
        commitmentId: conCommitmentId ? Number(conCommitmentId) : undefined,
      });
      show('ok', res.data.message || t('events.contributed'));
      setContributeAmt(''); setConPlanId(''); setConCommitmentId('');
      load();
      selectEvent(selected);
    } catch (err) { show('err', err.response?.data?.message || t('events.error')); }
  };

  const makeCommitment = async (e) => {
    e.preventDefault();
    if (!commitAmt) { show('err', t('events.enter_amount')); return; }
    try {
      await api.post(`/events/${selected.id}/commitments`, {
        amount: Number(commitAmt), note: commitNote || undefined,
      });
      show('ok', t('events.commit_created'));
      setCommitAmt(''); setCommitNote('');
      selectEvent(selected);
    } catch (err) { show('err', err.response?.data?.message || t('events.error')); }
  };

  const cancelCommit = async (cid) => {
    try {
      await api.post(`/events/${selected.id}/commitments/${cid}/cancel`);
      show('ok', t('events.commit_cancelled'));
      selectEvent(selected);
    } catch (err) { show('err', err.response?.data?.message || t('events.error')); }
  };

  const createPlan = async (e) => {
    e.preventDefault();
    if (!planName || !planTarget || !planSession) { show('err', t('events.plan_required')); return; }
    try {
      await api.post(`/events/${selected.id}/savings-plans`, {
        name: planName, targetAmount: Number(planTarget),
        cadence: planCadence, sessionAmount: Number(planSession),
      });
      show('ok', t('events.plan_created'));
      setPlanName(''); setPlanTarget(''); setPlanCadence('WEEKLY'); setPlanSession('');
      selectEvent(selected);
    } catch (err) { show('err', err.response?.data?.message || t('events.error')); }
  };

  const closePlan = async (pid) => {
    try {
      await api.post(`/events/${selected.id}/savings-plans/${pid}/close`);
      show('ok', t('events.plan_closed'));
      selectEvent(selected);
    } catch (err) { show('err', err.response?.data?.message || t('events.error')); }
  };

  const requestWithdraw = async (e) => {
    e.preventDefault();
    if (!withdrawAmt) { show('err', t('events.enter_amount')); return; }
    try {
      const res = await api.post(`/events/${selected.id}/withdrawals`, {
        amount: Number(withdrawAmt), mode: withdrawMode,
        toUserId: withdrawTo ? Number(withdrawTo) : undefined,
      });
      show('ok', res.data.message || t('events.withdraw_requested'));
      setWithdrawAmt('');
      selectEvent(selected);
    } catch (err) { show('err', err.response?.data?.message || t('events.error')); }
  };

  const cancelWithdraw = async (wid) => {
    try {
      await api.post(`/events/${selected.id}/withdrawals/${wid}/cancel`);
      show('ok', t('events.withdraw_cancelled'));
      selectEvent(selected);
    } catch (err) { show('err', err.response?.data?.message || t('events.error')); }
  };

  const generateInvite = async () => {
    try {
      const res = await api.post(`/events/${selected.id}/invites`, { maxUses: 100 });
      show('ok', t('events.invite_created'));
      selectEvent(selected);
      if (navigator.clipboard) {
        navigator.clipboard.writeText(res.data.invite.code).catch(() => {});
      }
    } catch (err) { show('err', err.response?.data?.message || t('events.error')); }
  };

  const copyInvite = (code) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).then(() => show('ok', t('events.copied'))).catch(() => {});
    }
  };

  const addMember = async (e) => {
    e.preventDefault();
    if (!memberPhone) { show('err', t('events.enter_phone')); return; }
    try {
      await api.post(`/events/${selected.id}/members`, { phoneNumber: memberPhone });
      show('ok', t('events.member_added'));
      setMemberPhone('');
      selectEvent(selected);
    } catch (err) { show('err', err.response?.data?.message || t('events.error')); }
  };

  const removeMember = async (mid) => {
    try {
      await api.delete(`/events/${selected.id}/members/${mid}`);
      show('ok', t('events.member_removed'));
      selectEvent(selected);
    } catch (err) { show('err', err.response?.data?.message || t('events.error')); }
  };

  const addBudget = async (e) => {
    e.preventDefault();
    if (!budgetCat || !budgetAmt) { show('err', t('events.budget_required')); return; }
    try {
      await api.post(`/events/${selected.id}/budget`, {
        category: budgetCat, description: budgetDesc || undefined, amount: Number(budgetAmt),
      });
      show('ok', t('events.budget_added'));
      setBudgetCat(''); setBudgetDesc(''); setBudgetAmt('');
      selectEvent(selected);
    } catch (err) { show('err', err.response?.data?.message || t('events.error')); }
  };

  const removeBudget = async (itemId) => {
    try {
      await api.delete(`/events/${selected.id}/budget/${itemId}`);
      show('ok', t('events.budget_removed'));
      selectEvent(selected);
    } catch (err) { show('err', err.response?.data?.message || t('events.error')); }
  };

  const isOwner = selected && Number(selected.owner_user_id) === Number(user.id);

  const updateStatus = async (status) => {
    try {
      await api.patch(`/events/${selected.id}`, { status });
      show('ok', status === 'CLOSED' ? t('events.closed') : t('events.cancelled'));
      load();
      selectEvent(selected);
    } catch (err) { show('err', err.response?.data?.message || t('events.error')); }
  };

  const isActive = selected && selected.status === 'ACTIVE';

  const myPledges = (commitments || []).filter(
    (c) => Number(c.userId) === Number(user.id) && c.status !== 'CANCELLED' && c.status !== 'FULFILLED'
  );

  return (
    <div>
      <div className="page-head">
        <h2>{t('events.title')}</h2>
        <p>{t('events.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      {!selected && (
        <div className="grid grid-2">
          <div className="card">
            <h3>{t('events.create_title')}</h3>
            <form onSubmit={createEvent}>
              <div className="field" style={{ marginBottom: 10 }}><label>{t('events.name')}</label><input value={name} onChange={(e) => setName(e.target.value)} required /></div>
              <div className="form-row">
                <div className="field"><label>{t('events.type')}</label>
                  <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
                    {EVENT_TYPES.map((et) => <option key={et} value={et}>{et}</option>)}
                  </select>
                </div>
                <div className="field"><label>{t('events.owner_type')}</label>
                  <select value={ownerType} onChange={(e) => setOwnerType(e.target.value)}>
                    {OWNER_TYPES.map((ot) => <option key={ot} value={ot}>{ot}</option>)}
                  </select>
                </div>
              </div>
              <div className="field" style={{ marginBottom: 10 }}><label>{t('events.description')}</label><textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} /></div>
              <div className="form-row">
                <div className="field"><label>{t('events.target')}</label><input type="number" min="1" value={target} onChange={(e) => setTarget(e.target.value)} required /></div>
                <div className="field"><label>{t('events.event_date')}</label><input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} /></div>
                <div className="field"><label>{t('events.deadline')}</label><input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></div>
              </div>
              <div className="form-row">
                <div className="field"><label>{t('events.savings_cadence')}</label>
                  <select value={cadence} onChange={(e) => setCadence(e.target.value)}>
                    {SAVINGS_CADENCE.map((sc) => <option key={sc} value={sc}>{sc === '' ? t('events.no_savings') : sc}</option>)}
                  </select>
                </div>
                <div className="field"><label>{t('events.session_amount')}</label><input type="number" min="1" value={sessionAmt} onChange={(e) => setSessionAmt(e.target.value)} /></div>
                <div className="field"><label>{t('events.suggested')}</label><input type="number" min="1" value={suggested} onChange={(e) => setSuggested(e.target.value)} /></div>
              </div>
              <div className="form-row">
                <div className="field"><label>{t('events.minimum')}</label><input type="number" min="1" value={minimum} onChange={(e) => setMinimum(e.target.value)} /></div>
                <div className="field"><label>{t('events.surplus')}</label>
                  <select value={surplus} onChange={(e) => setSurplus(e.target.value)}>
                    {SURPLUS_RULES.map((sr) => <option key={sr} value={sr}>{sr}</option>)}
                  </select>
                </div>
              </div>
              <button className="btn" type="submit">{t('events.create_btn')}</button>
            </form>
          </div>

          <div className="card section">
            <h3>{t('events.my_events')}</h3>
            {events.length === 0 && <p className="roles-tag">{t('events.no_events')}</p>}
            {events.map((ev) => (
              <div key={ev.id} className="list-item" onClick={() => selectEvent(ev)} style={{ cursor: 'pointer' }}>
                <div>
                  <strong>{ev.name}</strong> <span className="roles-tag">{ev.event_type}</span>
                </div>
                <div className="roles-tag">{t('events.target')}: {formatMoney(ev.target_amount)} · {formatMoney(Number(ev.fundraising_raised) + Number(ev.savings_raised))} imekusanywa</div>
                <div style={{ opacity: 0.8 }}>{ev.status} · {t('events.contributors')}: {ev.donation_count}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {selected && dashboard && (
        <div className="grid grid-2">
          <div className="card">
            <h3>{dashboard.event.name} <span className="roles-tag">{dashboard.event.eventType}</span> <StatusBadge status={dashboard.event.status} /></h3>
            <p>{dashboard.event.description}</p>
            <p className="roles-tag">{t('events.event_on')}: {dashboard.event.eventDate || '-'} · {t('events.deadline')}: {dashboard.event.contributionDeadline || '-'}</p>
            <button className="btn" style={{ marginTop: 8 }} onClick={() => setSelected(null)}>{t('events.back')}</button>
            {isOwner && isActive && (
              <div className="inline-actions" style={{ marginTop: 8 }}>
                <button className="btn warn" onClick={() => updateStatus('CLOSED')}>{t('events.close')}</button>
                <button className="btn warn" onClick={() => updateStatus('CANCELLED')}>{t('events.cancel')}</button>
              </div>
            )}
          </div>

          <div className="card">
            <h3>{t('events.dashboard_title')}</h3>
            <div className="stat-row">
              <div className="stat-box"><strong>{formatMoney(dashboard.summary.target)}</strong><span>{t('events.target')}</span></div>
              <div className="stat-box"><strong>{formatMoney(dashboard.summary.collected.total)}</strong><span>{t('events.collected')}</span></div>
              <div className="stat-box"><strong>{formatMoney(dashboard.summary.remaining)}</strong><span>{t('events.remaining')}</span></div>
            </div>
            <div className="stat-row">
              <div className="stat-box"><strong>{formatMoney(dashboard.commitments.total)}</strong><span>{t('events.pledged')}</span></div>
              <div className="stat-box"><strong>{formatMoney(dashboard.commitments.outstanding)}</strong><span>{t('events.outstanding')}</span></div>
              <div className="stat-box"><strong>{dashboard.savingsPlans.length}</strong><span>{t('events.plans_count')}</span></div>
            </div>
            <div className="stat-row">
              <div className="stat-box"><strong>{dashboard.participants.members}</strong><span>{t('events.members')}</span></div>
              <div className="stat-box"><strong>{dashboard.participants.invitesActive}</strong><span>{t('events.invites_active')}</span></div>
              <div className="stat-box"><strong>{formatMoney(dashboard.withdrawals?.FUNDRAISING?.paid || 0)}</strong><span>{t('events.withdrawn')}</span></div>
            </div>
            <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.min(dashboard.summary.progress, 100)}%` }} /></div>
            <p>{t('events.progress')}: {dashboard.summary.progress}% · {dashboard.stats.contributors} {t('events.contributors').toLowerCase()} · {dashboard.stats.donations} {t('events.donations').toLowerCase()}</p>
            <div className="form-row">
              <div className="field"><label>{t('events.fundraising')}</label><div>{formatMoney(dashboard.summary.collected.fundraising)}</div></div>
              <div className="field"><label>{t('events.savings_raised')}</label><div>{formatMoney(dashboard.summary.collected.savings)}</div></div>
              <div className="field"><label>{t('events.budget_total')}</label><div>{formatMoney(dashboard.budget.total)}</div></div>
            </div>
            <div className="form-row">
              {dashboard.budget.categories.map((c) => (
                <div className="field" key={c.category}><label>{c.category}</label><div>{formatMoney(c.total)}</div></div>
              ))}
            </div>
          </div>
        </div>
      )}

      {selected && dashboard && (
        <div className="grid grid-2">
          <div className="card">
            <h3>{t('events.contribute_title')}</h3>
            <form onSubmit={contribute}>
              <div className="form-row">
                <div className="field"><label>{t('events.amount')}</label><input type="number" min="1" value={contributeAmt} onChange={(e) => setContributeAmt(e.target.value)} required /></div>
                <div className="field"><label>{t('events.mode')}</label>
                  <select value={contributeMode} onChange={(e) => setContributeMode(e.target.value)}>
                    <option value="FUNDRAISING">{t('events.mode_fundraising')}</option>
                    <option value="SAVINGS">{t('events.mode_savings')}</option>
                  </select>
                </div>
                {contributeMode === 'SAVINGS' && (
                  <div className="field"><label>{t('events.select_plan')}</label>
                    <select value={conPlanId} onChange={(e) => setConPlanId(e.target.value)}>
                      <option value="">-</option>
                      {plans.filter((p) => p.status === 'ACTIVE').map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                {myPledges.length > 0 && (
                  <div className="field"><label>{t('events.select_commitment')}</label>
                    <select value={conCommitmentId} onChange={(e) => setConCommitmentId(e.target.value)}>
                      <option value=""></option>
                      {myPledges.map((p) => (
                        <option key={p.id} value={p.id}>{formatMoney(p.amount)} · {p.status}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              {!isActive && <p className="roles-tag">{t('events.not_accepting')}</p>}
              <button className="btn" type="submit" disabled={!isActive}>{t('events.contribute_btn')}</button>
            </form>
          </div>

          <div className="card">
            <h3>{t('events.budget_title')}</h3>
            <form onSubmit={addBudget}>
              <div className="form-row">
                <div className="field"><label>{t('events.budget_category')}</label><input value={budgetCat} onChange={(e) => setBudgetCat(e.target.value)} required /></div>
                <div className="field"><label>{t('events.budget_amount')}</label><input type="number" min="1" value={budgetAmt} onChange={(e) => setBudgetAmt(e.target.value)} required /></div>
              </div>
              <div className="field" style={{ marginBottom: 10 }}><label>{t('events.budget_description')}</label><input value={budgetDesc} onChange={(e) => setBudgetDesc(e.target.value)} /></div>
              {isOwner ? (
                <button className="btn" type="submit">{t('events.budget_add')}</button>
              ) : (
                <p className="roles-tag">{t('events.owner_only')}</p>
              )}
            </form>
            {budgetItems.length > 0 && (
              <table style={{ marginTop: 10 }}>
                <thead><tr><th>{t('events.budget_category')}</th><th>{t('events.budget_description')}</th><th>{t('events.budget_amount')}</th>{isOwner && <th></th>}</tr></thead>
                <tbody>
                  {budgetItems.map((bi) => (
                    <tr key={bi.id}>
                      <td>{bi.category}</td>
                      <td>{bi.description || '-'}</td>
                      <td>{formatMoney(bi.amount)}</td>
                      {isOwner && <td><button className="btn warn" onClick={() => removeBudget(bi.id)}>x</button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {selected && dashboard && (
        <div className="card section">
          <h3>{t('events.commitments_title')}</h3>
          <form onSubmit={makeCommitment} className="form-row" style={{ marginBottom: 10 }}>
            <div className="field"><label>{t('events.commit_amount')}</label><input type="number" min="1" value={commitAmt} onChange={(e) => setCommitAmt(e.target.value)} required /></div>
            <div className="field"><label>{t('events.commit_note')}</label><input value={commitNote} onChange={(e) => setCommitNote(e.target.value)} /></div>
            {isActive && <button className="btn" type="submit" style={{ alignSelf: 'end' }}>{t('events.commit_btn')}</button>}
          </form>
          {commitments.length === 0 && <p className="roles-tag">{t('events.no_commitments')}</p>}
          <table>
            <thead><tr><th>{t('events.contributor')}</th><th>{t('events.commit_amount')}</th><th>{t('events.fulfilled')}</th><th>{t('events.commit_status')}</th><th>{t('events.note')}</th>{isOwner && <th></th>}</tr></thead>
            <tbody>
              {commitments.map((c) => (
                <tr key={c.id}>
                  <td>{c.userName}</td>
                  <td>{formatMoney(c.amount)}</td>
                  <td>{formatMoney(c.fulfilled)}</td>
                  <td><StatusBadge status={c.status} /></td>
                  <td>{c.note || '-'}</td>
                  <td>
                    {(isOwner || Number(c.userId) === Number(user.id)) && c.status === 'PENDING' && (
                      <button className="btn warn" onClick={() => cancelCommit(c.id)}>{t('events.commit_cancel')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && dashboard && (
        <div className="card section">
          <h3>{t('events.plan_title')}</h3>
          {isOwner && (
            <form onSubmit={createPlan} className="form-row" style={{ marginBottom: 10 }}>
              <div className="field"><label>{t('events.plan_name')}</label><input value={planName} onChange={(e) => setPlanName(e.target.value)} required /></div>
              <div className="field"><label>{t('events.plan_target')}</label><input type="number" min="1" value={planTarget} onChange={(e) => setPlanTarget(e.target.value)} required /></div>
              <div className="field"><label>{t('events.plan_cadence')}</label>
                <select value={planCadence} onChange={(e) => setPlanCadence(e.target.value)}>
                  {['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'].map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="field"><label>{t('events.plan_session')}</label><input type="number" min="1" value={planSession} onChange={(e) => setPlanSession(e.target.value)} required /></div>
              <button className="btn" type="submit" style={{ alignSelf: 'end' }}>{t('events.plan_create_btn')}</button>
            </form>
          )}
          {plans.length === 0 && <p className="roles-tag">{t('events.no_plans')}</p>}
          {plans.map((p) => {
            const pct = p.targetAmount > 0 ? Math.min(Math.round((p.collected / p.targetAmount) * 100), 100) : 0;
            return (
              <div key={p.id} className="list-item">
                <div>
                  <strong>{p.name}</strong> <span className="roles-tag">{p.status}</span>
                  <div className="progress-track" style={{ maxWidth: 260, marginTop: 4 }}><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
                  <div className="roles-tag">
                    {t('events.plan_target')}: {formatMoney(p.targetAmount)} · {t('events.collected')}: {formatMoney(p.collected)} ({pct}%)
                  </div>
                </div>
                {isOwner && p.status === 'ACTIVE' && (
                  <button className="btn warn" onClick={() => closePlan(p.id)}>{t('events.plan_close')}</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {selected && dashboard && (
        <div className="grid grid-2">
          <div className="card">
            <h3>{t('events.members_title')}</h3>
            {isOwner ? (
              <>
                <p className="roles-tag">{t('events.invite_hint')}</p>
                {invites.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0', flexWrap: 'wrap' }}>
                    {invites.slice(0, 3).map((iv) => (
                      <span key={iv.id} className="roles-tag" style={{ cursor: 'pointer' }} onClick={() => copyInvite(iv.code)} title={t('events.copied')}>
                        <strong>{iv.code}</strong> · {iv.uses}/{iv.maxUses} <StatusBadge status={iv.status} />
                      </span>
                    ))}
                  </div>
                )}
                <button className="btn" onClick={generateInvite}>{t('events.invite_create')}</button>
                <form onSubmit={addMember} className="form-row" style={{ marginTop: 10 }}>
                  <div className="field"><label>{t('events.add_member_phone')}</label><input value={memberPhone} onChange={(e) => setMemberPhone(e.target.value)} placeholder="07XXXXXXXX" required /></div>
                  <button className="btn" type="submit" style={{ alignSelf: 'end' }}>{t('events.member_add')}</button>
                </form>
              </>
            ) : (
              <p className="roles-tag">{t('events.owner_only')}</p>
            )}
            {members.length > 0 && (
              <table style={{ marginTop: 10 }}>
                <thead><tr><th>{t('events.member_name')}</th><th>{t('events.member_role')}</th><th>{t('events.member_joined')}</th>{isOwner && <th></th>}</tr></thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.userId}>
                      <td>{m.userName} {m.userId === user.id && '· wewe'}</td>
                      <td><StatusBadge status={m.role} /></td>
                      <td>{m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : '-'}</td>
                      {isOwner && m.role !== 'OWNER' && (
                        <td><button className="btn warn" onClick={() => removeMember(m.userId)}>{t('events.member_remove')}</button></td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <h3>{t('events.withdraw_title')}</h3>
            {isOwner ? (
              <form onSubmit={requestWithdraw} className="form-row" style={{ marginBottom: 10 }}>
                <div className="field"><label>{t('events.withdraw_mode')}</label>
                  <select value={withdrawMode} onChange={(e) => setWithdrawMode(e.target.value)}>
                    <option value="FUNDRAISING">{t('events.mode_fundraising')}</option>
                    <option value="SAVINGS">{t('events.mode_savings')}</option>
                  </select>
                </div>
                <div className="field"><label>{t('events.amount')}</label>
                  <input type="number" min="1" value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)} required />
                </div>
                <div className="field"><label>{t('events.withdraw_to')}</label>
                  <select value={withdrawTo} onChange={(e) => setWithdrawTo(e.target.value)}>
                    <option value="">{t('events.withdraw_to_owner')}</option>
                    {members.filter((m) => m.userId !== user.id).map((m) => (
                      <option key={m.userId} value={m.userId}>{m.userName}</option>
                    ))}
                  </select>
                </div>
                <button className="btn" type="submit" style={{ alignSelf: 'end' }}>{t('events.withdraw_btn')}</button>
              </form>
            ) : (
              <p className="roles-tag">{t('events.owner_only')}</p>
            )}
            <div className="form-row">
              <div className="field"><label>{t('events.fundraising')} · {t('events.withdraw_available')}</label><div>{formatMoney(dashboard.withdrawals?.FUNDRAISING?.available || 0)}</div></div>
              <div className="field"><label>{t('events.savings_raised')} · {t('events.withdraw_available')}</label><div>{formatMoney(dashboard.withdrawals?.SAVINGS?.available || 0)}</div></div>
            </div>
            {withdrawals.length > 0 && (
              <table style={{ marginTop: 10 }}>
                <thead><tr><th>{t('events.mode')}</th><th>{t('events.amount')}</th><th>{t('events.recipient')}</th><th>{t('events.commit_status')}</th><th>{t('events.date')}</th>{isOwner && <th></th>}</tr></thead>
                <tbody>
                  {withdrawals.map((w) => (
                    <tr key={w.id}>
                      <td>{w.mode}</td>
                      <td>{formatMoney(w.amount)}</td>
                      <td>{w.recipient}</td>
                      <td>{w.status}{w.requiresApproval && <span className="roles-tag"> 4-eyes</span>}</td>
                      <td>{new Date(w.created_at).toLocaleDateString()}</td>
                      {isOwner && w.status === 'PENDING' && (
                        <td><button className="btn warn" onClick={() => cancelWithdraw(w.id)}>{t('events.withdraw_cancel')}</button></td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {reminders.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <h4>{t('events.reminders_title')}</h4>
                {reminders.slice(0, 5).map((r) => (
                  <div key={r.id} className="list-item" style={{ padding: '6px 0' }}>
                    <div>
                      <strong>{r.type}</strong> <span className="roles-tag">{r.sent_date}</span>
                    </div>
                    <div className="roles-tag">{r.recipient_name || '-'} · {r.channel}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {selected && dashboard && (
        <div className="card section">
          <h3>{t('events.contributions_title')}</h3>
          {contributions.length === 0 && <p className="roles-tag">{t('events.no_contributions')}</p>}
          <table>
            <thead><tr><th>{t('events.contributor')}</th><th>{t('events.mode')}</th><th>{t('events.amount')}</th><th>{t('events.reference')}</th><th>{t('events.date')}</th></tr></thead>
            <tbody>
              {contributions.map((c) => (
                <tr key={c.id}>
                  <td>{c.contributor}</td>
                  <td>{c.mode}</td>
                  <td>{formatMoney(c.amount)}</td>
                  <td className="roles-tag">{c.reference_id}</td>
                  <td>{new Date(c.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}