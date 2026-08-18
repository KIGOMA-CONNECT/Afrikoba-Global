import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';

const PROVIDERS = ['Mpesa', 'Tigo', 'Airtel', 'Halopesa'];

export default function Wallet() {
  const [balance, setBalance] = useState(null);
  const [txs, setTxs] = useState([]);
  const [amount, setAmount] = useState('');
  const [provider, setProvider] = useState('Mpesa');
  const [toPhone, setToPhone] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState({ type: '', text: '' });

  const refresh = () => {
    api.get('/wallet/balance').then((r) => setBalance(r.data.balance)).catch(() => {});
    api.get('/wallet/transactions').then((r) => setTxs(r.data.transactions)).catch(() => {});
  };

  useEffect(refresh, []);

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 5000);
  };

  const deposit = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/wallet/deposit/initiate', { amount, provider });
      show('ok', `${res.data.message} (Kutoka: ${formatMoney(res.data.totalCharged)})`);
      setAmount('');
    } catch (err) {
      show('err', err.response?.data?.message || 'Hitilafu.');
    }
  };

  const transfer = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/wallet/transfer', { toPhoneNumber: toPhone, amount, note });
      show('ok', res.data.message);
      setAmount(''); setToPhone(''); setNote('');
      refresh();
    } catch (err) {
      show('err', err.response?.data?.message || 'Hitilafu.');
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>Wallet</h2>
        <p>Weka, toa na hamisha fedha</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      {balance && (
        <div className="grid grid-3" style={{ marginBottom: 20 }}>
          <div className="card stat">
            <div className="value">{formatMoney(balance.wallet_balance)}</div>
            <div className="label">Salio linalopatikana</div>
          </div>
          <div className="card stat">
            <div className="value">{formatMoney(balance.locked_balance)}</div>
            <div className="label">Imefungwa (Collateral)</div>
          </div>
          <div className="card stat">
            <div className="value">{balance.currency_code}</div>
            <div className="label">Sarafu</div>
          </div>
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3>Weka Fedha (Deposit - USSD Push)</h3>
          <form className="form-row" onSubmit={deposit}>
            <div className="field">
              <label>Kiasi (TZS)</label>
              <input type="number" min="1000" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </div>
            <div className="field">
              <label>Mtandao</label>
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <button className="btn" type="submit">Tuma Prompt</button>
          </form>
          <p className="roles-tag">Ada ya mfumo (1% Add-on) inakatwa juu ya kiasi. Mfano: Weka 100,000 → utatozwa 101,000.</p>
        </div>

        <div className="card">
          <h3>Hamisha (Transfer kwa Mteja Mwingine)</h3>
          <form className="form-row" onSubmit={transfer}>
            <div className="field">
              <label>Namba ya Mpokeaji</label>
              <input value={toPhone} onChange={(e) => setToPhone(e.target.value)} placeholder="255713000000" required />
            </div>
            <div className="field">
              <label>Kiasi</label>
              <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </div>
            <div className="field">
              <label>Ujumbe (si lazima)</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <button className="btn" type="submit">Hamisha</button>
          </form>
        </div>
      </div>

      <div className="card section">
        <h3>Historia ya Miamala</h3>
        <table>
          <thead>
            <tr>
              <th>Ref</th><th>Aina</th><th>Kiasi</th><th>Ada</th><th>Jumla</th><th>Hali</th><th>Tarehe</th>
            </tr>
          </thead>
          <tbody>
            {txs.map((t) => (
              <tr key={t.id}>
                <td>{t.reference_id}</td>
                <td>{t.type}</td>
                <td>{formatMoney(t.wallet_amount)}</td>
                <td>{formatMoney(t.commission)}</td>
                <td>{formatMoney(t.total_charged)}</td>
                <td><StatusBadge status={t.status} /></td>
                <td>{new Date(t.created_at).toLocaleString('en-GB')}</td>
              </tr>
            ))}
            {txs.length === 0 && <tr><td colSpan="7" style={{ color: 'var(--muted)' }}>Hakuna miamala bado.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
