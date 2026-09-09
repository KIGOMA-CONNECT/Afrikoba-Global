import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED'];

export default function Support() {
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const isReviewer = ['ADMIN', 'SUPPORT', 'COMPLIANCE'].includes(user.role);
  const { t } = useT();
  const [tickets, setTickets] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [showTicketForm, setShowTicketForm] = useState(false);
  const [showDisputeForm, setShowDisputeForm] = useState(false);
  const [ticketForm, setTicketForm] = useState({ category: 'TRANSACTION', priority: 'MEDIUM', subject: '', description: '' });
  const [disputeForm, setDisputeForm] = useState({ transaction_id: '', reason: 'NOT_RECEIVED', amount_disputed: '', description: '' });
  const [activeTab, setActiveTab] = useState('tickets');
  const [openId, setOpenId] = useState(null);
  const [thread, setThread] = useState(null);
  const [reply, setReply] = useState('');
  // Admin console
  const [qTickets, setQTickets] = useState([]);
  const [qStats, setQStats] = useState({});
  const [qFilter, setQFilter] = useState('');
  const [qStatus, setQStatus] = useState({});
  const [qRes, setQRes] = useState({});
  const [qReply, setQReply] = useState({});

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('support.error') });
  const flash = (text) => { setMsg({ type: 'ok', text }); setTimeout(() => setMsg({ type: '', text: '' }), 3500); };

  const load = () => {
    api.get('/advanced/support/tickets').then((r) => setTickets(r.data.tickets || r.data || [])).catch(() => {});
    api.get('/disputes').then((r) => setDisputes(r.data.disputes || r.data || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (activeTab === 'admin' && isReviewer) loadQueue(); }, [activeTab, isReviewer]);
  useEffect(() => { if (activeTab === 'admin' && isReviewer) loadQueue(); }, [qFilter]);

  const loadQueue = () => {
    api.get(`/advanced/admin/support/tickets${qFilter ? `?status=${encodeURIComponent(qFilter)}` : ''}`)
      .then((r) => setQTickets(r.data.tickets || [])).catch(() => {});
    api.get('/advanced/admin/support/stats').then((r) => setQStats(r.data.stats || {})).catch(() => {});
  };

  const createTicket = async (e) => {
    e.preventDefault();
    try {
      await api.post('/advanced/support/tickets', ticketForm);
      flash(t('support.ticket_created'));
      setShowTicketForm(false);
      setTicketForm({ category: 'TRANSACTION', priority: 'MEDIUM', subject: '', description: '' });
      load();
    } catch (err) { error(err); }
  };

  const createDispute = async (e) => {
    e.preventDefault();
    try {
      await api.post('/disputes', {
        transaction_id: Number(disputeForm.transaction_id),
        reason: disputeForm.reason,
        amount_disputed: Number(disputeForm.amount_disputed),
        description: disputeForm.description,
      });
      flash(t('support.dispute_created'));
      setShowDisputeForm(false);
      setDisputeForm({ transaction_id: '', reason: 'NOT_RECEIVED', amount_disputed: '', description: '' });
      load();
    } catch (err) { error(err); }
  };

  const openThread = async (id) => {
    if (openId === id) { setOpenId(null); setThread(null); setReply(''); return; }
    try {
      const r = await api.get(`/advanced/support/tickets/${id}`);
      setThread(r.data);
      setOpenId(id);
      setReply('');
    } catch (err) { error(err); }
  };

  const sendReply = async (e) => {
    e.preventDefault();
    if (!reply.trim()) return;
    try {
      const r = await api.post(`/advanced/support/tickets/${openId}/messages`, { message: reply.trim() });
      flash(t('support.reply_sent'));
      setReply('');
      setThread((th) => ({ ...th, messages: [...(th.messages || []), r.data.message], ticket: { ...th.ticket, status: 'OPEN' } }));
    } catch (err) { error(err); }
  };

  const updateStatus = async (id) => {
    try {
      await api.put(`/advanced/admin/support/tickets/${id}/status`, { status: qStatus[id] || 'OPEN', resolution: qRes[id] || null });
      flash(t('support.status_updated'));
      setQRes((m) => { const n = { ...m }; delete n[id]; return n; });
      loadQueue(); load();
    } catch (err) { error(err); }
  };

  const adminReply = async (id) => {
    if (!(qReply[id] || '').trim()) return;
    try {
      await api.post(`/advanced/admin/support/tickets/${id}/messages`, { message: qReply[id].trim() });
      flash(t('support.reply_sent'));
      setQReply((m) => { const n = { ...m }; delete n[id]; return n; });
    } catch (err) { error(err); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>{t('support.title')}</h2>
        <p>{t('support.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <button className={`btn ${activeTab === 'tickets' ? '' : 'btn-secondary'}`} onClick={() => setActiveTab('tickets')}>
          🛠️ {t('support.tickets_tab')} ({tickets.length})
        </button>
        <button className={`btn ${activeTab === 'disputes' ? '' : 'btn-secondary'}`} onClick={() => setActiveTab('disputes')}>
          ⚖️ {t('support.disputes_tab')} ({disputes.length})
        </button>
        {isReviewer && (
          <button className={`btn ${activeTab === 'admin' ? '' : 'btn-secondary'}`} onClick={() => setActiveTab('admin')}>
            🧑‍💼 {t('support.admin_tab')} ({qStats.total != null ? qStats.total : '…'})
          </button>
        )}
      </div>

      {activeTab === 'tickets' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h3 style={{ margin: 0 }}>{t('support.tickets_title')}</h3>
            <button className="btn" onClick={() => setShowTicketForm(true)}>＋ {t('support.new_ticket')}</button>
          </div>

          {showTicketForm && (
            <div className="card" style={{ marginBottom: 24 }}>
              <h3 style={{ marginBottom: 12 }}>{t('support.new_ticket')}</h3>
              <form onSubmit={createTicket} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>{t('support.category')}<select value={ticketForm.category} onChange={(e) => setTicketForm({ ...ticketForm, category: e.target.value })}><option value="TRANSACTION">Transaction</option><option value="ACCOUNT">Account</option><option value="KYC">KYC</option><option value="TECHNICAL">Technical</option><option value="OTHER">Other</option></select></label>
                <label>{t('support.priority')}<select value={ticketForm.priority} onChange={(e) => setTicketForm({ ...ticketForm, priority: e.target.value })}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="URGENT">Urgent</option></select></label>
                <label>{t('support.subject')}<input type="text" value={ticketForm.subject} onChange={(e) => setTicketForm({ ...ticketForm, subject: e.target.value })} required /></label>
                <label>{t('support.description')}<textarea value={ticketForm.description} onChange={(e) => setTicketForm({ ...ticketForm, description: e.target.value })} rows={4} required style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }} /></label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="btn" type="submit">{t('support.save')}</button>
                  <button className="btn btn-secondary" type="button" onClick={() => setShowTicketForm(false)}>✕</button>
                </div>
              </form>
            </div>
          )}

          <div className="card">
            {tickets.length === 0 ? (
              <p className="roles-tag">{t('support.no_tickets')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('support.ticket_no')}</th>
                      <th>{t('support.category')}</th>
                      <th>{t('support.subject')}</th>
                      <th>{t('support.priority')}</th>
                      <th>{t('support.status')}</th>
                      <th>{t('support.date')}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tickets.map((tk) => (
                      <React.Fragment key={tk.id}>
                        <tr>
                          <td><strong>{tk.ticket_number || tk.ticket_id || tk.id}</strong></td>
                          <td><span className="badge info">{tk.category}</span></td>
                          <td>{tk.subject}</td>
                          <td>{tk.priority}</td>
                          <td><span className={`badge ${tk.status === 'RESOLVED' || tk.status === 'CLOSED' ? 'success' : 'warning'}`}>{tk.status}</span></td>
                          <td>{new Date(tk.created_at).toLocaleDateString()}</td>
                          <td><button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => openThread(tk.id)}>{t('support.open_thread')}</button></td>
                        </tr>
                        {openId === tk.id && thread && thread.ticket?.id === tk.id && (
                          <tr>
                            <td colSpan={7}>
                              <h4 style={{ marginTop: 4 }}>{t('support.thread')} <span className="roles-tag">{thread.ticket.ticket_id}</span></h4>
                              {thread.messages.length === 0 && <p className="roles-tag">{t('service.no_items') || '—'}</p>}
                              {thread.messages.map((m) => (
                                <div key={m.id} style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 8, background: '#f1f5f9' }}>
                                  <small style={{ color: '#64748b' }}>{m.sender_phone} · {new Date(m.created_at).toLocaleString()}</small>
                                  <p style={{ margin: '4px 0 0' }}>{m.message}</p>
                                </div>
                              ))}
                              <form onSubmit={sendReply} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                <input className="input" style={{ flex: 1 }} placeholder={t('support.reply_ph')} value={reply} onChange={(e) => setReply(e.target.value)} />
                                <button className="btn" type="submit">{t('support.reply')}</button>
                              </form>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {activeTab === 'disputes' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h3 style={{ margin: 0 }}>{t('support.disputes_title')}</h3>
            <button className="btn" onClick={() => setShowDisputeForm(true)}>＋ {t('support.new_dispute')}</button>
          </div>

          {showDisputeForm && (
            <div className="card" style={{ marginBottom: 24 }}>
              <h3 style={{ marginBottom: 12 }}>{t('support.new_dispute')}</h3>
              <form onSubmit={createDispute} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>{t('support.transaction_id')}<input type="number" value={disputeForm.transaction_id} onChange={(e) => setDisputeForm({ ...disputeForm, transaction_id: e.target.value })} required /></label>
                <label>{t('support.reason')}<select value={disputeForm.reason} onChange={(e) => setDisputeForm({ ...disputeForm, reason: e.target.value })}><option value="NOT_RECEIVED">Not Received</option><option value="UNAUTHORIZED">Unauthorized</option><option value="WRONG_AMOUNT">Wrong Amount</option><option value="DUPLICATE">Duplicate</option><option value="FRAUD">Fraud</option><option value="OTHER">Other</option></select></label>
                <label>{t('support.amount_disputed')}<input type="number" min="1" value={disputeForm.amount_disputed} onChange={(e) => setDisputeForm({ ...disputeForm, amount_disputed: e.target.value })} required /></label>
                <label>{t('support.description')}<textarea value={disputeForm.description} onChange={(e) => setDisputeForm({ ...disputeForm, description: e.target.value })} rows={3} required style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }} /></label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="btn" type="submit">{t('support.save')}</button>
                  <button className="btn btn-secondary" type="button" onClick={() => setShowDisputeForm(false)}>✕</button>
                </div>
              </form>
            </div>
          )}

          <div className="card">
            {disputes.length === 0 ? (
              <p className="roles-tag">{t('support.no_disputes')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>{t('support.reason')}</th>
                      <th>{t('support.amount')}</th>
                      <th>{t('support.status')}</th>
                      <th>{t('support.date')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {disputes.map((d) => (
                      <tr key={d.id}>
                        <td><strong>#{d.id}</strong></td>
                        <td><span className="badge warning">{d.reason}</span></td>
                        <td><strong>{formatMoney(d.amount_disputed || d.amount)}</strong></td>
                        <td><span className={`badge ${d.status === 'RESOLVED' ? 'success' : 'info'}`}>{d.status}</span></td>
                        <td>{new Date(d.created_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {activeTab === 'admin' && isReviewer && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            {[
              { key: 'stats_total', label: t('support.stats_total'), val: qStats.total },
              { key: 'stats_open', label: t('support.stats_open'), val: qStats.open },
              { key: 'stats_in_progress', label: t('support.stats_in_progress'), val: qStats.in_progress },
              { key: 'stats_resolved', label: t('support.stats_resolved'), val: qStats.resolved },
              { key: 'stats_closed', label: t('support.stats_closed'), val: qStats.closed },
            ].map((s) => (
              <div key={s.key} className="card" style={{ padding: '10px 14px', margin: 0 }}>
                <small style={{ color: 'var(--muted)' }}>{s.label}</small>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{s.val ?? '…'}</div>
              </div>
            ))}
            <div style={{ flex: 1 }} />
            <select className="input" style={{ alignSelf: 'flex-end' }} value={qFilter} onChange={(e) => { setQFilter(e.target.value); }}>
              <option value="">{t('support.stats_total')}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <div style={{ alignSelf: 'flex-end' }}><button className="btn btn-secondary" onClick={loadQueue}>↻</button></div>
          </div>

          <div className="card">
            {qTickets.length === 0 ? (
              <p className="roles-tag">{t('support.admin_empty')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('support.ticket_no')}</th>
                      <th>{t('support.user_phone')}</th>
                      <th>{t('support.category')}</th>
                      <th>{t('support.subject')}</th>
                      <th>{t('support.priority')}</th>
                      <th>{t('support.status')}</th>
                      <th style={{ minWidth: 260 }}>{t('support.reply')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {qTickets.map((tk) => (
                      <tr key={tk.id}>
                        <td><strong>{tk.ticket_id}</strong><div className="roles-tag">{new Date(tk.created_at).toLocaleDateString()}</div></td>
                        <td>{tk.user_phone}</td>
                        <td><span className="badge info">{tk.category}</span></td>
                        <td>{tk.subject}<div className="roles-tag">{tk.description}</div></td>
                        <td>{tk.priority}</td>
                        <td>
                          <select className="input" style={{ marginBottom: 6 }} value={qStatus[tk.id] || tk.status} onChange={(e) => setQStatus({ ...qStatus, [tk.id]: e.target.value })}>
                            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                          <input className="input" placeholder={t('support.resolution_ph')} value={qRes[tk.id] || ''} onChange={(e) => setQRes({ ...qRes, [tk.id]: e.target.value })} />
                          <button className="btn" style={{ fontSize: 12, padding: '4px 10px', marginTop: 6 }} onClick={() => updateStatus(tk.id)}>{t('support.update_status')}</button>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <input className="input" style={{ flex: 1 }} placeholder={t('support.reply_ph')} value={qReply[tk.id] || ''} onChange={(e) => setQReply({ ...qReply, [tk.id]: e.target.value })} />
                            <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => adminReply(tk.id)}>{t('support.reply')}</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}