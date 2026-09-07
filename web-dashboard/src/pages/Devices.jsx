import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

export default function Devices() {
  const { t } = useT();

  const [devices, setDevices] = useState([]);
  const [policy, setPolicy] = useState('PERMISSIVE');
  const [deviceName, setDeviceName] = useState('');
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [busy, setBusy] = useState(false);

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 5000);
  };

  const load = () => {
    api.get('/devices').then((r) => setDevices(r.data.devices || [])).catch(() => show('err', t('dev.load_failed')));
    api.get('/auth/me').then((r) => setPolicy(r.data.user?.device_policy || 'PERMISSIVE')).catch(() => {});
  };

  useEffect(() => { load(); }, []);

  const register = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/devices', { deviceName: deviceName || undefined });
      show('ok', t('dev.registered'));
      setDeviceName('');
      load();
    } catch (err) { show('err', err.response?.data?.message || t('dev.error')); }
    finally { setBusy(false); }
  };

  const changePolicy = async (p) => {
    setBusy(true);
    try {
      await api.put('/devices/policy', { policy: p });
      setPolicy(p);
      show('ok', t('dev.policy_saved'));
    } catch (err) { show('err', err.response?.data?.message || t('dev.error')); }
    finally { setBusy(false); }
  };

  const setTrust = async (id, trusted) => {
    try {
      await api.put(`/devices/${id}/trust`, { trusted });
      show('ok', t(trusted ? 'dev.restored' : 'dev.revoked'));
      load();
    } catch (err) { show('err', err.response?.data?.message || t('dev.error')); }
  };

  const removeDevice = async (id, name) => {
    if (!window.confirm(`${t('dev.remove_confirm')} ${name}?`)) return;
    try {
      await api.delete(`/devices/${id}`);
      show('ok', t('dev.removed'));
      load();
    } catch (err) { show('err', err.response?.data?.message || t('dev.error')); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>{t('dev.title')}</h2>
        <p>{t('dev.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="grid grid-2">
        <div className="card">
          <h3>{t('dev.policy_label')}</h3>
          <p className="roles-tag" style={{ marginBottom: 10 }}>{t('dev.policy_hint')}</p>
          <div className="inline-actions">
            <button className={`btn${policy === 'PERMISSIVE' ? '' : ' warn'}`} disabled={busy || policy === 'PERMISSIVE'} onClick={() => changePolicy('PERMISSIVE')}>{t('dev.permissive')}</button>
            <button className={`btn${policy === 'TRUSTED_ONLY' ? '' : ' warn'}`} disabled={busy || policy === 'TRUSTED_ONLY'} onClick={() => changePolicy('TRUSTED_ONLY')}>{t('dev.trusted_only')}</button>
          </div>
          <div className="roles-tag" style={{ marginTop: 10 }}>{t('dev.current_policy')}: <strong>{policy}</strong></div>
        </div>

        <div className="card">
          <h3>{t('dev.register_title')}</h3>
          <form onSubmit={register}>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>{t('dev.device_name')}</label>
              <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder={t('dev.name_ph')} />
            </div>
            <button className="btn" type="submit" disabled={busy}>{t('dev.register_btn')}</button>
          </form>
        </div>
      </div>

      <div className="card section">
        <h3>{t('dev.list_title')}</h3>
        {devices.length === 0 && <p className="roles-tag">{t('dev.no_devices')}</p>}
        <table>
          <thead><tr><th>{t('dev.device')}</th><th>{t('dev.type')}</th><th>{t('dev.last_seen')}</th><th>{t('dev.trusted')}</th><th></th></tr></thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>{d.device_name}</td>
                <td>{d.device_type} <div className="roles-tag">{d.os} / {d.browser}</div></td>
                <td>{d.last_used_at ? new Date(d.last_used_at).toLocaleString() : '-'}</td>
                <td>{d.is_trusted ? t('dev.trusted_yes') : t('dev.trusted_no')}</td>
                <td>
                  <div className="inline-actions">
                    {d.is_trusted
                      ? <button className="btn warn" onClick={() => setTrust(d.id, false)}>{t('dev.revoke')}</button>
                      : <button className="btn" onClick={() => setTrust(d.id, true)}>{t('dev.restore')}</button>}
                    <button className="btn" onClick={() => removeDevice(d.id, d.device_name)}>{t('dev.remove')}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}