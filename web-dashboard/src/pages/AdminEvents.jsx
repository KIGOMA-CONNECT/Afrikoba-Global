import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function AdminEvents() {
  const { t } = useT();
  const [tab, setTab] = useState('events');
  const [events, setEvents] = useState([]);
  const [search, setSearch] = useState('');
  const [wds, setWds] = useState({ withdrawals: [], flags: { requiresApproval: [] } });

  useEffect(() => { loadEvents(); loadWithdrawals(); }, []);

  const loadEvents = async () => {
    try { setEvents((await api.get('/admin/events')).data.events); } catch (_) {}
  };

  const loadWithdrawals = async () => {
    try { setWds((await api.get('/admin/events/withdrawals')).data); } catch (_) {}
  };

  const searchEvents = async () => {
    try { setEvents((await api.get(`/admin/events${search ? `?search=${encodeURIComponent(search)}` : ''}`)).data.events); } catch (_) {}
  };

  return (
    <>
      <div className="page-head">
        <h2>{t('nav.events_admin')}</h2>
        <p>{t('admin_events.sub')}</p>
      </div>

      <div style={{ display:'flex',gap:10,marginBottom:16 }}>
        {['events', 'withdrawals'].map((key) => (
          <button key={key} className={`btn ${tab === key ? '' : 'btn-secondary'}`} onClick={() => setTab(key)}>
            {t(key === 'events' ? 'admin_events.tab_events' : 'admin_events.tab_withdrawals')}
          </button>
        ))}
      </div>

      {tab === 'events' && (
        <div className="card section">
          <div style={{ display:'flex',gap:10,alignItems:'center',marginBottom:12 }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('admin_events.search_ph')} style={{ flex:1 }} />
            <button className="btn btn-secondary" onClick={searchEvents}>{t('admin_events.search')}</button>
          </div>
          <table>
            <thead><tr>
              <th>ID</th><th>{t('admin_events.th_name')}</th><th>{t('admin_events.th_owner')}</th>
              <th>{t('admin_events.th_type')}</th><th>{t('admin_events.th_status')}</th>
              <th>{t('admin_events.th_collected')}</th><th>{t('admin_events.th_goal')}</th>
              <th>{t('admin_events.th_members')}</th><th>{t('admin_events.th_donations')}</th>
            </tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{e.id}</td>
                  <td>{e.name}</td>
                  <td>{e.owner_name}<div className="roles-tag">{e.owner_phone}</div></td>
                  <td>{e.event_type}</td>
                  <td><StatusBadge status={e.status} /></td>
                  <td>{formatMoney(Number(e.collected_amount) + Number(e.savings_amount))}</td>
                  <td>{formatMoney(e.target_amount)}</td>
                  <td>{e.active_members}</td>
                  <td>{e.donations}</td>
                </tr>
              ))}
              {events.length === 0 && (
                <tr><td colSpan={9} style={{ textAlign:'center',color:'#9aa5a0' }}>{t('admin_events.empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'withdrawals' && (
        <div className="card section">
          <h3>{t('admin_events.wd_title')}</h3>
          <table>
            <thead><tr>
              <th>ID</th><th>{t('admin_events.th_event')}</th><th>{t('admin_events.th_requester')}</th>
              <th>{t('admin_events.th_recipient')}</th><th>{t('admin_events.th_mode')}</th>
              <th>{t('admin_events.th_amount')}</th><th>{t('admin_events.th_status')}</th>
              <th>{t('admin_events.th_4eyes')}</th><th>{t('admin_events.th_date')}</th>
            </tr></thead>
            <tbody>
              {wds.withdrawals.map((w) => (
                <tr key={w.id} style={wds.flags.requiresApproval.includes(w.id) ? { background:'#fff7ed' } : undefined}>
                  <td>{w.id}</td>
                  <td>{w.event_name}</td>
                  <td>{w.owner_name}</td>
                  <td>{w.recipient_name || '-'}</td>
                  <td>{w.mode}</td>
                  <td>{formatMoney(w.amount)}</td>
                  <td><StatusBadge status={w.status} /></td>
                  <td>{w.requires_approval ? '4-eyes' : '-'}</td>
                  <td>{new Date(w.created_at).toLocaleString('en-GB')}</td>
                </tr>
              ))}
              {wds.withdrawals.length === 0 && (
                <tr><td colSpan={9} style={{ textAlign:'center',color:'#9aa5a0' }}>{t('admin_events.empty_wd')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}