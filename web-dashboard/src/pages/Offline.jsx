import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

export default function Offline() {
  const { t } = useT();
  const [ops, setOps] = useState([]);
  const [devices, setDevices] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [showQueue, setShowQueue] = useState(false);
  const [showDevice, setShowDevice] = useState(false);
  const [queueForm, setQueueForm] = useState({ op_type: 'TRANSFER', payload: '{"amount": 5000, "toPhone": "255700000001", "note": "Test offline transfer"}' });
  const [deviceForm, setDeviceForm] = useState({ device_id: 'dev-' + Math.random().toString(36).slice(2, 9), device_name: 'Mobile Phone', biometric_token: 'bio-token-secret' });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('offline.error') });

  const load = () => {
    api.get('/family/offline/ops').then((r) => setOps(r.data.ops || [])).catch(() => {});
    api.get('/family/devices').then((r) => setDevices(r.data.devices || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const queueOp = async (e) => {
    e.preventDefault();
    try {
      let parsedPayload;
      try {
        parsedPayload = JSON.parse(queueForm.payload);
      } catch {
        return setMsg({ type: 'err', text: t('offline.json_err') });
      }
      await api.post('/family/offline/queue', {
        op_type: queueForm.op_type,
        payload: parsedPayload,
      });
      setMsg({ type: 'ok', text: t('offline.queued_ok') });
      setShowQueue(false);
      load();
    } catch (err) { error(err); }
  };

  const syncOps = async () => {
    try {
      const res = await api.post('/family/offline/sync');
      const r = res.data.result || res.data;
      setMsg({ type: 'ok', text: `${t('offline.synced_ok')} (Processed: ${r.processed || 0}, Failed: ${r.failed || 0})` });
      load();
    } catch (err) { error(err); }
  };

  const registerDevice = async (e) => {
    e.preventDefault();
    try {
      await api.post('/family/devices', deviceForm);
      setMsg({ type: 'ok', text: t('offline.device_registered') });
      setShowDevice(false);
      load();
    } catch (err) { error(err); }
  };

  const removeDevice = async (deviceId) => {
    try {
      await api.delete(`/family/devices/${deviceId}`);
      setMsg({ type: 'ok', text: t('offline.device_removed') });
      load();
    } catch (err) { error(err); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>{t('offline.title')}</h2>
        <p>{t('offline.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      {/* Sync Bar */}
      <div className="card" style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc', padding: 20 }}>
        <div>
          <h4 style={{ margin: 0, marginBottom: 4 }}>{t('offline.sync_title')}</h4>
          <p className="roles-tag" style={{ margin: 0 }}>{t('offline.sync_hint')}</p>
        </div>
        <button className="btn" onClick={syncOps}>⚡ {t('offline.sync_now')}</button>
      </div>

      {/* Offline Queue Section */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>{t('offline.queue_title')}</h3>
        <button className="btn" onClick={() => setShowQueue(true)}>＋ {t('offline.queue_btn')}</button>
      </div>

      {showQueue && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('offline.queue_btn')}</h3>
          <form onSubmit={queueOp} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('offline.op_type')}<select value={queueForm.op_type} onChange={(e) => setQueueForm({ ...queueForm, op_type: e.target.value })}><option value="TRANSFER">Transfer</option><option value="CONTRIBUTION">Contribution</option><option value="BILL_PAYMENT">Bill Payment</option></select></label>
            <label>{t('offline.payload')}<textarea rows={4} value={queueForm.payload} onChange={(e) => setQueueForm({ ...queueForm, payload: e.target.value })} required style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontFamily: 'monospace' }} /></label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('offline.save')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowQueue(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      <div className="card" style={{ marginBottom: 24 }}>
        {ops.length === 0 ? (
          <p className="roles-tag">{t('offline.no_ops')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{t('offline.op_type')}</th>
                  <th>{t('offline.payload')}</th>
                  <th>{t('offline.status')}</th>
                  <th>{t('offline.date')}</th>
                </tr>
              </thead>
              <tbody>
                {ops.map((o) => (
                  <tr key={o.id}>
                    <td><strong>#{o.id}</strong></td>
                    <td><span className="badge info">{o.op_type}</span></td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{JSON.stringify(o.payload)}</td>
                    <td><span className={`badge ${o.status === 'PROCESSED' ? 'success' : o.status === 'QUEUED' ? 'warning' : 'danger'}`}>{o.status}</span></td>
                    <td>{new Date(o.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Biometric Devices Section */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>{t('offline.devices_title')}</h3>
        <button className="btn" onClick={() => setShowDevice(true)}>＋ {t('offline.device_btn')}</button>
      </div>

      {showDevice && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('offline.device_btn')}</h3>
          <form onSubmit={registerDevice} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('offline.device_id')}<input type="text" value={deviceForm.device_id} onChange={(e) => setDeviceForm({ ...deviceForm, device_id: e.target.value })} required /></label>
            <label>{t('offline.device_name')}<input type="text" value={deviceForm.device_name} onChange={(e) => setDeviceForm({ ...deviceForm, device_name: e.target.value })} required /></label>
            <label>{t('offline.biometric_token')}<input type="text" value={deviceForm.biometric_token} onChange={(e) => setDeviceForm({ ...deviceForm, biometric_token: e.target.value })} required /></label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('offline.save')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowDevice(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        {devices.length === 0 ? (
          <p className="roles-tag">{t('offline.no_devices')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('offline.device_name')}</th>
                  <th>{t('offline.device_id')}</th>
                  <th>{t('offline.trusted')}</th>
                  <th>{t('offline.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id}>
                    <td><strong>{d.device_name || 'Device'}</strong></td>
                    <td style={{ fontFamily: 'monospace' }}>{d.device_id}</td>
                    <td><span className={`badge ${d.is_trusted ? 'success' : 'warning'}`}>{d.is_trusted ? 'Trusted' : 'Pending'}</span></td>
                    <td>
                      <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => removeDevice(d.device_id)}>{t('offline.remove')}</button>
                    </td>
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
