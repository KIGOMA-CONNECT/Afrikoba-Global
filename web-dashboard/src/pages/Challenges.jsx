import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

function money(v) {
  return (Number(v) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export default function Challenges() {
  const { t } = useT();
  const [challenges, setChallenges] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [showCreate, setShowCreate] = useState(false);
  const [cForm, setCForm] = useState({ name: '', target_amount: '', start_date: '', end_date: '', frequency: 'WEEKLY', per_contribution: '' });
  const [joinId, setJoinId] = useState('');
  const [contrib, setContrib] = useState({});
  const [lb, setLb] = useState({ challengeId: null, rows: [] });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('challenges.error') });
  const ok = (text) => { setMsg({ type: 'ok', text }); load(); };

  const load = () => {
    api.get('/eco/challenges').then((r) => setChallenges(r.data.challenges || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    try {
      await api.post('/eco/challenges', cForm);
      ok(t('challenges.created_ok'));
      setShowCreate(false);
      setCForm({ name: '', target_amount: '', start_date: '', end_date: '', frequency: 'WEEKLY', per_contribution: '' });
    } catch (err) { error(err); }
  };

  const join = async () => {
    if (!joinId) return;
    try {
      await api.post(`/eco/challenges/${joinId}/join`);
      ok(t('challenges.joined_ok'));
      setJoinId('');
    } catch (err) { error(err); }
  };

  const contribute = async (id) => {
    const amount = Number(contrib[id]);
    if (!amount || amount <= 0) return;
    try {
      await api.post(`/eco/challenges/${id}/contribute`, { amount });
      ok(t('challenges.contributed_ok'));
      setContrib((c) => ({ ...c, [id]: '' }));
    } catch (err) { error(err); }
  };

  const leaderboard = async (id) => {
    try {
      const r = await api.get(`/eco/challenges/${id}/leaderboard`);
      setLb({ challengeId: id, rows: r.data.leaderboard || [] });
    } catch (err) { error(err); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>🎯 {t('challenges.title')}</h2>
        <p>{t('challenges.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 24 }}>
        <button className="btn" onClick={() => setShowCreate(!showCreate)}>＋ {t('challenges.create_btn')}</button>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="number" placeholder={t('challenges.challenge_id')} value={joinId} onChange={(e) => setJoinId(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1', width: 140 }} />
          <button className="btn btn-secondary" onClick={join}>{t('challenges.join_btn')}</button>
        </div>
      </div>

      {showCreate && (
        <div className="card" style={{ marginBottom: 24, maxWidth: 640 }}>
          <h3 style={{ marginBottom: 12 }}>{t('challenges.create_title')}</h3>
          <form onSubmit={create} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 12 }}>
            <label style={{ gridColumn: '1 / -1' }}>{t('challenges.name')}<input value={cForm.name} onChange={(e) => setCForm({ ...cForm, name: e.target.value })} required /></label>
            <label>{t('challenges.target')}<input type="number" value={cForm.target_amount} onChange={(e) => setCForm({ ...cForm, target_amount: e.target.value })} required /></label>
            <label>{t('challenges.per_contrib')}<input type="number" value={cForm.per_contribution} onChange={(e) => setCForm({ ...cForm, per_contribution: e.target.value })} required /></label>
            <label>{t('challenges.frequency')}
              <select value={cForm.frequency} onChange={(e) => setCForm({ ...cForm, frequency: e.target.value })}>
                <option value="DAILY">Daily</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </label>
            <label>{t('challenges.start')}<input type="date" value={cForm.start_date} onChange={(e) => setCForm({ ...cForm, start_date: e.target.value })} required /></label>
            <label>{t('challenges.end')}<input type="date" value={cForm.end_date} onChange={(e) => setCForm({ ...cForm, end_date: e.target.value })} required /></label>
            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('challenges.create_submit')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowCreate(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      {/* My challenges */}
      <h3 style={{ margin: '0 0 14px' }}>{t('challenges.mine')}</h3>
      {challenges.length === 0 ? (
        <div className="card"><p className="roles-tag">{t('challenges.empty')}</p></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 16, marginBottom: 24 }}>
          {challenges.map((c) => {
            const total = Number(c.total_contributed) || 0;
            const target = Number(c.target_amount) || 1;
            const pct = Math.min(100, (total / target) * 100);
            const progress = Number(c.contributions_count) || 0;
            return (
              <div className="card" key={c.id} style={{ padding: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ margin: 0 }}>{c.name}</h3>
                  <span className={`badge ${c.status === 'ACTIVE' ? 'success' : 'info'}`}>{c.status}</span>
                </div>
                <p className="roles-tag" style={{ margin: '10px 0 0' }}>
                  {t('challenges.target')} {money(target)} · {t('challenges.frequency')} {c.frequency} · {t('challenges.per_contrib')} {money(c.per_contribution)}
                </p>
                <div style={{ marginTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                    <span>{money(total)} / {money(target)}</span><strong>{pct.toFixed(0)}%</strong>
                  </div>
                  <div style={{ height: 8, borderRadius: 6, background: '#e2e8f0', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, borderRadius: 6, background: 'linear-gradient(90deg,#22d3ee,#0ea5e9)' }} />
                  </div>
                </div>
                <p className="roles-tag" style={{ margin: '8px 0' }}>{t('challenges.streak')} {c.streak ?? 0} · {t('challenges.contribs')} {progress}</p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input type="number" placeholder={t('challenges.amount')} value={contrib[c.id] || ''} onChange={(e) => setContrib({ ...contrib, [c.id]: e.target.value })}
                    style={{ width: 110, padding: '8px 10px', borderRadius: 8, border: '1px solid #cbd5e1' }} />
                  <button className="btn" onClick={() => contribute(c.id)}>💸 {t('challenges.contribute')}</button>
                  <button className="btn btn-secondary" onClick={() => leaderboard(c.id)}>🏆 {t('challenges.leaderboard')}</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Leaderboard */}
      {lb.challengeId && (
        <h3 style={{ margin: '0 0 14px' }}>{t('challenges.leaderboard_for')} #{lb.challengeId}</h3>
      )}
      {lb.rows.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('challenges.rank')}</th>
                  <th>{t('challenges.member')}</th>
                  <th>{t('challenges.contributed')}</th>
                  <th>{t('challenges.streak')}</th>
                </tr>
              </thead>
              <tbody>
                {lb.rows.map((r, i) => (
                  <tr key={r.id}>
                    <td><strong>{i + 1}</strong></td>
                    <td>{r.name || r.phone || 'Member'}</td>
                    <td>{money(r.total_contributed)}</td>
                    <td>{r.streak ?? 0}</td>
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