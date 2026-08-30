import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

export default function Login() {
  const navigate = useNavigate();
  const { t, setLang, lang } = useT();
  const [tab, setTab] = useState('login');
  const [step, setStep] = useState(1);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [otp, setOtp] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [devOtp, setDevOtp] = useState('');
  const [loading, setLoading] = useState(false);

  const sendOtp = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await api.post('/auth/send-otp', { phoneNumber });
      if (res.data.devOtp) {
        setDevOtp(t('login.dev_otp', { otp: res.data.devOtp }));
      } else {
        setDevOtp('');
      }
      setStep(2);
    } catch (e) {
      setError(e.response?.data?.message || t('login.error.send'));
    } finally {
      setLoading(false);
    }
  };

  const goHome = (services) => {
    const onlyBase = Array.isArray(services) && services.length <= 1;
    navigate(onlyBase ? '/dashboard/services' : '/dashboard');
  };

  const doLogin = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await api.post('/auth/login', { phoneNumber, otp });
      localStorage.setItem('afrikoba_token', res.data.token);
      localStorage.setItem('afrikoba_user', JSON.stringify(res.data.user));
      goHome(res.data.user.services);
    } catch (e) {
      setError(e.response?.data?.message || t('login.error.login'));
    } finally {
      setLoading(false);
    }
  };

  const doRegister = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await api.post('/auth/register', { fullName, phoneNumber, email, otp });
      localStorage.setItem('afrikoba_token', res.data.token);
      localStorage.setItem('afrikoba_user', JSON.stringify(res.data.user));
      goHome(res.data.user.services);
    } catch (e) {
      setError(e.response?.data?.message || t('login.error.register'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-lang">
          <button className={`lang-btn${lang === 'sw' ? ' active' : ''}`} onClick={() => setLang('sw')}>{t('lang.sw')}</button>
          <button className={`lang-btn${lang === 'en' ? ' active' : ''}`} onClick={() => setLang('en')}>{t('lang.en')}</button>
        </div>
        <h1>AFRIKOBA GLOBAL</h1>
        <div className="sub">{t('login.sub')}</div>

        <div className="tabs">
          <button className={tab === 'login' ? 'active' : ''} onClick={() => { setTab('login'); setStep(1); }}>{t('login.login_button')}</button>
          <button className={tab === 'register' ? 'active' : ''} onClick={() => { setTab('register'); setStep(1); }}>{t('login.register')}</button>
        </div>

        {error && <div className="msg err">{error}</div>}

        {step === 1 ? (
          <>
            <div className="field">
              <label>{t('login.phone')}</label>
              <input
                placeholder="0712000001"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
              />
            </div>
            {tab === 'register' && (
              <>
                <div className="field">
                  <label>{t('login.full_name')}</label>
                  <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
                </div>
                <div className="field">
                  <label>{t('login.email')}</label>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
              </>
            )}
            <button className="btn" style={{ width: '100%', marginTop: 10 }} onClick={sendOtp} disabled={loading || !phoneNumber}>
              {loading ? t('login.sending_otp') : t('login.send_otp')}
            </button>
          </>
        ) : (
          <>
            {devOtp && <div className="msg ok">{devOtp}</div>}
            <div className="field">
              <label>{t('login.otp_sms_label')}</label>
              <input value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="123456" />
            </div>
            <button
              className="btn"
              style={{ width: '100%', marginTop: 10 }}
              onClick={tab === 'login' ? doLogin : doRegister}
              disabled={loading || !otp}
            >
              {loading ? t('login.processing') : tab === 'login' ? t('login.login_button') : t('login.register_and_login')}
            </button>
            <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setStep(1)}>
              {t('login.back')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}