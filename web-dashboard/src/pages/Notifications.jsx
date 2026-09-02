import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

export default function Notifications() {
  const { t } = useT();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 3000);
  };

  const load = () => {
    api.get('/notifications', { params: { page, limit: 20, unreadOnly } })
      .then((r) => {
        setNotifications(r.data.notifications);
        setTotalPages(r.data.totalPages);
      })
      .catch(() => {});
    api.get('/notifications/unread-count')
      .then((r) => setUnreadCount(r.data.count))
      .catch(() => {});
  };

  useEffect(load, [page, unreadOnly]);

  const markRead = async (id) => {
    await api.put(`/notifications/${id}/read`);
    load();
  };

  const markAllRead = async () => {
    const res = await api.put('/notifications/read-all');
    show('ok', t('notifications.read_all_msg', { count: res.data.count }));
    load();
  };

  const typeColors = {
    INFO: 'info',
    TRANSACTION: 'success',
    VICOBA: 'success',
    ROSCA: 'info',
    P2P: 'info',
    SECURITY: 'failed',
    PROMO: 'pending',
  };

  return (
    <>
      <div className="page-head">
        <h2>{t('notifications.title')}</h2>
        <p>{t('notifications.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="inline-actions" style={{ justifyContent: 'space-between' }}>
          <div className="inline-actions">
            <button className={`btn ${!unreadOnly ? '' : 'ghost'}`} onClick={() => { setUnreadOnly(false); setPage(1); }}>{t('notifications.all')}</button>
            <button className={`btn ${unreadOnly ? '' : 'ghost'}`} onClick={() => { setUnreadOnly(true); setPage(1); }}>
              {t('notifications.unread', { count: unreadCount })}
            </button>
          </div>
          <button className="btn ghost" onClick={markAllRead}>{t('notifications.read_all')}</button>
        </div>
      </div>

      <div className="card">
        {notifications.length === 0 && <p className="roles-tag">{t('notifications.empty')}</p>}
        {notifications.map((n) => (
          <div key={n.id} style={{
            padding: '12px 0',
            borderBottom: '1px solid var(--border)',
            opacity: n.read_at ? 0.6 : 1,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
          }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong>{n.title}</strong>
                <span className={`badge ${typeColors[n.type] || 'info'}`}>{n.type}</span>
              </div>
              <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{n.body}</p>
              <span className="roles-tag">{new Date(n.created_at).toLocaleString('en-GB')}</span>
            </div>
            {!n.read_at && (
              <button className="btn ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => markRead(n.id)}>
                {t('notifications.read')}
              </button>
            )}
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="inline-actions" style={{ justifyContent: 'center', marginTop: 16 }}>
          <button className="btn ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('notifications.prev')}</button>
          <span className="roles-tag">{t('notifications.page', { page, total: totalPages })}</span>
          <button className="btn ghost" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>{t('notifications.next')}</button>
        </div>
      )}
    </>
  );
}
