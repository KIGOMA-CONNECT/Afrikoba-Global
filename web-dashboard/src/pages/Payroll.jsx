import React, { useEffect, useState } from 'react';
import { useT } from '../i18n/LangProvider.jsx';
import api from '../api/client.js';

export default function Payroll() {
  const { t } = useT();
  const [schedules, setSchedules] = useState([]);
  const [runs, setRuns] = useState([]);
  const [name, setName] = useState('');
  const [walletId, setWalletId] = useState('');
  const [scheduleId, setScheduleId] = useState('');
  const [scheduleTarget, setScheduleTarget] = useState('');
  const [userId, setUserId] = useState('');
  const [amount, setAmount] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedRun, setSelectedRun] = useState(null);
  const [runPayslips, setRunPayslips] = useState([]);
  const [loading, setLoading] = useState(false);

  const show = (m, ok = true) => { setNotice({ m, ok }); setTimeout(() => setNotice(''), 4000); };

  const loadAll = () => {
    api.get('/payroll/schedules').then((r) => setSchedules(r.data.schedules || [])).catch(() => {});
    api.get('/payroll/runs').then((r) => setRuns(r.data.runs || [])).catch(() => {});
  };

  useEffect(() => { loadAll(); }, []);

  const createSchedule = async () => {
    setLoading(true);
    try {
      await api.post('/payroll/schedules', { name, treasuryWalletId: parseInt(walletId, 10) });
      show('Schedule created'); setName(''); setWalletId(''); loadAll();
    } catch (e) { show(e.response?.data?.error || t('gov.error'), false); } finally { setLoading(false); }
  };

  const addEntry = async () => {
    setLoading(true);
    try {
      await api.post(`/payroll/schedules/${scheduleTarget}/entries`, { userId: parseInt(userId, 10), baseAmount: Number(amount) });
      show('Entry added'); setUserId(''); setAmount(''); loadAll();
    } catch (e) { show(e.response?.data?.error || t('gov.error'), false); } finally { setLoading(false); }
  };

  const runPayroll = async () => {
    setLoading(true);
    try {
      const start = new Date(); start.setMonth(start.getMonth() - 1);
      const res = await api.post('/payroll/runs', {
        scheduleId: parseInt(scheduleId, 10),
        periodStart: start.toISOString().slice(0, 10),
        periodEnd: new Date().toISOString().slice(0, 10),
      });
      show(`Run created (${res.data.payslips.length} payslips, total ${res.data.run.total_amount})`);
      loadAll();
    } catch (e) { show(e.response?.data?.error || t('gov.error'), false); } finally { setLoading(false); }
  };

  const approveRun = async (id) => {
    try {
      const res = await api.post(`/payroll/runs/${id}/approve`);
      show(`Run ${res.data.status}`);
      loadAll();
      if (selectedRun === id) viewRun(id);
    } catch (e) { show(e.response?.data?.error || t('gov.error'), false); }
  };

  const viewRun = async (id) => {
    setSelectedRun(id);
    try { const r = await api.get(`/payroll/runs/${id}/payslips`); setRunPayslips(r.data.payslips || []); }
    catch (e) { setRunPayslips([]); }
  };

  const statColor = (s) => ({ PAID: 'bg-green-100 text-green-700', PARTIAL: 'bg-yellow-100 text-yellow-700', DRAFT: 'bg-gray-100 text-gray-600', PENDING_APPROVAL: 'bg-blue-100 text-blue-700', FAILED: 'bg-red-100 text-red-700' }[s] || 'bg-gray-100 text-gray-600');

  return (
    <div className="fade-in">
      <h2 className="text-xl font-semibold mb-1">Automated Payroll</h2>
      <p className="text-gray-500 text-sm mb-4">Recurring compensation via treasury multi-sig</p>
      {notice && <div className={`px-3 py-2 rounded mb-3 text-sm ${notice.ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{notice.m}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="bg-white border rounded p-4">
          <b className="text-sm">Create Schedule</b>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="border rounded px-2 py-1 text-sm w-full mt-2" />
          <input value={walletId} onChange={(e) => setWalletId(e.target.value)} placeholder="Treasury wallet ID" className="border rounded px-2 py-1 text-sm w-full mt-2" />
          <button onClick={createSchedule} disabled={loading} className="mt-2 bg-blue-600 text-white px-4 py-2 rounded text-sm w-full">Create</button>
        </div>

        <div className="bg-white border rounded p-4">
          <b className="text-sm">Add Entry to Schedule</b>
          <select value={scheduleTarget} onChange={(e) => setScheduleTarget(e.target.value)} className="border rounded px-2 py-1 text-sm w-full mt-2">
            <option value="">Select schedule</option>
            {schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="Recipient user ID" className="border rounded px-2 py-1 text-sm w-full mt-2" />
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Base amount" className="border rounded px-2 py-1 text-sm w-full mt-2" />
          <button onClick={addEntry} disabled={loading} className="mt-2 bg-blue-600 text-white px-4 py-2 rounded text-sm w-full">Add Entry</button>
        </div>

        <div className="bg-white border rounded p-4">
          <b className="text-sm">Generate Payroll Run</b>
          <select value={scheduleId} onChange={(e) => setScheduleId(e.target.value)} className="border rounded px-2 py-1 text-sm w-full mt-2">
            <option value="">Select schedule</option>
            {schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button onClick={runPayroll} disabled={loading} className="mt-2 bg-blue-600 text-white px-4 py-2 rounded text-sm w-full">Generate Run</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border rounded p-4">
          <b className="text-sm block mb-2">Schedules</b>
          {schedules.map((s) => (
            <div key={s.id} className="border-b py-2 text-sm">
              <div className="flex justify-between">
                <span><b>{s.name}</b> ({s.frequency})</span>
                <span className={`text-xs px-2 py-0.5 rounded ${s.status === 'ACTIVE' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{s.status}</span>
              </div>
              <div className="text-xs text-gray-500">Wallet {s.wallet_name} · Headcount {s.headcount} · Monthly cost {Number(s.monthly_cost || 0).toLocaleString()}</div>
            </div>
          ))}
          {schedules.length === 0 && <div className="text-gray-400 text-sm">No schedules.</div>}
        </div>

        <div className="bg-white border rounded p-4">
          <b className="text-sm block mb-2">Runs</b>
          {runs.map((r) => (
            <div key={r.id} className="border-b py-2 text-sm cursor-pointer" onClick={() => viewRun(r.id)}>
              <div className="flex justify-between">
                <span>Run #{r.id} · {r.schedule_name}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${statColor(r.status)}`}>{r.status}</span>
              </div>
              <div className="text-xs text-gray-500">{r.period_start} → {r.period_end} · {r.recipients} recipients · {Number(r.total_amount).toLocaleString()}</div>
              {r.status === 'PENDING_APPROVAL' && (
                <button onClick={(e) => { e.stopPropagation(); approveRun(r.id); }} className="mt-1 text-xs bg-green-600 text-white px-2 py-1 rounded">Approve & Pay</button>
              )}
            </div>
          ))}
          {runs.length === 0 && <div className="text-gray-400 text-sm">No runs.</div>}
        </div>
      </div>

      {selectedRun && (
        <div className="bg-white border rounded p-4 mt-4">
          <b className="text-sm block mb-2">Run #{selectedRun} — Payslips</b>
          {runPayslips.map((p) => (
            <div key={p.id} className="flex justify-between border-b py-1 text-sm">
              <span>{p.full_name} ({p.phone_number})</span>
              <span className="flex items-center gap-2">
                <span>{Number(p.net_amount).toLocaleString()}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${p.status === 'PAID' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{p.status}</span>
              </span>
            </div>
          ))}
          {runPayslips.length === 0 && <div className="text-gray-400 text-sm">No payslips.</div>}
        </div>
      )}
    </div>
  );
}
