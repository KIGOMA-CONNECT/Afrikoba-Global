import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import ServiceLock from '../components/ServiceLock.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function Rosca() {
  const { t } = useT();
  const [pools, setPools] = useState([]);
  const [selected, setSelected] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [statusFilter, setStatusFilter] = useState('');

  const [pName, setPName] = useState('');
  const [pAmount, setPAmount] = useState('');
  const [pFreq, setPFreq] = useState('WEEKLY');
  const [pMembers, setPMembers] = useState('');
  const [pType, setPType] = useState('PUBLIC');
  const [wantEarly, setWantEarly] = useState(false);
  const [trust, setTrust] = useState(null);

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 5000);
  };

  const load = () => {
    const q = statusFilter ? `?status=${statusFilter}` : '';
    api.get(`/rosca/pools${q}`).then((r) => setPools(r.data.pools)).catch(() => {});
  };

  const loadTrust = () => {
    api.get('/rosca/trust/summary').then((r) => {
      setTrust({ totals: r.data.totals, history: r.data.history || [] });
    }).catch(() => {});
  };

  useEffect(load, [statusFilter]);
  useEffect(loadTrust, []);

  const createPool = async (e) => {
    e.preventDefault();
    try {
      await api.post('/rosca/pools', {
        poolName: pName, contributionAmount: pAmount, cycleFrequency: pFreq,
        totalMembers: pMembers, poolType: pType,
      });
      show('ok', t('rosca.pool_created'));
      setPName(''); setPAmount(''); setPMembers('');
      load();
    } catch (err) { show('err', err.response?.data?.message || t('rosca.error')); }
  };

  const openPool = async (id) => {
    const res = await api.get(`/rosca/pools/${id}`);
    setSelected(res.data.pool);
  };

  const joinPool = async (id) => {
    try {
      const res = await api.post(`/rosca/pools/${id}/join`, { wantEarlySlot: wantEarly });
      show('ok', res.data.message);
      openPool(id);
    } catch (err) { show('err', err.response?.data?.message || t('rosca.error')); }
  };

  return (
    <ServiceLock serviceKey="ROSCA">
      <div className="page-head">
        <h2>{t('rosca.title')}</h2>
        <p>{t('rosca.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="grid grid-2">
        <div className="card">
          <h3>{t('rosca.create_cycle')}</h3>
          <form className="form-row" onSubmit={createPool}>
            <div className="field"><label>{t('rosca.name')}</label><input value={pName} onChange={(e) => setPName(e.target.value)} required /></div>
            <div className="field"><label>{t('rosca.contribution')}</label><input type="number" value={pAmount} onChange={(e) => setPAmount(e.target.value)} required /></div>
            <div className="field"><label>{t('rosca.frequency')}</label>
              <select value={pFreq} onChange={(e) => setPFreq(e.target.value)}><option value="WEEKLY">Wiki</option><option value="MONTHLY">Mwezi</option></select>
            </div>
            <div className="field"><label>{t('rosca.member_count')}</label><input type="number" value={pMembers} onChange={(e) => setPMembers(e.target.value)} required /></div>
            <div className="field"><label>{t('rosca.type')}</label>
              <select value={pType} onChange={(e) => setPType(e.target.value)}><option value="PUBLIC">Wazi</option><option value="PRIVATE_KIKOBA">Kikundi (Kibinafsi)</option></select>
            </div>
            <button className="btn" type="submit">{t('rosca.create_btn')}</button>
          </form>
        </div>

        <div className="card">
          <h3>{t('rosca.available')}</h3>
          <div className="field" style={{ marginBottom: 10 }}>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">{t('rosca.filter_all')}</option>
              <option value="WAITING_MEMBERS">{t('rosca.filter_waiting')}</option>
              <option value="ACTIVE">{t('rosca.filter_active')}</option>
              <option value="COMPLETED">{t('rosca.filter_completed')}</option>
            </select>
          </div>
          {pools.length === 0 && <p className="roles-tag">{t('rosca.no_pools')}</p>}
          {pools.map((p) => (
            <div key={p.id} className="inline-actions" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div>
                <strong>{p.pool_name}</strong>
                <div className="roles-tag">{formatMoney(p.contribution_amount)} · {p.cycle_frequency} · {p.current_members}/{p.total_members}</div>
              </div>
              <div className="inline-actions">
                <StatusBadge status={p.status} />
                <button className="btn ghost" onClick={() => openPool(p.id)}>{t('rosca.open')}</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {trust && (
        <div className="card section">
          <h3>{t('rosca.trust_title')}</h3>
          <p className="roles-tag" style={{ marginBottom: 14 }}>{t('rosca.trust_sub')}</p>
          <div className="grid grid-3">
            <div className="stat"><div className="value">{trust.totals?.contributions_ok ?? 0}</div><div className="label">{t('rosca.trust_ok')}</div></div>
            <div className="stat"><div className="value">{trust.totals?.contributions_missed ?? 0}</div><div className="label">{t('rosca.trust_missed')}</div></div>
            <div className="stat"><div className="value">{trust.totals?.best_streak ?? 0}</div><div className="label">{t('rosca.trust_streak')}</div></div>
          </div>

          <h3 style={{ margin: '22px 0 8px' }}>{t('rosca.trust_history')}</h3>
          <table>
            <thead><tr><th>{t('rosca.trust_h_pool')}</th><th>{t('rosca.trust_h_cycle')}</th><th>{t('rosca.trust_h_reason')}</th><th>{t('rosca.trust_h_delta')}</th><th>{t('rosca.trust_h_score')}</th><th>{t('rosca.trust_h_date')}</th></tr></thead>
            <tbody>
              {trust.history.map((h, i) => (
                <tr key={i}>
                  <td>{h.pool_name || `#${h.pool_id ?? ''}`}</td>
                  <td>{h.cycle_number ? `#${h.cycle_number}` : '-'}</td>
                  <td>{t(`rosca.reason.${h.reason}`)}</td>
                  <td style={{ color: Number(h.delta) >= 0 ? 'inherit' : 'var(--red, #d33)' }}>{Number(h.delta) > 0 ? `+${h.delta}` : h.delta}</td>
                  <td>{h.score_after}</td>
                  <td>{new Date(h.created_at).toLocaleDateString('en-GB')}</td>
                </tr>
              ))}
              {trust.history.length === 0 && <tr><td colSpan="6" className="roles-tag">{t('rosca.trust_no_history')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

        <div className="card section">
          <h3>{selected.pool_name} <span className="roles-tag" style={{ marginLeft: 8 }}>{selected.pool_type}</span></h3>
          {selected.status === 'WAITING_MEMBERS' && (
            <div className="inline-actions" style={{ marginBottom: 14 }}>
              <button className="btn" onClick={() => joinPool(selected.id)}>{t('rosca.join_cycle')}</button>
              <label className="roles-tag" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={wantEarly} onChange={(e) => setWantEarly(e.target.checked)} />
                {t('rosca.early_slot')}
              </label>
            </div>
          )}

          <h3 style={{ marginBottom: 8 }}>{t('rosca.members_title')}</h3>
          <table>
            <thead><tr><th>{t('rosca.m_th_num')}</th><th>{t('rosca.m_th_name')}</th><th>{t('rosca.m_th_phone')}</th><th>{t('rosca.m_th_trust')}</th><th>{t('rosca.m_th_received')}</th></tr></thead>
            <tbody>
              {selected.members.map((m) => (
                <tr key={m.assigned_queue_number}>
                  <td><strong>{m.assigned_queue_number}</strong></td>
                  <td>{m.full_name}</td>
                  <td>{m.phone_number}</td>
                  <td>{m.trust_score}</td>
                  <td>{m.has_received_payout ? t('rosca.yes') : t('rosca.no')}</td>
                </tr>
              ))}
              {selected.members.length === 0 && <tr><td colSpan="5" className="roles-tag">{t('rosca.no_members')}</td></tr>}
            </tbody>
          </table>

          <h3 style={{ margin: '22px 0 8px' }}>{t('rosca.schedules')}</h3>
          <table>
            <thead><tr><th>{t('rosca.s_th_cycle')}</th><th>{t('rosca.s_th_recipient')}</th><th>{t('rosca.s_th_date')}</th><th>{t('rosca.s_th_total')}</th><th>{t('rosca.s_th_fee')}</th><th>{t('rosca.s_th_status')}</th></tr></thead>
            <tbody>
              {selected.schedules.map((s) => (
                <tr key={s.id}>
                  <td>#{s.cycle_number}</td>
                  <td>{s.recipient_user_id}</td>
                  <td>{new Date(s.scheduled_date).toLocaleDateString('en-GB')}</td>
                  <td>{formatMoney(s.total_payout_amount)}</td>
                  <td>{formatMoney(s.comm_amount)}</td>
                  <td><StatusBadge status={s.status} /></td>
                </tr>
              ))}
              {selected.schedules.length === 0 && <tr><td colSpan="6" className="roles-tag">{t('rosca.no_schedules')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </ServiceLock>
  );
}
