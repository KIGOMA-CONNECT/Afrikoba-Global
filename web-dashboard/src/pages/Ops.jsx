import React, { useEffect, useState } from 'react';
import api from '../api/client.js';

function Stat({ label, value, sub, tone }) {
  return (
    <div className="bg-white border rounded p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold ${tone || 'text-gray-900'}`}>{value ?? '—'}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

export default function Ops() {
  const [data, setData] = useState(null);
  const [audit, setAudit] = useState([]);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try { const r = await api.get('/ops/dashboard'); setData(r.data); }
    catch (e) { setNotice(e.response?.data?.message || 'Failed to load ops dashboard'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const loadAudit = async () => {
    try { const r = await api.get('/ops/audit?limit=20'); setAudit(r.data.logs || []); }
    catch (e) { setAudit([]); }
  };

  useEffect(() => { loadAudit(); }, []);

  const mb = (n) => n ? (n / 1024 / 1024).toFixed(1) + ' MB' : null;

  return (
    <div className="fade-in">
      <h2 className="text-xl font-semibold mb-1">Operations Dashboard</h2>
      <p className="text-gray-500 text-sm mb-4">System health · security posture · financial health · audit</p>
      {notice && <div className="bg-red-100 text-red-800 px-3 py-2 rounded mb-3 text-sm">{notice}</div>}

      {loading && !data ? <div className="text-gray-400 text-sm">Loading…</div> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            <Stat label="DB Status" value={data?.health?.db} tone={data?.health?.db === 'UP' ? 'text-green-600' : 'text-red-600'} />
            <Stat label="Total Users" value={data?.security?.totalUsers} />
            <Stat label="Active (7d)" value={data?.security?.active7d} />
            <Stat label="2FA Enabled" value={data?.security?.totpEnabledUsers} />
            <Stat label="Active Step-Up" value={data?.security?.activeStepupTokens} tone="text-amber-600" />
            <Stat label="Recurrence Rules" value={data?.recurrence?.activeRules} />
            <Stat label="Recurr. Failures (24h)" value={data?.recurrence?.failedLast24h} tone={(data?.recurrence?.failedLast24h || 0) > 0 ? 'text-red-600' : 'text-green-600'} />
            <Stat label="Uptime" value={data?.system ? `${Math.floor(data.system.uptime / 60)}m` : undefined} />
            <Stat label="Node" value={data?.system?.node || '—'} sub={mb(data?.system?.memory?.heapUsed) + ' heap'} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            <div className="bg-white border rounded p-4">
              <b className="text-sm block mb-2">Financial Health</b>
              {data?.financial ? (
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between border-b py-1">
                    <span className="text-gray-600">Status</span>
                    <b className={data.financial.ok ? 'text-green-600' : 'text-red-600'}>{data.financial.ok ? 'OK' : 'ATTENTION'}</b>
                  </div>
                  <div className="flex justify-between border-b py-1">
                    <span className="text-gray-600">Open Exceptions</span>
                    <b>{data.financial.openExceptions}</b>
                  </div>
                  <div className="flex justify-between border-b py-1">
                    <span className="text-gray-600">Stale Txn</span>
                    <b>{data.financial.aging?.stale}</b>
                  </div>
                  <div className="flex justify-between border-b py-1">
                    <span className="text-gray-600">Pending Deposits</span>
                    <b>{data.financial.aging?.pendingDeposits}</b>
                  </div>
                  <div className="flex justify-between border-b py-1">
                    <span className="text-gray-600">Processing Withdrawals</span>
                    <b>{data.financial.aging?.processingWithdrawals}</b>
                  </div>
                  <div className="flex justify-between border-b py-1">
                    <span className="text-gray-600">Latest Reconcile</span>
                    <b>{data.financial.reconciliation?.latest ? new Date(data.financial.reconciliation.latest.run_at).toLocaleString() : 'None'}</b>
                  </div>
                </div>
              ) : <div className="text-sm text-gray-400">No financial data</div>}
            </div>

            <div className="bg-white border rounded p-4">
              <b className="text-sm block mb-2">Security Events</b>
              {(data?.securityEvents || []).length === 0 && <div className="text-gray-400 text-sm">No recent events.</div>}
              {(data?.securityEvents || []).map((e) => (
                <div key={e.id} className="flex justify-between border-b py-1 text-sm">
                  <span className="text-gray-600">{e.summary || `Rule ${e.rule_id}`}</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${e.status === 'SUCCESS' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{e.status}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white border rounded p-4">
            <b className="text-sm block mb-2">Recent Audit Log</b>
            <div className="max-h-96 overflow-auto">
              {audit.length === 0 && <div className="text-gray-400 text-sm">No audit entries.</div>}
              {audit.map((a) => (
                <div key={a.id} className="flex justify-between border-b py-1 text-sm">
                  <span className="text-gray-700">{a.action} <span className="text-gray-400">({a.entity_type})</span></span>
                  <span className="text-xs text-gray-400">
                    {a.full_name || `#${a.user_id || 'system'}`} · {new Date(a.created_at).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
