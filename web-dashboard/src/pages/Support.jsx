import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function Support() {
  const { t } = useT();
  const [tickets, setTickets] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [showTicketForm, setShowTicketForm] = useState(false);
  const [showDisputeForm, setShowDisputeForm] = useState(false);
  const [ticketForm, setTicketForm] = useState({ category: 'TRANSACTION', priority: 'MEDIUM', subject: '', description: '' });
  const [disputeForm, setDisputeForm] = useState({ transaction_id: '', reason: 'NOT_RECEIVED', amount_disputed: '', description: '' });
  const [activeTab, setActiveTab] = useState('tickets');

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('support.error') });

  const load = () => {
    api.get('/support/tickets').then((r) => setTickets(r.data.tickets || r.data || [])).catch(() => {});
    api.get('/disputes').then((r) => setDisputes(r.data.disputes || r.data || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const createTicket = async (e) => {
    e.preventDefault();
    try {
      await api.post('/support/tickets', ticketForm);
      setMsg({ type: 'ok', text: t('support.ticket_created') });
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
      setMsg({ type: 'ok', text: t('support.dispute_created') });
      setShowDisputeForm(false);
      setDisputeForm({ transaction_id: '', reason: 'NOT_RECEIVED', amount_disputed: '', description: '' });
      load();
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
                    </tr>
                  </thead>
                  <tbody>
                    {tickets.map((tk) => (
                      <tr key={tk.id}>
                        <td><strong>{tk.ticket_number || tk.id}</strong></td>
                        <td><span className="badge info">{tk.category}</span></td>
                        <td>{tk.subject}</td>
                        <td>{tk.priority}</td>
                        <td><span className={`badge ${tk.status === 'RESOLVED' || tk.status === 'CLOSED' ? 'success' : 'warning'}`}>{tk.status}</span></td>
                        <td>{new Date(tk.created_at).toLocaleDateString()}</td>
                      </tr>
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
    </div>
  );
}
