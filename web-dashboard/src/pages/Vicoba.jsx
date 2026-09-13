import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import ServiceLock from '../components/ServiceLock.jsx';
import { useT } from '../i18n/LangProvider.jsx';

const LEADER_ROLES = ['MWENYEKITI', 'MWEKAHAZINA', 'KATIBU'];
const CYCLE_LABEL = { WEEKLY: 'Wiki', MONTHLY: 'Mwezi', DAILY: 'Kila Siku', BIWEEKLY: 'Wiki Mbili' };

export default function Vicoba() {
  const { t } = useT();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const [groups, setGroups] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loans, setLoans] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });

  // Group creation (modal stepper)
  const [showCreate, setShowCreate] = useState(false);
  const [createStep, setCreateStep] = useState(1);
  const [createdGroup, setCreatedGroup] = useState(null);
  const [showJoin, setShowJoin] = useState(false);

  const [gName, setGName] = useState('');
  const [gCycle, setGCycle] = useState('MONTHLY');
  const [gShare, setGShare] = useState('');
  const [gFee, setGFee] = useState('');
  const [cDescription, setCDescription] = useState('');
  const [cGroupType, setCGroupType] = useState('STANDARD');
  const [cCountry, setCCountry] = useState('Tanzania');
  const [cLanguage, setCLanguage] = useState('sw');
  const [cStartDate, setCStartDate] = useState('');
  const [cMinShares, setCMinShares] = useState('');
  const [cMaxShares, setCMaxShares] = useState('');

  // Workspace tabs
  const [tab, setTab] = useState('overview');
  const [fsTab, setFsTab] = useState('shares');
  const [govTab, setGovTab] = useState('leaders');

  const [contributeAmt, setContributeAmt] = useState('');
  const [contributeShares, setContributeShares] = useState('1');
  const [newMemberId, setNewMemberId] = useState('');

  const [loanApplicant, setLoanApplicant] = useState('');
  const [loanAmount, setLoanAmount] = useState('');
  const [loanInterest, setLoanInterest] = useState('10');
  const [loanMonths, setLoanMonths] = useState('3');
  const [approveAmount, setApproveAmount] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [invitePhones, setInvitePhones] = useState('');

  const [pCycle, setPCycle] = useState('1');
  const [pProfit, setPProfit] = useState('');
  const [profitCalc, setProfitCalc] = useState(null);
  const [distributions, setDistributions] = useState([]);
  const [myPayouts, setMyPayouts] = useState([]);
  const [invitations, setInvitations] = useState([]);

  const [constitution, setConstitution] = useState(null);
  const [attendance, setAttendance] = useState(null);
  const [finReport, setFinReport] = useState(null);
  const [withdrawals, setWithdrawals] = useState([]);
  const [wdAmt, setWdAmt] = useState('');
  const [bonuses, setBonuses] = useState([]);
  const [bonusForm, setBonusForm] = useState({ amount: '', purpose: '' });
  const [penalties, setPenalties] = useState([]);
  const [socialFund, setSocialFund] = useState(null);
  const [shareBook, setShareBook] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [sFundMonthly, setSFundMonthly] = useState('');
  const [sMonth, setSMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [sReqType, setSReqType] = useState('FUNERAL');
  const [sReqDetail, setSReqDetail] = useState('');
  const [sReqAmount, setSReqAmount] = useState('');
  const [loanExtra, setLoanExtra] = useState({});
  const [repayMap, setRepayMap] = useState({});

  // Governance (embedded from /governance endpoints)
  const [gMeetings, setGMeetings] = useState([]);
  const [gDocs, setGDocs] = useState([]);
  const [gResolutions, setGResolutions] = useState([]);
  const [gActions, setGActions] = useState([]);
  const [gMinutes, setGMinutes] = useState([]);
  const [meetForm, setMeetForm] = useState({ title: '', scheduledAt: '' });
  const [agendaForm, setAgendaForm] = useState({ title: '', description: '' });
  const [docForm, setDocForm] = useState({ title: '', category: 'CONSTITUTION', body: '', access: 'MEMBERS' });
  const [expanded, setExpanded] = useState(null); // meeting id with agenda loaded
  const [expandedAgenda, setExpandedAgenda] = useState([]);
  const [expandedProposals, setExpandedProposals] = useState([]);
  const [propForm, setPropForm] = useState({ title: '', description: '' });
  const [tallyMap, setTallyMap] = useState({});
  const [aziMap, setAziMap] = useState({});
  const [gExecutions, setGExecutions] = useState([]);
  const [gAnalytics, setGAnalytics] = useState(null);
  const [transcriptMap, setTranscriptMap] = useState({});
  const [govBusy, setGovBusy] = useState(false);

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 6000);
  };

  const loadGroups = () => {
    api.get('/vicoba/groups').then((r) => setGroups(r.data.groups)).catch(() => {});
  };

  const loadInvites = () => {
    api.get('/vicoba/invitations').then((r) => setInvitations(r.data.invitations || [])).catch(() => { setInvitations([]); });
  };

  const acceptInvite = async (id) => {
    try {
      const res = await api.post(`/vicoba/invitations/${id}/accept`);
      show('ok', res.data.message || 'Umejiunga na kikundi.');
      setInvitations([]);
      loadGroups();
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const rejectInvite = async (id) => {
    try {
      await api.post(`/vicoba/invitations/${id}/reject`);
      show('ok', 'Umekataa mwaliko.');
      setInvitations((prev) => prev.filter((i) => i.id !== id));
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  useEffect(() => {
    loadGroups();
    loadInvites();
  }, []);

  const selectGroup = (g) => {
    setSelected(g);
    setTab('overview');
    api.get(`/vicoba/groups/${g.id}`).then((r) => setSelected(r.data.group)).catch(() => {});
    api.get(`/vicoba/groups/${g.id}/loans`).then((r) => setLoans(r.data.loans)).catch(() => {});
    api.get(`/vicoba/groups/${g.id}/profits`).then((r) => setDistributions(r.data.distributions)).catch(() => { setDistributions([]); });
    api.get('/vicoba/profits/my').then((r) => setMyPayouts(r.data.payouts)).catch(() => setMyPayouts([]));
    api.get(`/vicoba/groups/${g.id}/constitution`).then((r) => setConstitution(r.data.constitution || r.data)).catch(() => setConstitution(null));
    api.get(`/vicoba/groups/${g.id}/attendance/report`).then((r) => setAttendance(r.data.report)).catch(() => setAttendance(null));
    api.get(`/vicoba/groups/${g.id}/reports/financial`).then((r) => setFinReport(r.data.summary)).catch(() => setFinReport(null));
    api.get(`/vicoba/groups/${g.id}/withdrawals`).then((r) => setWithdrawals(r.data.withdrawals || [])).catch(() => setWithdrawals([]));
    api.get(`/vicoba/groups/${g.id}/bonuses`).then((r) => setBonuses(r.data.bonuses || [])).catch(() => setBonuses([]));
    api.get(`/vicoba/groups/${g.id}/penalties?status=ALL`).then((r) => setPenalties(r.data.penalties || [])).catch(() => setPenalties([]));
    api.get(`/vicoba/groups/${g.id}/social-fund`).then((r) => setSocialFund(r.data.fund || r.data)).catch(() => setSocialFund(null));
    api.get(`/vicoba/groups/${g.id}/shares`).then((r) => setShareBook(r.data.purchases || r.data.shares || [])).catch(() => setShareBook([]));
    setShowArchived(false);
    loadTx(g.id, 0, false);
    loadGov(g.id);
  };

  const loadTx = (gid, offset, archived) => {
    api.get(`/vicoba/groups/${gid}/transactions?limit=25&offset=${offset}`).then((r) => {
      setTransactions((prev) => (offset === 0 ? (r.data.transactions || []) : prev.concat(r.data.transactions || [])));
      setShowArchived(archived);
    }).catch(() => {});
  };

  const loadMoreTx = () => {
    const next = showArchived ? transactions.length : 25;
    loadTx(selected.id, next, true);
  };

  // ---- Governance embed (read-first, group-scoped) ----
  const loadGov = (gid) => {
    const gp = { params: { group_id: gid, group_type: 'VICOBA' } };
    api.get('/governance/meetings', gp).then((r) => setGMeetings(r.data.meetings || [])).catch(() => setGMeetings([]));
    api.get('/governance/documents', gp).then((r) => setGDocs(r.data.documents || r.data.docs || [])).catch(() => setGDocs([]));
    api.get('/governance/resolutions', gp).then((r) => setGResolutions(r.data.resolutions || [])).catch(() => setGResolutions([]));
    api.get('/governance/action-items', gp).then((r) => setGActions(r.data.items || r.data.actionItems || [])).catch(() => setGActions([]));
    api.get('/governance/minutes', gp).then((r) => setGMinutes(r.data.minutes || [])).catch(() => setGMinutes([]));
    api.get('/governance/financial-executions', gp).then((r) => setGExecutions(r.data.executions || [])).catch(() => setGExecutions([]));
    api.get('/governance/analytics', gp).then((r) => setGAnalytics(r.data.analytics || null)).catch(() => setGAnalytics(null));
  };

  const loadMeetingDetails = (mid, keepExpanded) => {
    api.get(`/governance/meetings/${mid}`).then((r) => {
      const sorted = (r.data.agenda || []).sort((a, b) => (a.position || 0) - (b.position || 0));
      setExpandedAgenda(sorted);
      setExpandedProposals(r.data.proposals || []);
      if (keepExpanded !== false) setExpanded(mid);
    }).catch(() => { setExpandedAgenda([]); setExpandedProposals([]); });
  };

  const toggleAgenda = async (mid) => {
    if (expanded === mid) { setExpanded(null); return; }
    loadMeetingDetails(mid);
  };

  const createProposal = async (e, mid) => {
    e.preventDefault();
    if (!selected || !propForm.title) return;
    try {
      await api.post('/governance/proposals', {
        meetingId: mid, groupType: 'VICOBA', groupId: selected.id, title: propForm.title,
        description: propForm.description || undefined, secretBallot: false
      });
      show('ok', t('gov.proposal_created'));
      setPropForm({ title: '', description: '' });
      loadMeetingDetails(mid);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const castVote = async (pid, choice) => {
    try {
      const res = await api.post(`/governance/proposals/${pid}/vote`, { choice });
      if (res.data.tally) setTallyMap((m) => ({ ...m, [pid]: res.data.tally }));
      if (res.data && res.data.tally === undefined && res.data.result) setTallyMap((m) => ({ ...m, [pid]: res.data.result.tally }));
      if (selected) loadGov(selected.id);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const promoteResolution = async (pid, mid) => {
    const p = expandedProposals.find((x) => x.id === pid);
    if (!p || !selected) return;
    const azi = aziMap[pid] || {};
    try {
      const res = await api.post('/governance/resolutions', {
        proposalId: pid, groupType: 'VICOBA', groupId: selected.id, meetingId: mid,
        title: p.title, body: p.description || p.title,
        rules: { quorum_percent: 50, voting_threshold: 50 },
        financialActionType: azi.type || null, financialAmount: azi.amount ? Number(azi.amount) : null
      });
      show('ok', res.data.outcome && res.data.outcome.thresholdMet ? t('gov.resolution_passed') : t('gov.resolution_failed'));
      loadMeetingDetails(mid, false);
      if (selected) loadGov(selected.id);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const createExecution = async (resolutionId, amount) => {
    const r = gResolutions.find((x) => x.id === resolutionId);
    if (!r || !selected) return;
    try {
      await api.post('/governance/financial-executions', {
        resolutionId, groupId: selected.id, financialActionType: r.financial_action_type || 'GENERAL',
        targetEntityType: 'VICOBA', targetEntityId: selected.id, amount: Number(amount || r.financial_amount || 0), notes: t('gov.exec_from_res')
      });
      show('ok', t('gov.exec_registered'));
      if (selected) loadGov(selected.id);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const loadAgenda = (mid) => {
    loadMeetingDetails(mid);
  };

  const addAgenda = async (e, mid) => {
    e.preventDefault();
    if (!selected || !agendaForm.title) return;
    try {
      await api.post(`/governance/meetings/${mid}/agenda`, {
        position: expandedAgenda.length + 1, title: agendaForm.title, description: agendaForm.description || undefined
      });
      show('ok', t('gov.agenda_added'));
      setAgendaForm({ title: '', description: '' });
      loadAgenda(mid);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const genMinutes = async (mid) => {
    setGovBusy(true);
    try {
      const res = await api.post(`/governance/meetings/${mid}/ai-minutes`, { transcript: transcriptMap[mid] || '' });
      show('ok', t('gov.minutes_generated'));
      if (selected) loadGov(selected.id);
      loadAgenda(mid);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
    setGovBusy(false);
  };

  const addDoc = async (e) => {
    e.preventDefault();
    if (!selected || !docForm.title) return;
    try {
      await api.post('/governance/documents', {
        groupType: 'VICOBA', groupId: selected.id, docCategory: docForm.category, title: docForm.title,
        body: docForm.body || undefined, accessLevel: docForm.access
      });
      show('ok', t('gov.doc_added'));
      setDocForm({ title: '', category: docForm.category, body: '', access: docForm.access });
      loadGov(selected.id);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const createMeeting = async (e) => {
    e.preventDefault();
    if (!selected) return;
    try {
      await api.post('/governance/meetings', {
        groupType: 'VICOBA', groupId: selected.id, title: meetForm.title,
        scheduledAt: meetForm.scheduledAt || undefined, description: meetForm.title,
      });
      show('ok', t('gov.created'));
      setMeetForm({ title: '', scheduledAt: '' });
      loadGov(selected.id);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const govRsvp = async (mid, status) => {
    try {
      await api.post(`/governance/meetings/${mid}/rsvp`, { status });
      if (selected) loadGov(selected.id);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const govAttended = async (mid) => {
    try {
      await api.post(`/governance/meetings/${mid}/attended`, {});
      if (selected) loadGov(selected.id);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/vicoba/groups', {
        groupName: gName, cycleType: gCycle, shareValue: gShare, monthlyMaintenanceFee: gFee || undefined,
        description: cDescription, groupType: cGroupType, country: cCountry, language: cLanguage,
        startDate: cStartDate || undefined, minShares: cMinShares || undefined, maxShares: cMaxShares || undefined,
      });
      setCreatedGroup(res.data.group || res.data);
      show('ok', t('vicoba.created_success'));
      setShowCreate(false);
      setCreateStep(1);
      setGName(''); setGShare(''); setGFee(''); setCDescription(''); setCStartDate('');
      setCMinShares(''); setCMaxShares('');
      loadGroups();
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const nextStep = () => { if (createStep < 4) setCreateStep(createStep + 1); };
  const prevStep = () => { if (createStep > 1) setCreateStep(createStep - 1); };
  const openCreated = () => {
    if (!createdGroup) return;
    const g = createdGroup;
    setCreatedGroup(null);
    setSelected(g);
    selectGroup(g);
    setTab('overview');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const contribute = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post(`/vicoba/groups/${selected.id}/contribute`, {
        amount: contributeAmt, sharesCount: contributeShares,
      });
      show('ok', res.data.message);
      setContributeAmt('');
      selectGroup(selected);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const addMember = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/vicoba/groups/${selected.id}/members`, { userId: newMemberId });
      show('ok', t('vicoba.member_added'));
      setNewMemberId('');
      selectGroup(selected);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const joinByCode = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/vicoba/groups/join', { joinCode });
      show('ok', res.data.message);
      setJoinCode('');
      setShowJoin(false);
      loadGroups();
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const invite = async (e) => {
    e.preventDefault();
    try {
      const phones = invitePhones.split(',').map((p) => p.trim()).filter(Boolean);
      const res = await api.post(`/vicoba/groups/${selected.id}/invite`, { phoneNumbers: phones });
      show('ok', `Mialiko ${res.data.invited} imetumwa kwa SMS. Msimbo wa kikundi: ${res.data.joinCode}`);
      setInvitePhones('');
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const addLoan = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/vicoba/groups/${selected.id}/loans`, {
        applicantUserId: loanApplicant, requestedAmount: loanAmount,
        interestRate: loanInterest, repaymentMonths: loanMonths,
      });
      show('ok', t('vicoba.loan_added'));
      setLoanApplicant(''); setLoanAmount('');
      api.get(`/vicoba/groups/${selected.id}/loans`).then((r) => setLoans(r.data.loans)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const approve = async (loanId) => {
    try {
      const res = await api.post(`/vicoba/loans/${loanId}/approve`, {
        approvedAmount: approveAmount || undefined,
      });
      show('ok', res.data.message);
      selectGroup(selected);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const myRole = selected?.role_in_group || '';

  const calculateProfit = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post(`/vicoba/groups/${selected.id}/profits/calculate`, {
        cycleNumber: pCycle, totalProfit: pProfit,
      });
      setProfitCalc(res.data);
      show('ok', t('vicoba.profit_calculated'));
      const dl = await api.get(`/vicoba/groups/${selected.id}/profits`).then((r) => r.data.distributions);
      setDistributions(dl);
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const approveProfit = async (distId) => {
    try {
      const res = await api.post(`/vicoba/profits/${distId}/approve`);
      show('ok', res.data.message);
      setProfitCalc(null);
      const dl = await api.get(`/vicoba/groups/${selected.id}/profits`).then((r) => r.data.distributions);
      setDistributions(dl);
      api.get('/vicoba/profits/my').then((r) => setMyPayouts(r.data.payouts)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const canApprove = myRole === 'MWEKAHAZINA' || myRole === 'KATIBU';
  const canAddLoan = LEADER_ROLES.includes(myRole);
  const isLeader = LEADER_ROLES.includes(myRole);

  const requestWithdrawal = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post(`/vicoba/groups/${selected.id}/withdrawals`, { amount: wdAmt });
      show('ok', res.data.message);
      setWdAmt('');
      api.get(`/vicoba/groups/${selected.id}/withdrawals`).then((r) => setWithdrawals(r.data.withdrawals || [])).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const decideWithdrawal = async (wdId, approved) => {
    try {
      const res = await api.post(`/vicoba/withdrawals/${wdId}/approve`, { approved, note: approved ? '' : 'Imekataliwa' });
      show('ok', res.data.message);
      api.get(`/vicoba/groups/${selected.id}/withdrawals`).then((r) => setWithdrawals(r.data.withdrawals || [])).catch(() => {});
      api.get(`/vicoba/groups/${selected.id}/reports/financial`).then((r) => setFinReport(r.data.summary)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const submitBonus = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post(`/vicoba/groups/${selected.id}/bonus`, bonusForm);
      show('ok', res.data.message);
      setBonusForm({ amount: '', purpose: '' });
      api.get(`/vicoba/groups/${selected.id}/bonuses`).then((r) => setBonuses(r.data.bonuses || [])).catch(() => {});
      api.get(`/vicoba/groups/${selected.id}/reports/financial`).then((r) => setFinReport(r.data.summary)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const payPenalty = async (pid) => {
    try {
      await api.post(`/vicoba/penalties/${pid}/pay`);
      show('ok', 'Faini imelipwa.');
      api.get(`/vicoba/groups/${selected.id}/penalties?status=ALL`).then((r) => setPenalties(r.data.penalties || [])).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const waivePenalty = async (pid) => {
    try {
      await api.post(`/vicoba/penalties/${pid}/waive`);
      show('ok', 'Faini imesahaulishwa.');
      api.get(`/vicoba/groups/${selected.id}/penalties?status=ALL`).then((r) => setPenalties(r.data.penalties || [])).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const initSocialFund = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post(`/vicoba/groups/${selected.id}/social-fund`, { monthlyContribution: sFundMonthly });
      show('ok', res.data.message);
      setSFundMonthly('');
      api.get(`/vicoba/groups/${selected.id}/social-fund`).then((r) => setSocialFund(r.data.fund || r.data)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const contributeSocial = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/vicoba/groups/${selected.id}/social-fund/contribute`, { month: sMonth });
      show('ok', 'Michango ya mfuko imepokelewa.');
      api.get(`/vicoba/groups/${selected.id}/social-fund`).then((r) => setSocialFund(r.data.fund || r.data)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const requestSocial = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post(`/vicoba/groups/${selected.id}/social-fund/request`, {
        reasonType: sReqType, reasonDetail: sReqDetail, requestedAmount: sReqAmount,
      });
      show('ok', res.data.message);
      setSReqDetail(''); setSReqAmount('');
      api.get(`/vicoba/groups/${selected.id}/social-fund`).then((r) => setSocialFund(r.data.fund || r.data)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const decideSocial = async (reqId, decision, approvedAmount) => {
    try {
      const res = await api.post(`/vicoba/social-fund-requests/${reqId}/${decision}`, approvedAmount ? { approvedAmount } : {});
      show('ok', res.data.message);
      api.get(`/vicoba/groups/${selected.id}/social-fund`).then((r) => setSocialFund(r.data.fund || r.data)).catch(() => {});
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const toggleLoanExtra = (loan) => {
    if (loanExtra[loan.id]) { setLoanExtra((p) => ({ ...p, [loan.id]: undefined })); return; }
    Promise.all([
      api.get(`/vicoba/loans/${loan.id}/schedule`).then((r) => r.data.schedule || []).catch(() => []),
      api.get(`/vicoba/loans/${loan.id}/repayments`).then((r) => r.data.repayments || []).catch(() => []),
    ]).then(([schedule, payments]) => setLoanExtra((p) => ({ ...p, [loan.id]: { schedule, payments } })));
  };

  const repayLoanRow = async (loanId) => {
    const amt = repayMap[loanId];
    if (!amt) { show('err', 'Weka kiasi cha malipo.'); return; }
    try {
      const res = await api.post(`/vicoba/loans/${loanId}/repay`, { amount: amt });
      show('ok', res.data.message);
      setRepayMap((p) => ({ ...p, [loanId]: '' }));
      api.get(`/vicoba/groups/${selected.id}/loans`).then((r) => setLoans(r.data.loans)).catch(() => {});
      if (loanExtra[loanId]) toggleLoanExtra({ id: loanId });
    } catch (err) { show('err', err.response?.data?.message || t('vicoba.error')); }
  };

  const members = selected?.members || [];
  const leadership = LEADER_ROLES.map((r) => members.find((m) => m.role_in_group === r)).filter(Boolean);
  const totalShares = members.reduce((s, m) => s + Number(m.total_shares || 0), 0);
  const totalContrib = members.reduce((s, m) => s + Number(m.contribution_balance || 0), 0);
  const myMember = members.find((m) => Number(m.user_id) === Number(user.id));
  const canSignWd = myRole === 'MWENYEKITI' || myRole === 'MWEKAHAZINA';
  const activeLoans = loans.filter((l) => ['APPROVED', 'DISBURSED', 'PENDING'].includes(l.status)).length;

  const txKindLabel = (kind) => {
    const map = {
      CONTRIBUTION: t('vicoba.tx_contribution'),
      LOAN_REPAYMENT: t('vicoba.tx_loan_repayment'),
      PENALTY: t('vicoba.tx_penalty'),
      SHARE_PURCHASE: t('vicoba.tx_share_purchase'),
      DIVIDEND: t('vicoba.tx_dividend'),
      SOCIAL_FUND: t('vicoba.tx_social_fund'),
      WITHDRAWAL: t('vicoba.tx_withdrawal'),
    };
    return map[kind] || kind;
  };

  const filteredMembers = members.filter((m) => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return true;
    return String(m.full_name || '').toLowerCase().includes(q) || String(m.phone_number || '').includes(q);
  });

  // ===== Overview helpers =====
  const pendingWd = withdrawals.filter((w) => w.status === 'PENDING').length;
  const pendingSocial = (socialFund?.requests || []).filter((r) => r.status === 'PENDING').length;
  const pendingLoans = loans.filter((l) => l.status === 'PENDING').length;
  const readyLoans = loans.filter((l) => l.status === 'APPROVED').length;
  const myUnpaidPenalty = penalties.filter((p) => p.status === 'UNPAID' && Number(p.user_id) === Number(user.id)).length;

  const attention = [];
  if (pendingWd > 0) attention.push({ text: canSignWd ? t('vicoba.wd_need_sig') : t('vicoba.wd_pending_alert'), go: () => { setTab('finance'); setFsTab('withdraw'); } });
  if (pendingSocial > 0) attention.push({ text: t('vicoba.social_pending_alert'), go: () => { setTab('finance'); setFsTab('social'); } });
  if (pendingLoans > 0) attention.push({ text: t('vicoba.loan_pending_alert'), go: () => { setTab('finance'); setFsTab('loans'); } });
  if (readyLoans > 0) attention.push({ text: t('vicoba.loan_disburse_alert'), go: () => { setTab('finance'); setFsTab('loans'); } });
  if (myUnpaidPenalty > 0) attention.push({ text: t('vicoba.own_penalty_alert'), go: () => { setTab('finance'); setFsTab('fines'); } });

  const recentTx = transactions.slice(0, 6);

  const mainTabs = [
    { id: 'overview', key: 'vicoba.tab_overview' },
    { id: 'finance', key: 'vicoba.tab_finance' },
    { id: 'members', key: 'vicoba.tab_members' },
    { id: 'gov', key: 'vicoba.tab_gov' },
    { id: 'docs', key: 'vicoba.tab_docs' },
    { id: 'meetings', key: 'vicoba.tab_meetings' },
    { id: 'reports', key: 'vicoba.tab_reports' },
  ];

  const fsTabs = [
    { id: 'shares', key: 'vicoba.fs_shares' },
    { id: 'loans', key: 'vicoba.fs_loans' },
    { id: 'social', key: 'vicoba.fs_social' },
    { id: 'fines', key: 'vicoba.fs_fines' },
    { id: 'withdraw', key: 'vicoba.fs_withdraw' },
    { id: 'dividends', key: 'vicoba.fs_dividends' },
  ];

  const govTabs = [
    { id: 'leaders', key: 'vicoba.gov_leaders' },
    { id: 'structure', key: 'vicoba.gov_structure' },
    { id: 'resolutions', key: 'vicoba.gov_resolutions' },
    { id: 'actions', key: 'vicoba.gov_actions' },
    { id: 'analytics', key: 'vicoba.gov_analytics' },
  ];

  const quickActions = [
    { key: 'vicoba.quick_share', hint: t('vicoba.fs_shares'), go: () => { setTab('finance'); setFsTab('shares'); } },
    { key: 'vicoba.quick_loan', hint: t('vicoba.fs_loans'), go: () => { setTab('finance'); setFsTab('loans'); } },
    { key: 'vicoba.quick_social', hint: t('vicoba.fs_social'), go: () => { setTab('finance'); setFsTab('social'); } },
    ...(isLeader ? [
      { key: 'vicoba.quick_add_member', hint: t('vicoba.tab_members'), go: () => { setTab('members'); } },
      { key: 'vicoba.quick_invite', hint: t('vicoba.tab_members'), go: () => { setTab('members'); } },
      { key: 'vicoba.quick_bonus', hint: t('vicoba.fs_dividends'), go: () => { setTab('finance'); setFsTab('dividends'); } },
    ] : []),
  ];

  const printDocs = () => {
    const win = window.open('', '_blank');
    if (!win) return;
    const roleName = selected?.role_in_group || 'MWANACHAMA';
    win.document.write(`<!doctype html><html><head><title>${selected?.group_name} - Nyaraka</title><style>body{font-family:sans-serif;max-width:720px;margin:30px auto;padding:0 16px;color:#111}table{border-collapse:collapse;width:100%;margin:14px 0}th,td{border:1px solid #999;padding:8px;font-size:13px;text-align:left}th{background:#f2f2f2}h1{font-size:22px}h2{font-size:16px;border-bottom:1px solid #ccc;padding-bottom:4px}</style></head><body><h1>${selected?.group_name}</h1><p>Mzunguko: ${selected?.cycle_type} · Msimbo: ${selected?.join_code || '-'} · Wajibu Wako: ${roleName}</p><h2>Wanachama</h2><table><tr><th>Jina</th><th>Namba</th><th>Wajibu</th><th>Hisa</th><th>Michango</th></tr>${members.map((m) => `<tr><td>${m.full_name || ''}</td><td>${m.phone_number || ''}</td><td>${m.role_in_group || ''}</td><td>${m.total_shares || 0}</td><td>${formatMoney(m.contribution_balance)}</td></tr>`).join('')}</table>${constitution && Object.keys(constitution).length > 0 ? `<h2>Katiba / Nyaraka</h2><pre style="white-space:pre-wrap;font-size:12px">${JSON.stringify(constitution, null, 2)}</pre>` : ''}</body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 350);
  };

  const createStepTitles = [t('vicoba.step_group_info'), t('vicoba.step_contrib'), t('vicoba.step_governance'), t('vicoba.step_review')];

  return (
    <ServiceLock serviceKey="VICOBA">
      <div className="page-head">
        <h2>{t('vicoba.title')}</h2>
        <p>{t('vicoba.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      {createdGroup && (
        <div className="card" style={{ marginBottom: 14, borderLeft: '4px solid var(--green)' }}>
          <h3 style={{ marginTop: 0 }}>{t('vicoba.created_success')}</h3>
          <div className="grid grid-2" style={{ gap: 10 }}>
            <div className="bc-subnote">
              <div><strong>{createdGroup.group_name}</strong> · {t('vicoba.code')}: <strong>{createdGroup.join_code}</strong></div>
              <div>{t('vicoba.chairman_label')}: {user.full_name || 'Wewe'} · {t('vicoba.cycle')}: {CYCLE_LABEL[createdGroup.cycle_type] || createdGroup.cycle_type}</div>
              <div>{t('vicoba.share')}: {formatMoney(createdGroup.share_value)}</div>
            </div>
            <div className="inline-actions" style={{ justifyContent: 'flex-end', alignItems: 'center' }}>
              <button className="btn ghost" onClick={() => setCreatedGroup(null)}>Funga</button>
              <button className="btn" onClick={openCreated}>{t('vicoba.open_group')}</button>
            </div>
          </div>
        </div>
      )}

      {invitations.length > 0 && (
        <div className="card section" style={{ marginBottom: 14 }}>
          <h3>Mialiko ya kujiunga (<strong>{invitations.length}</strong>)</h3>
          <div className="grid grid-2" style={{ gap: 8 }}>
            {invitations.map((i) => (
              <div key={i.id} className="list-item">
                <div>
                  <strong>{i.group_name}</strong>
                  <div className="roles-tag">{i.cycle_type} · {t('vicoba.share')} {formatMoney(i.share_value)} · Wanachama: {i.member_count}</div>
                  <div style={{ opacity: 0.7, fontSize: 12 }}>Umealikwa {String(i.created_at).slice(0, 10)}</div>
                </div>
                <div className="inline-actions">
                  <button className="btn" onClick={() => acceptInvite(i.id)}>{t('vicoba.accept')}</button>
                  <button className="btn warn" onClick={() => rejectInvite(i.id)}>{t('vicoba.reject')}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!selected ? (
        <>
          <div className="card" style={{ marginBottom: 16, border: 'none', boxShadow: 'none', padding: '6px 0' }}>
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>{t('vicoba.landing_sub')}</p>
          </div>

          <h3 style={{ marginBottom: 10 }}>{t('vicoba.groups')}</h3>
          {groups.length === 0 && <p className="roles-tag">{t('vicoba.no_groups')}</p>}
          {groups.length > 0 && (
            <div className="grid grid-2">
              {groups.map((g) => (
                <div key={g.id} className="card bc-group-card">
                  <h3 style={{ marginTop: 0 }}>{g.group_name}</h3>
                  <div className="roles-tag" style={{ marginBottom: 8 }}>
                    VICOBA · {CYCLE_LABEL[g.cycle_type] || g.cycle_type} · <StatusBadge status={g.status} />
                  </div>
                  <div className="bc-subnote" style={{ marginBottom: 12 }}>
                    {g.member_count != null ? `Wanachama ${g.member_count}` : `Wewe: ${g.role_in_group}`} · {t('vicoba.share')} {formatMoney(g.share_value)}
                    {g.country && g.country !== 'Tanzania' ? ` · ${g.country}` : ''}
                  </div>
                  <button className="btn" style={{ width: '100%' }} onClick={() => selectGroup(g)}>{t('vicoba.open_group')}</button>
                </div>
              ))}
            </div>
          )}

          <div className="inline-actions" style={{ marginTop: 16, gap: 10 }}>
            <button className="btn" onClick={() => setShowCreate(true)}>+ {t('vicoba.create_group')}</button>
            <button className="btn ghost" onClick={() => setShowJoin(true)}>{t('vicoba.join_modal')}</button>
          </div>
        </>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="inline-actions" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <h3 style={{ margin: 0 }}>
                  {selected.group_name}
                  {selected.join_code && <span className="roles-tag" style={{ marginLeft: 12 }}>{t('vicoba.code')}: <strong>{selected.join_code}</strong></span>}
                  <span className="roles-tag" style={{ marginLeft: 8 }}><StatusBadge status={selected.status} /></span>
                </h3>
                <div className="roles-tag" style={{ marginTop: 4 }}>
                  VICOBA · {CYCLE_LABEL[selected.cycle_type] || selected.cycle_type}
                  {selected.country ? ` · ${selected.country}` : ''}
                  {selected.group_type && selected.group_type !== 'STANDARD' ? ` · ${selected.group_type}` : ''}
                </div>
                {selected.description && <div className="bc-subnote" style={{ marginTop: 6 }}>{selected.description}</div>}
              </div>
              <span className="roles-tag">Wajibu Wako: <strong>{myRole}</strong></span>
            </div>

            <div className="bc-tabs" style={{ marginTop: 14, marginBottom: 0 }}>
              {mainTabs.map((tm) => (
                <button key={tm.id} className={tab === tm.id ? 'active' : ''} onClick={() => setTab(tm.id)}>{t(tm.key)}</button>
              ))}
            </div>
          </div>

          {/* ============ OVERVIEW ============ */}
          {tab === 'overview' && (
            <div>
              <div className="bc-subnote" style={{ marginBottom: 10 }}>{t('vicoba.hisari_tooltip')}</div>
              <div className="grid grid-4" style={{ marginBottom: 14 }}>
                <div className="card stat"><div className="value">{formatMoney(selected.group_wallet_balance)}</div><div className="label">{t('vicoba.group_wallet')}</div></div>
                <div className="card stat"><div className="value">{members.length}</div><div className="label">{t('vicoba.members_count')}</div></div>
                <div className="card stat"><div className="value">{totalShares}</div><div className="label">{t('vicoba.total_shares_label')}</div></div>
                <div className="card stat"><div className="value">{activeLoans}</div><div className="label">{t('vicoba.active_loans')}</div></div>
              </div>
              <div className="grid grid-2" style={{ marginBottom: 14 }}>
                <div className="card"><div className="value" style={{ fontSize: 20 }}>{formatMoney(finReport?.social_fund_balance || socialFund?.fund?.total_balance || 0)}</div><div className="label">{t('vicoba.tab_finance')} · {t('vicoba.fs_social')}</div></div>
                <div className="card"><div className="value" style={{ fontSize: 20 }}>{formatMoney((Number(selected.group_wallet_balance) || 0) + (Number(finReport?.social_fund_balance) || 0))}</div><div className="label">Salio la Jumla (Pochi + Mfuko wa Jamii)</div></div>
              </div>

              <div className="card bc-attention" style={{ marginBottom: 14 }}>
                <h3 style={{ marginTop: 0 }}>{t('vicoba.needs_attention')}</h3>
                {attention.length === 0 && <p className="roles-tag">{t('vicoba.no_pending')}</p>}
                {attention.map((a, i) => (
                  <div key={i} className="inline-actions" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 13.5 }}>{a.text}</span>
                    <button className="btn ghost" onClick={a.go}>{t('vicoba.view_all')}</button>
                  </div>
                ))}
              </div>

              <div className="card" style={{ marginBottom: 14 }}>
                <h3 style={{ marginTop: 0 }}>{t('vicoba.quick_actions')}</h3>
                <div className="grid grid-2">
                  {quickActions.map((qa) => (
                    <button key={qa.key} className="bc-action" onClick={qa.go}>
                      <strong>{t(qa.key)}</strong>
                      <span>{qa.hint}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="card">
                <div className="inline-actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ margin: 0 }}>{t('vicoba.recent_activity')}</h3>
                  <button className="btn ghost" onClick={() => { setTab('finance'); setFsTab('shares'); }}>{t('vicoba.see_all')}</button>
                </div>
                <table style={{ marginTop: 10 }}>
                  <thead><tr><th>Mwanachama</th><th>Aina</th><th>Kiasi</th><th>Tarehe</th></tr></thead>
                  <tbody>
                    {recentTx.map((tx, i) => (
                      <tr key={i}>
                        <td>{tx.full_name}</td>
                        <td>{txKindLabel(tx.kind)}</td>
                        <td>{formatMoney(tx.amount)}</td>
                        <td>{tx.created_at ? String(tx.created_at).slice(0, 10) : '—'}</td>
                      </tr>
                    ))}
                    {recentTx.length === 0 && <tr><td colSpan="4" className="roles-tag">{t('dash.no_recent')}</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============ FINANCE ============ */}
          {tab === 'finance' && (
            <div>
              <div className="bc-tabs">
                {fsTabs.map((f) => (
                  <button key={f.id} className={`${fsTab === f.id ? 'active' : ''} bc-chip`} onClick={() => setFsTab(f.id)}>{t(f.key)}</button>
                ))}
              </div>

              {fsTab === 'shares' && (
                <>
                  <div className="card" style={{ marginBottom: 14 }}>
                    <h3 style={{ marginTop: 0 }}>1. {t('vicoba.share_book')} ({t('vicoba.hisari_tooltip')})</h3>
                    <div className="bc-subnote" style={{ marginBottom: 10 }}>
                      {t('vicoba.share_def')} · {t('vicoba.contribution_def')} · Mzunguko: {CYCLE_LABEL[selected.cycle_type] || selected.cycle_type}. Mchango wako wa sasa: {formatMoney(totalContrib)}.
                    </div>
                    <form className="form-row" onSubmit={contribute}>
                      <div className="field"><label>{t('vicoba.contribute')} (TZS)</label><input type="number" value={contributeAmt} onChange={(e) => setContributeAmt(e.target.value)} required /></div>
                      <div className="field"><label>{t('vicoba.share_count')}</label><input type="number" value={contributeShares} onChange={(e) => setContributeShares(e.target.value)} /></div>
                      <button className="btn" type="submit">{t('vicoba.contribute_btn')}</button>
                    </form>
                    <table>
                      <thead><tr><th>{t('vicoba.m_th_name')}</th><th>{t('vicoba.m_th_phone')}</th><th>Hisa (Unyumbaji)</th><th>{t('vicoba.m_th_contrib')}</th></tr></thead>
                      <tbody>
                        {shareBook.map((s) => (
                          <tr key={s.id || s.reference_id}>
                            <td>{s.full_name || s.user_name || '—'}</td>
                            <td>{s.phone_number || '—'}</td>
                            <td>{s.shares_count}</td>
                            <td>{formatMoney(s.amount)}</td>
                          </tr>
                        ))}
                        {shareBook.length === 0 && <tr><td colSpan="4" className="roles-tag">{t('vicoba.no_docs')}</td></tr>}
                      </tbody>
                    </table>
                  </div>

                  <div className="card">
                    <h3 style={{ marginTop: 0 }}>{t('vicoba.transactions')} <span className="roles-tag" style={{ marginLeft: 8 }}>{showArchived ? t('vicoba.tx_archive') : 'Hali ya Sasa'}</span></h3>
                    <table>
                      <thead><tr><th>Mwanachama</th><th>Aina</th><th>Kiasi</th><th>Mzunguko</th><th>Tarehe</th></tr></thead>
                      <tbody>
                        {transactions.map((tx, i) => (
                          <tr key={i}>
                            <td>{tx.full_name}</td>
                            <td>{txKindLabel(tx.kind)}</td>
                            <td>{formatMoney(tx.amount)}</td>
                            <td>{tx.cycle_number || '—'}</td>
                            <td>{tx.created_at ? String(tx.created_at).slice(0, 10) : '—'}</td>
                          </tr>
                        ))}
                        {transactions.length === 0 && <tr><td colSpan="5" className="roles-tag">{t('dash.no_recent')}</td></tr>}
                      </tbody>
                    </table>
                    <button className="btn ghost" style={{ marginTop: 10 }} onClick={loadMoreTx}>{t('vicoba.load_more')}</button>
                  </div>
                </>
              )}

              {fsTab === 'loans' && (
                <div className="card">
                  <h3 style={{ marginTop: 0 }}>{t('vicoba.loans_section')}</h3>
                  <div className="bc-subnote" style={{ marginBottom: 10 }}>
                    Mkopo unakaguliwa kwa ratiba ya kurejesha (riba + awamu) kabla ya kutolewa. Mahitaji: KYC imekamilika.
                  </div>
                  {canAddLoan && (
                    <form className="form-row" onSubmit={addLoan}>
                      <div className="field"><label>{t('vicoba.loan_member')} (User ID)</label><input type="number" value={loanApplicant} onChange={(e) => setLoanApplicant(e.target.value)} required /></div>
                      <div className="field"><label>{t('vicoba.loan_amount')}</label><input type="number" value={loanAmount} onChange={(e) => setLoanAmount(e.target.value)} required /></div>
                      <div className="field"><label>{t('vicoba.loan_interest')} (%)</label><input type="number" value={loanInterest} onChange={(e) => setLoanInterest(e.target.value)} /></div>
                      <div className="field"><label>{t('vicoba.loan_months')}</label><input type="number" value={loanMonths} onChange={(e) => setLoanMonths(e.target.value)} /></div>
                      <button className="btn" type="submit">{t('vicoba.add_loan')}</button>
                    </form>
                  )}

                  <table>
                    <thead><tr><th>{t('vicoba.th_request')}</th><th>{t('vicoba.th_applicant')}</th><th>{t('vicoba.loan_amount')}</th><th>{t('vicoba.th_approval')}</th><th>{t('vicoba.th_loan_status')}</th><th>{t('vicoba.th_loan_actions')}</th></tr></thead>
                    <tbody>
                      {loans.map((l) => (
                        <React.Fragment key={l.id}>
                          <tr>
                            <td>#{l.id}</td>
                            <td>{l.full_name}<div className="roles-tag">{l.phone_number}</div></td>
                            <td>{formatMoney(l.requested_amount)}</td>
                            <td>
                              <span className="roles-tag">
                                {t('vicoba.approvals', { c: l.chairman_approval ? '✓' : '✗', t: l.treasurer_approval ? `${String.fromCharCode(10003)}` : '✗' })}
                              </span>
                            </td>
                            <td><StatusBadge status={l.status} /></td>
                            <td>
                              {canApprove && l.status === 'APPROVED' && (
                                <div className="inline-actions">
                                  <input type="number" placeholder="Kiasi" style={{ minWidth: 80 }} value={approveAmount}
                                    onChange={(e) => setApproveAmount(e.target.value)} />
                                  <button className="btn" onClick={() => approve(l.id)}>{t('vicoba.release_loan')}</button>
                                </div>
                              )}
                              {l.status === 'PENDING' && l.treasurer_approval === false && canApprove && (
                                <button className="btn warn" onClick={() => approve(l.id)}>{t('vicoba.approve_loan')}</button>
                              )}
                            </td>
                          </tr>
                          <tr>
                            <td>(marejesho)</td>
                            <td colSpan="4">
                              <div className="inline-actions" style={{ gap: 6, flexWrap: 'wrap' }}>
                                <input type="number" placeholder="Kiasi" style={{ minWidth: 90 }} value={repayMap[l.id] || ''} onChange={(e) => setRepayMap((p) => ({ ...p, [l.id]: e.target.value }))} />
                                <button className="btn" onClick={() => repayLoanRow(l.id)}>{t('vicoba.repay_loan_btn')}</button>
                                <button className="btn ghost" onClick={() => toggleLoanExtra(l)}>{t('vicoba.view_schedule')}</button>
                                <span className="roles-tag">Salio: {formatMoney(l.outstanding_balance != null ? l.outstanding_balance : l.requested_amount)}</span>
                              </div>
                            </td>
                          </tr>
                          {loanExtra[l.id] && (
                            <tr>
                              <td colSpan="6">
                                <strong>{t('vicoba.view_repay')}:</strong>
                                <table>
                                  <thead><tr><th>Ratiba</th><th>Tarehe</th><th>Principali</th><th>Riba</th><th>Jumla</th><th>Hali</th></tr></thead>
                                  <tbody>
                                    {(loanExtra[l.id].schedule || []).map((sc) => (
                                      <tr key={sc.id}>
                                        <td>#{sc.installment_number}</td>
                                        <td>{sc.due_date}</td>
                                        <td>{formatMoney(sc.principal_amount)}</td>
                                        <td>{formatMoney(sc.interest_amount)}</td>
                                        <td>{formatMoney(sc.total_amount)}</td>
                                        <td><StatusBadge status={sc.status} /></td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                                <strong>Malipo yaliyofanyika:</strong>
                                <table>
                                  <thead><tr><th>Mwanachama</th><th>Kiasi</th><th>Tarehe</th></tr></thead>
                                  <tbody>
                                    {(loanExtra[l.id].payments || []).map((p) => (
                                      <tr key={p.id}><td>{p.full_name}</td><td>{formatMoney(p.amount)}</td><td>{String(p.created_at).slice(0, 10)}</td></tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      ))}
                      {loans.length === 0 && <tr><td colSpan="6" className="roles-tag">{t('vicoba.no_loans')}</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}

              {fsTab === 'social' && (
                <div className="card">
                  <h3 style={{ marginTop: 0 }}>{t('vicoba.fs_social')}</h3>
                  <p className="roles-tag" style={{ marginBottom: 12 }}>Mfuko wa msiba na dharura za kijamii. Michango na uondoaji vinathibitishwa na viongozi na kurekodiwa kwenye leja.</p>
                  {isLeader && (
                    <form className="form-row" onSubmit={initSocialFund}>
                      <div className="field"><label>{t('vicoba.soc_contribute')} (kila mwanachama)</label><input type="number" value={sFundMonthly} onChange={(e) => setSFundMonthly(e.target.value)} placeholder="e.g. 5000" required /></div>
                      <button className="btn" type="submit">Anzisha/Weza Mfuko</button>
                    </form>
                  )}
                  <div className="inline-actions" style={{ gap: 14, margin: '10px 0', flexWrap: 'wrap' }}>
                    <span className="roles-tag">Salio la Mfuko: <strong>{formatMoney(socialFund?.fund?.total_balance || 0)}</strong></span>
                    <span className="roles-tag">Kilichokusanywa: <strong>{formatMoney(socialFund?.fund?.total_collected || 0)}</strong></span>
                    <span className="roles-tag">Kilichotolewa: <strong>{formatMoney(socialFund?.fund?.total_disbursed || 0)}</strong></span>
                  </div>
                  <div className="grid grid-2" style={{ gap: 10 }}>
                    <form className="form-row" onSubmit={contributeSocial}>
                      <div className="field"><label>Mwezi (YYYY-MM)</label><input value={sMonth} onChange={(e) => setSMonth(e.target.value)} required /></div>
                      <button className="btn ghost" type="submit">{t('vicoba.soc_contribute')}</button>
                    </form>
                    <form className="form-row" onSubmit={requestSocial}>
                      <div className="field"><label>{t('vicoba.soc_reason_type')}</label>
                        <select value={sReqType} onChange={(e) => setSReqType(e.target.value)}>
                          <option value="FUNERAL">Msiba</option><option value="WEDDING">Harusi</option><option value="ILLNESS">Ugonjwa</option><option value="FAMILY_EVENT">Tukio la Familia</option><option value="OTHER">Nyingine</option>
                        </select>
                      </div>
                      <div className="field" style={{ flex: 1 }}><label>{t('vicoba.soc_reason_detail')}</label><input value={sReqDetail} onChange={(e) => setSReqDetail(e.target.value)} required /></div>
                      <div className="field"><label>{t('vicoba.soc_amount')}</label><input type="number" value={sReqAmount} onChange={(e) => setSReqAmount(e.target.value)} required /></div>
                      <button className="btn warn" type="submit">{t('vicoba.soc_request')}</button>
                    </form>
                  </div>
                  {(socialFund?.requests || []).length > 0 && (
                    <table style={{ marginTop: 12 }}>
                      <thead><tr><th>Aliyeomba</th><th>Aina</th><th>Kiasi</th><th>Hali</th><th></th></tr></thead>
                      <tbody>
                        {socialFund.requests.map((r) => (
                          <tr key={r.id}>
                            <td>{r.requester_name}</td>
                            <td>{r.reason_type}<div className="roles-tag">{r.reason_detail}</div></td>
                            <td>{formatMoney(r.requested_amount)}</td>
                            <td><StatusBadge status={r.status} /></td>
                            <td>
                              {isLeader && r.status === 'PENDING' && (
                                <div className="inline-actions">
                                  <button className="btn" onClick={() => decideSocial(r.id, 'approve', r.requested_amount)}>Idhinisha</button>
                                  <button className="btn warn" onClick={() => decideSocial(r.id, 'reject')}>Kataa</button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {fsTab === 'fines' && (
                <div className="card">
                  <h3 style={{ marginTop: 0 }}>{t('vicoba.fs_fines')}</h3>
                  <p className="roles-tag" style={{ marginBottom: 12 }}>Faini za kuchelewesha mchango au kutohudhuria kikao. Malipo yanaenda kwenye leja ya kikundi.</p>
                  <table>
                    <thead><tr><th>Mwanachama</th><th>Aina</th><th>Kiasi</th><th>Sababu</th><th>Hali</th><th></th></tr></thead>
                    <tbody>
                      {penalties.map((p) => (
                        <tr key={p.id}>
                          <td>{p.full_name || '—'}</td>
                          <td>{p.penalty_type}</td>
                          <td>{formatMoney(p.amount)}</td>
                          <td>{p.reason || '—'}</td>
                          <td><StatusBadge status={p.status} /></td>
                          <td>
                            <div className="inline-actions">
                              {p.status === 'UNPAID' && Number(p.user_id) === Number(user.id) && (
                                <button className="btn" onClick={() => payPenalty(p.id)}>{t('vicoba.penalty_pay')}</button>
                              )}
                              {isLeader && p.status === 'UNPAID' && (
                                <button className="btn warn" onClick={() => waivePenalty(p.id)}>{t('vicoba.penalty_waive')}</button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {penalties.length === 0 && <tr><td colSpan="6" className="roles-tag">{t('vicoba.no_penalties')}</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}

              {fsTab === 'withdraw' && (
                <div className="card">
                  <h3 style={{ marginTop: 0 }}>{t('vicoba.fs_withdraw')} <span className="roles-tag" style={{ marginLeft: 8 }}>{t('vicoba.signature_title')}</span></h3>
                  <p className="roles-tag" style={{ marginBottom: 12 }}>
                    Unaweza kutoa hisa zako (mchango uliokusanywa). Utoaji unasubiri saini ya Mwenyekiti NA Mweka Hazina kabla ya kupelekwa kwenye pochi yako.
                  </p>
                  <form className="form-row" onSubmit={requestWithdrawal}>
                    <div className="field"><label>{t('vicoba.wd_amount')}</label><input type="number" value={wdAmt} onChange={(e) => setWdAmt(e.target.value)} required /></div>
                    {myMember && <div className="field"><label>{t('vicoba.wd_my_avail')}</label><input value={formatMoney(myMember.contribution_balance)} disabled /></div>}
                    <button className="btn" type="submit">{t('vicoba.request_withdraw')}</button>
                  </form>
                  <table style={{ marginTop: 12 }}>
                    <thead><tr><th>Mwanachama</th><th>Kiasi</th><th>{t('vicoba.wd_chair')}</th><th>{t('vicoba.wd_treasurer')}</th><th>Hali</th><th></th></tr></thead>
                    <tbody>
                      {withdrawals.map((w) => (
                        <tr key={w.id}>
                          <td>{w.full_name}<div className="roles-tag">{w.phone_number}</div></td>
                          <td>{formatMoney(w.amount)}</td>
                          <td>{w.chairman_id ? (w.chairman_name || '✓') : '—'}</td>
                          <td>{w.treasurer_id ? (w.treasurer_name || '✓') : '—'}</td>
                          <td><StatusBadge status={w.status} /></td>
                          <td>
                            {canSignWd && w.status === 'PENDING' && (
                              <div className="inline-actions">
                                <button className="btn" onClick={() => decideWithdrawal(w.id, true)}>✓ {t('vicoba.wd_approve')}</button>
                                <button className="btn warn" onClick={() => decideWithdrawal(w.id, false)}>{t('vicoba.wd_reject')}</button>
                              </div>
                            )}
                            {w.status === 'PENDING' && !canSignWd && <span className="roles-tag">{t('vicoba.wd_pending_approval')}</span>}
                          </td>
                        </tr>
                      ))}
                      {withdrawals.length === 0 && <tr><td colSpan="6" className="roles-tag">{t('vicoba.no_withdrawals')}</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}

              {fsTab === 'dividends' && (
                <div className="grid grid-2" style={{ gap: 14, alignItems: 'start' }}>
                  <div className="card">
                    <h3 style={{ marginTop: 0 }}>{t('vicoba.fs_dividends')}</h3>
                    <p className="roles-tag" style={{ marginBottom: 12 }}>{t('vicoba.profit_sub')}</p>
                    {isLeader && (
                      <form className="form-row" onSubmit={calculateProfit}>
                        <div className="field"><label>{t('vicoba.profit_cycle')}</label><input type="number" value={pCycle} onChange={(e) => setPCycle(e.target.value)} required /></div>
                        <div className="field"><label>{t('vicoba.profit_total')}</label><input type="number" value={pProfit} onChange={(e) => setPProfit(e.target.value)} required /></div>
                        <button className="btn" type="submit">{t('vicoba.profit_calc_btn')}</button>
                      </form>
                    )}
                    {profitCalc && (
                      <div className="card" style={{ marginBottom: 12, padding: 14 }}>
                        <strong>{t('vicoba.profit_preview')}: {formatMoney(profitCalc.totalProfit)}</strong>
                        <div className="roles-tag">{t('vicoba.profit_per_share', { v: formatMoney(profitCalc.perShareDividend) })} · {t('vicoba.profit_members', { c: profitCalc.payouts?.length || 0 })}</div>
                        <table style={{ marginTop: 10 }}>
                          <thead><tr><th>{t('vicoba.m_th_name')}</th><th>{t('vicoba.m_th_shares')}</th><th>{t('vicoba.profit_dividend')}</th></tr></thead>
                          <tbody>
                            {(profitCalc.payouts || []).map((p, i) => (
                              <tr key={i}><td>{p.name}</td><td>{p.shares}</td><td>{formatMoney(p.dividend)}</td></tr>
                            ))}
                          </tbody>
                        </table>
                        {profitCalc.distribution && (
                          <div className="inline-actions" style={{ marginTop: 10 }}>
                            <button className="btn warn" onClick={() => approveProfit(profitCalc.distribution.id)}>{t('vicoba.profit_approve')}</button>
                          </div>
                        )}
                      </div>
                    )}
                    {distributions.length > 0 && (
                      <>
                        <h3 style={{ marginBottom: 8 }}>{t('vicoba.profit_distributions')}</h3>
                        <table>
                          <thead><tr><th>{t('vicoba.profit_d_cycle')}</th><th>{t('vicoba.profit_total2')}</th><th>{t('vicoba.profit_per_share2')}</th><th>{t('vicoba.profit_d_members')}</th><th>{t('vicoba.profit_d_paid')}</th><th>{t('vicoba.th_loan_status')}</th><th></th></tr></thead>
                          <tbody>
                            {distributions.map((d) => (
                              <tr key={d.id}>
                                <td>#{d.cycle_number}</td>
                                <td>{formatMoney(d.total_profit)}</td>
                                <td>{formatMoney(d.per_share_dividend)}</td>
                                <td>{d.payout_count}</td>
                                <td>{formatMoney(d.total_paid)}</td>
                                <td><StatusBadge status={d.status} /></td>
                                <td>{isLeader && d.status === 'PENDING' && (
                                  <button className="btn warn" onClick={() => approveProfit(d.id)}>{t('vicoba.profit_approve')}</button>
                                )}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>

                  <div className="card">
                    <h3 style={{ marginTop: 0 }}>{t('vicoba.quick_bonus')}</h3>
                    {isLeader ? (
                      <form className="form-row" onSubmit={submitBonus}>
                        <div className="field"><label>{t('vicoba.bonus_add')} (TZS)</label><input type="number" value={bonusForm.amount} onChange={(e) => setBonusForm({ ...bonusForm, amount: e.target.value })} required /></div>
                        <div className="field" style={{ flex: 1 }}><label>{t('vicoba.bonus_purpose')}</label><input value={bonusForm.purpose} onChange={(e) => setBonusForm({ ...bonusForm, purpose: e.target.value })} placeholder="Mapato ya riba / malipo ya ziada" /></div>
                        <button className="btn" type="submit">+ BONUS</button>
                      </form>
                    ) : (<p className="roles-tag">Viongozi pekee wanaweza kuongeza bonus.</p>)}
                    {bonuses.length > 0 && (
                      <table style={{ marginTop: 12 }}>
                        <thead><tr><th>Kiasi</th><th>Sababu</th><th>Tarehe</th></tr></thead>
                        <tbody>
                          {bonuses.map((b) => (
                            <tr key={b.id}><td>{formatMoney(b.amount)}</td><td>{b.purpose || '—'}</td><td>{String(b.created_at).slice(0, 10)}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {myPayouts.length > 0 && (
                      <>
                        <h3 style={{ marginTop: 14, marginBottom: 8 }}>{t('vicoba.profit_my')}</h3>
                        <table>
                          <thead><tr><th>{t('vicoba.profit_d_cycle')}</th><th>{t('vicoba.profit_dividend')}</th><th>{t('vicoba.m_th_shares')}</th><th>{t('vicoba.rollover')}</th><th>{t('vicoba.profit_paid')}</th><th>{t('vicoba.th_loan_status')}</th></tr></thead>
                          <tbody>
                            {myPayouts.map((p) => (
                              <tr key={p.id}>
                                <td>#{p.cycle_number}</td>
                                <td>{formatMoney(p.dividend_amount)}</td>
                                <td>{p.shares_count}</td>
                                <td>{p.rollover_shares}</td>
                                <td>{formatMoney(p.dividend_amount)}</td>
                                <td>{p.paid ? t('vicoba.yes') : t('vicoba.no')}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ============ MEMBERS ============ */}
          {tab === 'members' && (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>{t('vicoba.members_section')} <span className="roles-tag">({members.length})</span></h3>
              <input
                placeholder={t('vicoba.member_search')}
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                style={{ marginBottom: 10, maxWidth: 300 }}
              />
              <table>
                <thead><tr><th>{t('vicoba.m_th_name')}</th><th>{t('vicoba.m_th_phone')}</th><th>{t('vicoba.m_th_role')}</th><th>{t('vicoba.m_th_shares')}</th><th>{t('vicoba.m_th_contrib')}</th></tr></thead>
                <tbody>
                  {filteredMembers.map((m) => (
                    <tr key={m.user_id}>
                      <td>{m.full_name}</td>
                      <td>{m.phone_number}</td>
                      <td>{m.role_in_group}</td>
                      <td>{m.total_shares}</td>
                      <td>{formatMoney(m.contribution_balance)}</td>
                    </tr>
                  ))}
                  {filteredMembers.length === 0 && <tr><td colSpan="5" className="roles-tag">Hakuna mwanachama anayefanana.</td></tr>}
                </tbody>
              </table>
              {isLeader && (
                <div className="grid grid-2" style={{ marginTop: 14 }}>
                  <form className="form-row" onSubmit={addMember}>
                    <div className="field"><label>{t('vicoba.add_member')} (User ID)</label><input type="number" value={newMemberId} onChange={(e) => setNewMemberId(e.target.value)} required /></div>
                    <button className="btn ghost" type="submit">{t('vicoba.add')}</button>
                  </form>
                  <form className="form-row" onSubmit={invite}>
                    <div className="field" style={{ flex: 1 }}>
                      <label>{t('vicoba.invite_sms')}</label>
                      <input value={invitePhones} onChange={(e) => setInvitePhones(e.target.value)} placeholder="0712000001, 0713000002" />
                    </div>
                    <button className="btn warn" type="submit">{t('vicoba.send_invites')}</button>
                  </form>
                </div>
              )}
            </div>
          )}

          {/* ============ GOVERNANCE ============ */}
          {tab === 'gov' && (
            <div>
              <div className="bc-tabs">
                {govTabs.map((gt) => (
                  <button key={gt.id} className={`${govTab === gt.id ? 'active' : ''} bc-chip`} onClick={() => setGovTab(gt.id)}>{t(gt.key)}</button>
                ))}
              </div>

              {govTab === 'leaders' && (
                <div className="card">
                  <h3 style={{ marginTop: 0 }}>{t('vicoba.leaders_table')}</h3>
                  <p className="roles-tag" style={{ marginBottom: 12 }}>
                    Majukumu yanathibitishwa upande wa backend: Mwenyekiti (miundo na idhini), Mweka Hazina (fedha na saini ya 2), Katibu (wanachama na kumbukumbu). Wanachama wajumbe huona shughuli zao.
                  </p>
                  {leadership.length > 0 ? (
                    <table>
                      <thead><tr><th>{t('vicoba.m_th_name')}</th><th>{t('vicoba.m_th_role')}</th><th>{t('vicoba.m_th_phone')}</th><th>{t('vicoba.m_th_shares')}</th></tr></thead>
                      <tbody>
                        {leadership.map((m) => (
                          <tr key={m.user_id}>
                            <td>{m.full_name}</td>
                            <td><strong>{m.role_in_group}</strong></td>
                            <td>{m.phone_number}</td>
                            <td>{m.total_shares}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="roles-tag">{t('vicoba.no_docs')}</p>}
                  <div className="inline-actions" style={{ marginTop: 14 }}>
                    <Link to="/dashboard/governance" className="btn ghost" style={{ textDecoration: 'none' }}>{t('vicoba.go_to_governance')}</Link>
                  </div>
                </div>
              )}

              {govTab === 'structure' && (
                <div className="grid grid-2" style={{ gap: 14, alignItems: 'start' }}>
                  <div className="card">
                    <h3 style={{ marginTop: 0 }}>{t('vicoba.settings_table')}</h3>
                    <div className="bc-subnote" style={{ marginBottom: 10 }}>
                      {t('vicoba.share_def')} · {t('vicoba.contribution_def')} · {t('vicoba.cycle_def')} · {t('vicoba.maintenance_def')}
                    </div>
                    <table>
                      <tbody>
                        <tr><th>{t('vicoba.name')}</th><td>{selected.group_name}</td></tr>
                        <tr><th>{t('vicoba.members_count')}</th><td>{members.length}</td></tr>
                        <tr><th>{t('vicoba.cycle')}</th><td>{CYCLE_LABEL[selected.cycle_type] || selected.cycle_type}</td></tr>
                        <tr><th>{t('vicoba.share')} (Thamani ya Hisa)</th><td>{formatMoney(selected.share_value)}</td></tr>
                        <tr><th>{t('vicoba.maintenance_fee')}</th><td>{formatMoney(selected.monthly_maintenance_fee)}</td></tr>
                        <tr><th>RIBA</th><td>{constitution?.loan_interest_rate != null ? `${constitution.loan_interest_rate}%` : '—'}</td></tr>
                        <tr><th>{t('vicoba.fs_social')} (kwa mwanachama)</th><td>{socialFund?.fund?.monthly_contribution != null ? formatMoney(socialFund.fund.monthly_contribution) : '—'}</td></tr>
                        {selected.country && <tr><th>{t('vicoba.country')}</th><td>{selected.country}</td></tr>}
                        {selected.group_type && <tr><th>{t('vicoba.group_type')}</th><td>{selected.group_type}</td></tr>}
                        {selected.min_shares && <tr><th>{t('vicoba.min_shares')}</th><td>{selected.min_shares}</td></tr>}
                        {selected.max_shares && <tr><th>{t('vicoba.max_shares')}</th><td>{selected.max_shares}</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <div className="card">
                    <h3 style={{ marginTop: 0 }}>Katiba / Maagizo ya Kikundi</h3>
                    <p className="roles-tag" style={{ marginBottom: 12 }}>Ratiba ya mchango, riba ya mikopo na faini zinasimamiwa hapa na kutumika moja kwa moja kwenye hesabu.</p>
                    {constitution && Object.keys(constitution).length > 0 ? (
                      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: 'var(--bg)', padding: 10, borderRadius: 8 }}>{JSON.stringify(constitution, null, 2)}</pre>
                    ) : <p className="roles-tag">{t('vicoba.no_docs')}</p>}
                    <div className="inline-actions" style={{ marginTop: 10 }}>
                      <button className="btn ghost" onClick={printDocs}>{t('vicoba.view_doc')}</button>
                    </div>
                  </div>
                </div>
              )}

              {govTab === 'resolutions' && (
                <div>
                  <div className="card">
                    <h3 style={{ marginTop: 0 }}>{t('gov.resolutions')}</h3>
                    {gResolutions.length === 0 && <p className="roles-tag">{t('gov.no_resolutions')}</p>}
                    {gResolutions.map((r) => (
                      <div key={r.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                        <div className="inline-actions" style={{ justifyContent: 'space-between' }}>
                          <div>
                            <strong>{r.resolution_number || `#${r.id}`} · {r.title}</strong>
                            <div className="roles-tag">{r.body}</div>
                          </div>
                          <StatusBadge status={r.status} />
                        </div>
                        {r.financial_amount != null && <div className="roles-tag">{r.financial_action_type || 'FINANCIAL'} · {formatMoney(r.financial_amount)}</div>}
                        {r.financial_action_type && isLeader && (
                          <div className="inline-actions" style={{ marginTop: 6 }}>
                            <button className="btn ghost" onClick={() => createExecution(r.id, r.financial_amount)}>{t('gov.register_exec')}</button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="card">
                    <h3 style={{ marginTop: 0 }}>{t('gov.executions')}</h3>
                    {gExecutions.length === 0 && <p className="roles-tag">{t('gov.no_executions')}</p>}
                    {gExecutions.map((x) => (
                      <div key={x.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                        <div className="inline-actions" style={{ justifyContent: 'space-between' }}>
                          <div>
                            <strong>{x.resolution_title || `#${x.resolution_id}`}</strong>
                            <div className="roles-tag">{x.financial_action_type} · {formatMoney(x.amount)} · {t('gov.target')}: {x.target_entity_type || '—'}</div>
                            {x.ledger_reference && <div className="roles-tag">{t('gov.ledger_ref')}: {x.ledger_reference}</div>}
                          </div>
                          <StatusBadge status={x.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {govTab === 'actions' && (
                <div className="card">
                  <h3 style={{ marginTop: 0 }}>{t('gov.action')}</h3>
                  {gActions.length === 0 && <p className="roles-tag">{t('gov.no_actions')}</p>}
                  {gActions.map((a) => (
                    <div key={a.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                      <div className="inline-actions" style={{ justifyContent: 'space-between' }}>
                        <div>
                          <strong>{a.task}</strong>
                          <div className="roles-tag">{a.role_or_member || a.full_name || ''} · {a.deadline ? new Date(a.deadline).toLocaleDateString() : ''}</div>
                        </div>
                        <StatusBadge status={a.status} />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {govTab === 'analytics' && (
                <div>
                  {gAnalytics ? (
                    <>
                      <div className="grid grid-3">
                        <div className="card stat"><div className="value">{gAnalytics.meetings?.total || 0}</div><div className="label">{t('gov.ana_meetings')}</div></div>
                        <div className="card stat"><div className="value">{gAnalytics.meetings?.completed || 0}</div><div className="label">{t('gov.ana_completed')}</div></div>
                        <div className="card stat"><div className="value">{gAnalytics.meetings?.avgAttendancePercent || 0}%</div><div className="label">{t('gov.ana_attendance')}</div></div>
                      </div>
                      <div className="grid grid-3">
                        <div className="card stat"><div className="value">{gAnalytics.resolutions?.passed || 0}/{gAnalytics.resolutions?.total || 0}</div><div className="label">{t('gov.ana_passed')}</div></div>
                        <div className="card stat"><div className="value">{gAnalytics.resolutions?.passRate || 0}%</div><div className="label">{t('gov.ana_passrate')}</div></div>
                        <div className="card stat"><div className="value">{gAnalytics.resolutions?.avgDecisionHours || 0} h</div><div className="label">{t('gov.ana_decision_time')}</div></div>
                      </div>
                      <div className="grid grid-3">
                        <div className="card stat"><div className="value">{gAnalytics.actionItems?.completed || 0}/{gAnalytics.actionItems?.total || 0}</div><div className="label">{t('gov.ana_done')}</div></div>
                        <div className="card stat"><div className="value">{gAnalytics.actionItems?.open || 0}</div><div className="label">{t('gov.ana_open')}</div></div>
                        <div className="card stat"><div className="value">{gAnalytics.actionItems?.overdue || 0}</div><div className="label">{t('gov.ana_overdue')}</div></div>
                      </div>
                    </>
                  ) : <p className="roles-tag">{t('gov.ana_empty')}</p>}
                </div>
              )}
            </div>
          )}

          {/* ============ DOCUMENTS ============ */}
          {tab === 'docs' && (
            <div>
              <div className="card">
                <h3 style={{ marginTop: 0 }}>{t('vicoba.docs')}</h3>
                <div className="inline-actions" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <button className="btn" onClick={printDocs}>{t('vicoba.view_doc')}</button>
                  <Link to="/dashboard/governance" className="btn ghost" style={{ textDecoration: 'none' }}>{t('vicoba.go_to_governance')}</Link>
                </div>
              </div>
              {isLeader && (
                <details className="card">
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('gov.add_document')}</summary>
                  <form onSubmit={addDoc} style={{ marginTop: 10 }}>
                    <div className="form-row">
                      <div className="field" style={{ flex: 2 }}><label>{t('gov.doc_title')}</label><input value={docForm.title} onChange={(e) => setDocForm({ ...docForm, title: e.target.value })} required /></div>
                      <div className="field" style={{ flex: 1 }}><label>{t('gov.doc_category')}</label>
                        <select value={docForm.category} onChange={(e) => setDocForm({ ...docForm, category: e.target.value })}>
                          {['CONSTITUTION', 'MEMBERS', 'MEETINGS', 'MINUTES', 'RESOLUTIONS', 'FINANCIAL', 'LOANS', 'SOCIAL_FUND', 'POLICIES', 'ANNOUNCEMENTS'].map((c) => <option key={c} value={c}>{t(`gov.cat_${c.toLowerCase()}`)}</option>)}
                        </select>
                      </div>
                      <div className="field" style={{ flex: 1 }}><label>{t('gov.doc_access')}</label>
                        <select value={docForm.access} onChange={(e) => setDocForm({ ...docForm, access: e.target.value })}>
                          <option value="MEMBERS">{t('gov.access_members')}</option>
                          <option value="OFFICERS">{t('gov.access_officers')}</option>
                          <option value="PUBLIC">{t('gov.access_public')}</option>
                        </select>
                      </div>
                    </div>
                    <div className="field" style={{ marginTop: 8 }}><label>{t('gov.doc_body')}</label><textarea style={{ width: '100%', minHeight: 90 }} value={docForm.body} onChange={(e) => setDocForm({ ...docForm, body: e.target.value })} /></div>
                    <button className="btn" type="submit">{t('gov.save')}</button>
                  </form>
                </details>
              )}
              <div className="card section">
                <h3 style={{ marginTop: 0 }}>{t('gov.documents')}</h3>
                {gDocs.length === 0 ? (
                  <p className="roles-tag">{t('vicoba.no_docs')}</p>
                ) : (
                  gDocs.map((d) => (
                    <div key={d.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                      <div className="inline-actions" style={{ justifyContent: 'space-between' }}>
                        <div>
                          <strong>{d.title}</strong>
                          <div className="roles-tag">{d.doc_category} · {new Date(d.created_at).toLocaleDateString()}</div>
                          {d.body && <div className="roles-tag">{String(d.body).slice(0, 180)}{String(d.body).length > 180 ? '…' : ''}</div>}
                        </div>
                        <StatusBadge status={d.access_level} />
                      </div>
                    </div>
                  ))
                )}
              </div>
              {constitution && Object.keys(constitution).length > 0 && (
                <details className="card" style={{ marginTop: 10 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Katiba / Maagizo ya Kikundi</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: 'var(--bg)', padding: 10, borderRadius: 8, marginTop: 8 }}>{JSON.stringify(constitution, null, 2)}</pre>
                </details>
              )}
              {(!constitution || Object.keys(constitution).length === 0) && <p className="roles-tag" style={{ marginTop: 8 }}>{t('vicoba.no_docs')}</p>}
            </div>
          )}

          {/* ============ MEETINGS ============ */}
          {tab === 'meetings' && (
            <div>
              {attendance && Object.keys(attendance).length > 0 && (
                <div className="grid grid-3" style={{ marginBottom: 14 }}>
                  <div className="card stat"><div className="value">{attendance.total_meetings}</div><div className="label">Mikutano</div></div>
                  <div className="card stat"><div className="value">{formatMoney(attendance.total_fines)}</div><div className="label">Faini</div></div>
                  <div className="card stat"><div className="value">{formatMoney(attendance.total_expected_contributions)}</div><div className="label">Michango</div></div>
                </div>
              )}
              {isLeader && (
                <div className="card">
                  <h3 style={{ marginTop: 0 }}>{t('gov.new_meeting')}</h3>
                  <form onSubmit={createMeeting}>
                    <div className="form-row">
                      <div className="field" style={{ flex: 2 }}><label>{t('gov.meeting_title')}</label><input value={meetForm.title} onChange={(e) => setMeetForm({ ...meetForm, title: e.target.value })} required /></div>
                      <div className="field" style={{ flex: 1 }}><label>{t('gov.meeting_date')}</label><input type="datetime-local" value={meetForm.scheduledAt} onChange={(e) => setMeetForm({ ...meetForm, scheduledAt: e.target.value })} /></div>
                    </div>
                    <button className="btn" type="submit">{t('gov.create_meeting')}</button>
                  </form>
                </div>
              )}
              <div className="card section">
                <h3 style={{ marginTop: 0 }}>{t('gov.meetings')}</h3>
                {gMeetings.length === 0 && <p className="roles-tag">{t('gov.no_meetings')}</p>}
                {gMeetings.map((m) => (
                  <div key={m.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                    <div className="inline-actions" style={{ justifyContent: 'space-between' }}>
                      <div>
                        <strong>{m.title}</strong>
                        <div className="roles-tag">{new Date(m.scheduled_at).toLocaleString()} · {m.attended_count}/{m.total_count} {t('gov.present_total')}</div>
                      </div>
                      <div className="inline-actions">
                        <StatusBadge status={m.status} />
                        <button className="btn ghost" onClick={() => toggleAgenda(m.id)}>{expanded === m.id ? t('gov.collapse') : t('gov.expand')}</button>
                        <button className="btn ghost" onClick={() => govRsvp(m.id, 'ACCEPTED')}>{t('gov.rsvp')}</button>
                        <button className="btn ghost" onClick={() => govAttended(m.id)}>{t('gov.mark_attended')}</button>
                      </div>
                    </div>
                    {expanded === m.id && (
                      <div style={{ marginTop: 10, paddingLeft: 8, borderLeft: '2px solid var(--primary)', background: 'var(--bg)', borderRadius: 6, padding: 8 }}>
                        <strong className="roles-tag" style={{ display: 'block', marginBottom: 6 }}>{t('gov.agenda_list')}</strong>
                        {expandedAgenda.length === 0 && <p className="roles-tag">{t('gov.no_agenda')}</p>}
                        {expandedAgenda.map((a) => (
                          <div key={a.id} className="roles-tag" style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '4px 0' }}>
                            <span>{a.position}. {a.title}{a.description ? ` — ${a.description}` : ''}</span>
                            <StatusBadge status={a.status || 'PENDING'} />
                          </div>
                        ))}
                        {isLeader && (
                          <form onSubmit={(e) => addAgenda(e, m.id)} style={{ marginTop: 8 }} className="inline-actions" >
                            <input style={{ flex: 2 }} placeholder={t('gov.agenda_title')} value={agendaForm.title} onChange={(e) => setAgendaForm({ ...agendaForm, title: e.target.value })} required />
                            <input style={{ flex: 2 }} placeholder={t('gov.agenda_desc')} value={agendaForm.description} onChange={(e) => setAgendaForm({ ...agendaForm, description: e.target.value })} />
                            <button className="btn" type="submit">{t('gov.agenda_add')}</button>
                          </form>
                        )}
                        {isLeader && (
                          <details style={{ marginTop: 10 }}>
                            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>{t('gov.ai_minutes')}</summary>
                            <textarea style={{ width: '100%', minHeight: 80, marginTop: 8 }} placeholder={t('gov.transcript_hint')} value={transcriptMap[m.id] || ''} onChange={(e) => setTranscriptMap({ ...transcriptMap, [m.id]: e.target.value })} />
                            <button className="btn" style={{ marginTop: 6 }} disabled={!!govBusy} onClick={() => genMinutes(m.id)}>{t('gov.gen_minutes')}</button>
                          </details>
                        )}
                        <strong className="roles-tag" style={{ display: 'block', marginTop: 12, marginBottom: 6 }}>{t('gov.proposals')}</strong>
                        {expandedProposals.length === 0 && <p className="roles-tag">{t('gov.no_proposals')}</p>}
                        {expandedProposals.map((p) => {
                          const tly = tallyMap[p.id];
                          return (
                            <div key={p.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                              <div className="inline-actions" style={{ justifyContent: 'space-between' }}>
                                <div>
                                  <strong>{p.title}</strong>
                                  <div className="roles-tag">{p.description}</div>
                                </div>
                                <div className="inline-actions">
                                  <StatusBadge status={p.status} />
                                  <button className="btn ghost" onClick={() => castVote(p.id, 'YES')}>{t('gov.vote_yes')}</button>
                                  <button className="btn ghost" onClick={() => castVote(p.id, 'NO')}>{t('gov.vote_no')}</button>
                                  <button className="btn ghost" onClick={() => castVote(p.id, 'ABSTAIN')}>{t('gov.vote_abstain')}</button>
                                </div>
                              </div>
                              {tly && (
                                <div className="roles-tag">{t('gov.vote_yes')} {tly.YES || 0} · {t('gov.vote_no')} {tly.NO || 0} · {t('gov.vote_abstain')} {tly.ABSTAIN || 0}</div>
                              )}
                              {isLeader && (p.status || 'OPEN') === 'OPEN' && (
                                <div className="inline-actions" style={{ marginTop: 6, gap: 8 }}>
                                  <select style={{ flex: 1 }} value={aziMap[p.id]?.type || ''} onChange={(e) => setAziMap({ ...aziMap, [p.id]: { ...(aziMap[p.id] || {}), type: e.target.value } })}>
                                    <option value="">{t('gov.azi_normal')}</option>
                                    <option value="LOAN_APPROVAL">{t('gov.azi_loan')}</option>
                                    <option value="SOCIAL_FUND">{t('gov.azi_social')}</option>
                                    <option value="GENERAL_EXPENSE">{t('gov.azi_expense')}</option>
                                  </select>
                                  <input style={{ flex: 1 }} type="number" min="0" placeholder={t('gov.amount')} value={aziMap[p.id]?.amount || ''} onChange={(e) => setAziMap({ ...aziMap, [p.id]: { ...(aziMap[p.id] || {}), amount: e.target.value } })} />
                                  <button className="btn" onClick={() => promoteResolution(p.id, m.id)}>{t('gov.promote')}</button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                        <form onSubmit={(e) => createProposal(e, m.id)} className="inline-actions" style={{ marginTop: 10 }}>
                          <input style={{ flex: 2 }} placeholder={t('gov.prop_title')} value={propForm.title} onChange={(e) => setPropForm({ ...propForm, title: e.target.value })} required />
                          <input style={{ flex: 2 }} placeholder={t('gov.prop_desc')} value={propForm.description} onChange={(e) => setPropForm({ ...propForm, description: e.target.value })} />
                          <button className="btn" type="submit">{t('gov.prop_create')}</button>
                        </form>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="card">
                <h3 style={{ marginTop: 0 }}>{t('gov.minutes')}</h3>
                {gMinutes.length === 0 && <p className="roles-tag">{t('gov.no_minutes')}</p>}
                {gMinutes.map((mn) => {
                  let draft = {};
                  try { draft = typeof mn.draft === 'string' ? JSON.parse(mn.draft) : (mn.draft || {}); } catch (e) { draft = { draft: mn.draft }; }
                  return (
                    <div key={mn.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                      <div className="inline-actions" style={{ justifyContent: 'space-between' }}>
                        <div>
                          <strong>{draft.title || mn.title}</strong>
                          <div className="roles-tag">{mn.scheduled_at ? new Date(mn.scheduled_at).toLocaleDateString() : ''} · {draft.decisions ? draft.decisions.length : 0} {t('gov.decisions')} · {draft.actionItems ? draft.actionItems.length : 0} {t('gov.actions_count')}</div>
                        </div>
                        <StatusBadge status={mn.status} />
                      </div>
                      {draft.summary && <div className="roles-tag">{draft.summary}</div>}
                    </div>
                  );
                })}
              </div>
              <div className="inline-actions" style={{ marginTop: 14 }}>
                <Link to="/dashboard/governance" className="btn ghost" style={{ textDecoration: 'none' }}>{t('vicoba.go_to_governance')}</Link>
              </div>
            </div>
          )}

          {/* ============ REPORTS ============ */}
          {tab === 'reports' && (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>{t('vicoba.reports_section')}</h3>
              {finReport && Object.keys(finReport).length > 0 && (
                <>
                  <div className="grid grid-3">
                    <div className="card stat"><div className="value">{formatMoney(finReport.total_contributions)}</div><div className="label">Michango (HISARI)</div></div>
                    <div className="card stat"><div className="value">{formatMoney(finReport.total_loans_outstanding)}</div><div className="label">Mikopo Ambayo Bado</div></div>
                    <div className="card stat"><div className="value">{formatMoney(finReport.penalties_collected)}</div><div className="label">Faini Zilizolipwa</div></div>
                  </div>
                  <div className="grid grid-3" style={{ marginTop: 14 }}>
                    <div className="card stat"><div className="value">{formatMoney(finReport.total_loan_repayments || 0)}</div><div className="label">Marejesho</div></div>
                    <div className="card stat"><div className="value">{formatMoney(finReport.total_withdrawals_disbursed || 0)}</div><div className="label">Utoaji wa Hisa</div></div>
                    <div className="card stat"><div className="value">{formatMoney(finReport.social_fund_balance || 0)}</div><div className="label">Mfuko wa Jamii</div></div>
                  </div>
                  <div className="grid grid-3" style={{ marginTop: 14 }}>
                    <div className="card stat"><div className="value">{formatMoney(finReport.total_bonus || 0)}</div><div className="label">Bonus</div></div>
                    <div className="card stat"><div className="value">{formatMoney(finReport.total_profits_distributed || 0)}</div><div className="label">Magawio</div></div>
                    <div className="card stat"><div className="value">{formatMoney(finReport.social_fund_balance || 0)}</div><div className="label">Overall (Fedha)</div></div>
                  </div>
                </>
              )}
              {!finReport || Object.keys(finReport).length === 0 && <p className="roles-tag">{t('vicoba.no_docs')}</p>}
            </div>
          )}
        </>
      )}

      {/* ============ CREATE GROUP MODAL ============ */}
      {showCreate && (
        <div className="bc-modal-backdrop" onClick={() => setShowCreate(false)}>
          <div className="bc-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('vicoba.create_group_modal')}</h3>
            <div className="step-meta">{t('vicoba.step_of')} {createStep}/4 · {createStepTitles[createStep - 1]}</div>

            {createStep === 1 && (
              <form id="step1">
                <div className="field"><label>{t('vicoba.name')} *</label><input value={gName} onChange={(e) => setGName(e.target.value)} required /></div>
                <div className="field"><label>{t('vicoba.group_description')}</label><input value={cDescription} onChange={(e) => setCDescription(e.target.value)} /></div>
                <div className="field"><label>{t('vicoba.group_type')}</label>
                  <select value={cGroupType} onChange={(e) => setCGroupType(e.target.value)}>
                    <option value="STANDARD">Jumuiya ya Kawaida</option>
                    <option value="FARMERS">Jamii ya Wakulima</option>
                    <option value="WOMEN">Kikundi cha Wanawake</option>
                    <option value="YOUTH">Kikundi cha Vijana</option>
                    <option value="BUSINESS">Kikundi cha Biashara</option>
                    <option value="COMMUNITY">Kikundi cha Jamii</option>
                  </select>
                </div>
                <div className="grid grid-2" style={{ gap: 10 }}>
                  <div className="field"><label>{t('vicoba.country')}</label>
                    <select value={cCountry} onChange={(e) => setCCountry(e.target.value)}>
                      <option value="Tanzania">Tanzania</option><option value="Kenya">Kenya</option><option value="Uganda">Uganda</option>
                      <option value="Rwanda">Rwanda</option><option value="Nigeria">Nigeria</option><option value="Ghana">Ghana</option>
                      <option value="South Africa">South Africa</option><option value="Other">Nyingine</option>
                    </select>
                  </div>
                  <div className="field"><label>{t('vicoba.language')}</label>
                    <select value={cLanguage} onChange={(e) => setCLanguage(e.target.value)}>
                      <option value="sw">Kiswahili</option><option value="en">English</option><option value="fr">Français</option>
                    </select>
                  </div>
                </div>
              </form>
            )}

            {createStep === 2 && (
              <div>
                <div className="explain">
                  {t('vicoba.share_def')}<br />{t('vicoba.contribution_def')}<br />{t('vicoba.cycle_def')}
                </div>
                <div className="grid grid-2" style={{ gap: 10 }}>
                  <div className="field"><label>{t('vicoba.cycle')} (Mzunguko)</label>
                    <select value={gCycle} onChange={(e) => setGCycle(e.target.value)}>
                      <option value="WEEKLY">Wiki</option><option value="MONTHLY">Mwezi</option>
                    </select>
                  </div>
                  <div className="field"><label>{t('vicoba.share')} (Thamani ya Hisa) *</label><input type="number" value={gShare} onChange={(e) => setGShare(e.target.value)} required /></div>
                  <div className="field"><label>{t('vicoba.maintenance_fee')}</label><input type="number" value={gFee} onChange={(e) => setGFee(e.target.value)} /></div>
                  <div className="field"><label>{t('vicoba.min_shares')}</label><input type="number" value={cMinShares} onChange={(e) => setCMinShares(e.target.value)} /></div>
                  <div className="field"><label>{t('vicoba.max_shares')}</label><input type="number" value={cMaxShares} onChange={(e) => setCMaxShares(e.target.value)} /></div>
                  <div className="field"><label>{t('vicoba.start_date')}</label><input type="date" value={cStartDate} onChange={(e) => setCStartDate(e.target.value)} /></div>
                </div>
              </div>
            )}

            {createStep === 3 && (
              <div>
                <div className="explain">{t('vicoba.creator_chairman')}</div>
                <div className="field"><label>{t('vicoba.chairman_label')}</label><input value={user.full_name || 'Wewe'} disabled /></div>
                <div className="field"><label>Katibu</label><input value="— 'Kuteuliwa kwenye kikao cha kwanza'" disabled /></div>
                <div className="field"><label>Mweka Hazina</label><input value="— 'Kuteuliwa kwenye kikao cha kwanza'" disabled /></div>
                <p className="roles-tag">Idhini mbili (maker-checker) zimesanidiwa kwa mikopo, uondoaji na mfuko wa jamii.</p>
              </div>
            )}

            {createStep === 4 && (
              <div>
                <p className="roles-tag">{t('vicoba.review_confirm')}</p>
                <div className="bc-subnote" style={{ background: 'var(--bg)', padding: 12, borderRadius: 8 }}>
                  <div><strong>{gName || '—'}</strong></div>
                  <div>{t('vicoba.cycle')}: {CYCLE_LABEL[gCycle] || gCycle}</div>
                  <div>{t('vicoba.share')}: {formatMoney(gShare)}</div>
                  <div>{t('vicoba.maintenance_fee')}: {formatMoney(gFee)}</div>
                  <div>{t('vicoba.group_type')}: {cGroupType} · {t('vicoba.country')}: {cCountry}</div>
                  {cMinShares && <div>{t('vicoba.min_shares')}: {cMinShares}</div>}
                  {cMaxShares && <div>{t('vicoba.max_shares')}: {cMaxShares}</div>}
                  {cStartDate && <div>{t('vicoba.start_date')}: {cStartDate}</div>}
                  {cDescription && <div>{t('vicoba.group_description')}: {cDescription}</div>}
                </div>
              </div>
            )}

            <div className="inline-actions" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn ghost" onClick={() => setShowCreate(false)}>{t('vicoba.mth_cancel')}</button>
              {createStep > 1 && <button className="btn ghost" onClick={prevStep}>{t('vicoba.mth_back')}</button>}
              {createStep < 4 && <button className="btn" onClick={nextStep}>{t('vicoba.mth_next')}</button>}
              {createStep === 4 && <button className="btn" onClick={submitCreate}>{t('vicoba.create_btn')}</button>}
            </div>
          </div>
        </div>
      )}

      {/* ============ JOIN MODAL ============ */}
      {showJoin && (
        <div className="bc-modal-backdrop" onClick={() => setShowJoin(false)}>
          <div className="bc-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('vicoba.join_modal')}</h3>
            <p className="step-meta">Andika msimbo wa kikundi uliopewa na kiongozi wake.</p>
            <form onSubmit={joinByCode}>
              <div className="field"><label>{t('vicoba.join_code_prompt')}</label><input value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="e.g. C9C9BDE7" required /></div>
              <div className="inline-actions" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
                <button className="btn ghost" type="button" onClick={() => setShowJoin(false)}>{t('vicoba.mth_cancel')}</button>
                <button className="btn" type="submit">{t('vicoba.join_btn')}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </ServiceLock>
  );
}