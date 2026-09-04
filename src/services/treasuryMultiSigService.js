/**
 * Multi-Signature Treasury Service
 * Implements N-of-M multi-signature approvals for institutional and treasury funds.
 */

const pool = require('../config/db');
const fin = require('./financialEngine');
const { generateReference } = require('../utils/helpers');
const { logAudit } = require('./auditService');

async function createProposal(proposerId, { walletId, recipientPhone, amount, description }) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const walletRes = await client.query('SELECT * FROM treasury_wallets WHERE id = $1 FOR UPDATE', [walletId]);
    if (walletRes.rows.length === 0) throw Object.assign(new Error('Mkoba wa hazina haupatikani.'), { statusCode: 404 });
    const wallet = walletRes.rows[0];

    if (Number(wallet.balance) < amountNum) {
      throw Object.assign(new Error('Salio la mkoba wa hazina halitoshi.'), { statusCode: 400 });
    }

    const propRes = await client.query(
      `INSERT INTO treasury_proposals (wallet_id, proposer_id, recipient_phone, amount, description)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [walletId, proposerId, recipientPhone, amountNum, description || null]
    );
    const proposal = propRes.rows[0];

    // Automatically sign by proposer
    await client.query(
      `INSERT INTO treasury_signatures (proposal_id, signer_id, signature_status)
       VALUES ($1, $2, 'APPROVED') ON CONFLICT (proposal_id, signer_id) DO NOTHING`,
      [proposal.id, proposerId]
    );

    await client.query('COMMIT');
    return { success: true, proposal };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function signProposal(signerId, proposalId, approve = true) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const propRes = await client.query('SELECT p.*, w.required_signatures FROM treasury_proposals p JOIN treasury_wallets w ON p.wallet_id = w.id WHERE p.id = $1 FOR UPDATE', [proposalId]);
    if (propRes.rows.length === 0) throw Object.assign(new Error('Pendekezo halipatikani.'), { statusCode: 404 });
    const prop = propRes.rows[0];

    if (prop.status !== 'PENDING') throw Object.assign(new Error('Pendekezo hili limeshakamilika.'), { statusCode: 400 });
    if (prop.proposer_id === signerId) throw Object.assign(new Error('Mpendekeza hawezi kujisainia mwenyewe.'), { statusCode: 400 });

    await client.query(
      `INSERT INTO treasury_signatures (proposal_id, signer_id, signature_status)
       VALUES ($1, $2, $3)
       ON CONFLICT (proposal_id, signer_id) DO UPDATE SET signature_status = EXCLUDED.signature_status`,
      [proposalId, signerId, approve ? 'APPROVED' : 'REJECTED']
    );

    if (!approve) {
      await client.query(`UPDATE treasury_proposals SET status = 'REJECTED' WHERE id = $1`, [proposalId]);
      await client.query('COMMIT');
      return { success: true, status: 'REJECTED' };
    }

    // Count signatures
    const sigCount = await client.query(
      `SELECT COUNT(*)::int AS count FROM treasury_signatures WHERE proposal_id = $1 AND signature_status = 'APPROVED'`,
      [proposalId]
    );

    const approvedCount = sigCount.rows[0].count;
    let executed = false;

    if (approvedCount >= prop.required_signatures) {
      // Execute treasury transfer
      const referenceId = generateReference('TSG');
      await client.query(`UPDATE treasury_wallets SET balance = balance - $1 WHERE id = $2`, [prop.amount, prop.wallet_id]);
      await client.query(`UPDATE treasury_proposals SET status = 'EXECUTED' WHERE id = $1`, [proposalId]);
      executed = true;

      await logAudit({
        eventType: 'TREASURY_MULTISIG_EXECUTE',
        action: 'EXECUTE',
        entityType: 'TREASURY_PROPOSAL',
        userId: signerId,
        referenceId,
        amount: Number(prop.amount),
        afterData: { proposal_id: proposalId, signatures: approvedCount }
      }).catch(() => {});
    }

    await client.query('COMMIT');
    return { success: true, approvedSignatures: approvedCount, required: prop.required_signatures, executed };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function listProposals(walletId) {
  const res = await pool.query(
    `SELECT p.*, u.full_name AS proposer_name,
            (SELECT COUNT(*)::int FROM treasury_signatures s WHERE s.proposal_id = p.id AND s.signature_status = 'APPROVED') AS approvals_count
     FROM treasury_proposals p JOIN users u ON p.proposer_id = u.id
     WHERE p.wallet_id = $1 ORDER BY p.created_at DESC`,
    [walletId]
  );
  return res.rows;
}

module.exports = { createProposal, signProposal, listProposals };
