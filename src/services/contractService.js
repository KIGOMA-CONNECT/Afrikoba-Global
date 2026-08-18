const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const config = require('../config');
const { formatMoney } = require('../utils/helpers');

const contractDir = path.resolve(process.cwd(), config.contract.dir);
if (!fs.existsSync(contractDir)) {
  fs.mkdirSync(contractDir, { recursive: true });
}

/**
 * Tengeneza Mkataba wa Uwekezaji (PDF) na E-Signature Timestamp
 * @param {Object} opts
 * @param {Object} opts.investor  - { full_name, phone_number, nida_number }
 * @param {Object} opts.project   - { title, sector, description, roi_percentage, tenure_months, payback_start_months }
 * @param {Object} opts.investment - { reference_id, total_amount, shares_bought, share_price }
 * @param {Object} opts.signature  - { ip, timestamp }
 */
function generateInvestmentContract(opts) {
  const { investor, project, investment, signature } = opts;
  const filename = `contract-${investment.reference_id}.pdf`;
  const filePath = path.join(contractDir, filename);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  // Header
  doc.fontSize(18).fillColor('#0B5D1E').text('AFRIKOBA GLOBAL', { align: 'center' });
  doc.fontSize(12).fillColor('#333').text('Mkataba wa Uwekezaji (Investment Contract)', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(9).fillColor('#888').text(`Ref: ${investment.reference_id}`, { align: 'center' });
  doc.moveDown();

  doc.fontSize(11).fillColor('#111');
  doc.text('SEHEMU YA 1: VYAMA VYA MKATABA', { underline: true });
  doc.moveDown(0.3);
  doc.text(`Mwekezaji (Investor): ${investor.full_name}`);
  doc.text(`Namba ya Simu: ${investor.phone_number}`);
  doc.text(`NIDA: ${investor.nida_number || 'Sijabainisha (N/A)'}`);
  doc.moveDown(0.5);
  doc.text(`Mradi (Project): ${project.title}`);
  doc.text(`Sekta: ${project.sector}`);
  doc.text(`Maelezo: ${project.description}`);
  doc.moveDown();

  doc.text('SEHEMU YA 2: MASHARTI YA UWEKEZAJI', { underline: true });
  doc.moveDown(0.3);
  doc.text(`Bei ya Hisa (Share Price): ${formatMoney(investment.share_price)}`);
  doc.text(`Idadi ya Hisa: ${investment.shares_bought}`);
  doc.text(`Jumla ya Uwekezaji: ${formatMoney(investment.total_amount)}`);
  doc.text(`Faida (ROI): ${project.roi_percentage}%`);
  doc.text(`Muda wa Mkataba (Tenure): ${project.tenure_months} miezi`);
  doc.text(`Faida huanza kurudishwa baada ya: ${project.payback_start_months} miezi`);
  doc.moveDown();

  doc.text('SEHEMU YA 3: ULINZI WA MTAJI (CAPITAL PROTECTION)', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10);
  doc.text(
    '1. Fedha za mwekezaji zinalindwa ndani ya Escrow Account na kutolewa kwa awamu (Milestones) tu pale ushahidi wa utekelezaji utakapoonekana.',
    { width: 490 }
  );
  doc.text(
    '2. Mwekezaji anapokea taarifa ya kila muamala kupitia SMS na mfumo wa reconciliation wa kiotomatiki.',
    { width: 490 }
  );
  doc.text(
    '3. Afrikoba Global inahifadhi haki ya kumsimamisha mradi (Default) kama mjasiriamali atakipata kipimo cha uwazi wa fedha.',
    { width: 490 }
  );
  doc.moveDown();

  doc.text('SEHEMU YA 4: E-SIGNATURE YA KIDIGITALI', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#444');
  doc.text(`Mwekezaji alithibitisha uwekezaji kwa PIN/OTP tarehe: ${signature.timestamp.toLocaleString('en-GB')}`);
  doc.text(`IP Address: ${signature.ip}`);
  doc.text(`Namba ya Simu iliyothibitisha: ${investor.phone_number}`);
  doc.text(`NIDA ya Mwekezaji: ${investor.nida_number || 'N/A'}`);
  doc.moveDown();
  doc.text('Hii ni sahihi ya kidijitali inayotambulika kisheria (Digital Signature Timestamp).', { italics: true });

  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', () => {
      const url = `${config.contract.baseUrl}/${filename}`;
      resolve({ url, filePath });
    });
    stream.on('error', reject);
  });
}

module.exports = { generateInvestmentContract };
