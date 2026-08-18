import React, { useEffect, useState } from 'react';
import api from '../api/client.js';

export default function ServiceLock({ serviceKey, children }) {
  const [state, setState] = useState({ loading: true, subscribed: false, catalog: null });
  const [msg, setMsg] = useState('');

  const refresh = () => {
    api.get('/services/catalog').then((r) => {
      const svc = r.data.catalog.find((s) => s.key === serviceKey);
      setState({ loading: false, subscribed: !!svc?.active, catalog: svc });
      const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
      const active = r.data.catalog.filter((s) => s.active).map((s) => s.key);
      if ((user.services || []).join(',') !== active.join(',')) {
        user.services = active;
        localStorage.setItem('afrikoba_user', JSON.stringify(user));
      }
    }).catch(() => setState((s) => ({ ...s, loading: false })));
  };

  useEffect(() => { refresh(); }, [serviceKey]);

  const subscribe = async () => {
    setMsg('');
    try {
      await api.post('/services/subscribe', { serviceKey });
      setMsg('Umejiunga na huduma hii. Karibu!');
      setTimeout(refresh, 800);
    } catch (e) {
      setMsg(e.response?.data?.message || 'Hitilafu.');
    }
  };

  if (state.loading) return <p className="roles-tag">Inapakia...</p>;
  if (state.subscribed) return children;

  return (
    <div className="card section" style={{ textAlign: 'center', padding: 48 }}>
      <h3>{state.catalog?.name}</h3>
      <p>{state.catalog?.description}</p>
      <p className="roles-tag" style={{ marginBottom: 16 }}>
        Huduma hii bado haijawashwa kwenye akaunti yako. Jiunge kwanza uanze kuitumia.
      </p>
      {msg && <div className={`msg ${msg.startsWith('Kamilisha') ? 'warn' : 'ok'}`}>{msg}</div>}
      <button className="btn" onClick={subscribe}>Jiunge na Huduma hii</button>
    </div>
  );
}
