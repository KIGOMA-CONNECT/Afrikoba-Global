import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function Referrals() {
  const { t } = useT();
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
      show('ok', t('referrals.code_new', { code: res.data.code }));
      load();
    } catch (err) {
      show('err', err.response?.data?.message || t('referrals.error'));
    }
  };

  const copyCode = () => {
    if (stats?.code) {
      navigator.clipboard.writeText(stats.code);
      show('ok', t('referrals.code_copy'));
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>{t('referrals.title')}</h2>
        <p>{t('referrals.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        <div className="card stat">
          <div className="value">{stats?.code || '...'}</div>
          <div className="label">{t('referrals.code')}</div>
          <div className="inline-actions" style={{ justifyContent: 'center', marginTop: 8 }}>
            <button className="btn ghost" style={{ fontSize: 11 }} onClick={copyCode}>{t('referrals.copy')}</button>
            <button className="btn ghost" style={{ fontSize: 11 }} onClick={generateCode}>{t('referrals.new')}</button>
          </div>
        </div>
        <div className="card stat">
          <div className="value">{stats?.totalReferrals || 0}</div>
          <div className="label">{t('referrals.total')}</div>
        </div>
        <div className="card stat">
          <div className="value">{formatMoney(stats?.totalEarned || 0)}</div>
          <div className="label">{t('referrals.earned')}</div>
        </div>
      </div>

      <div className="card">
        <h3>{t('referrals.howto')}</h3>
        <ol style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.8 }}>
          <li>{t('referrals.howto_step1')}</li>
          <li>{t('referrals.howto_step2')}</li>
          <li>{t('referrals.howto_step3', { min: formatMoney(10000) })}</li>
          <li>{t('referrals.howto_step4', { reward: formatMoney(5000) })}</li>
        </ol>
      </div>

      <div className="card section">
        <h3>{t('referrals.my')}</h3>
        <table>
          <thead>
            <tr><th>{t('referrals.th_friend')}</th><th>{t('referrals.th_status')}</th><th>{t('referrals.th_reward')}</th><th>{t('referrals.th_date')}</th></tr>
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
              <tr><td colSpan="4" className="roles-tag">{t('referrals.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
