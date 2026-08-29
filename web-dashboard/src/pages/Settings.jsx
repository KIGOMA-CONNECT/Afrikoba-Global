import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

export default function Settings() {
  const { t, lang, setLang } = useT();
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
      show('ok', t('settings.prefs_saved'));
    } catch (err) {
      show('err', err.response?.data?.message || t('settings.error'));
    }
  };

  const updateProfile = async () => {
    try {
      await api.patch('/auth/profile', { fullName, email });
      const updated = { ...user, full_name: fullName, email };
      localStorage.setItem('afrikoba_user', JSON.stringify(updated));
      show('ok', t('settings.profile_saved'));
    } catch (err) {
      show('err', err.response?.data?.message || t('settings.error'));
    }
  };

  const updateCurrency = async () => {
    try {
      await api.put('/currency/my-currency', { currency });
      show('ok', t('settings.currency_set', { currency }));
    } catch (err) {
      show('err', err.response?.data?.message || t('settings.error'));
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
        <h2>{t('settings.title')}</h2>
        <p>{t('settings.desc')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="grid grid-2">
        <div className="card">
          <h3>{t('settings.profile')}</h3>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>{t('settings.full_name')}</label>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>{t('settings.email')}</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>{t('settings.phone')}</label>
            <input value={user.phone_number || ''} disabled style={{ opacity: 0.6 }} />
          </div>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>{t('settings.country')}</label>
            <input value={user.country_code || 'TZ'} disabled style={{ opacity: 0.6 }} />
          </div>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>{t('settings.role')}</label>
            <input value={user.role || ''} disabled style={{ opacity: 0.6 }} />
          </div>
          <button className="btn" onClick={updateProfile}>{t('settings.save_profile')}</button>
        </div>

        <div className="card">
          <h3>{t('settings.currency_card')}</h3>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>{t('settings.your_currency')}</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>{c.code} — {c.name} ({c.symbol})</option>
              ))}
            </select>
          </div>
          <button className="btn" onClick={updateCurrency}>{t('settings.change_currency')}</button>

          <h3 style={{ marginTop: 22 }}>{t('settings.language_card')}</h3>
          <p className="roles-tag" style={{ marginBottom: 10 }}>{t('settings.language_hint')}</p>
          <div className="inline-actions">
            <button className={`lang-btn active-lang${lang === 'sw' ? ' act' : ''}`} onClick={() => setLang('sw')}>{t('settings.lang_sw')}</button>
            <button className={`lang-btn active-lang${lang === 'en' ? ' act' : ''}`} onClick={() => setLang('en')}>{t('settings.lang_en')}</button>
          </div>
        </div>
      </div>

      {prefs && (
        <div className="card section" style={{ marginTop: 20 }}>
          <h3>{t('settings.notif_prefs')}</h3>
          <div className="grid grid-2">
            <div>
              <Toggle label={t('settings.sms')} checked={prefs.sms_enabled} onChange={(v) => updatePrefs('sms_enabled', v)} />
              <Toggle label={t('settings.email_alerts')} checked={prefs.email_enabled} onChange={(v) => updatePrefs('email_enabled', v)} />
              <Toggle label={t('settings.push')} checked={prefs.push_enabled} onChange={(v) => updatePrefs('push_enabled', v)} />
            </div>
            <div>
              <Toggle label={t('settings.transaction_alerts')} checked={prefs.transaction_alerts} onChange={(v) => updatePrefs('transaction_alerts', v)} />
              <Toggle label={t('settings.vicoba_alerts')} checked={prefs.vicoba_alerts} onChange={(v) => updatePrefs('vicoba_alerts', v)} />
              <Toggle label={t('settings.rosca_alerts')} checked={prefs.rosca_alerts} onChange={(v) => updatePrefs('rosca_alerts', v)} />
              <Toggle label={t('settings.p2p_alerts')} checked={prefs.p2p_alerts} onChange={(v) => updatePrefs('p2p_alerts', v)} />
              <Toggle label={t('settings.promo_alerts')} checked={prefs.promo_alerts} onChange={(v) => updatePrefs('promo_alerts', v)} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}