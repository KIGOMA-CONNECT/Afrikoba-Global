import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';

export default function Referrals() {
  const [stats, setStats] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 3000);
  };

  const load = () => {
    api.get('/referrals/my-code')
      .then((r) => setStats(r.data))
      .catch(() => {});
  };

  useEffect(load, []);

  const generateCode = async () => {
    try {
      const res = await api.post('/referrals/generate-code');
      show('ok', `Msimbo wako: ${res.data.code}`);
      load();
    } catch (err) {
      show('err', err.response?.data?.message || 'Hitilafu.');
    }
  };

  const copyCode = () => {
    if (stats?.code) {
      navigator.clipboard.writeText(stats.code);
      show('ok', 'Msimbo umenakiliwa!');
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>Referrals</h2>
        <p>Alta rafiki, pata zawadi</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        <div className="card stat">
          <div className="value">{stats?.code || '...'}</div>
          <div className="label">Msimbo Wako</div>
          <div className="inline-actions" style={{ justifyContent: 'center', marginTop: 8 }}>
            <button className="btn ghost" style={{ fontSize: 11 }} onClick={copyCode}>Nakili</button>
            <button className="btn ghost" style={{ fontSize: 11 }} onClick={generateCode}>Mpya</button>
          </div>
        </div>
        <div className="card stat">
          <div className="value">{stats?.totalReferrals || 0}</div>
          <div className="label">Rafiki Walioalitwa</div>
        </div>
        <div className="card stat">
          <div className="value">{formatMoney(stats?.totalEarned || 0)}</div>
          <div className="label">Zawadi Ulizopata</div>
        </div>
      </div>

      <div className="card">
        <h3>Jinsi ya Kufanya Kazi</h3>
        <ol style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.8 }}>
          <li>Shiriki msimbo wako na rafiki</li>
          <li>Rafiki ajiunge na Afrikoba Global kwa msimbo wako</li>
          <li>Rafiki aweka fedha kwenye wallet (kiwango cha chini: TSh 10,000)</li>
          <li>Unapata TSh 5,000 zawadi moja kwa moja kwenye wallet yako!</li>
        </ol>
      </div>

      <div className="card section">
        <h3>Rafiki Waliyoalitwa</h3>
        <table>
          <thead>
            <tr><th>Rafiki</th><th>Hali</th><th>Zawadi</th><th>Tarehe</th></tr>
          </thead>
          <tbody>
            {stats?.referrals?.map((r) => (
              <tr key={r.id}>
                <td>{r.referred_name}</td>
                <td><StatusBadge status={r.status} /></td>
                <td>{r.reward_amount > 0 ? formatMoney(r.reward_amount) : '-'}</td>
                <td>{new Date(r.created_at).toLocaleDateString('en-GB')}</td>
              </tr>
            ))}
            {(!stats?.referrals || stats.referrals.length === 0) && (
              <tr><td colSpan="4" className="roles-tag">Hujafanikiwa kualta rafiki bado.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
