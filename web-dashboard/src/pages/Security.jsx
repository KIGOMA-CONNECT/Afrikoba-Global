import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import api from '../api/client.js';

export default function Security() {
  const [totp, setTotp] = useState(null);        // { enabled, verifiedAt }
  const [setup, setSetup] = useState(null);      // { secret, otpauthUrl, qr }
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);

  const show = (m, ok = true) => { setNotice({ m, ok }); setTimeout(() => setNotice(''), 5000); };

  const load = () => {
    api.get('/auth/totp/status').then((r) => setTotp(r.data)).catch(() => {});
  };

  useEffect(() => { load(); }, []);

  const startSetup = async () => {
    setLoading(true);
    try {
      const r = await api.post('/auth/totp/setup');
      const qr = await QRCode.toDataURL(r.data.otpauthUrl, { width: 220, margin: 1 });
      setSetup({ secret: r.data.secret, otpauthUrl: r.data.otpauthUrl, qr });
    } catch (e) { show(e.response?.data?.message || 'Failed to start 2FA setup', false); }
    finally { setLoading(false); }
  };

  const enable = async () => {
    if (code.length < 4) return show('Enter your 6-digit code', false);
    setLoading(true);
    try {
      await api.post('/auth/totp/enable', { code });
      show('Two-factor authentication enabled.');
      setSetup(null); setCode(''); load();
    } catch (e) { show(e.response?.data?.message || 'Invalid code', false); }
    finally { setLoading(false); }
  };

  const disable = async () => {
    if (!window.confirm('Disable two-factor authentication?')) return;
    setLoading(true);
    try { await api.post('/auth/totp/disable'); show('Two-factor authentication disabled.'); load(); }
    catch (e) { show(e.response?.data?.message || 'Failed', false); }
    finally { setLoading(false); }
  };

  return (
    <div className="fade-in">
      <h2 className="text-xl font-semibold mb-1">Account Security</h2>
      <p className="text-gray-500 text-sm mb-4">Two-factor authentication and account protection</p>
      {notice && <div className={`px-3 py-2 rounded mb-3 text-sm ${notice.ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{notice.m}</div>}

      <div className="bg-white border rounded p-6 max-w-lg">
        <div className="flex items-center justify-between">
          <div>
            <b className="text-sm">Two-Factor Authentication (2FA)</b>
            <div className="text-sm text-gray-500 mt-1">
              {totp?.enabled
                ? `Enabled${totp.verifiedAt ? ` since ${new Date(totp.verifiedAt).toLocaleDateString()}` : ''}. Uses your authenticator app.`
                : 'Add an extra security layer with an authenticator app (Google Authenticator, Authy, etc.).'}
            </div>
          </div>
          <span className={`text-xs px-2 py-1 rounded ${totp?.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
            {totp?.enabled ? 'ENABLED' : 'DISABLED'}
          </span>
        </div>

        {!totp?.enabled && !setup && (
          <button onClick={startSetup} disabled={loading} className="mt-4 bg-blue-600 text-white px-4 py-2 rounded text-sm">
            {loading ? 'Starting…' : 'Enable 2FA'}
          </button>
        )}

        {!totp?.enabled && setup && (
          <div className="mt-4 border-t pt-4 text-center">
            <p className="text-xs text-gray-500 mb-2">Scan this QR code with your authenticator app, then enter the 6-digit code.</p>
            {setup.qr && <img src={setup.qr} alt="QR" className="mx-auto border rounded" />}
            <div className="text-xs text-gray-500 mt-2">Manual entry code: <b className="font-mono">{setup.secret}</b></div>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code"
              className="border rounded px-2 py-1 text-sm w-40 mt-3 text-center font-mono" />
            <div className="flex gap-2 mt-3 justify-center">
              <button onClick={enable} disabled={loading} className="bg-blue-600 text-white px-4 py-2 rounded text-sm">Verify & Enable</button>
              <button onClick={() => setSetup(null)} className="bg-gray-100 text-gray-700 px-4 py-2 rounded text-sm">Cancel</button>
            </div>
          </div>
        )}

        {totp?.enabled && (
          <button onClick={disable} disabled={loading} className="mt-4 bg-red-50 text-red-600 border border-red-200 px-4 py-2 rounded text-sm">
            Disable 2FA
          </button>
        )}
      </div>
    </div>
  );
}
