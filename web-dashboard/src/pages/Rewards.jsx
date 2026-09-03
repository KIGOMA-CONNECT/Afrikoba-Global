import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

const TIER_COLORS = {
  BRONZE: '#a06a3b',
  SILVER: '#9aa3ad',
  GOLD: '#d4a017',
  PLATINUM: '#37b7c3',
};

const TIER_ORDER = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'];

function TierProgress({ tier, nextTier }) {
  const idx = nextTier ? TIER_ORDER.indexOf(tier) : TIER_ORDER.length;
  const pct = nextTier
    ? Math.max(0, Math.min(100, (idx / TIER_ORDER.length) * 100))
    : 100;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
        {TIER_ORDER.map((t) => (
          <span key={t} style={{ fontWeight: t === tier ? 700 : 400, color: TIER_COLORS[t] }}>
            {t}
          </span>
        ))}
      </div>
      <div style={{ height: 8, borderRadius: 6, background: '#e2e8f0', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, borderRadius: 6, background: 'linear-gradient(90deg,#22d3ee,#0ea5e9)' }} />
      </div>
      {nextTier ? (
        <p className="roles-tag" style={{ marginTop: 6, marginBottom: 0 }}>
          {nextTier.remaining.toLocaleString()} pts kuendeleza kwa {nextTier.name}
        </p>
      ) : (
        <p className="roles-tag" style={{ marginTop: 6, marginBottom: 0 }}>Kiwango cha juu kimefikiwa! 🏆</p>
      )}
    </div>
  );
}

export default function Rewards() {
  const { t } = useT();
  const [rewards, setRewards] = useState(null);
  const [redeem, setRedeem] = useState(100);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const load = () => {
    api.get('/smart/rewards').then((r) => setRewards(r.data.rewards)).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const doRedeem = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/smart/rewards/redeem', { points: parseInt(redeem) });
      const r = res.data.result;
      setMsg({ type: 'ok', text: `${t('rewards.redeemed_ok')} +TSh ${r.cashValue}` });
      setRedeem(100);
      load();
    } catch (err) {
      setMsg({ type: 'err', text: err.response?.data?.message || t('rewards.error') });
    }
  };

  if (!rewards) return <p className="roles-tag">Loading...</p>;

  const { tier, points, total_earned, total_redeemed, cashValue, nextTier, recentTransactions } = rewards;

  return (
    <div>
      <div className="page-head">
        <h2>🏆 {t('rewards.title')}</h2>
        <p>{t('rewards.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      {/* Tier + points hero */}
      <div className="card" style={{ background: 'linear-gradient(135deg,#0f172a,#1e293b)', color: '#fff', marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <h3 style={{ margin: 0, marginBottom: 4 }}>{t('rewards.tier')}</h3>
            <span style={{ fontSize: 28, fontWeight: 800, color: TIER_COLORS[tier] || '#fff' }}>{tier}</span>
          </div>
          <div style={{ textAlign: 'right' }}>
            <h3 style={{ margin: 0, marginBottom: 4 }}>{t('rewards.points')}</h3>
            <span style={{ fontSize: 28, fontWeight: 800 }}>{points?.toLocaleString?.() ?? 0}</span>
          </div>
        </div>
        <TierProgress tier={tier} nextTier={nextTier} />
      </div>

      {/* Stats */}
      <div className="stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 14, marginBottom: 24 }}>
        <div className="card" style={{ padding: 18 }}>
          <p className="roles-tag" style={{ margin: 0 }}>{t('rewards.cash_value')}</p>
          <h3 style={{ margin: 0, marginTop: 4 }}>{formatTsh(cashValue)}</h3>
        </div>
        <div className="card" style={{ padding: 18 }}>
          <p className="roles-tag" style={{ margin: 0 }}>{t('rewards.total_earned')}</p>
          <h3 style={{ margin: 0, marginTop: 4 }}>{total_earned?.toLocaleString?.() ?? 0}</h3>
        </div>
        <div className="card" style={{ padding: 18 }}>
          <p className="roles-tag" style={{ margin: 0 }}>{t('rewards.total_redeemed')}</p>
          <h3 style={{ margin: 0, marginTop: 4 }}>{total_redeemed?.toLocaleString?.() ?? 0}</h3>
        </div>
      </div>

      {/* Redeem */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ margin: 0, marginBottom: 12 }}>{t('rewards.redeem_title')}</h3>
        <form onSubmit={doRedeem} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label>{t('rewards.redeem_points')}</label>
            <input type="number" min={100} step={100} value={redeem} onChange={(e) => setRedeem(e.target.value)} style={{ width: '100%' }} required />
          </div>
          <button className="btn" type="submit">💸 {t('rewards.redeem_btn')}</button>
        </form>
        <p className="roles-tag" style={{ marginTop: 10, marginBottom: 0 }}>{t('rewards.redeem_hint')}</p>
      </div>

      {/* History */}
      <h3 style={{ margin: '0 0 14px' }}>{t('rewards.history')}</h3>
      <div className="card">
        {!recentTransactions || recentTransactions.length === 0 ? (
          <p className="roles-tag">{t('rewards.no_history')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('rewards.type')}</th>
                  <th>{t('rewards.description')}</th>
                  <th>{t('rewards.points')}</th>
                  <th>{t('rewards.date')}</th>
                </tr>
              </thead>
              <tbody>
                {recentTransactions.map((rt) => (
                  <tr key={rt.id}>
                    <td><span className={`badge ${rt.type === 'EARN' ? 'success' : 'danger'}`}>{rt.type}</span></td>
                    <td>{rt.description}</td>
                    <td><strong>{rt.points > 0 ? `+${rt.points}` : rt.points}</strong></td>
                    <td>{new Date(rt.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function formatTsh(v) {
  const n = Number(v) || 0;
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}