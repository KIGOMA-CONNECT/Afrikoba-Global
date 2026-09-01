const pool = require('../config/db');
const fin = require('../services/financialEngine');
const logger = require('../utils/logger');

const sessions = new Map();

function getOrCreateSession(sessionId, phoneNumber) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      phoneNumber,
      step: 'MAIN_MENU',
      data: {},
      createdAt: Date.now(),
    });
  }
  return sessions.get(sessionId);
}

function clearSession(sessionId) {
  sessions.delete(sessionId);
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > 180000) {
      sessions.delete(id);
    }
  }
}

setInterval(cleanupExpiredSessions, 60000);

function formatMoney(amount) {
  return Number(amount).toLocaleString('en-US', { minimumFractionDigits: 0 });
}

async function handleUssd(sessionId, phoneNumber, text) {
  const session = getOrCreateSession(sessionId, phoneNumber);
  const parts = (text || '').split('*');
  const input = parts[parts.length - 1].trim();
  const menuPath = parts.slice(0, -1).join('*');

  const user = await pool.query(
    `SELECT id, full_name, wallet_balance, kyc_level FROM users WHERE phone_number = $1`,
    [phoneNumber]
  );
  if (user.rows.length === 0) {
    clearSession(sessionId);
    return { response: 'Karibu Afrikoba Global!\nHujajiungana na mfumo.\nTafadhali jisajili kupitia app kwanza.\n\nTafadhali pekee.', end: true };
  }
  const u = user.rows[0];

  if (input === '') {
    session.step = 'MAIN_MENU';
    return {
      response: `Karibu ${u.full_name}!\nAfrikoba Global\n\n1. Salio la Pochi\n2. Kuhamisha Pochi\n3. VICOBA\n4. Upatu (ROSCA)\n5. Uwekezaji (P2P)\n6. Msaada`,
      end: false,
    };
  }

  switch (session.step) {
    case 'MAIN_MENU':
      switch (input) {
        case '1': {
          const bal = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [u.id]);
          clearSession(sessionId);
          return {
            response: `Salio la Pochi: TZS ${formatMoney(bal.rows[0].wallet_balance)}\n\nAsante, ${u.full_name}.\nPekee kupata HUDUMA zaidi.`,
            end: true,
          };
        }
        case '2': {
          session.step = 'TRANSFER_PHONE';
          return { response: 'Weka nambari ya simu ya mpokeaji:\n(mfano: 255712345678)', end: false };
        }
        case '3': {
          const vicoba = await pool.query(
            `SELECT vm.group_id, vg.group_name FROM vicoba_members vm
             JOIN vicoba_groups vg ON vg.id = vm.group_id
             WHERE vm.user_id = $1`,
            [u.id]
          );
          if (vicoba.rows.length === 0) {
            clearSession(sessionId);
            return { response: 'Huna kikundi cha VICOBA.\nJiunge kupitia app.', end: true };
          }
          session.step = 'VICOBA_MENU';
          session.data.groups = vicoba.rows;
          let msg = 'VICOBA - Vikundi vyako:\n\n';
          vicoba.rows.forEach((g, i) => { msg += `${i + 1}. ${g.group_name}\n`; });
          msg += '\n0. Rudi';
          return { response: msg, end: false };
        }
        case '4': {
          const rosca = await pool.query(
            `SELECT rm.pool_id, rp.pool_name, rp.contribution_amount FROM rosca_members rm
             JOIN rosca_pools rp ON rp.id = rm.pool_id
             WHERE rm.user_id = $1`,
            [u.id]
          );
          if (rosca.rows.length === 0) {
            clearSession(sessionId);
            return { response: 'Huna upatu (ROSCA).\nJiunge kupitia app.', end: true };
          }
          session.step = 'ROSCA_MENU';
          session.data.pools = rosca.rows;
          let msg = 'UPATU - Upatu zako:\n\n';
          rosca.rows.forEach((p, i) => { msg += `${i + 1}. ${p.pool_name}\n   Mchango: TZS ${formatMoney(p.contribution_amount)}\n`; });
          msg += '\n0. Rudi';
          return { response: msg, end: false };
        }
        case '5': {
          const projects = await pool.query(
            `SELECT title, sector, roi_percentage FROM investment_projects WHERE status = 'ACTIVE' LIMIT 5`
          );
          if (projects.rows.length === 0) {
            clearSession(sessionId);
            return { response: 'Hakuna miradi sasa.\nTazama kupitia app.', end: true };
          }
          let msg = 'UWEKEZAJI - Miradi Available:\n\n';
          projects.rows.forEach((p, i) => { msg += `${i + 1}. ${p.title}\n   Sekta: ${p.sector} | ROI: ${p.roi_percentage}%\n`; });
          msg += '\nIli kuwekeza, tumia app.';
          clearSession(sessionId);
          return { response: msg, end: true };
        }
        case '6': {
          clearSession(sessionId);
          return {
            response: 'MSAADA\n\n1. Piga: +255712000001\n2. Email: support@afrikoba.com\n\nAfrikoba Global - Uchumi wa Kidijitali.',
            end: true,
          };
        }
        default:
          return { response: 'Chaguo si sahihi.\n\n1. Salio la Pochi\n2. Kuhamisha Pochi\n3. VICOBA\n4. Upatu\n5. Uwekezaji\n6. Msaada', end: false };
      }

    case 'TRANSFER_PHONE': {
      if (input === '0') {
        session.step = 'MAIN_MENU';
        return { response: '1. Salio la Pochi\n2. Kuhamisha Pochi\n3. VICOBA\n4. Upatu\n5. Uwekezaji\n6. Msaada', end: false };
      }
      const phoneRegex = /^255\d{9}$/;
      if (!phoneRegex.test(input)) {
        return { response: 'Nambari ya simu si sahihi.\nWeka kwa mfano: 255712345678\n\n0. Rudi', end: false };
      }
      const target = await pool.query('SELECT id, full_name FROM users WHERE phone_number = $1', [input]);
      if (target.rows.length === 0) {
        return { response: 'Simu hii haijapatikana mfumoni.\nWeka nambari nyingine:\n\n0. Rudi', end: false };
      }
      session.data.toUserId = target.rows[0].id;
      session.data.toUserName = target.rows[0].full_name;
      session.step = 'TRANSFER_AMOUNT';
      return { response: `Kuhamisha kwa: ${target.rows[0].full_name}\nWeka kiasi (TZS):\n\n0. Rudi`, end: false };
    }

    case 'TRANSFER_AMOUNT': {
      if (input === '0') {
        session.step = 'MAIN_MENU';
        return { response: '1. Salio la Pochi\n2. Kuhamisha Pochi\n3. VICOBA\n4. Upatu\n5. Uwekezaji\n6. Msaada', end: false };
      }
      const amount = parseFloat(input);
      if (isNaN(amount) || amount <= 0) {
        return { response: 'Kiasi si sahihi.\nWeka nambari:\n\n0. Rudi', end: false };
      }
      session.data.amount = amount;
      session.step = 'TRANSFER_CONFIRM';
      return {
        response: `Thibitisha kuhamisha:\nTZS ${formatMoney(amount)}\nKwa: ${session.data.toUserName}\n\n1. Ndiyo\n2. Hapana`,
        end: false,
      };
    }

    case 'TRANSFER_CONFIRM': {
      if (input === '1') {
        try {
          const pool2 = require('../config/db');
          const client = await pool2.connect();
          try {
            await client.query('BEGIN');
            const sender = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [u.id]);
            if (Number(sender.rows[0].wallet_balance) < session.data.amount) {
              await client.query('ROLLBACK');
              clearSession(sessionId);
              return { response: `Salio haletoshi.\nSalio: TZS ${formatMoney(sender.rows[0].wallet_balance)}\nUmehitaji: TZS ${formatMoney(session.data.amount)}\n\n1. Salio\n2. Kuhamisha\n3. VICOBA\n4. Upatu\n5. Uwekezaji\n6. Msaada`, end: false };
            }

            const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
            let ref = 'USSD-';
            for (let i = 0; i < 8; i++) ref += chars[Math.floor(Math.random() * chars.length)];

            await fin.internalTransfer({ client, fromUserId: u.id, toUserId: session.data.toUserId, amount: session.data.amount, reference: ref, description: 'USSD Transfer' });

            await client.query(
              `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
               VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'TRANSFER', $4)`,
              [ref, u.id, session.data.amount, JSON.stringify({ to_user_id: session.data.toUserId, via: 'USSD' })]
            );

            await client.query(
              `INSERT INTO wallet_ledger (reference_id, from_user_id, to_user_id, amount, description)
               VALUES ($1, $2, $3, $4, 'USSD Transfer')`,
              [ref, u.id, session.data.toUserId, session.data.amount]
            );

            await client.query('COMMIT');
            clearSession(sessionId);
            return {
              response: `Uhamisho umefanikiwa!\nKiasi: TZS ${formatMoney(session.data.amount)}\nKwa: ${session.data.toUserName}\nRef: ${ref}\n\n1. Salio\n2. Kuhamisha\n3. VICOBA\n4. Upatu\n5. Uwekezaji\n6. Msaada`,
              end: false,
            };
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
          } finally {
            client.release();
          }
        } catch (err) {
          logger.error('USSD', `Transfer failed: ${err.message}`);
          clearSession(sessionId);
          return { response: 'Hitilafu imetokea.\nTafadhali jaribu tena.', end: true };
        }
      } else {
        session.step = 'MAIN_MENU';
        return { response: '1. Salio la Pochi\n2. Kuhamisha Pochi\n3. VICOBA\n4. Upatu\n5. Uwekezaji\n6. Msaada', end: false };
      }
    }

    case 'VICOBA_MENU': {
      if (input === '0') {
        session.step = 'MAIN_MENU';
        return { response: '1. Salio la Pochi\n2. Kuhamisha Pochi\n3. VICOBA\n4. Upatu\n5. Uwekezaji\n6. Msaada', end: false };
      }
      const idx = parseInt(input, 10) - 1;
      const groups = session.data.groups;
      if (isNaN(idx) || idx < 0 || idx >= groups.length) {
        return { response: 'Chaguo si sahihi.\n\n' + groups.map((g, i) => `${i + 1}. ${g.group_name}`).join('\n') + '\n\n0. Rudi', end: false };
      }
      const group = groups[idx];
      const details = await pool.query(
        `SELECT * FROM vicoba_groups WHERE id = $1`, [group.group_id]
      );
      const member = await pool.query(
        `SELECT total_shares, contribution_balance FROM vicoba_members WHERE group_id = $1 AND user_id = $2`,
        [group.group_id, u.id]
      );
      const g = details.rows[0];
      const m = member.rows[0];
      clearSession(sessionId);
      return {
        response: `${g.group_name}\nMchango: TZS ${formatMoney(g.share_value)}\nMuda: ${g.cycle_type}\nSalio la Kikundi: TZS ${formatMoney(g.group_wallet_balance)}\nHisa zako: ${m.total_shares}\nSalio la Mchango: TZS ${formatMoney(m.contribution_balance)}\n\n1. Salio\n2. Kuhamisha\n3. VICOBA\n4. Upatu\n5. Uwekezaji\n6. Msaada`,
        end: false,
      };
    }

    case 'ROSCA_MENU': {
      if (input === '0') {
        session.step = 'MAIN_MENU';
        return { response: '1. Salio la Pochi\n2. Kuhamisha Pochi\n3. VICOBA\n4. Upatu\n5. Uwekezaji\n6. Msaada', end: false };
      }
      const idx = parseInt(input, 10) - 1;
      const pools = session.data.pools;
      if (isNaN(idx) || idx < 0 || idx >= pools.length) {
        return { response: 'Chaguo si sahihi.\n\n' + pools.map((p, i) => `${i + 1}. ${p.pool_name}`).join('\n') + '\n\n0. Rudi', end: false };
      }
      const poolData = pools[idx];
      const details = await pool.query(
        `SELECT rp.*, rm.assigned_queue_number, rm.has_received_payout, rm.received_payout_amount
         FROM rosca_pools rp
         JOIN rosca_members rm ON rm.pool_id = rp.id
         WHERE rp.id = $1 AND rm.user_id = $2`,
        [poolData.pool_id, u.id]
      );
      const p = details.rows[0];
      clearSession(sessionId);
      return {
        response: `${p.pool_name}\nMchango: TZS ${formatMoney(p.contribution_amount)}\nMzunguko: ${p.cycle_frequency}\nHali: ${p.status}\nMzunguko wa sasa: ${p.current_cycle}/${p.total_members}\nNamba yako: ${p.assigned_queue_number}\nUmepokea?: ${p.has_received_payout ? 'Ndiyo - TZS ' + formatMoney(p.received_payout_amount) : 'Hapana'}\n\n1. Salio\n2. Kuhamisha\n3. VICOBA\n4. Upatu\n5. Uwekezaji\n6. Msaada`,
        end: false,
      };
    }

    default:
      session.step = 'MAIN_MENU';
      return {
        response: `Karibu ${u.full_name}!\nAfrikoba Global\n\n1. Salio la Pochi\n2. Kuhamisha Pochi\n3. VICOBA\n4. Upatu (ROSCA)\n5. Uwekezaji (P2P)\n6. Msaada`,
        end: false,
      };
  }
}

module.exports = { handleUssd };
