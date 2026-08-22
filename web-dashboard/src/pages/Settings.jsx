import React, { useEffect, useState } from 'react';
import api from '../api/client.js';

export default function Settings() {
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const [prefs, setPrefs] = useState(null);
  const [fullName, setFullName] = useState(user.full_name || '');
  const [email, setEmail] = useState(user.email || '');
  const [currency, setCurrency] = useState('');
  const [currencies, setCurrencies] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 3000);
  };

  useEffect(() => {
    api.get('/notifications/preferences')
      .then((r) => setPrefs(r.data.preferences))
      .catch(() => {});
    api.get('/currency/currencies')
      .then((r) => setCurrencies(r.data.currencies))
      .catch(() => {});
    api.get('/currency/my-currency')
      .then((r) => setCurrency(r.data.currency))
      .catch(() => {});
  }, []);

  const updatePrefs = async (key, value) => {
    try {
      const res = await api.put('/notifications/preferences', { [key]: value });
      setPrefs(res.data.preferences);
      show('ok', 'Mapendeleo yamesimbwa.');
    } catch (err) {
      show('err', err.response?.data?.message || 'Hitilafu.');
    }
  };

  const updateProfile = async () => {
    try {
      await api.patch('/auth/profile', { fullName, email });
      const updated = { ...user, full_name: fullName, email };
      localStorage.setItem('afrikoba_user', JSON.stringify(updated));
      show('ok', 'Wasifu umesasishwa.');
    } catch (err) {
      show('err', err.response?.data?.message || 'Hitilafu.');
    }
  };

  const updateCurrency = async () => {
    try {
      await api.put('/currency/my-currency', { currency });
      show('ok', `Sarafu imewekwa: ${currency}`);
    } catch (err) {
      show('err', err.response?.data?.message || 'Hitilafu.');
    }
  };

  const Toggle = ({ label, checked, onChange }) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ width: 18, height: 18 }} />
      <span style={{ fontSize: 14 }}>{label}</span>
    </label>
  );

  return (
    <>
      <div className="page-head">
        <h2>Mipangilio (Settings)</h2>
        <p>Dhibiti wasifu, arifa na sarafu yako</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="grid grid-2">
        <div className="card">
          <h3>Wasifu Wako</h3>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>Jina Kamili</label>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>Email</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>Simu</label>
            <input value={user.phone_number || ''} disabled style={{ opacity: 0.6 }} />
          </div>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>Wajibu</label>
            <input value={user.role || ''} disabled style={{ opacity: 0.6 }} />
          </div>
          <button className="btn" onClick={updateProfile}>Hifadhi Wasifu</button>
        </div>

        <div className="card">
          <h3>Sarafu (Currency)</h3>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>Sarafu Yako</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>{c.code} — {c.name} ({c.symbol})</option>
              ))}
            </select>
          </div>
          <button className="btn" onClick={updateCurrency}>Badilisha Sarafu</button>
        </div>
      </div>

      {prefs && (
        <div className="card section" style={{ marginTop: 20 }}>
          <h3>Mapendeleo ya Arifa</h3>
          <div className="grid grid-2">
            <div>
              <Toggle label="SMS Arifa" checked={prefs.sms_enabled} onChange={(v) => updatePrefs('sms_enabled', v)} />
              <Toggle label="Email Arifa" checked={prefs.email_enabled} onChange={(v) => updatePrefs('email_enabled', v)} />
              <Toggle label="Push Arifa" checked={prefs.push_enabled} onChange={(v) => updatePrefs('push_enabled', v)} />
            </div>
            <div>
              <Toggle label="Arifa za Miamala" checked={prefs.transaction_alerts} onChange={(v) => updatePrefs('transaction_alerts', v)} />
              <Toggle label="Arifa za VICOBA" checked={prefs.vicoba_alerts} onChange={(v) => updatePrefs('vicoba_alerts', v)} />
              <Toggle label="Arifa za ROSCA" checked={prefs.rosca_alerts} onChange={(v) => updatePrefs('rosca_alerts', v)} />
              <Toggle label="Arifa za P2P" checked={prefs.p2p_alerts} onChange={(v) => updatePrefs('p2p_alerts', v)} />
              <Toggle label="Arifa za Matangazo" checked={prefs.promo_alerts} onChange={(v) => updatePrefs('promo_alerts', v)} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
