import React from 'react';

export function formatMoney(n, currency) {
  const cur = currency || 'TZS';
  const val = Number(n || 0);
  return `${cur} ${val.toLocaleString('en-US')}`;
}

export function StatusBadge({ status }) {
  const s = String(status || '').toUpperCase();
  const cls = [
    'SUCCESS', 'VERIFIED_ACTIVE', 'ACTIVE', 'DISBURSED', 'PASSED', 'RELEASED',
    'CONFIRMED', 'PAID', 'RESOLVED', 'COMPLETED',
  ].includes(s)
    ? 'success'
    : [
      'PENDING', 'WAITING_MEMBERS', 'PENDING_AUDIT', 'LOCKED', 'ESCROW_HELD',
      'OPEN', 'UNDER_REVIEW', 'PARTIAL',
    ].includes(s)
      ? 'pending'
      : ['FAILED', 'REJECTED', 'SKIPPED', 'DEFAULTED', 'CANCELLED'].includes(s)
        ? 'failed'
        : 'info';
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function Loading() {
  return <div className="msg ok">Inapakia...</div>;
}
