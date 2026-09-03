import React, { useEffect, useRef, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

export default function Chat() {
  const { t } = useT();
  const [convs, setConvs] = useState([]);
  const [unread, setUnread] = useState(0);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [myId, setMyId] = useState(null);
  const [draft, setDraft] = useState('');
  const [startPhone, setStartPhone] = useState('');
  const [msg, setMsg] = useState({ type: '', text: '' });
  const me = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const bottomRef = useRef(null);

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('chat.error') });

  const loadConvs = () => {
    api.get('/eco/chat').then((r) => setConvs(r.data.conversations || [])).catch(() => {});
    api.get('/eco/chat/unread').then((r) => setUnread(r.data.count || 0)).catch(() => {});
    if (me && me.id) setMyId(me.id);
  };
  useEffect(() => { loadConvs(); }, []);

  const openConv = async (id) => {
    setActiveId(id);
    try {
      const r = await api.get(`/eco/chat/${id}`);
      setMessages(r.data.messages || []);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    } catch (err) { error(err); }
  };

  const startConv = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/eco/chat/start', { phone: startPhone });
      setStartPhone('');
      loadConvs();
      openConv(r.data.conversationId);
    } catch (err) { error(err); }
  };

  const send = async (e) => {
    e.preventDefault();
    if (!draft.trim() || !activeId) return;
    try {
      await api.post(`/eco/chat/${activeId}/send`, { content: draft.trim() });
      setDraft('');
      openConv(activeId);
      loadConvs();
    } catch (err) { error(err); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>💬 {t('chat.title')}</h2>
        <p>{t('chat.sub')}{unread > 0 && <span> · <strong style={{ color: '#dc2626' }}>{unread} {t('chat.unread')}</strong></span>}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      <div className="card" style={{ marginBottom: 24, maxWidth: 560 }}>
        <form onSubmit={startConv} style={{ display: 'flex', gap: 8 }}>
          <input value={startPhone} onChange={(e) => setStartPhone(e.target.value)} placeholder={t('chat.start_phone')} required
            style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }} />
          <button className="btn" type="submit">＋ {t('chat.start_btn')}</button>
        </form>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: 16, minHeight: 420 }}>
        {/* Conversation list */}
        <div className="card" style={{ overflow: 'hidden' }}>
          <h3 style={{ margin: '0 0 12px', padding: '0 16px' }}>{t('chat.conversations')}</h3>
          {convs.length === 0 ? (
            <p className="roles-tag" style={{ padding: '0 16px' }}>{t('chat.empty')}</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 480, overflowY: 'auto' }}>
              {convs.map((c) => (
                <button key={c.id} onClick={() => openConv(c.id)}
                  style={{ textAlign: 'left', padding: '12px 16px', border: 'none', borderBottom: '1px solid #e2e8f0', cursor: 'pointer', background: activeId === c.id ? '#e0f2fe' : '#fff' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>{t('chat.conversation')} #{c.id}</strong>
                    {c.unread_count > 0 && <span className="badge danger">{c.unread_count}</span>}
                  </div>
                  <p className="roles-tag" style={{ margin: '6px 0 0', fontSize: 13, color: '#475569' }}>
                    {c.last_message || t('chat.no_messages')}
                  </p>
                  <p className="roles-tag" style={{ margin: '2px 0 0', fontSize: 11 }}>
                    {c.last_message_at ? new Date(c.last_message_at).toLocaleString() : ''}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Message thread */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          {!activeId ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: '#94a3b8' }}>
              {t('chat.select')}
            </div>
          ) : (
            <>
              <div style={{ padding: '0 16px 12px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>{t('chat.conversation')} #{activeId}</h3>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {messages.length === 0 && <p className="roles-tag">{t('chat.no_messages')}</p>}
                {messages.map((m) => {
                  const mine = myId && Number(m.sender_id) === Number(myId);
                  return (
                    <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                      <div style={{
                        maxWidth: '75%', padding: '9px 14px', borderRadius: 14,
                        background: mine ? '#0ea5e9' : '#f1f5f9', color: mine ? '#fff' : '#0f172a',
                        borderBottomRightRadius: mine ? 4 : 14, borderBottomLeftRadius: mine ? 14 : 4,
                      }}>
                        <div>{m.content}</div>
                        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>{new Date(m.created_at).toLocaleTimeString()}</div>
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>
              <form onSubmit={send} style={{ display: 'flex', gap: 8, padding: '12px 16px', borderTop: '1px solid #e2e8f0' }}>
                <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('chat.type')}
                  style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }} />
                <button className="btn" type="submit">➤ {t('chat.send')}</button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}