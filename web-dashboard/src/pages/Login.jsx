import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client.js';

export default function Login() {
  const navigate = useNavigate();
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
        setDevOtp(`Mode ya majaribio - OTP yako ni: ${res.data.devOtp}`);
      } else {
        setDevOtp('');
      }
      setStep(2);
    } catch (e) {
      setError(e.response?.data?.message || 'Hitilafu katika kutuma OTP.');
    } finally {
      setLoading(false);
    }
  };

  const goHome = (services) => {
    const onlyBase = Array.isArray(services) && services.length <= 1;
    navigate(onlyBase ? '/services' : '/');
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
      setError(e.response?.data?.message || 'Hitilafu ya kuingia.');
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
      setError(e.response?.data?.message || 'Hitilafu ya kusajili.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>AFRIKOBA GLOBAL</h1>
        <div className="sub">Kuingia kwenye mfumo wa fedha wa kidijitali</div>

        <div className="tabs">
          <button className={tab === 'login' ? 'active' : ''} onClick={() => { setTab('login'); setStep(1); }}>Ingia</button>
          <button className={tab === 'register' ? 'active' : ''} onClick={() => { setTab('register'); setStep(1); }}>Sajili</button>
        </div>

        {error && <div className="msg err">{error}</div>}

        {step === 1 ? (
          <>
            <div className="field">
              <label>Namba ya Simu</label>
              <input
                placeholder="0712000001"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
              />
            </div>
            {tab === 'register' && (
              <>
                <div className="field">
                  <label>Jina Kamili</label>
                  <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
                </div>
                <div className="field">
                  <label>Email (si lazima)</label>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
              </>
            )}
            <button className="btn" style={{ width: '100%', marginTop: 10 }} onClick={sendOtp} disabled={loading || !phoneNumber}>
              {loading ? 'Inatuma...' : 'Tuma OTP'}
            </button>
          </>
        ) : (
          <>
            {devOtp && <div className="msg ok">{devOtp}</div>}
            <div className="field">
              <label>Msimbo wa OTP (umetumwa SMS)</label>
              <input value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="123456" />
            </div>
            <button
              className="btn"
              style={{ width: '100%', marginTop: 10 }}
              onClick={tab === 'login' ? doLogin : doRegister}
              disabled={loading || !otp}
            >
              {loading ? 'Inachakata...' : tab === 'login' ? 'Ingia' : 'Sajili na Ingia'}
            </button>
            <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setStep(1)}>
              Rudi nyuma
            </button>
          </>
        )}
      </div>
    </div>
  );
}
