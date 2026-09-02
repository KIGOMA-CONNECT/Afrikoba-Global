import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function Family() {
  const { t } = useT();
  const [wallets, setWallets] = useState([]);
  const [selectedWallet, setSelectedWallet] = useState(null);
  const [details, setDetails] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [showCreate, setShowCreate] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showContribute, setShowContribute] = useState(false);
  const [showSpend, setShowSpend] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);

  const [createForm, setCreateForm] = useState({ name: '', currency: 'TZS', monthly_allowance_limit: '' });
  const [invitePhone, setInvitePhone] = useState('');
  const [contribAmount, setContribAmount] = useState('');
  const [spendForm, setSpendForm] = useState({ amount: '', description: '' });
  const [transferForm, setTransferForm] = useState({ amount: '', phone: '', description: '' });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('family.error') });

  const load = () => {
    api.get('/family').then((r) => setWallets(r.data.wallets || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const loadWalletDetails = async (id) => {
    try {
      const res = await api.get(`/family/${id}`);
      setDetails(res.data);
      setSelectedWallet(id);
    } catch (err) { error(err); }
  };

  const createWallet = async (e) => {
    e.preventDefault();
    try {
      await api.post('/family', {
        name: createForm.name,
        currency: createForm.currency,
        monthly_allowance_limit: createForm.monthly_allowance_limit ? Number(createForm.monthly_allowance_limit) : undefined,
      });
      setMsg({ type: 'ok', text: t('family.created_ok') });
      setShowCreate(false);
      setCreateForm({ name: '', currency: 'TZS', monthly_allowance_limit: '' });
      load();
    } catch (err) { error(err); }
  };

  const inviteMember = async (e) => {
    e.preventDefault();
    if (!selectedWallet) return;
    try {
      await api.post(`/family/${selectedWallet}/invite`, { phone: invitePhone });
      setMsg({ type: 'ok', text: t('family.invited_ok') });
      setShowInvite(false);
      setInvitePhone('');
      loadWalletDetails(selectedWallet);
    } catch (err) { error(err); }
  };

  const contribute = async (e) => {
    e.preventDefault();
    if (!selectedWallet) return;
    try {
      await api.post(`/family/${selectedWallet}/contribute`, { amount: Number(contribAmount) });
      setMsg({ type: 'ok', text: t('family.contributed_ok') });
      setShowContribute(false);
      setContribAmount('');
      load();
      loadWalletDetails(selectedWallet);
    } catch (err) { error(err); }
  };

  const spend = async (e) => {
    e.preventDefault();
    if (!selectedWallet) return;
    try {
      await api.post(`/family/${selectedWallet}/spend`, { amount: Number(spendForm.amount), description: spendForm.description });
      setMsg({ type: 'ok', text: t('family.spent_ok') });
      setShowSpend(false);
      setSpendForm({ amount: '', description: '' });
      load();
      loadWalletDetails(selectedWallet);
    } catch (err) { error(err); }
  };

  const transfer = async (e) => {
    e.preventDefault();
    if (!selectedWallet) return;
    try {
      await api.post(`/family/${selectedWallet}/transfer`, { amount: Number(transferForm.amount), phone: transferForm.phone, description: transferForm.description });
      setMsg({ type: 'ok', text: t('family.transferred_ok') });
      setShowTransfer(false);
      setTransferForm({ amount: '', phone: '', description: '' });
      load();
      loadWalletDetails(selectedWallet);
    } catch (err) { error(err); }
  };

  const removeMember = async (userId) => {
    if (!selectedWallet) return;
    if (!window.confirm(t('family.confirm_remove'))) return;
    try {
      await api.delete(`/family/${selectedWallet}/members/${userId}`);
      setMsg({ type: 'ok', text: t('family.removed_ok') });
      loadWalletDetails(selectedWallet);
    } catch (err) { error(err); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>{t('family.title')}</h2>
        <p>{t('family.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>{t('family.my_wallets')}</h3>
        <button className="btn" onClick={() => setShowCreate(true)}>＋ {t('family.create_wallet')}</button>
      </div>

      {showCreate && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('family.create_wallet')}</h3>
          <form onSubmit={createWallet} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('family.name')}<input type="text" value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} required placeholder="e.g. Familia ya Juma" /></label>
            <label>{t('family.currency')}<select value={createForm.currency} onChange={(e) => setCreateForm({ ...createForm, currency: e.target.value })}><option value="TZS">TZS</option><option value="USD">USD</option></select></label>
            <label>{t('family.allowance_limit')}<input type="number" min="0" value={createForm.monthly_allowance_limit} onChange={(e) => setCreateForm({ ...createForm, monthly_allowance_limit: e.target.value })} placeholder="0 for unlimited" /></label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('family.save')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowCreate(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      {wallets.length === 0 && !showCreate ? (
        <div className="card" style={{ padding: 24, textAlign: 'center', marginBottom: 24 }}>
          <p style={{ fontSize: 36, marginBottom: 8 }}>👨‍👩‍👧‍👦</p>
          <p className="roles-tag">{t('family.empty')}</p>
          <button className="btn" style={{ marginTop: 10 }} onClick={() => setShowCreate(true)}>{t('family.create_wallet')}</button>
        </div>
      ) : (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', marginBottom: 24 }}>
          {wallets.map((w) => (
            <div key={w.id} className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', borderTop: '4px solid var(--green)', padding: 20 }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4 style={{ margin: 0 }}>{w.name}</h4>
                  <span className="badge success">{w.currency}</span>
                </div>
                <p style={{ fontSize: 22, fontWeight: 'bold', marginTop: 12, marginBottom: 4 }}>{formatMoney(w.balance)}</p>
                <small className="roles-tag">{t('family.role')}: {w.role}</small>
              </div>
              <button className="btn" style={{ marginTop: 16 }} onClick={() => loadWalletDetails(w.id)}>{t('family.manage')}</button>
            </div>
          ))}
        </div>
      )}

      {/* Selected Family Wallet Management View */}
      {selectedWallet && details && (
        <div className="card" style={{ marginBottom: 24, border: '2px solid var(--green)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ margin: 0 }}>{details.wallet.name} — {formatMoney(details.wallet.balance)} {details.wallet.currency}</h3>
            <button className="btn btn-secondary" onClick={() => setSelectedWallet(null)}>✕</button>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            <button className="btn" onClick={() => setShowContribute(true)}>📥 {t('family.contribute_btn')}</button>
            <button className="btn" onClick={() => setShowSpend(true)}>💳 {t('family.spend_btn')}</button>
            <button className="btn" onClick={() => setShowTransfer(true)}>📤 {t('family.transfer_btn')}</button>
            <button className="btn btn-secondary" onClick={() => setShowInvite(true)}>＋ {t('family.invite_btn')}</button>
          </div>

          {/* Action Modals / Forms */}
          {showContribute && (
            <div className="card" style={{ background: '#f8fafc', marginBottom: 16 }}>
              <h4>{t('family.contribute_btn')}</h4>
              <form onSubmit={contribute} style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
                <input type="number" min="100" placeholder={t('family.amount_ph')} value={contribAmount} onChange={(e) => setContribAmount(e.target.value)} required style={{ flex: 1 }} />
                <button className="btn" type="submit">{t('family.save')}</button>
                <button className="btn btn-secondary" type="button" onClick={() => setShowContribute(false)}>✕</button>
              </form>
            </div>
          )}

          {showSpend && (
            <div className="card" style={{ background: '#f8fafc', marginBottom: 16 }}>
              <h4>{t('family.spend_btn')}</h4>
              <form onSubmit={spend} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                <input type="number" min="100" placeholder={t('family.amount_ph')} value={spendForm.amount} onChange={(e) => setSpendForm({ ...spendForm, amount: e.target.value })} required />
                <input type="text" placeholder={t('family.desc_ph')} value={spendForm.description} onChange={(e) => setSpendForm({ ...spendForm, description: e.target.value })} />
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="btn" type="submit">{t('family.save')}</button>
                  <button className="btn btn-secondary" type="button" onClick={() => setShowSpend(false)}>✕</button>
                </div>
              </form>
            </div>
          )}

          {showTransfer && (
            <div className="card" style={{ background: '#f8fafc', marginBottom: 16 }}>
              <h4>{t('family.transfer_btn')}</h4>
              <form onSubmit={transfer} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                <input type="number" min="100" placeholder={t('family.amount_ph')} value={transferForm.amount} onChange={(e) => setTransferForm({ ...transferForm, amount: e.target.value })} required />
                <input type="text" placeholder="2557..." value={transferForm.phone} onChange={(e) => setTransferForm({ ...transferForm, phone: e.target.value })} required />
                <input type="text" placeholder={t('family.desc_ph')} value={transferForm.description} onChange={(e) => setTransferForm({ ...transferForm, description: e.target.value })} />
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="btn" type="submit">{t('family.save')}</button>
                  <button className="btn btn-secondary" type="button" onClick={() => setShowTransfer(false)}>✕</button>
                </div>
              </form>
            </div>
          )}

          {showInvite && (
            <div className="card" style={{ background: '#f8fafc', marginBottom: 16 }}>
              <h4>{t('family.invite_btn')}</h4>
              <form onSubmit={inviteMember} style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
                <input type="text" placeholder="2557..." value={invitePhone} onChange={(e) => setInvitePhone(e.target.value)} required style={{ flex: 1 }} />
                <button className="btn" type="submit">{t('family.invite')}</button>
                <button className="btn btn-secondary" type="button" onClick={() => setShowInvite(false)}>✕</button>
              </form>
            </div>
          )}

          <h4>{t('family.members_title')}</h4>
          <div style={{ overflowX: 'auto', marginBottom: 20 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('family.member_name')}</th>
                  <th>{t('family.member_phone')}</th>
                  <th>{t('family.role')}</th>
                  <th>{t('family.status')}</th>
                  <th>{t('family.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {(details.members || []).map((m) => (
                  <tr key={m.id}>
                    <td><strong>{m.name || 'User'}</strong></td>
                    <td>{m.phone}</td>
                    <td><span className="badge info">{m.role}</span></td>
                    <td><span className={`badge ${m.status === 'ACTIVE' ? 'success' : 'warning'}`}>{m.status}</span></td>
                    <td>
                      {m.role !== 'OWNER' && (
                        <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => removeMember(m.user_id)}>{t('family.remove')}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
