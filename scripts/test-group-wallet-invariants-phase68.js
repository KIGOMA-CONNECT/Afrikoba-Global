'use strict';

const { Pool } = require('pg');
const fin = require('../src/services/financialEngine');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5436),
  user: process.env.DB_USER || 'afrikoba_r',
  password: process.env.DB_PASSWORD || 'afrikoba_ro_strong',
  database: process.env.DB_NAME || 'afrikoba_global',
  max: 20,
});

let passed = 0;
let failed = 0;
const failures = [];

function section(name) {
  console.log(`\n=== ${name} ===`);
}

function expect(condition, label, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.error(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`);
  }
}

function REF(prefix = 'P68-GW') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function q(sql, params = []) {
  return pool.query(sql, params);
}

async function balances(userId, familyId) {
  const [u, f] = await Promise.all([
    q(`SELECT wallet_balance, locked_balance FROM users WHERE id = $1`, [userId]),
    q(`SELECT balance FROM family_wallets WHERE id = $1`, [familyId]),
  ]);

  return {
    wallet: Number(u.rows[0]?.wallet_balance ?? 0),
    locked: Number(u.rows[0]?.locked_balance ?? 0),
    family: Number(f.rows[0]?.balance ?? 0),
  };
}

async function journalFor(ref) {
  const r = await q(`
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM(CASE WHEN direction = 'DR' THEN amount ELSE 0 END), 0) AS dr,
           COALESCE(SUM(CASE WHEN direction = 'CR' THEN amount ELSE 0 END), 0) AS cr
    FROM journal_entries
    WHERE reference_id = $1
  `, [ref]);

  const n = Number(r.rows[0].n);
  const dr = Number(r.rows[0].dr);
  const cr = Number(r.rows[0].cr);

  return {
    n,
    dr,
    cr,
    balanced: n === 2 && dr === cr,
  };
}

async function opsFor(ref) {
  const r = await q(`
    SELECT id, operation_type, reference_id, user_id, amount, status
    FROM financial_operations
    WHERE reference_id = $1
    ORDER BY id
  `, [ref]);

  return r.rows;
}

async function auditFor(ref) {
  const r = await q(`
    SELECT id, account_kind, account_id, operation, amount,
           balance_before, balance_after, reference_id, actor
    FROM financial_audit_log
    WHERE reference_id = $1
    ORDER BY id
  `, [ref]);

  return r.rows;
}

async function makeUser(walletBalance) {
  const phone = `P68${Date.now()}${Math.floor(Math.random() * 100000)}`.slice(-15);

  const r = await q(`
    INSERT INTO users (
      full_name,
      phone_number,
      wallet_balance,
      locked_balance
    )
    VALUES ($1, $2, $3, 0)
    RETURNING id
  `, [
    `P68 Test User ${phone}`,
    phone,
    walletBalance,
  ]);

  return r.rows[0].id;
}

async function makeFamily(balance, createdBy) {
  const r = await q(`
    INSERT INTO family_wallets (
      name,
      created_by,
      currency,
      balance,
      description
    )
    VALUES ($1, $2, 'TZS', $3, $4)
    RETURNING id
  `, [
    `P68 Test Family ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdBy,
    balance,
    'Phase 68 group-wallet invariant test',
  ]);

  return r.rows[0].id;
}

async function cleanup(userIds, familyIds, references) {
  if (references.length) {
    await q(
      `DELETE FROM journal_entries
       WHERE reference_id = ANY($1::text[])`,
      [references]
    );

    await q(
      `DELETE FROM financial_audit_log
       WHERE reference_id = ANY($1::text[])`,
      [references]
    );

    await q(
      `DELETE FROM financial_operations
       WHERE reference_id = ANY($1::text[])`,
      [references]
    );
  }

  if (familyIds.length) {
    await q(
      `DELETE FROM family_wallets
       WHERE id = ANY($1::int[])`,
      [familyIds]
    );
  }

  if (userIds.length) {
    await q(
      `DELETE FROM users
       WHERE id = ANY($1::int[])`,
      [userIds]
    );
  }
}

async function inTx(fn) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

(async () => {
  const users = [];
  const families = [];
  const references = [];

  try {
    section('P68 PREFLIGHT');

    const accounts = await q(`
      SELECT account_code
      FROM ledger_accounts
      WHERE account_code IN ('CUSTOMER_WALLET', 'FAMILY_WALLET')
      ORDER BY account_code
    `);

    expect(
      accounts.rows.length === 2,
      'CUSTOMER_WALLET and FAMILY_WALLET ledger accounts exist',
      JSON.stringify(accounts.rows)
    );

    // -----------------------------------------------------------------------
    // G1: walletToGroup happy path
    // -----------------------------------------------------------------------
    section('G1 walletToGroup happy path');

    {
      const uid = await makeUser(100000);
      const fid = await makeFamily(10000, uid);
      users.push(uid);
      families.push(fid);

      const ref = REF('P68-G1');
      references.push(ref);

      const before = await balances(uid, fid);

      const result = await inTx((client) =>
        fin.walletToGroup({
          client,
          userId: uid,
          groupId: fid,
          groupAccount: 'FAMILY_WALLET',
          groupSql: `
            UPDATE family_wallets
            SET balance = balance + $1
            WHERE id = $2
          `,
          amount: 25000,
          reference: ref,
          description: 'P68 wallet to family',
          actor: 'phase68-test',
        })
      );

      const after = await balances(uid, fid);
      const j = await journalFor(ref);
      const ops = await opsFor(ref);
      const aud = await auditFor(ref);

      expect(result && result.success === true, 'G1 operation succeeded');
      expect(
        after.wallet === before.wallet - 25000 &&
        after.family === before.family + 25000,
        'G1 source debit and destination credit are correct',
        JSON.stringify({ before, after })
      );
      expect(j.balanced && j.n === 2, 'G1 journal is balanced with exactly 2 lines', JSON.stringify(j));
      expect(ops.length === 1 && ops[0].status === 'SUCCESS',
        'G1 exactly one SUCCESS operation exists', JSON.stringify(ops));
      expect(aud.length === 1, 'G1 exactly one USER_BALANCE audit row exists', `rows=${aud.length}`);
    }

    // -----------------------------------------------------------------------
    // G2: walletToGroup destination rowCount=0 must rollback source debit
    // -----------------------------------------------------------------------
    section('G2 walletToGroup failed destination projection rolls back source');

    {
      const uid = await makeUser(100000);
      const fid = await makeFamily(10000, uid);
      users.push(uid);
      families.push(fid);

      const ref = REF('P68-G2');
      references.push(ref);
      const before = await balances(uid, fid);

      let threw = null;

      try {
        await inTx((client) =>
          fin.walletToGroup({
            client,
            userId: uid,
            groupId: fid,
            groupAccount: 'FAMILY_WALLET',
            groupSql: `
              UPDATE family_wallets
              SET balance = balance + $1
              WHERE id = $2 AND id = -999999
            `,
            amount: 25000,
            reference: ref,
            description: 'P68 forced destination failure',
            actor: 'phase68-test',
          })
        );
      } catch (e) {
        threw = e;
      }

      const after = await balances(uid, fid);
      const j = await journalFor(ref);
      const ops = await opsFor(ref);
      const aud = await auditFor(ref);

      expect(threw !== null, 'G2 failed destination throws');
      expect(
        after.wallet === before.wallet &&
        after.family === before.family,
        'G2 source debit was rolled back after destination rowCount=0',
        JSON.stringify({ before, after })
      );
      expect(j.n === 0, 'G2 no journal residue', `lines=${j.n}`);
      expect(ops.length === 0, 'G2 operation claim rolled back', `rows=${ops.length}`);
      expect(aud.length === 0, 'G2 no audit residue', `rows=${aud.length}`);
    }

    // -----------------------------------------------------------------------
    // G3: groupToWallet happy path
    // -----------------------------------------------------------------------
    section('G3 groupToWallet happy path');

    {
      const uid = await makeUser(5000);
      const fid = await makeFamily(100000, uid);
      users.push(uid);
      families.push(fid);

      const ref = REF('P68-G3');
      references.push(ref);
      const before = await balances(uid, fid);

      const result = await inTx((client) =>
        fin.groupToWallet({
          client,
          userId: uid,
          groupId: fid,
          groupAccount: 'FAMILY_WALLET',
          groupSql: `
            UPDATE family_wallets
            SET balance = balance - $1
            WHERE id = $2 AND balance >= $1
          `,
          amount: 40000,
          reference: ref,
          description: 'P68 family to wallet',
          actor: 'phase68-test',
        })
      );

      const after = await balances(uid, fid);
      const j = await journalFor(ref);
      const ops = await opsFor(ref);
      const aud = await auditFor(ref);

      expect(result && result.success === true, 'G3 operation succeeded');
      expect(
        after.wallet === before.wallet + 40000 &&
        after.family === before.family - 40000,
        'G3 source debit and wallet credit are correct',
        JSON.stringify({ before, after })
      );
      expect(j.balanced && j.n === 2, 'G3 journal is balanced with exactly 2 lines', JSON.stringify(j));
      expect(ops.length === 1 && ops[0].status === 'SUCCESS',
        'G3 exactly one SUCCESS operation exists', JSON.stringify(ops));
      expect(aud.length === 1, 'G3 exactly one USER_BALANCE audit row exists', `rows=${aud.length}`);
    }

    // -----------------------------------------------------------------------
    // G4: insufficient source must NOT credit wallet
    // -----------------------------------------------------------------------
    section('G4 groupToWallet insufficient source must rollback everything');

    {
      const uid = await makeUser(5000);
      const fid = await makeFamily(10000, uid);
      users.push(uid);
      families.push(fid);

      const ref = REF('P68-G4');
      references.push(ref);
      const before = await balances(uid, fid);

      let threw = null;

      try {
        await inTx((client) =>
          fin.groupToWallet({
            client,
            userId: uid,
            groupId: fid,
            groupAccount: 'FAMILY_WALLET',
            groupSql: `
              UPDATE family_wallets
              SET balance = balance - $1
              WHERE id = $2 AND balance >= $1
            `,
            amount: 20000,
            reference: ref,
            description: 'P68 insufficient family source',
            actor: 'phase68-test',
          })
        );
      } catch (e) {
        threw = e;
      }

      const after = await balances(uid, fid);
      const j = await journalFor(ref);
      const ops = await opsFor(ref);
      const aud = await auditFor(ref);

      expect(threw !== null, 'G4 insufficient source throws');
      expect(
        after.wallet === before.wallet &&
        after.family === before.family,
        'G4 insufficient source caused NO economic movement',
        JSON.stringify({ before, after })
      );
      expect(j.n === 0, 'G4 no journal residue', `lines=${j.n}`);
      expect(ops.length === 0, 'G4 operation claim rolled back', `rows=${ops.length}`);
      expect(aud.length === 0, 'G4 no audit residue', `rows=${aud.length}`);
    }

    // -----------------------------------------------------------------------
    // G5: missing source must NOT credit wallet
    // -----------------------------------------------------------------------
    section('G5 groupToWallet missing source must rollback everything');

    {
      const uid = await makeUser(5000);
      users.push(uid);

      const missingFamilyId = 2147483000;
      const ref = REF('P68-G5');
      references.push(ref);

      const beforeUser = await q(
        `SELECT wallet_balance FROM users WHERE id = $1`,
        [uid]
      );

      let threw = null;

      try {
        await inTx((client) =>
          fin.groupToWallet({
            client,
            userId: uid,
            groupId: missingFamilyId,
            groupAccount: 'FAMILY_WALLET',
            groupSql: `
              UPDATE family_wallets
              SET balance = balance - $1
              WHERE id = $2 AND balance >= $1
            `,
            amount: 20000,
            reference: ref,
            description: 'P68 missing family source',
            actor: 'phase68-test',
          })
        );
      } catch (e) {
        threw = e;
      }

      const afterUser = await q(
        `SELECT wallet_balance FROM users WHERE id = $1`,
        [uid]
      );

      const j = await journalFor(ref);
      const ops = await opsFor(ref);
      const aud = await auditFor(ref);

      expect(threw !== null, 'G5 missing source throws');
      expect(
        Number(afterUser.rows[0].wallet_balance) ===
        Number(beforeUser.rows[0].wallet_balance),
        'G5 missing source did NOT credit destination wallet',
        JSON.stringify({ beforeUser: beforeUser.rows[0], afterUser: afterUser.rows[0] })
      );
      expect(j.n === 0, 'G5 no journal residue', `lines=${j.n}`);
      expect(ops.length === 0, 'G5 operation claim rolled back', `rows=${ops.length}`);
      expect(aud.length === 0, 'G5 no audit residue', `rows=${aud.length}`);
    }

    // -----------------------------------------------------------------------
    // G6: duplicate reference
    // -----------------------------------------------------------------------
    section('G6 duplicate groupToWallet reference has no second economic effect');

    {
      const uid = await makeUser(5000);
      const fid = await makeFamily(100000, uid);
      users.push(uid);
      families.push(fid);

      const ref = REF('P68-G6');
      references.push(ref);

      const first = await inTx((client) =>
        fin.groupToWallet({
          client,
          userId: uid,
          groupId: fid,
          groupAccount: 'FAMILY_WALLET',
          groupSql: `
            UPDATE family_wallets
            SET balance = balance - $1
            WHERE id = $2 AND balance >= $1
          `,
          amount: 30000,
          reference: ref,
          description: 'P68 duplicate test',
          actor: 'phase68-test',
        })
      );

      const after1 = await balances(uid, fid);

      const second = await inTx((client) =>
        fin.groupToWallet({
          client,
          userId: uid,
          groupId: fid,
          groupAccount: 'FAMILY_WALLET',
          groupSql: `
            UPDATE family_wallets
            SET balance = balance - $1
            WHERE id = $2 AND balance >= $1
          `,
          amount: 30000,
          reference: ref,
          description: 'P68 duplicate test retry',
          actor: 'phase68-test',
        })
      );

      const after2 = await balances(uid, fid);
      const j = await journalFor(ref);
      const ops = await opsFor(ref);
      const aud = await auditFor(ref);

      expect(first && first.success === true, 'G6 first call succeeded');
      expect(second && second.dedup === true, 'G6 second call was deduplicated', JSON.stringify(second));
      expect(
        after2.wallet === after1.wallet &&
        after2.family === after1.family,
        'G6 retry created NO second economic effect',
        JSON.stringify({ after1, after2 })
      );
      expect(j.n === 2, 'G6 retry did not add a second journal group', `lines=${j.n}`);
      expect(ops.length === 1, 'G6 exactly one financial_operations row for the reference', `rows=${ops.length}`);
      expect(aud.length === 1, 'G6 retry did not duplicate audit rows', `rows=${aud.length}`);
    }

    // -----------------------------------------------------------------------
    // G7: concurrency
    // -----------------------------------------------------------------------
    section('G7 concurrent groupToWallet withdrawals cannot overdraw source');

    {
      const N = 8;
      const each = 30000;

      // Distinct destination users force all transactions to contend
      // on the same source family row.
      const g7Users = [];

      for (let i = 0; i < N; i++) {
        const uid = await makeUser(0);
        g7Users.push(uid);
        users.push(uid);
      }

      const fid = await makeFamily(100000, g7Users[0]);
      families.push(fid);

      const refs = Array.from(
        { length: N },
        (_, i) => `${REF('P68-G7')}:${i}`
      );

      refs.forEach((ref) => references.push(ref));

      const results = await Promise.allSettled(
        g7Users.map((uid, i) =>
          inTx((client) =>
            fin.groupToWallet({
              client,
              userId: uid,
              groupId: fid,
              groupAccount: 'FAMILY_WALLET',
              groupSql: `
                UPDATE family_wallets
                SET balance = balance - $1
                WHERE id = $2 AND balance >= $1
              `,
              amount: each,
              reference: refs[i],
              description: 'P68 concurrency test',
              actor: 'phase68-test',
            })
          )
        )
      );

      const successCount = results.filter(
        r => r.status === 'fulfilled' && r.value && r.value.success
      ).length;

      const userRows = await Promise.all(
        g7Users.map((uid) =>
          q(
            `SELECT wallet_balance
             FROM users
             WHERE id = $1`,
            [uid]
          )
        )
      );

      const walletBalances = userRows.map(
        r => Number(r.rows[0]?.wallet_balance ?? 0)
      );

      const totalWallet = walletBalances.reduce(
        (sum, value) => sum + value,
        0
      );

      const after = await balances(g7Users[0], fid);

      expect(
        successCount === 3,
        'G7 exactly 3 of 8 x 30,000 withdrawals succeeded from 100,000',
        `success=${successCount}`
      );

      expect(
        after.family === 100000 - (successCount * each),
        'G7 family source equals successful withdrawals only',
        JSON.stringify({ after, successCount })
      );

      expect(
        totalWallet === successCount * each,
        'G7 total wallet credits equal successful withdrawals only',
        JSON.stringify({ walletBalances, totalWallet, successCount })
      );

      expect(
        walletBalances.every(balance => balance === 0 || balance === each),
        'G7 each destination received either 0 or exactly 30,000',
        JSON.stringify({ walletBalances })
      );

      expect(
        after.family >= 0 && walletBalances.every(balance => balance >= 0),
        'G7 no negative source or destination balance',
        JSON.stringify({ after, walletBalances })
      );
    }

    console.log(`\n${failed === 0 ? 'PASSED' : 'FAILED'} ${passed}/${passed + failed} checks`);

    if (failures.length) {
      console.log('Failing: ' + failures.join(' | '));
    }

    await cleanup(users, families, references);
    await pool.end();

    process.exit(failed === 0 ? 0 : 1);
  } catch (e) {
    console.error('\nSUITE_ERROR', e && e.stack ? e.stack : e);
    await cleanup(users, families, references).catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
  }
})();
