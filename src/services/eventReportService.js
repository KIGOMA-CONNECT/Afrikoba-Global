const PDFDocument = require('pdfkit');
const eventService = require('./eventService');
const { formatMoney } = require('../utils/helpers');

function money(v) {
  return formatMoney(v);
}

function sectionHeader(doc, text) {
  doc.moveDown(0.4);
  doc.fontSize(11).fillColor('#0B5D1E').text(text, { underline: true });
  doc.moveDown(0.2);
}

function row(doc, label, value) {
  doc.fontSize(9).fillColor('#333');
  doc.text(`${label}: ${value}`);
}

/**
 * Tengeneza PDF report ya tukio kwa streaming (returned doc inapaswa kupiped kwa HTTP response).
 */
async function renderEventReportPdf(eventId) {
  const report = await eventService.getEventReport(eventId);
  const { event, summary } = report;
  const doc = new PDFDocument({ size: 'A4', margin: 40 });

  // Header
  doc.fontSize(18).fillColor('#0B5D1E').text('AFRIKOBA GLOBAL', { align: 'center' });
  doc.fontSize(12).fillColor('#333').text('Ripoti ya Tukio (Event Report)', { align: 'center', marginBottom: 2 });
  doc.fontSize(9).fillColor('#888').text(`#${event.id} — ${event.name}`, { align: 'center' });
  doc.moveDown(0.6);

  sectionHeader(doc, 'Maelezo (Event)');
  row(doc, 'Jina/Tarehe', `${event.name} — ${event.eventDate || '-'}`);
  row(doc, 'Aina / Hali', `${event.eventType} / ${event.status}`);
  row(doc, 'Mmiliki', event.ownerName || '-');
  row(doc, 'Maelezo', event.description || '-');
  row(doc, 'Lengo (Target)', money(event.targetAmount));

  sectionHeader(doc, 'Muhtasari (Summary)');
  row(doc, 'Zilizokusanywa (Fundraising)', money(summary.collected.fundraising));
  row(doc, 'Akiba (Savings)', money(summary.collected.savings));
  row(doc, 'Jumla ya Michango', money(summary.collected.total));
  row(doc, 'Baki', money(summary.remaining));
  row(doc, 'Maendeleo', `${summary.progress}%`);
  row(doc, 'Bajeti (Jumla)', money(summary.budgetTotal));
  row(doc, 'Ufunikwaji wa Bajeti', `${summary.budgetCoverage}%`);
  row(doc, 'Michango / Wachangiaji', `${summary.donations} / ${summary.contributors}`);
  row(doc, 'Wanachama Amilifu', summary.activeMembers);

  sectionHeader(doc, 'Michango (Contributions)');
  if (report.contributions.length === 0) {
    doc.fontSize(9).fillColor('#888').text('Hakuna michango.');
  } else {
    report.contributions.forEach((c) => {
      const date = c.created_at ? new Date(c.created_at).toLocaleDateString('en-GB') : '';
      row(doc, `#${c.id}`, `${c.contributor} — ${c.mode} — ${money(c.amount)} — ${c.status} — ${date}`);
    });
  }

  sectionHeader(doc, 'Wanachama (Members)');
  report.members.forEach((m) => {
    row(doc, m.user_name, `${m.role} — ${money(m.contributed)}`);
  });

  sectionHeader(doc, 'Bajeti (Budget)');
  report.budget.forEach((b) => {
    row(doc, b.category, `${b.description || '-'} — ${money(b.amount)}`);
  });

  sectionHeader(doc, 'Uondoaji (Withdrawals)');
  if (report.withdrawals.length === 0) {
    doc.fontSize(9).fillColor('#888').text('Hakuna uondoaji.');
  } else {
    report.withdrawals.forEach((w) => {
      row(doc, w.mode, `${w.recipient || '-'} — ${money(w.amount)} — ${w.status}${w.requires_approval ? ' (4-eyes)' : ''}`);
    });
  }

  sectionHeader(doc, 'Ahadi (Commitments)');
  report.commitments.forEach((c) => {
    row(doc, c.user_name, `${money(c.amount)} — fulfilled ${money(c.fulfilled)} — ${c.status}`);
  });

  doc.moveDown(1);
  doc.fontSize(8).fillColor('#888').text('Imetolewa na Afrikoba Global — ripoti ya kumbukumbu pekee. Hakiki takwimu kwenye app.', { align: 'center' });

  return doc;
}

module.exports = { renderEventReportPdf };