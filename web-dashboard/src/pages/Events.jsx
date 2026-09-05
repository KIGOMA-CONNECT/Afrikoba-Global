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
      });
      show('ok', res.data.message || t('events.contributed'));
      setContributeAmt('');
      load();
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