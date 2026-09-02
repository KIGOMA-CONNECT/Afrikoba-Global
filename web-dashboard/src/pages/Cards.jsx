import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function Cards() {
  const { t } = useT();
  const [cards, setCards] = useState([]);
  const [summary, setSummary] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [showIssue, setShowIssue] = useState(false);
  const [cardType, setCardType] = useState('VISA');
  const [currency, setCurrency] = useState('TZS');
  const [spendLimit, setSpendLimit] = useState('500000');
  const [selectedCard, setSelectedCard] = useState(null);
  const [statement, setStatement] = useState([]);
  const [limitModal, setLimitModal] = useState(null);
  const [newDailyLimit, setNewDailyLimit] = useState('');
  const [newTxnLimit, setNewTxnLimit] = useState('');

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('cards.error') });

  const load = () => {
    api.get('/cards').then((r) => setCards(r.data.cards || [] )).catch(() => {});
    api.get('/cards/summary').then((r) => setSummary(r.data.summary || null)).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const issueCard = async (e) => {
    e.preventDefault();
    try {
      await api.post('/cards', { card_type: cardType, currency, spending_limit_daily: Number(spendLimit) });
      setMsg({ type: 'ok', text: t('cards.issued_ok') });
      setShowIssue(false);
      load();
    } catch (err) { error(err); }
  };

  const toggleFreeze = async (id, isFrozen) => {
    try {
      await api.post(`/cards/${id}/freeze`, { freeze: !isFrozen });
      setMsg({ type: 'ok', text: !isFrozen ? t('cards.frozen_ok') : t('cards.unfrozen_ok') });
      load();
      if (selectedCard && selectedCard.id === id) {
        const r = await api.get(`/cards/${id}`);
        setSelectedCard(r.data.card);
      }
    } catch (err) { error(err); }
  };

  const blockCard = async (id) => {
    if (!window.confirm(t('cards.confirm_block'))) return;
    try {
      await api.post(`/cards/${id}/block`);
      setMsg({ type: 'ok', text: t('cards.blocked_ok') });
      setSelectedCard(null);
      load();
    } catch (err) { error(err); }
  };

  const updateLimits = async (e) => {
    e.preventDefault();
    if (!limitModal) return;
    try {
      await api.post(`/cards/${limitModal.id}/limits`, {
        spending_limit_daily: newDailyLimit ? Number(newDailyLimit) : limitModal.spending_limit_daily,
        spending_limit_per_txn: newTxnLimit ? Number(newTxnLimit) : limitModal.spending_limit_per_txn,
      });
      setMsg({ type: 'ok', text: t('cards.limits_ok') });
      setLimitModal(null);
      setNewDailyLimit('');
      setNewTxnLimit('');
      load();
      if (selectedCard && selectedCard.id === limitModal.id) {
        const r = await api.get(`/cards/${limitModal.id}`);
        setSelectedCard(r.data.card);
      }
    } catch (err) { error(err); }
  };

  const viewDetails = async (c) => {
    try {
      const res = await api.get(`/cards/${c.id}`);
      setSelectedCard(res.data.card);
      const st = await api.get(`/cards/${c.id}/transactions`);
      setStatement(st.data.transactions || []);
    } catch (err) { error(err); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>{t('cards.title')}</h2>
        <p>{t('cards.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      {/* Summary */}
      {summary && (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 24 }}>
          <div className="stat-card"><span className="label">{t('cards.total_cards')}</span><strong>{summary.total}</strong></div>
          <div className="stat-card"><span className="label">{t('cards.active_cards')}</span><strong style={{ color: 'var(--green)' }}>{summary.active}</strong></div>
          <div className="stat-card"><span className="label">{t('cards.frozen_cards')}</span><strong style={{ color: '#d97706' }}>{summary.frozen}</strong></div>
          <div className="stat-card"><span className="label">{t('cards.locked_hold')}</span><strong>{formatMoney(summary.locked_balance)}</strong></div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>{t('cards.my_cards')}</h3>
        <button className="btn" onClick={() => setShowIssue(true)}>＋ {t('cards.issue_new')}</button>
      </div>

      {/* Issue Modal / Card */}
      {showIssue && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('cards.issue_new')}</h3>
          <form onSubmit={issueCard} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('cards.brand')}
              <select value={cardType} onChange={(e) => setCardType(e.target.value)}>
                <option value="VISA">VISA Virtual</option>
                <option value="MASTERCARD">Mastercard Virtual</option>
                <option value="VERVE">Verve Virtual</option>
              </select>
            </label>
            <label>{t('cards.currency')}
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="TZS">TZS</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
              </select>
            </label>
            <label>{t('cards.daily_limit')}
              <input type="number" min="1000" value={spendLimit} onChange={(e) => setSpendLimit(e.target.value)} required />
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('cards.issue_btn')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowIssue(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      {/* Cards Grid */}
      {cards.length === 0 && !showIssue ? (
        <div className="card" style={{ padding: 24, textAlign: 'center', marginBottom: 24 }}>
          <p style={{ fontSize: 36, marginBottom: 8 }}>💳</p>
          <p className="roles-tag">{t('cards.empty')}</p>
          <button className="btn" style={{ marginTop: 10 }} onClick={() => setShowIssue(true)}>{t('cards.issue_new')}</button>
        </div>
      ) : (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', marginBottom: 24 }}>
          {cards.map((c) => (
            <div key={c.id} className="card" style={{ background: c.card_type === 'VISA' ? 'linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%)' : c.card_type === 'MASTERCARD' ? 'linear-gradient(135deg, #7c2d12 0%, #ea580c 100%)' : 'linear-gradient(135deg, #065f46 0%, #059669 100%)', color: '#fff', borderRadius: 16, padding: 20, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: 180, boxShadow: '0 10px 20px rgba(0,0,0,0.1)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{c.card_type}</strong>
                <span className={`badge ${c.status === 'ACTIVE' ? 'success' : c.status === 'FROZEN' ? 'warning' : 'danger'}`} style={{ color: '#fff', background: 'rgba(0,0,0,0.3)' }}>{c.status}</span>
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: 18, letterSpacing: 2, margin: '14px 0' }}>
                •••• •••• •••• {c.masked_pan || '••••'}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', fontSize: 13 }}>
                <div>
                  <small style={{ opacity: 0.8, display: 'block' }}>{t('cards.expiry')}: {c.expiry_month}/{c.expiry_year}</small>
                  <small style={{ opacity: 0.8 }}>{c.currency} · {t('cards.daily')}: {formatMoney(c.spending_limit_daily)}</small>
                </div>
                <button className="btn" style={{ background: '#fff', color: '#000', padding: '6px 12px', fontSize: 12 }} onClick={() => viewDetails(c)}>{t('cards.manage')}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Selected Card Details Modal / View */}
      {selectedCard && (
        <div className="card" style={{ marginBottom: 24, border: '2px solid var(--green)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ margin: 0 }}>{selectedCard.card_type} — **** {selectedCard.masked_pan}</h3>
            <button className="btn btn-secondary" onClick={() => setSelectedCard(null)}>✕</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 18 }}>
            <div><small className="roles-tag">{t('cards.status')}</small><p><strong>{selectedCard.status}</strong></p></div>
            <div><small className="roles-tag">{t('cards.currency')}</small><p><strong>{selectedCard.currency}</strong></p></div>
            <div><small className="roles-tag">{t('cards.daily_limit')}</small><p><strong>{formatMoney(selectedCard.spending_limit_daily)}</strong></p></div>
            <div><small className="roles-tag">{t('cards.txn_limit')}</small><p><strong>{formatMoney(selectedCard.spending_limit_per_txn)}</strong></p></div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
            <button className="btn" onClick={() => toggleFreeze(selectedCard.id, selectedCard.status === 'FROZEN')}>
              {selectedCard.status === 'FROZEN' ? t('cards.unfreeze') : t('cards.freeze')}
            </button>
            <button className="btn btn-secondary" onClick={() => { setLimitModal(selectedCard); setNewDailyLimit(selectedCard.spending_limit_daily); setNewTxnLimit(selectedCard.spending_limit_per_txn); }}>
              {t('cards.set_limits')}
            </button>
            <button className="btn" style={{ background: '#dc2626', color: '#fff' }} onClick={() => blockCard(selectedCard.id)}>
              {t('cards.block')}
            </button>
          </div>

          <h4>{t('cards.statement')}</h4>
          {statement.length === 0 ? (
            <p className="roles-tag">{t('cards.no_txns')}</p>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: 10 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('cards.date')}</th>
                    <th>{t('cards.reference')}</th>
                    <th>{t('cards.amount')}</th>
                    <th>{t('cards.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.map((s, idx) => (
                    <tr key={idx}>
                      <td>{new Date(s.created_at).toLocaleString()}</td>
                      <td style={{ wordBreak: 'break-all' }}>{s.reference}</td>
                      <td><strong>{formatMoney(s.amount)}</strong></td>
                      <td><span className={`badge ${s.status === 'SUCCESS' || s.status === 'COMPLETED' ? 'success' : 'info'}`}>{s.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Limits Modal */}
      {limitModal && (
        <div className="card" style={{ marginBottom: 24, background: '#f8fafc', border: '1px solid #cbd5e1' }}>
          <h3 style={{ marginBottom: 12 }}>{t('cards.set_limits')}</h3>
          <form onSubmit={updateLimits} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('cards.daily_limit')}<input type="number" value={newDailyLimit} onChange={(e) => setNewDailyLimit(e.target.value)} required /></label>
            <label>{t('cards.txn_limit')}<input type="number" value={newTxnLimit} onChange={(e) => setNewTxnLimit(e.target.value)} required /></label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('cards.save')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setLimitModal(null)}>✕</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
