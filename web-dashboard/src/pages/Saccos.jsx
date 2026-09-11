import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

function toDate(v) {
  if (!v) return '-';
  if (v instanceof Date) return v.toLocaleDateString('en-CA');
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toLocaleDateString('en-CA');
}

function Stat({ value = '-', label }) {
  return (
    <div className="stat">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

export default function Saccos() {
  const { t } = useT();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const [orgs, setOrgs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loans, setLoans] = useState([]);
  const [openInst, setOpenInst] = useState({});
  const [instData, setInstData] = useState({});
  const [statement, setStatement] = useState(null);
  const [chips, setChips] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [meetForm, setMeetForm] = useState({ show: false, title: '', when: '', where: '', quorum: '50', agenda: '' });
  const [meetDetailId, setMeetDetailId] = useState(null);
  const [meetDetail, setMeetDetail] = useState({});
  const [minutesDraft, setMinutesDraft] = useState({});
  const [minutesDone, setMinutesDone] = useState({});
  const [si, setSi] = useState({ summary: null, cycles: [], mine: null, detail: {} });
  const [siDetailId, setSiDetailId] = useState(null);
  const [backing, setBacking] = useState(null);
  const [welfare, setWelfare] = useState({ schemes: [], mine: [], claims: [], summary: null, form: { show: false, name: '', contribution: '', payout: '' } });
  const [wClaim, setWClaim] = useState({});
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [busy, setBusy] = useState({});
  const [guar, setGuar] = useState([]);
  const [rest, setRest] = useState({ history: {}, form: {} });
  const [wo, setWo] = useState({ list: [], form: {} });
  const [so, setSo] = useState({
    mine: [],
    all: [],
    targets: { funds: [], schemes: [], loans: [] },
    form: { show: false, type: 'SAVINGS_DEPOSIT', amount: '', day: '1', targetId: '' },
  });
  const [lp, setLp] = useState({
    list: [],
    form: { show: false, code: '', name: '', desc: '', rate: '', min: '', max: '', term: '' },
    apply: { show: false, productId: '', amount: '', term: '', purpose: '' },
  });

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 5000);
  };

  const loadOrgs = () => {
    api.get('/saccos').then((r) => setOrgs(r.data.result || r.data.saccos || [])).catch(() => {});
  };

  useEffect(() => {
    loadOrgs();
  }, []);

  const isGoverning = () => {
    const role = selected ? (selected.membership_role || selected.role || '') : '';
    const platformAdmin = user.role === 'ADMIN';
    return platformAdmin || role === 'OWNER' || role === 'BOARD';
  };

  const loadChips = (id, role) => {
    setChips(null);
    if (role !== 'OWNER' && role !== 'BOARD' && user.role !== 'ADMIN') return;
    const picks = {
      loans: '/loans/summary',
      savings: '/savings/summary',
      dividends: '/dividends/summary',
      funds: '/funds/summary',
      accounting: '/accounting/summary',
      arrears: '/loans/arrears',
      meetings: '/meetings/summary',
      savingsInterest: '/savings-interest/summary',
      welfare: '/welfare/summary',
      standingOrders: '/standing-orders',
      writeOffs: '/loans/write-offs',
    };
    const out = {};
    Promise.all(Object.entries(picks).map(([k, p]) =>
      api.get(`/saccos/${id}${p}`).then((r) => { out[k] = r.data.result || r.data; })
        .catch(() => { out[k] = null; })
    )).then(() => setChips(out));
  };

  const selectOrg = (org) => {
    setSelected(org);
    setLoans([]);
    setOpenInst({});
    setInstData({});
    setStatement(null);
    setChips(null);
    setMeetings([]);
    setMeetDetailId(null);
    setMeetDetail({});
    setMinutesDraft({});
    setMinutesDone({});
    setSi({ summary: null, cycles: [], mine: null, detail: {} });
    setSiDetailId(null);
    setBacking(null);
    setWelfare({ schemes: [], mine: [], claims: [], summary: null, form: { show: false, name: '', contribution: '', payout: '' } });
    setWClaim({});
    setGuar([]);
    setRest({ history: {}, form: {} });
    setWo({ list: [], form: {} });
    setSo({ mine: [], all: [], targets: { funds: [], schemes: [], loans: [] }, form: { show: false, type: 'SAVINGS_DEPOSIT', amount: '', day: '1', targetId: '' } });
    setLp({ list: [], form: { show: false, code: '', name: '', desc: '', rate: '', min: '', max: '', term: '' }, apply: { show: false, productId: '', amount: '', term: '', purpose: '' } });
    loadProducts(org.id);
    api.get(`/saccos/${org.id}/loans/mine`).then((r) => {
      setLoans(r.data.result.loans || []);
      if (r.data.result.loans && r.data.result.loans.length) {
        const first = r.data.result.loans[0];
        fetchInstallments(org.id, first.id);
      }
    }).catch(() => {});
    api.get(`/saccos/${org.id}/statements/mine`).then((r) => setStatement(r.data.result)).catch(() => {});
    loadMeetings(org.id);
    loadSi(org.id, org.membership_role);
    loadBacking(org.id);
    loadWelfare(org.id, org.membership_role);
    loadGuar(org.id);
    loadWo(org.id, org.membership_role);
    loadSo(org.id, org.membership_role);
    loadChips(org.id, org.membership_role);
  };

  const loadSi = (id, role) => {
    api.get(`/saccos/${id}/savings-interest/mine`)
      .then((r) => setSi((s) => ({ ...s, mine: r.data.result })))
      .catch(() => {});
    if (user.role === 'ADMIN' || role === 'OWNER' || role === 'BOARD') {
      api.get(`/saccos/${id}/savings-interest/summary`)
        .then((r) => setSi((s) => ({ ...s, summary: r.data.result })))
        .catch(() => {});
      api.get(`/saccos/${id}/savings-interest/cycles`)
        .then((r) => setSi((s) => ({ ...s, cycles: r.data.result || [] })))
        .catch(() => {});
    }
  };

  const reloadSi = () => loadSi(selected.id, selected.membership_role || selected.role);

  const prepareSi = async () => {
    setBusy((prev) => ({ ...prev, siPrep: true }));
    try {
      const res = await api.post(`/saccos/${selected.id}/savings-interest/prepare`);
      const r = res.data.result || {};
      show('ok', r.cycle ? `${r.awards || 0} ${t('saccos.si_members')} · ${formatMoney(r.total_interest)}` : t('saccos.saved'));
      reloadSi();
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, siPrep: false }));
    }
  };

  const postSi = async (cycleId) => {
    const key = `siPost${cycleId}`;
    setBusy((prev) => ({ ...prev, [key]: true }));
    try {
      const res = await api.post(`/saccos/${selected.id}/savings-interest/cycles/${cycleId}/post`);
      show('ok', res.data.message || t('saccos.saved'));
      reloadSi();
      api.get(`/saccos/${selected.id}/statements/mine`).then((r) => setStatement(r.data.result)).catch(() => {});
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
    }
  };

  const toggleSiDetail = (cycleId) => {
    if (siDetailId === cycleId) { setSiDetailId(null); return; }
    setSiDetailId(cycleId);
    api.get(`/saccos/${selected.id}/savings-interest/cycles/${cycleId}`)
      .then((r) => setSi((s) => ({ ...s, detail: { ...s.detail, [cycleId]: r.data.result } })))
      .catch(() => {});
  };

  const loadBacking = (id) => {
    api.get(`/saccos/${id}/loans/backing`)
      .then((r) => setBacking(r.data.result))
      .catch(() => setBacking(null));
  };

  const loadWelfare = (id, role) => {
    api.get(`/saccos/${id}/welfare/schemes`)
      .then((r) => setWelfare((w) => ({ ...w, schemes: r.data.result || [] })))
      .catch(() => setWelfare((w) => ({ ...w, schemes: [] })));
    api.get(`/saccos/${id}/welfare/contributions/mine`)
      .then((r) => setWelfare((w) => ({ ...w, mine: r.data.result || [] })))
      .catch(() => setWelfare((w) => ({ ...w, mine: [] })));
    api.get(`/saccos/${id}/welfare/claims`)
      .then((r) => setWelfare((w) => ({ ...w, claims: r.data.result || [] })))
      .catch(() => setWelfare((w) => ({ ...w, claims: [] })));
    if (user.role === 'ADMIN' || role === 'OWNER' || role === 'BOARD') {
      api.get(`/saccos/${id}/welfare/summary`)
        .then((r) => setWelfare((w) => ({ ...w, summary: r.data.result })))
        .catch(() => {});
    }
  };

  const reloadWelfare = () => loadWelfare(selected.id, selected.membership_role || selected.role);

  const reloadLoans = () => {
    api.get(`/saccos/${selected.id}/loans/mine`)
      .then((r) => setLoans(r.data.result.loans || []))
      .catch(() => {});
    api.get(`/saccos/${selected.id}/statements/mine`).then((r) => setStatement(r.data.result)).catch(() => {});
  };

  const loadProducts = (id) => {
    api.get(`/saccos/${id}/loans/products`)
      .then((r) => setLp((prev) => ({ ...prev, list: r.data.result || [] })))
      .catch(() => setLp((prev) => ({ ...prev, list: [] })));
  };

  const reloadProducts = () => loadProducts(selected.id);

  const toggleLpForm = () => setLp((prev) => ({ ...prev, form: { ...prev.form, show: !prev.form.show } }));

  const createProduct = async () => {
    const f = lp.form;
    if (!(f.code || '').trim() || !(f.name || '').trim() || !(Number(f.rate) >= 0) || !(Number(f.term) >= 1)) { show('err', t('saccos.error')); return; }
    setBusy((prev) => ({ ...prev, lpNew: true }));
    try {
      await api.post(`/saccos/${selected.id}/loans/products`, {
        code: f.code, name: f.name, description: f.desc || null,
        interestRatePercent: Number(f.rate), minAmount: Number(f.min || 0),
        maxAmount: f.max ? Number(f.max) : null, maxTermMonths: Number(f.term),
      });
      show('ok', t('saccos.saved'));
      setLp((prev) => ({ ...prev, form: { show: false, code: '', name: '', desc: '', rate: '', min: '', max: '', term: '' } }));
      reloadProducts();
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, lpNew: false }));
    }
  };

  const archiveProduct = async (productId) => {
    setBusy((prev) => ({ ...prev, [`lpArc${productId}`]: true }));
    try {
      await api.post(`/saccos/${selected.id}/loans/products/${productId}/archive`);
      show('ok', t('saccos.saved'));
      reloadProducts();
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, [`lpArc${productId}`]: false }));
    }
  };

  const openLoanApply = (productId) => setLp((prev) => ({ ...prev, apply: { show: true, productId: productId || '', amount: '', term: '', purpose: '' } }));

  const doLoanApply = async () => {
    const f = lp.apply;
    if (!(Number(f.amount) > 0) || !(Number(f.term) >= 1)) { show('err', t('saccos.error')); return; }
    setBusy((prev) => ({ ...prev, lpApply: true }));
    try {
      await api.post(`/saccos/${selected.id}/loans/apply`, {
        amount: Number(f.amount), termMonths: Number(f.term), purpose: f.purpose || null,
        productId: f.productId ? Number(f.productId) : undefined,
      });
      show('ok', t('saccos.saved'));
      setLp((prev) => ({ ...prev, apply: { show: false, productId: '', amount: '', term: '', purpose: '' } }));
      reloadLoans();
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, lpApply: false }));
    }
  };

  const loadGuar = (id) => {
    api.get(`/saccos/${id}/loans/guarantees/mine`)
      .then((r) => setGuar(r.data.result || []))
      .catch(() => setGuar([]));
  };

  const loadWo = (id, role) => {
    if (user.role !== 'ADMIN' && role !== 'OWNER' && role !== 'BOARD') return;
    api.get(`/saccos/${id}/loans/write-offs`)
      .then((r) => setWo((w) => ({ ...w, list: r.data.result || [] })))
      .catch(() => {});
  };

  const reloadWo = () => loadWo(selected.id, selected.membership_role || selected.role);

  const loadSo = (id, role) => {
    api.get(`/saccos/${id}/standing-orders/mine`)
      .then((r) => setSo((s) => ({ ...s, mine: r.data.result || [] })))
      .catch(() => setSo((s) => ({ ...s, mine: [] })));
    if (user.role === 'ADMIN' || role === 'OWNER' || role === 'BOARD') {
      api.get(`/saccos/${id}/standing-orders`)
        .then((r) => setSo((s) => ({ ...s, all: r.data.result || [] })))
        .catch(() => {});
    }
    api.get(`/saccos/${id}/funds`)
      .then((r) => setSo((s) => ({ ...s, targets: { ...s.targets, funds: (r.data.result || []).filter((f) => f.status === 'ACTIVE') } })))
      .catch(() => {});
    api.get(`/saccos/${id}/welfare/schemes`)
      .then((r) => setSo((s) => ({ ...s, targets: { ...s.targets, schemes: (r.data.result || []).filter((x) => x.status === 'ACTIVE') } })))
      .catch(() => {});
    api.get(`/saccos/${id}/loans/mine`)
      .then((r) => setSo((s) => ({ ...s, targets: { ...s.targets, loans: (r.data.result.loans || []).filter((l) => l.status === 'ACTIVE') } })))
      .catch(() => {});
  };

  const reloadSo = () => loadSo(selected.id, selected.membership_role || selected.role);

  const guaranteeAction = async (g, action) => {
    const key = `g${action}${g.id}`;
    setBusy((prev) => ({ ...prev, [key]: true }));
    try {
      await api.post(`/saccos/${selected.id}/loans/guarantees/${g.id}/${action}`);
      show('ok', t('saccos.saved'));
      loadGuar(selected.id);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
    }
  };

  const toggleRestForm = (loanId) => setRest((prev) => ({ ...prev, form: { ...prev.form, [loanId]: { ...(prev.form[loanId] || {}), show: !(prev.form[loanId] || {}).show } } }));

  const toggleRest = (loanId) => {
    const open = !!rest.history[loanId];
    setRest((prev) => ({ ...prev, history: { ...prev.history, [loanId]: open ? undefined : [] } }));
    if (open) return;
    api.get(`/saccos/${selected.id}/loans/${loanId}/restructures`)
      .then((r) => setRest((prev) => ({ ...prev, history: { ...prev.history, [loanId]: r.data.result || [] } })))
      .catch(() => {});
  };

  const doRestructure = async (loanId) => {
    const f = rest.form[loanId] || {};
    if (!(Number(f.term) > 0) || f.rate === '' || f.rate === undefined) { show('err', t('saccos.rest_term')); return; }
    setBusy((prev) => ({ ...prev, [`rest${loanId}`]: true }));
    try {
      await api.post(`/saccos/${selected.id}/loans/${loanId}/restructure`, { newTermMonths: Number(f.term), newRatePercent: Number(f.rate), reason: f.reason || null });
      show('ok', t('saccos.saved'));
      setRest((prev) => ({ ...prev, form: { ...prev.form, [loanId]: {} } }));
      reloadLoans();
      if (isGoverning()) loadChips(selected.id, selected.membership_role || selected.role);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, [`rest${loanId}`]: false }));
    }
  };

  const toggleWoForm = (loanId) => setWo((prev) => ({ ...prev, form: { ...prev.form, [loanId]: { ...(prev.form[loanId] || {}), show: !(prev.form[loanId] || {}).show } } }));

  const doWriteOff = async (loanId) => {
    const f = wo.form[loanId] || {};
    if (!(f.reason || '').trim()) { show('err', t('saccos.writeoff_reason')); return; }
    setBusy((prev) => ({ ...prev, [`wo${loanId}`]: true }));
    try {
      await api.post(`/saccos/${selected.id}/loans/${loanId}/write-off`, { reason: f.reason });
      show('ok', t('saccos.saved'));
      setWo((prev) => ({ ...prev, form: { ...prev.form, [loanId]: {} } }));
      reloadLoans();
      reloadWo();
      if (isGoverning()) loadChips(selected.id, selected.membership_role || selected.role);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, [`wo${loanId}`]: false }));
    }
  };

  const createSo = async () => {
    const f = so.form;
    const day = Number(f.day);
    if (!(Number(f.amount) > 0) || !(day >= 1 && day <= 28)) { show('err', t('saccos.so_day')); return; }
    if (f.type !== 'SAVINGS_DEPOSIT' && !f.targetId) { show('err', t('saccos.so_target')); return; }
    setBusy((prev) => ({ ...prev, soNew: true }));
    try {
      await api.post(`/saccos/${selected.id}/standing-orders`, { targetType: f.type, targetId: f.targetId || null, amount: Number(f.amount), dayOfMonth: day });
      show('ok', t('saccos.saved'));
      setSo((s) => ({ ...s, form: { show: false, type: 'SAVINGS_DEPOSIT', amount: '', day: '1', targetId: '' } }));
      reloadSo();
      if (isGoverning()) loadChips(selected.id, selected.membership_role || selected.role);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, soNew: false }));
    }
  };

  const deactivateSo = async (id) => {
    setBusy((prev) => ({ ...prev, [`soDe${id}`]: true }));
    try {
      await api.post(`/saccos/${selected.id}/standing-orders/${id}/deactivate`);
      show('ok', t('saccos.saved'));
      reloadSo();
      if (isGoverning()) loadChips(selected.id, selected.membership_role || selected.role);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, [`soDe${id}`]: false }));
    }
  };

  const runSo = async () => {
    setBusy((prev) => ({ ...prev, soRun: true }));
    try {
      const res = await api.post(`/saccos/${selected.id}/standing-orders/run`);
      const r = res.data.result || {};
      if (r.succeeded !== undefined) {
        show('ok', `${r.succeeded}/${r.executed} ${t('saccos.so_success')}`);
      } else {
        show('ok', t('saccos.saved'));
      }
      reloadSo();
      if (isGoverning()) loadChips(selected.id, selected.membership_role || selected.role);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, soRun: false }));
    }
  };

  const soTypeLabel = (type) => {
    if (type === 'SAVINGS_DEPOSIT') return t('saccos.so_savings');
    if (type === 'FUND_CONTRIBUTION') return t('saccos.so_fund');
    if (type === 'WELFARE_CONTRIBUTION') return t('saccos.so_welfare');
    if (type === 'LOAN_REPAYMENT') return t('saccos.so_loan');
    return type;
  };

  const soTargetName = (o) => {
    if (o.target_type === 'SAVINGS_DEPOSIT') return '-';
    if (o.target_type === 'FUND_CONTRIBUTION') {
      const f = so.targets.funds.find((x) => x.id === o.target_id);
      return f ? `${f.name || f.code} (${f.code})` : `#${o.target_id}`;
    }
    if (o.target_type === 'WELFARE_CONTRIBUTION') {
      const s = so.targets.schemes.find((x) => x.id === o.target_id);
      return s ? s.name : `#${o.target_id}`;
    }
    const l = so.targets.loans.find((x) => x.id === o.target_id);
    return l ? l.reference_id : `#${o.target_id}`;
  };

  const createScheme = async () => {
    const f = welfare.form;
    if (!f.name.trim() || !(Number(f.contribution) > 0) || !(Number(f.payout) > 0)) { show('err', t('saccos.wf_name')); return; }
    setBusy((prev) => ({ ...prev, wSch: true }));
    try {
      await api.post(`/saccos/${selected.id}/welfare/schemes`, { name: f.name, contribution: Number(f.contribution), payout: Number(f.payout) });
      show('ok', t('saccos.saved'));
      setWelfare((w) => ({ ...w, form: { show: false, name: '', contribution: '', payout: '' } }));
      reloadWelfare();
      if (isGoverning()) loadChips(selected.id, selected.membership_role || selected.role);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, wSch: false }));
    }
  };

  const joinScheme = async (scheme) => {
    setBusy((prev) => ({ ...prev, [`join${scheme.id}`]: true }));
    try {
      await api.post(`/saccos/${selected.id}/welfare/contributions`, { schemeId: scheme.id, amount: Number(scheme.contribution) });
      show('ok', t('saccos.saved'));
      reloadWelfare();
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, [`join${scheme.id}`]: false }));
    }
  };

  const submitClaim = async (scheme) => {
    const f = wClaim[scheme.id] || {};
    if (!(f.event || '').trim() || !(Number(f.amount) > 0)) { show('err', t('saccos.wf_event')); return; }
    setBusy((prev) => ({ ...prev, [`wClaim${scheme.id}`]: true }));
    try {
      await api.post(`/saccos/${selected.id}/welfare/claims`, { schemeId: scheme.id, event: f.event, details: f.details, amount: Number(f.amount) });
      show('ok', t('saccos.saved'));
      setWClaim((prev) => ({ ...prev, [scheme.id]: { event: '', details: '', amount: '' } }));
      reloadWelfare();
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, [`wClaim${scheme.id}`]: false }));
    }
  };

  const reviewClaim = async (claimId, decision) => {
    const key = `rev${claimId}`;
    setBusy((prev) => ({ ...prev, [key]: true }));
    try {
      await api.post(`/saccos/${selected.id}/welfare/claims/${claimId}/review`, { decision });
      show('ok', t('saccos.saved'));
      reloadWelfare();
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
    }
  };

  const payClaim = async (claimId) => {
    const key = `pay${claimId}`;
    setBusy((prev) => ({ ...prev, [key]: true }));
    try {
      await api.post(`/saccos/${selected.id}/welfare/claims/${claimId}/pay`);
      show('ok', t('saccos.saved'));
      reloadWelfare();
      if (isGoverning()) loadChips(selected.id, selected.membership_role || selected.role);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
    }
  };

  const loadMeetings = (id) => {
    api.get(`/saccos/${id}/meetings`)
      .then((r) => setMeetings(r.data.result || []))
      .catch(() => setMeetings([]));
  };

  const reloadMeetings = () => loadMeetings(selected.id);

  const meetAction = async (meetingId, action, extra) => {
    const key = `m${meetingId}${action}`;
    setBusy((prev) => ({ ...prev, [key]: true }));
    try {
      const res = await api.post(`/saccos/${selected.id}/meetings/${meetingId}/${action}`, extra);
      show('ok', res.data.message || t('saccos.saved'));
      reloadMeetings();
      if (isGoverning()) loadChips(selected.id, selected.membership_role || selected.role);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
    }
  };

  const createMeeting = async () => {
    if (!meetForm.title.trim()) { show('err', t('saccos.meet_title')); return; }
    setBusy((prev) => ({ ...prev, meetNew: true }));
    try {
      const agenda = meetForm.agenda.split('\n').map((l) => l.trim()).filter(Boolean).map((title) => ({ title }));
      await api.post(`/saccos/${selected.id}/meetings`, {
        title: meetForm.title,
        scheduledAt: new Date(meetForm.when).toISOString(),
        location: meetForm.where,
        quorumPct: Number(meetForm.quorum) || 50,
        agenda,
      });
      show('ok', t('saccos.meet_created'));
      setMeetForm({ show: false, title: '', when: '', where: '', quorum: '50', agenda: '' });
      reloadMeetings();
      if (isGoverning()) loadChips(selected.id, selected.membership_role || selected.role);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, meetNew: false }));
    }
  };

  const toggleMeetDetail = (meetingId) => {
    if (meetDetailId === meetingId) { setMeetDetailId(null); return; }
    setMeetDetailId(meetingId);
    api.get(`/saccos/${selected.id}/meetings/${meetingId}`)
      .then((r) => setMeetDetail((prev) => ({ ...prev, [meetingId]: r.data.result })))
      .catch(() => {});
  };

  const toggleDone = (meetingId, itemId) => {
    setMinutesDone((prev) => {
      const s = new Set(prev[meetingId] || []);
      if (s.has(itemId)) s.delete(itemId); else s.add(itemId);
      return { ...prev, [meetingId]: s };
    });
  };

  const fetchInstallments = (orgId, loanId) => {
    api.get(`/saccos/${orgId}/loans/${loanId}/installments`)
      .then((r) => {
        setInstData((prev) => ({ ...prev, [loanId]: r.data.result }));
        setOpenInst((prev) => ({ ...prev, [loanId]: true }));
      })
      .catch(() => setOpenInst((prev) => ({ ...prev, [loanId]: false })));
  };

  const toggleInst = (loanId) => {
    if (openInst[loanId]) {
      setOpenInst((prev) => ({ ...prev, [loanId]: false }));
      return;
    }
    fetchInstallments(selected.id, loanId);
  };

  const payInstallment = async (loanId, instId) => {
    setBusy((prev) => ({ ...prev, [instId]: true }));
    try {
      const res = await api.post(`/saccos/${selected.id}/loans/${loanId}/installments/${instId}/pay`);
      show('ok', res.data.message || 'Awamu imelipwa.');
      fetchInstallments(selected.id, loanId);
      api.get(`/saccos/${selected.id}/loans/mine`).then((r) => setLoans(r.data.result.loans || [])).catch(() => {});
      api.get(`/saccos/${selected.id}/statements/mine`).then((r) => setStatement(r.data.result)).catch(() => {});
      if (isGoverning()) loadChips(selected.id, selected.membership_role || selected.role);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, [instId]: false }));
    }
  };

  const recomputeArrears = async () => {
    setBusy((prev) => ({ ...prev, arrears: true }));
    try {
      const res = await api.post(`/saccos/${selected.id}/loans/recompute-arrears`);
      const r = res.data.result || {};
      show('ok', `${r.overdue || 0} ${t('saccos.arrears_overdue')} · ${formatMoney(r.arrears_total)}`);
      loadChips(selected.id, selected.membership_role || selected.role);
    } catch (err) {
      show('err', err.response?.data?.message || t('saccos.error'));
    } finally {
      setBusy((prev) => ({ ...prev, arrears: false }));
    }
  };

  const renderInstallments = (loan) => {
    const data = instData[loan.id];
    if (!data) return null;
    const firstUnpaid = data.installments.findIndex((inst) => inst.status !== 'PAID');
    return (
      <div style={{ padding: '10px 0 4px' }}>
        <div className="grid grid-3" style={{ marginBottom: 10 }}>
          <Stat value={formatMoney(data.total)} label={t('saccos.loan_total')} />
          <Stat value={formatMoney(data.outstanding)} label={t('saccos.outstanding')} />
          <Stat value={`${data.summary.paidCount}/${data.summary.total}`} label={t('saccos.paid')} />
        </div>
        {data.summary.overdue > 0 ? (
          <div className="msg err" style={{ marginBottom: 10 }}>
            {data.summary.overdue} {t('saccos.arrears_overdue')} · {t('saccos.fine')}: {formatMoney(data.summary.lateFees)}
          </div>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>{t('saccos.due')}</th>
              <th>{t('saccos.p_principal')}</th>
              <th>{t('saccos.p_interest')}</th>
              <th>{t('saccos.p_total')}</th>
              <th>{t('saccos.fine')}</th>
              <th>{t('saccos.status')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.installments.map((inst, idx) => {
              const can = loan.status === 'ACTIVE' && inst.status !== 'PAID' && idx === firstUnpaid;
              const hasFee = Number(inst.late_fee || 0) > 0;
              return (
                <tr key={inst.id}>
                  <td>{inst.installment_no}</td>
                  <td>{toDate(inst.due_date)}</td>
                  <td>{formatMoney(inst.principal_part)}</td>
                  <td>{formatMoney(inst.interest_part)}</td>
                  <td>{formatMoney(inst.total)}</td>
                  <td style={hasFee ? { color: 'var(--danger, #c0392b)', fontWeight: 600 } : {}}>
                    {hasFee ? formatMoney(inst.late_fee) : '-'}
                  </td>
                  <td><StatusBadge status={inst.status} /></td>
                  <td>
                    {can ? (
                      <>
                        {inst.status === 'OVERDUE' ? (
                          <span className="muted" style={{ marginRight: 8 }}>
                            {t('saccos.pay_with_fee')}: {formatMoney(Number(inst.total) + Number(inst.late_fee || 0))}
                          </span>
                        ) : null}
                        <button className="btn" disabled={!!busy[inst.id]} onClick={() => payInstallment(loan.id, inst.id)}>
                          {busy[inst.id] ? t('saccos.paying') : hasFee ? t('saccos.pay_with_fee') : t('saccos.pay')}
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div>
      <h2>{t('saccos.title')}</h2>
      <p className="muted">{t('saccos.sub')}</p>
      {msg.text ? <div className={`msg ${msg.type}`}>{msg.text}</div> : null}

      {!orgs.length ? (
        <div className="card"><p>{t('saccos.none')}</p></div>
      ) : (
        <div className="grid grid-3">
          {orgs.map((org) => (
            <div key={org.id} className={`card${selected && selected.id === org.id ? ' locked' : ''}`}>
              <h3>{org.name}</h3>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '8px 0' }}>
                <span className="muted">{org.code}</span>
                <StatusBadge status={org.status} />
              </div>
              <div className="muted" style={{ marginBottom: 10 }}>
                {t('saccos.member_role')}: {org.membership_role || '-'}&nbsp;·&nbsp;
                {t('saccos.member_no')}: {org.member_number || '-'}
              </div>
              {selected && selected.id === org.id ? (
                <div className="muted">{t('saccos.selected')}</div>
              ) : (
                <button className="btn" onClick={() => selectOrg(org)}>{t('saccos.open')}</button>
              )}
            </div>
          ))}
        </div>
      )}

      {selected && (
        <>
          {isGoverning() && (
            <div className="card">
              <h3>{t('saccos.overview')}</h3>
              {!chips ? (
                <div className="muted">{t('saccos.loading')}</div>
              ) : (
                <>
                  <div className="grid grid-2">
                    <Stat value={chips.loans ? `${chips.loans.active_loans || 0}` : '-'} label={t('saccos.chips_l_loans')} />
                    <Stat value={chips.loans ? formatMoney(chips.loans.outstanding) : '-'} label={t('saccos.chips_l_out')} />
                    <Stat value={chips.savings ? formatMoney(chips.savings.liability || chips.savings.total_deposits) : '-'} label={t('saccos.chips_savings')} />
                    <Stat value={chips.funds ? formatMoney(chips.funds.total_balance) : '-'} label={t('saccos.chips_funds')} />
                    <Stat value={chips.dividends ? formatMoney(chips.dividends.distributed || 0) : '-'} label={t('saccos.chips_dividends')} />
                    <Stat value={chips.arrears ? `${chips.arrears.overdue || 0}` : '-'} label={t('saccos.chips_arrears_o')} />
                    <Stat value={chips.arrears ? formatMoney(chips.arrears.arrears_total) : '-'} label={t('saccos.chips_arrears_t')} />
                    <Stat value={chips.arrears ? formatMoney(chips.arrears.late_fees_total) : '-'} label={t('saccos.chips_arrears_f')} />
                    <Stat value={chips.meetings ? `${chips.meetings.total || 0}` : '-'} label={t('saccos.chips_meetings')} />
                    <Stat value={chips.savingsInterest ? formatMoney(chips.savingsInterest.pending_total) : '-'} label={t('saccos.chips_si_pending')} />
                    <Stat value={chips.welfare ? formatMoney(chips.welfare.fund_balance) : '-'} label={t('saccos.chips_wf')} />
                    <Stat value={chips.standingOrders ? `${(chips.standingOrders || []).filter((o) => o.status === 'ACTIVE').length}` : '-'} label={t('saccos.chips_so')} />
                    <Stat value={chips.writeOffs ? `${(chips.writeOffs || []).length}` : '-'} label={t('saccos.chips_wo')} />
                  </div>
                  {chips.arrears && Number(chips.arrears.overdue || 0) > 0 ? (
                    <div className="msg err" style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                      <span>{chips.arrears.overdue} {t('saccos.arrears_overdue')} · {formatMoney(chips.arrears.arrears_total)}</span>
                      <button className="btn" disabled={!!busy.arrears} onClick={recomputeArrears}>
                        {busy.arrears ? t('saccos.recomputing') : t('saccos.recompute')}
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          )}

          <div className="card">
            <h3>{t('saccos.my_loans')}</h3>
            {backing && Number(backing.backing_limit) > 0 ? (
              <div className="grid grid-2" style={{ marginBottom: 10 }}>
                <Stat value={formatMoney(backing.backing_limit)} label={t('saccos.backing_limit')} />
                <Stat value={`${formatMoney(backing.savings_balance)} + ${formatMoney(backing.share_value)}`} label={t('saccos.backing_base')} />
              </div>
            ) : null}
            {!loans.length ? (
              <div className="muted">{t('saccos.no_loans')}</div>
            ) : (
              loans.map((loan) => (
                <div key={loan.id} style={{ borderTop: '1px solid var(--border, #e5e5e5)', padding: '12px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <div>
                      <strong>{formatMoney(loan.principal)}</strong>
                      <span className="muted"> · {loan.term_months} {t('saccos.months')} @ {loan.interest_rate}%</span>
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <span className="muted">{t('saccos.outstanding')}: <strong>{formatMoney(loan.amount_outstanding)}</strong></span>
                      <StatusBadge status={loan.status} />
                      {isGoverning() && loan.status === 'ACTIVE' ? (
                        <>
                          <button className="btn ghost" onClick={() => toggleRestForm(loan.id)}>
                            {rest.form[loan.id]?.show ? t('saccos.hide') : t('saccos.restructure')}
                          </button>
                          <button className="btn ghost" onClick={() => toggleWoForm(loan.id)}>
                            {wo.form[loan.id]?.show ? t('saccos.hide') : t('saccos.writeoff')}
                          </button>
                        </>
                      ) : null}
                      <button className="btn ghost" onClick={() => toggleInst(loan.id)}>
                        {openInst[loan.id] ? t('saccos.hide') : t('saccos.schedule')}
                      </button>
                    </div>
                  </div>
                  {openInst[loan.id] ? renderInstallments(loan) : null}
                  {rest.form[loan.id]?.show && isGoverning() && loan.status === 'ACTIVE' ? (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border, #e5e5e5)' }}>
                      <input type="number" placeholder={t('saccos.rest_term')}
                        value={rest.form[loan.id].term || ''}
                        onChange={(e) => setRest((prev) => ({ ...prev, form: { ...prev.form, [loan.id]: { ...(prev.form[loan.id] || {}), term: e.target.value } } }))} />
                      <input type="number" placeholder={t('saccos.rest_rate')}
                        value={rest.form[loan.id].rate || ''}
                        onChange={(e) => setRest((prev) => ({ ...prev, form: { ...prev.form, [loan.id]: { ...(prev.form[loan.id] || {}), rate: e.target.value } } }))} />
                      <input placeholder={t('saccos.rest_reason')}
                        value={rest.form[loan.id].reason || ''}
                        onChange={(e) => setRest((prev) => ({ ...prev, form: { ...prev.form, [loan.id]: { ...(prev.form[loan.id] || {}), reason: e.target.value } } }))} />
                      <button className="btn" disabled={!!busy[`rest${loan.id}`]} onClick={() => doRestructure(loan.id)}>
                        {busy[`rest${loan.id}`] ? t('saccos.loading') : t('saccos.rest_go')}
                      </button>
                      <button className="btn ghost" onClick={() => toggleRest(loan.id)}>{t('saccos.rest_history')}</button>
                    </div>
                  ) : null}
                  {rest.history[loan.id] ? (
                    <div style={{ marginTop: 8 }}>
                      {!rest.history[loan.id].length ? (
                        <div className="muted">{t('saccos.rest_none')}</div>
                      ) : (
                        rest.history[loan.id].map((h) => (
                          <div key={h.id} className="muted" style={{ fontSize: 13 }}>
                            {toDate(h.created_at)} · {formatMoney(h.previous_outstanding)} @ {h.previous_rate}% → {h.new_rate}% ({h.new_term_months} {t('saccos.months')}) → {formatMoney(h.new_total)}
                            {h.reason ? ` · ${h.reason}` : ''}
                          </div>
                        ))
                      )}
                    </div>
                  ) : null}
                  {wo.form[loan.id]?.show && isGoverning() && loan.status === 'ACTIVE' ? (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border, #e5e5e5)' }}>
                      <input placeholder={t('saccos.writeoff_reason')}
                        value={wo.form[loan.id].reason || ''}
                        onChange={(e) => setWo((prev) => ({ ...prev, form: { ...prev.form, [loan.id]: { ...(prev.form[loan.id] || {}), reason: e.target.value } } }))} />
                      <button className="btn" disabled={!!busy[`wo${loan.id}`]} onClick={() => doWriteOff(loan.id)}>
                        {busy[`wo${loan.id}`] ? t('saccos.loading') : t('saccos.writeoff_go')}
                      </button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <h3 style={{ margin: 0 }}>{t('saccos.lp_title')}</h3>
              {isGoverning() ? (
                <button className="btn ghost" onClick={toggleLpForm}>
                  {busy.lpNew ? t('saccos.loading') : t('saccos.lp_new')}
                </button>
              ) : null}
            </div>
            {lp.apply.show ? (
              <div style={{ marginTop: 12, padding: 14, border: '1px solid var(--border, #e5e5e5)', borderRadius: 8 }}>
                <h4 style={{ marginTop: 0 }}>{t('saccos.lp_app_title')}</h4>
                <select
                  value={lp.apply.productId}
                  onChange={(e) => setLp((prev) => ({ ...prev, apply: { ...prev.apply, productId: e.target.value } }))}
                >
                  <option value="">{t('saccos.lp_flat')}</option>
                  {lp.list.filter((p) => p.status === 'ACTIVE').map((p) => (
                    <option key={p.id} value={p.id}>{p.code} — {p.name} ({p.interest_rate_percent}%)</option>
                  ))}
                </select>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  <input type="number" placeholder={t('saccos.lp_app_amount')}
                    value={lp.apply.amount}
                    onChange={(e) => setLp((prev) => ({ ...prev, apply: { ...prev.apply, amount: e.target.value } }))} />
                  <input type="number" placeholder={t('saccos.lp_app_term')}
                    value={lp.apply.term}
                    onChange={(e) => setLp((prev) => ({ ...prev, apply: { ...prev.apply, term: e.target.value } }))} />
                  <input placeholder={t('saccos.lp_app_purpose')}
                    value={lp.apply.purpose}
                    onChange={(e) => setLp((prev) => ({ ...prev, apply: { ...prev.apply, purpose: e.target.value } }))} />
                  <button className="btn" disabled={busy.lpApply} onClick={doLoanApply}>
                    {busy.lpApply ? t('saccos.loading') : t('saccos.lp_apply_go')}
                  </button>
                  <button className="btn ghost" onClick={() => setLp((prev) => ({ ...prev, apply: { ...prev.apply, show: false } }))}>
                    {t('saccos.hide')}
                  </button>
                </div>
              </div>
            ) : null}
            {lp.form.show && isGoverning() ? (
              <div style={{ marginTop: 12, padding: 14, border: '1px solid var(--border, #e5e5e5)', borderRadius: 8 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input placeholder={t('saccos.lp_code')} style={{ width: 130 }}
                    value={lp.form.code} onChange={(e) => setLp((prev) => ({ ...prev, form: { ...prev.form, code: e.target.value } }))} />
                  <input placeholder={t('saccos.lp_name')}
                    value={lp.form.name} onChange={(e) => setLp((prev) => ({ ...prev, form: { ...prev.form, name: e.target.value } }))} />
                  <input placeholder={t('saccos.lp_desc')}
                    value={lp.form.desc} onChange={(e) => setLp((prev) => ({ ...prev, form: { ...prev.form, desc: e.target.value } }))} />
                  <input type="number" step="0.01" placeholder={t('saccos.lp_rate')} style={{ width: 110 }}
                    value={lp.form.rate} onChange={(e) => setLp((prev) => ({ ...prev, form: { ...prev.form, rate: e.target.value } }))} />
                  <input type="number" placeholder={t('saccos.lp_min')} style={{ width: 120 }}
                    value={lp.form.min} onChange={(e) => setLp((prev) => ({ ...prev, form: { ...prev.form, min: e.target.value } }))} />
                  <input type="number" placeholder={t('saccos.lp_max')} style={{ width: 160 }}
                    value={lp.form.max} onChange={(e) => setLp((prev) => ({ ...prev, form: { ...prev.form, max: e.target.value } }))} />
                  <input type="number" placeholder={t('saccos.lp_term')} style={{ width: 110 }}
                    value={lp.form.term} onChange={(e) => setLp((prev) => ({ ...prev, form: { ...prev.form, term: e.target.value } }))} />
                  <button className="btn" disabled={busy.lpNew} onClick={createProduct}>
                    {busy.lpNew ? t('saccos.loading') : t('saccos.lp_go')}
                  </button>
                </div>
              </div>
            ) : null}
            {!lp.list.length ? (
              <div className="muted" style={{ marginTop: 10 }}>{t('saccos.lp_none')}</div>
            ) : (
              lp.list.map((p) => (
                <div key={p.id} style={{ borderTop: '1px solid var(--border, #e5e5e5)', padding: '12px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <strong>{p.code}</strong> — {p.name}
                    <span className="muted">
                      {' '}<em>{p.description}</em>
                    </span>
                    <div className="muted" style={{ fontSize: 13 }}>
                      {t('saccos.lp_rate')}: {p.interest_rate_percent}% · {t('saccos.lp_band')}: {formatMoney(p.min_amount)}{p.max_amount ? ` - ${formatMoney(p.max_amount)}` : ' +'} · {t('saccos.lp_term')}: {p.max_term_months}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <StatusBadge status={p.status} />
                    {p.status === 'ACTIVE' ? (
                      <>
                        <button className="btn ghost" onClick={() => openLoanApply(p.id)}>{t('saccos.lp_apply')}</button>
                        {isGoverning() ? (
                          <button className="btn ghost" disabled={!!busy[`lpArc${p.id}`]} onClick={() => archiveProduct(p.id)}>
                            {busy[`lpArc${p.id}`] ? t('saccos.loading') : t('saccos.lp_archive')}
                          </button>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="card">
            <h3>{t('saccos.my_statement')}</h3>
            {!statement ? (
              <div className="muted">{t('saccos.loading')}</div>
            ) : (
              <>
                <div className="grid grid-4">
                  <Stat value={formatMoney(statement.savings ? statement.savings.balance : 0)} label={t('saccos.st_savings')} />
                  <Stat value={statement.shares ? `${statement.shares.share_count}` : '0'} label={t('saccos.st_shares')} />
                  <Stat value={formatMoney(statement.shares ? statement.shares.total_value : 0)} label={t('saccos.st_share_value')} />
                  <Stat value={formatMoney(statement.member ? statement.member.wallet_balance : 0)} label={t('saccos.st_wallet')} />
                </div>
                <div className="muted" style={{ marginTop: 12 }}>
                  {t('saccos.member_status')}: {statement.member ? statement.member.status : '-'}
                  {statement.member_number ? ` · ${t('saccos.member_no')}: ${statement.member_number}` : ''}
                </div>
              </>
            )}
          </div>

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <h3 style={{ margin: 0 }}>{t('saccos.meetings')}</h3>
              {isGoverning() ? (
                <button className="btn ghost" onClick={() => setMeetForm((f) => ({ ...f, show: !f.show }))}>
                  {t('saccos.meet_new')}
                </button>
              ) : null}
            </div>

            {meetForm.show && isGoverning() ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, margin: '12px 0', alignItems: 'center' }}>
                <label className="muted">{t('saccos.meet_title')}
                  <input value={meetForm.title} onChange={(e) => setMeetForm((f) => ({ ...f, title: e.target.value }))} placeholder={t('saccos.meet_title')} />
                </label>
                <label className="muted">{t('saccos.meet_when')}
                  <input type="datetime-local" value={meetForm.when} onChange={(e) => setMeetForm((f) => ({ ...f, when: e.target.value }))} />
                </label>
                <label className="muted">{t('saccos.meet_where')}
                  <input value={meetForm.where} onChange={(e) => setMeetForm((f) => ({ ...f, where: e.target.value }))} placeholder={t('saccos.meet_where')} />
                </label>
                <label className="muted">{t('saccos.meet_quorum')}
                  <input type="number" min="1" max="100" value={meetForm.quorum} onChange={(e) => setMeetForm((f) => ({ ...f, quorum: e.target.value }))} />
                </label>
                <label className="muted" style={{ gridColumn: '1 / -1' }}>{t('saccos.meet_agenda')}
                  <textarea rows={3} value={meetForm.agenda} onChange={(e) => setMeetForm((f) => ({ ...f, agenda: e.target.value }))} />
                </label>
                <div style={{ gridColumn: '1 / -1' }}>
                  <button className="btn" disabled={!!busy.meetNew} onClick={createMeeting}>
                    {busy.meetNew ? t('saccos.loading') : t('saccos.meet_create')}
                  </button>
                </div>
              </div>
            ) : null}

            {!meetings.length ? (
              <div className="muted" style={{ marginTop: 10 }}>{t('saccos.meetings_none')}</div>
            ) : (
              meetings.map((m) => {
                const detail = meetDetail[m.id];
                const open = meetDetailId === m.id;
                const depKey = (a) => `m${m.id}${a}`;
                const mins = minutesDraft[m.id] || '';
                return (
                  <div key={m.id} style={{ borderTop: '1px solid var(--border, #e5e5e5)', padding: '12px 0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <strong>{m.title}</strong>
                        <span className="muted"> · {toDate(m.scheduled_at)}</span>
                        {m.location ? <span className="muted"> · {m.location}</span> : null}
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        {m.present_count !== undefined ? (
                          <span className="muted">{m.present_count} {t('saccos.meet_present')}</span>
                        ) : null}
                        <StatusBadge status={m.status} />
                        {m.status === 'CLOSED' ? (
                          m.quorum_met ? (
                            <span className="badge success">{t('saccos.meet_q_met')}</span>
                          ) : (
                            <span className="badge failed">{t('saccos.meet_q_missed')}</span>
                          )
                        ) : null}
                        {m.status === 'OPEN' ? (
                          <button
                            className="btn"
                            disabled={!!busy[depKey('checkin')]}
                            onClick={() => meetAction(m.id, 'checkin')}
                          >
                            {busy[depKey('checkin')] ? t('saccos.loading') : (m.my_status ? t('saccos.meet_checked') : t('saccos.meet_checkin'))}
                          </button>
                        ) : null}
                        {isGoverning() && m.status === 'DRAFT' ? (
                          <button className="btn" disabled={!!busy[depKey('open')]} onClick={() => meetAction(m.id, 'open')}>
                            {busy[depKey('open')] ? t('saccos.loading') : t('saccos.meet_open')}
                          </button>
                        ) : null}
                        {isGoverning() && m.status === 'OPEN' ? (
                          <button className="btn" disabled={!!busy[depKey('close')]} onClick={() => meetAction(m.id, 'close')}>
                            {busy[depKey('close')] ? t('saccos.loading') : t('saccos.meet_close')}
                          </button>
                        ) : null}
                        {isGoverning() && m.status === 'CLOSED' ? (
                          <button className="btn ghost" onClick={() => toggleMeetDetail(m.id)}>
                            {t('saccos.meet_minutes')}
                          </button>
                        ) : (
                          <button className="btn ghost" onClick={() => toggleMeetDetail(m.id)}>
                            {open ? t('saccos.hide') : t('saccos.meet_attendance')}
                          </button>
                        )}
                      </div>
                    </div>

                    {open && detail ? (
                      <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                        <div>
                          <div className="muted" style={{ marginBottom: 6 }}>{t('saccos.meet_agenda_items')}</div>
                          {detail.agenda.length ? (
                            <ul>
                              {detail.agenda.map((a) => (
                                <li key={a.id} style={a.is_complete ? { textDecoration: 'line-through', color: 'var(--muted, #999)' } : {}}>
                                  {a.title}{a.notes ? <span className="muted"> — {a.notes}</span> : null}
                                </li>
                              ))}
                            </ul>
                          ) : <div className="muted">-</div>}
                        </div>
                        <div>
                          <div className="muted" style={{ marginBottom: 6 }}>{t('saccos.meet_attendance')} ({detail.attendance.length})</div>
                          {detail.attendance.length ? (
                            <ul>
                              {detail.attendance.map((a) => (
                                <li key={a.member_id}>
                                  {a.name} <span className="muted">· {a.member_number}</span> {a.is_me ? <span className="muted">({t('saccos.meet_my')})</span> : null}
                                  <StatusBadge status={a.status} />
                                </li>
                              ))}
                            </ul>
                          ) : <div className="muted">-</div>}
                        </div>
                      </div>
                    ) : null}

                    {open && isGoverning() && m.status === 'CLOSED' && detail ? (
                      <div style={{ marginTop: 12, borderTop: '1px solid var(--border, #e5e5e5)', paddingTop: 10 }}>
                        <div className="muted" style={{ marginBottom: 6 }}>{t('saccos.meet_agenda_items')} → {t('saccos.meet_minutes')}</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
                          {detail.agenda.map((a) => (
                            <label key={a.id} className="btn ghost" style={{ margin: 0 }}>
                              <input
                                type="checkbox"
                                checked={(minutesDone[m.id] || new Set()).has(a.id)}
                                onChange={() => toggleDone(m.id, a.id)}
                              />
                              {' '}{a.title}
                            </label>
                          ))}
                        </div>
                        <textarea
                          rows={3}
                          placeholder={t('saccos.meet_minutes')}
                          value={mins}
                          onChange={(e) => setMinutesDraft((prev) => ({ ...prev, [m.id]: e.target.value }))}
                          style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8 }}
                        />
                        <button
                          className="btn"
                          disabled={!!busy[depKey('minutes')] || !mins.trim()}
                          onClick={() => meetAction(m.id, 'minutes', { minutes: mins, agenda: [...(minutesDone[m.id] || [])] })}
                        >
                          {busy[depKey('minutes')] ? t('saccos.meet_publishing') : t('saccos.meet_minutes')}
                        </button>
                      </div>
                    ) : null}

                    {open && m.status === 'MINUTES_PUBLISHED' && detail && detail.meeting.minutes ? (
                      <div className="msg ok" style={{ marginTop: 10 }}>{detail.meeting.minutes}</div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <h3 style={{ margin: 0 }}>{t('saccos.savings_interest')}</h3>
              {isGoverning() && si.summary && si.summary.rate ? (
                <span className="muted">{t('saccos.si_rate')}: {si.summary.rate}%</span>
              ) : null}
            </div>

            {isGoverning() ? (
              <>
                {!si.summary ? (
                  <div className="muted" style={{ marginTop: 10 }}>{t('saccos.loading')}</div>
                ) : (
                  <>
                    <div className="grid grid-3" style={{ marginTop: 10 }}>
                      <Stat value={si.summary.rate ? `${si.summary.rate}%` : '-'} label={t('saccos.si_rate')} />
                      <Stat value={formatMoney(si.summary.posted_this_year)} label={t('saccos.si_this_year')} />
                      <Stat value={formatMoney(si.summary.pending_total)} label={t('saccos.si_pending')} />
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                      <button className="btn" disabled={!!busy.siPrep} onClick={prepareSi}>
                        {busy.siPrep ? t('saccos.si_preparing') : t('saccos.si_prepare')}
                      </button>
                      {si.summary.latest && si.summary.latest.status === 'PENDING' ? (
                        <button className="btn" disabled={!!busy[`siPost${si.summary.latest.id}`]} onClick={() => postSi(si.summary.latest.id)}>
                          {busy[`siPost${si.summary.latest.id}`] ? t('saccos.si_posting') : t('saccos.si_post')}
                        </button>
                      ) : null}
                    </div>
                  </>
                )}

                <div style={{ marginTop: 12 }}>
                  <div className="muted" style={{ marginBottom: 6 }}>{t('saccos.si_cycles')}</div>
                  {!si.cycles.length ? (
                    <div className="muted">{t('saccos.si_no_data')}</div>
                  ) : (
                    si.cycles.map((c) => {
                      const d = si.detail[c.id];
                      const open = siDetailId === c.id;
                      return (
                        <div key={c.id} style={{ borderTop: '1px solid var(--border, #e5e5e5)', padding: '10px 0' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                            <div>
                              <strong>{toDate(c.period)}</strong>
                              <span className="muted"> · {c.rate_percent}%</span>
                              <span className="muted"> · {formatMoney(c.total_interest)}</span>
                            </div>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                              <span className="muted">{c.posted_awards}/{c.total_awards}</span>
                              <StatusBadge status={c.status} />
                              <button className="btn ghost" onClick={() => toggleSiDetail(c.id)}>
                                {open ? t('saccos.hide') : t('saccos.si_members')}
                              </button>
                            </div>
                          </div>
                          {open && d ? (
                            <ul style={{ marginTop: 8 }}>
                              {d.awards.map((a) => (
                                <li key={a.id}>
                                  {a.full_name} <span className="muted">· {a.member_number} · {t('saccos.si_basis')} {formatMoney(a.basis_balance)} → {formatMoney(a.interest)}</span>
                                  <StatusBadge status={a.status} />
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            ) : (
              <div style={{ marginTop: 10 }}>
                {!si.mine ? (
                  <div className="muted">{t('saccos.loading')}</div>
                ) : (
                  <>
                    <div className="grid grid-2">
                      <Stat value={formatMoney(si.mine.total_posted)} label={t('saccos.si_mine_total')} />
                      <Stat value={`${si.mine.awards.length}`} label={t('saccos.si_mine_awards')} />
                    </div>
                    {si.mine.awards.length ? (
                      <ul style={{ marginTop: 8 }}>
                        {si.mine.awards.map((a) => (
                          <li key={a.id}>
                            {a.period} <span className="muted">· {t('saccos.si_basis')} {formatMoney(a.basis_balance)} → {formatMoney(a.interest)}</span>
                            <StatusBadge status={a.cycle_status} />
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="muted" style={{ marginTop: 8 }}>{t('saccos.si_no_data')}</div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <h3 style={{ margin: 0 }}>{t('saccos.welfare')}</h3>
              {isGoverning() ? (
                <button className="btn ghost" onClick={() => setWelfare((w) => ({ ...w, form: { ...w.form, show: !w.form.show } }))}>
                  {t('saccos.wf_new_scheme')}
                </button>
              ) : null}
            </div>

            {isGoverning() && welfare.form.show ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, margin: '12px 0', alignItems: 'center' }}>
                <label className="muted">{t('saccos.wf_name')}
                  <input value={welfare.form.name} onChange={(e) => setWelfare((w) => ({ ...w, form: { ...w.form, name: e.target.value } }))} />
                </label>
                <label className="muted">{t('saccos.wf_contribution')}
                  <input type="number" value={welfare.form.contribution} onChange={(e) => setWelfare((w) => ({ ...w, form: { ...w.form, contribution: e.target.value } }))} />
                </label>
                <label className="muted">{t('saccos.wf_payout')}
                  <input type="number" value={welfare.form.payout} onChange={(e) => setWelfare((w) => ({ ...w, form: { ...w.form, payout: e.target.value } }))} />
                </label>
                <div style={{ gridColumn: '1 / -1' }}>
                  <button className="btn" disabled={!!busy.wSch} onClick={createScheme}>
                    {busy.wSch ? t('saccos.loading') : t('saccos.wf_create')}
                  </button>
                </div>
              </div>
            ) : null}

            {isGoverning() ? (
              !welfare.summary ? (
                <div className="muted" style={{ marginTop: 10 }}>{t('saccos.loading')}</div>
              ) : (
                <div className="grid grid-4" style={{ marginTop: 10 }}>
                  <Stat value={formatMoney(welfare.summary.fund_balance)} label={t('saccos.wf_fund')} />
                  <Stat value={formatMoney(welfare.summary.total_contributions)} label={t('saccos.wf_contributions')} />
                  <Stat value={`${welfare.summary.pending_claims}`} label={t('saccos.wf_pending')} />
                  <Stat value={formatMoney(welfare.summary.paid_amount)} label={t('saccos.wf_paid_sum')} />
                </div>
              )
            ) : null}

            <div className="muted" style={{ marginTop: 14, marginBottom: 6 }}>{t('saccos.wf_schemes')}</div>
            {!welfare.schemes.length ? (
              <div className="muted">{t('saccos.wf_none')}</div>
            ) : (
              welfare.schemes.map((s) => {
                const claimDraft = wClaim[s.id] || { event: '', details: '', amount: '' };
                return (
                  <div key={s.id} style={{ borderTop: '1px solid var(--border, #e5e5e5)', padding: '12px 0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <strong>{s.name}</strong>
                        <span className="muted"> · {formatMoney(s.contribution)} → {formatMoney(s.payout)}</span>
                        <span className="muted"> · {s.members_joined} {t('saccos.wf_members_joined')}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <StatusBadge status={s.status} />
                        {s.joined ? <span className="badge success">{t('saccos.wf_joined')}</span> : null}
                        {!isGoverning() && !s.joined && s.status === 'ACTIVE' ? (
                          <button className="btn" disabled={!!busy[`join${s.id}`]} onClick={() => joinScheme(s)}>
                            {busy[`join${s.id}`] ? t('saccos.loading') : t('saccos.wf_join')}
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {!isGoverning() && s.joined ? (
                      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <input placeholder={t('saccos.wf_event')} value={claimDraft.event}
                          onChange={(e) => setWClaim((prev) => ({ ...prev, [s.id]: { ...claimDraft, event: e.target.value } }))} />
                        <input type="number" placeholder={t('saccos.wf_claim')} value={claimDraft.amount}
                          onChange={(e) => setWClaim((prev) => ({ ...prev, [s.id]: { ...claimDraft, amount: e.target.value } }))} />
                        <button className="btn" disabled={!!busy[`wClaim${s.id}`]} onClick={() => submitClaim(s)}>
                          {busy[`wClaim${s.id}`] ? t('saccos.loading') : t('saccos.wf_claim')}
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}

            <div className="muted" style={{ marginTop: 14, marginBottom: 6 }}>{t('saccos.wf_claims')}</div>
            {!welfare.claims.length ? (
              <div className="muted">{t('saccos.wf_no_claims')}</div>
            ) : (
              welfare.claims.map((c) => (
                <div key={c.id} style={{ borderTop: '1px solid var(--border, #e5e5e5)', padding: '10px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <strong>{c.event}</strong>
                    <span className="muted"> · {c.scheme_name} · {formatMoney(c.amount)} · {toDate(c.created_at)}</span>
                    {c.full_name ? <span className="muted"> · {c.full_name}</span> : null}
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <StatusBadge status={c.status} />
                    {isGoverning() && c.status === 'SUBMITTED' ? (
                      <>
                        <button className="btn" disabled={!!busy[`rev${c.id}`]} onClick={() => reviewClaim(c.id, 'APPROVE')}>
                          {t('saccos.wf_approve')}
                        </button>
                        <button className="btn ghost" disabled={!!busy[`rev${c.id}`]} onClick={() => reviewClaim(c.id, 'REJECT')}>
                          {t('saccos.wf_reject')}
                        </button>
                      </>
                    ) : null}
                    {isGoverning() && c.status === 'APPROVED' ? (
                      <button className="btn" disabled={!!busy[`pay${c.id}`]} onClick={() => payClaim(c.id)}>
                        {busy[`pay${c.id}`] ? t('saccos.loading') : t('saccos.wf_pay')}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="card">
            <h3>{t('saccos.guarantors')}</h3>
            {!guar.length ? (
              <div className="muted">{t('saccos.guar_none')}</div>
            ) : (
              guar.map((g) => (
                <div key={g.id} style={{ borderTop: '1px solid var(--border, #e5e5e5)', padding: '10px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <strong>{g.borrower_name}</strong>
                    <span className="muted"> · {g.application_reference} · {t('saccos.guar_cover')}: {formatMoney(g.cover_amount)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <StatusBadge status={g.status} />
                    {g.status === 'PENDING' && g.application_status === 'PENDING' ? (
                      <button className="btn" disabled={!!busy[`gaccept${g.id}`]} onClick={() => guaranteeAction(g, 'accept')}>
                        {busy[`gaccept${g.id}`] ? t('saccos.loading') : t('saccos.guar_accept')}
                      </button>
                    ) : null}
                    {['PENDING', 'ACCEPTED'].includes(g.status) ? (
                      <button className="btn ghost" disabled={!!busy[`gremove${g.id}`]} onClick={() => guaranteeAction(g, 'remove')}>
                        {busy[`gremove${g.id}`] ? t('saccos.loading') : t('saccos.guar_remove')}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>

          {isGoverning() ? (
            <div className="card">
              <h3>{t('saccos.writeoffs')}</h3>
              {!wo.list.length ? (
                <div className="muted">{t('saccos.writeoff_none')}</div>
              ) : (
                wo.list.map((w) => (
                  <div key={w.id} style={{ borderTop: '1px solid var(--border, #e5e5e5)', padding: '10px 0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <strong>{w.loan_reference}</strong>
                        <span className="muted"> · {toDate(w.created_at)} · {formatMoney(w.previous_outstanding)}</span>
                      </div>
                      <span className="muted">{w.principal_written_off !== undefined ? `${t('saccos.wo_principal')}: ${formatMoney(w.principal_written_off)}` : `${t('saccos.wo_reserves')}: ${formatMoney(w.reserves_used)} · ${t('saccos.wo_expense')}: ${formatMoney(w.expense_used)}`}</span>
                    </div>
                    {w.reason ? <div className="muted" style={{ marginTop: 4 }}>{w.reason}</div> : null}
                  </div>
                ))
              )}
            </div>
          ) : null}

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <h3 style={{ margin: 0 }}>{t('saccos.standing_orders')}</h3>
                <div className="muted" style={{ marginTop: 4 }}>{t('saccos.so_sub')}</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {isGoverning() ? (
                  <button className="btn" disabled={!!busy.soRun} onClick={runSo}>
                    {busy.soRun ? t('saccos.so_running') : t('saccos.so_run')}
                  </button>
                ) : null}
                <button className="btn ghost" onClick={() => setSo((s) => ({ ...s, form: { ...s.form, show: !s.form.show } }))}>
                  {t('saccos.so_new')}
                </button>
              </div>
            </div>

            {so.form.show ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, margin: '12px 0', alignItems: 'center' }}>
                <label className="muted">{t('saccos.so_type')}
                  <select value={so.form.type} onChange={(e) => setSo((s) => ({ ...s, form: { ...s.form, type: e.target.value, targetId: '' } }))}>
                    <option value="SAVINGS_DEPOSIT">{t('saccos.so_savings')}</option>
                    <option value="FUND_CONTRIBUTION">{t('saccos.so_fund')}</option>
                    <option value="WELFARE_CONTRIBUTION">{t('saccos.so_welfare')}</option>
                    <option value="LOAN_REPAYMENT">{t('saccos.so_loan')}</option>
                  </select>
                </label>
                <label className="muted">{t('saccos.so_day')}
                  <input type="number" min="1" max="28" value={so.form.day} onChange={(e) => setSo((s) => ({ ...s, form: { ...s.form, day: e.target.value } }))} />
                </label>
                <label className="muted">{t('saccos.so_amount')}
                  <input type="number" value={so.form.amount} onChange={(e) => setSo((s) => ({ ...s, form: { ...s.form, amount: e.target.value } }))} />
                </label>
                {so.form.type !== 'SAVINGS_DEPOSIT' ? (
                  <label className="muted">{t('saccos.so_target')}
                    <select value={so.form.targetId} onChange={(e) => setSo((s) => ({ ...s, form: { ...s.form, targetId: e.target.value } }))}>
                      <option value="">-</option>
                      {so.form.type === 'FUND_CONTRIBUTION' ? so.targets.funds.map((f) => (
                        <option key={f.id} value={f.id}>{f.name || f.code} ({f.code})</option>
                      )) : null}
                      {so.form.type === 'WELFARE_CONTRIBUTION' ? so.targets.schemes.map((s2) => (
                        <option key={s2.id} value={s2.id}>{s2.name}</option>
                      )) : null}
                      {so.form.type === 'LOAN_REPAYMENT' ? so.targets.loans.map((l) => (
                        <option key={l.id} value={l.id}>{l.reference_id}</option>
                      )) : null}
                    </select>
                  </label>
                ) : <span />}
                <div style={{ gridColumn: '1 / -1' }}>
                  <button className="btn" disabled={!!busy.soNew} onClick={createSo}>
                    {busy.soNew ? t('saccos.loading') : t('saccos.so_create')}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="muted" style={{ marginTop: 14, marginBottom: 6 }}>{isGoverning() ? t('saccos.so_all') : t('saccos.so_mine')}</div>
            {(!isGoverning() ? so.mine : so.all).length === 0 ? (
              <div className="muted">{t('saccos.so_none')}</div>
            ) : (
              (isGoverning() ? so.all : so.mine).map((o) => (
                <div key={o.id} style={{ borderTop: '1px solid var(--border, #e5e5e5)', padding: '10px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <strong>{soTypeLabel(o.target_type)}</strong>
                    <span className="muted"> · {formatMoney(o.amount)} · {t('saccos.so_day')}: {o.day_of_month} · {soTargetName(o)}</span>
                    {isGoverning() && o.full_name ? <span className="muted"> · {o.full_name}</span> : null}
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="muted">{t('saccos.so_next')}: {toDate(o.next_run_at)} · {o.total_runs || 0} ({o.success_runs || 0} {t('saccos.so_success')}{o.fail_runs ? ` / ${o.fail_runs} ${t('saccos.so_fail')}` : ''})</span>
                    <StatusBadge status={o.status} />
                    {o.last_error ? <span className="muted" title={o.last_error}>· {String(o.last_error).slice(0, 24)}…</span> : null}
                    {o.status === 'ACTIVE' ? (
                      <button className="btn ghost" disabled={!!busy[`soDe${o.id}`]} onClick={() => deactivateSo(o.id)}>
                        {busy[`soDe${o.id}`] ? t('saccos.loading') : t('saccos.so_deactivate')}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}