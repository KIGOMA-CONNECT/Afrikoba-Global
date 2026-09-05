import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

const PROGRESS_COLORS = ['#dc2626', '#f59e0b', '#eab308', '#16a34a', '#059669'];

export default function PublicEvent() {
  const { token } = useParams();
  const { t } = useT();
  const navigate = useNavigate();
  const [ev, setEv] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [joining, setJoining] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setLoading(true);
    api.get(`/events/public/${token}`)
      .then((r) => setEv(r.data.event))
      .catch((e) => setError(e.response?.data?.message || 'Tukio halipatikani.'))
      .finally(() => setLoading(false));
  }, [token]);

  const join = async () => {
    const loggedIn = localStorage.getItem('afrikoba_token');
    if (!loggedIn) { navigate('/login'); return; }
    setJoining(true);
    setMsg('');
    try {
      const r = await api.post(`/events/public/${token}/join`);
      setMsg(r.data.event ? 'JOINED' : 'joined');
    } catch (e) {
      setMsg(e.response?.data?.message || 'Kujiunga kumeshindikana.');
    } finally { setJoining(false); }
  };

  if (loading) return (
    <div style={{ display:'flex',justifyContent:'center',alignItems:'center',minHeight:'80vh',color:'#6b7a70',fontSize:14 }}>Inapakia...</div>
  );

  if (error) return (
    <div style={{ maxWidth:420,margin:'10vh auto',textAlign:'center',padding:24 }}>
      <p style={{ fontSize:28 }}>🎉</p>
      <h3 style={{ marginTop:8 }}>Tukio halipatikani</h3>
      <p style={{ color:'#6b7a70' }}>{error}</p>
      <Link to="/" className="btn" style={{ marginTop:16 }}>Rudi mwanzo</Link>
    </div>
  );

  if (msg === 'JOINED') {
    return (
      <div style={{ maxWidth:460,margin:'12vh auto',textAlign:'center',padding:24 }}>
        <p style={{ fontSize:42 }}>✅</p>
        <h2 style={{ marginTop:12 }}>Umejiunga na tukio!</h2>
        <p style={{ color:'#6b7a70',marginTop:8 }}>Sasa unaweza kuchangia na kuona michango ya "{ev.name}".</p>
        <Link to="/dashboard/events" className="btn" style={{ marginTop:20 }}>Enda kwenye Matukio</Link>
      </div>
    );
  }

  const pct = ev.progress || 0;
  const barColor = PROGRESS_COLORS[Math.min(Math.floor(pct / 20), 4)];

  return (
    <div style={{ maxWidth:480,margin:'8vh auto',padding:24 }}>
      <div className="card" style={{ padding:28,textAlign:'center',overflow:'hidden' }}>
        <p style={{ fontSize:40,margin:0 }}>🎉</p>
        {ev.eventType && <p style={{ color:'#6b7a70',margin:'8px 0 0',fontSize:13 }}>{ev.eventType}</p>}
        <h1 style={{ margin:'6px 0 4px',fontSize:24 }}>{ev.name}</h1>
        <p style={{ color:'#6b7a70',margin:0,fontSize:14 }}>{ev.ownerName} — {t('events.owner')}</p>
        {ev.eventDate && <p style={{ color:'#6b7a70',margin:'6px 0 0',fontSize:13 }}>📅 {ev.eventDate}</p>}
        {ev.description && <p style={{ marginTop:14,fontSize:15,color:'#333' }}>{ev.description}</p>}

        <div style={{ marginTop:18,background:'#f8faf9',borderRadius:12,padding:16 }}>
          <p style={{ fontSize:12,color:'#6b7a70',margin:'0 0 6px' }}>{t('events.progress')}</p>
          <div style={{ height:10,background:'#e5ede8',borderRadius:6,overflow:'hidden' }}>
            <div style={{ width:`${pct}%`,height:'100%',background:barColor,transition:'width .4s' }} />
          </div>
          <div style={{ display:'flex',justifyContent:'space-between',marginTop:8 }}>
            <span style={{ fontWeight:700,fontSize:16 }}>{formatMoney(ev.collectedAmount)}</span>
            <span style={{ color:'#6b7a70',fontSize:13 }}>{t('events.target_short')}: {formatMoney(ev.targetAmount)}</span>
          </div>
        </div>

        <div style={{ display:'flex',gap:10,marginTop:14,justifyContent:'center',flexWrap:'wrap',fontSize:13,color:'#6b7a70' }}>
          <span>🧑‍🤝‍🧑 {ev.members} {t('events.members')}</span>
          <span>❤️ {ev.donations} {t('events.donations')}</span>
          <span>👥 {ev.contributors} {t('events.contributors')}</span>
        </div>

        {msg && !msg.startsWith('JOIN') && <p style={{ color:'#dc2626',fontSize:13,margin:'12px 0 0' }}>{msg}</p>}

        <button className="btn" style={{ width:'100%',fontSize:16,padding:'12px 0',marginTop:18 }}
          disabled={joining} onClick={join}>
          {joining ? t('events.joining') : (localStorage.getItem('afrikoba_token') ? t('events.join_now') : t('events.login_to_join'))}
        </button>

        <p style={{ fontSize:11,color:'#9aa5a0',marginTop:12 }}>Powered by Afrikoba Global</p>
      </div>
    </div>
  );
}