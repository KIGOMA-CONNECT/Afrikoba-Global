const pool = require('../src/config/db');
const fin = require('../src/services/financialEngine');

describe('FinancialEngine amount guards (non-finite)', () => {
  const INVALIDS = [-100, -1, 0, NaN, Infinity];
  const USER1 = 1;
  const USER2 = 3;

  async function countResidue(prefixRef) {
    const r = await pool.query(
      SELECT
        (SELECT count(*) FROM financial_operations WHERE reference_id LIKE ) AS fo,
        (SELECT count(*) FROM journal_entries WHERE reference_id LIKE ) AS je,
        (SELECT count(*) FROM financial_audit_log WHERE reference_id LIKE ) AS fa,
      [${prefixRef}%]
    );
    return r.rows[0];
  }

  test('postDeposit rejects non-finite/zero/non-pos', async () => {
    const prefix = T68-PD-;
    const before = await countResidue(prefix);
    for (const v of INVALIDS) {
      const ref = ${prefix}-;
      await expect(fin.postDeposit({ userId: USER1, amount: v, commission: 0, reference: ref, externalTxId: ref })).rejects.toMatchObject({ statusCode: 400 });
    }
    const after = await countResidue(prefix);
    expect(Number(after.fo)).toBe(Number(before.fo));
    expect(Number(after.je)).toBe(Number(before.je));
    expect(Number(after.fa)).toBe(Number(before.fa));
  });

  test('holdFunds rejects invalid', async () => {
    const prefix = T68-HOLD-;
    const before = await countResidue(prefix);
    for (const v of INVALIDS) {
      const ref = ${prefix}-;
      await expect(fin.holdFunds({ userId: USER1, amount: v, reference: ref })).rejects.toMatchObject({ statusCode: 400 });
    }
    const after = await countResidue(prefix);
    expect(Number(after.fo)).toBe(Number(before.fo));
    expect(Number(after.je)).toBe(Number(before.je));
    expect(Number(after.fa)).toBe(Number(before.fa));
  });

  test('releaseHold rejects invalid', async () => {
    const prefix = T68-REL-;
    const before = await countResidue(prefix);
    for (const v of INVALIDS) {
      const ref = ${prefix}-;
      await expect(fin.releaseHold({ userId: USER1, amount: v, reference: ref })).rejects.toMatchObject({ statusCode: 400 });
    }
    const after = await countResidue(prefix);
    expect(Number(after.fo)).toBe(Number(before.fo));
    expect(Number(after.je)).toBe(Number(before.je));
    expect(Number(after.fa)).toBe(Number(before.fa));
  });

  test('captureHold rejects invalid', async () => {
    const prefix = T68-CAP-;
    const before = await countResidue(prefix);
    for (const v of INVALIDS) {
      const ref = ${prefix}-;
      await expect(fin.captureHold({ userId: USER1, amount: v, reference: ref })).rejects.toMatchObject({ statusCode: 400 });
    }
    const after = await countResidue(prefix);
    expect(Number(after.fo)).toBe(Number(before.fo));
    expect(Number(after.je)).toBe(Number(before.je));
    expect(Number(after.fa)).toBe(Number(before.fa));
  });

  test('transfer rejects invalid', async () => {
    const prefix = T68-TRN-;
    const before = await countResidue(prefix);
    for (const v of INVALIDS) {
      const ref = ${prefix}-;
      await expect(fin.transfer({ fromUserId: USER1, toUserId: USER2, amount: v, reference: ref })).rejects.toMatchObject({ statusCode: 400 });
    }
    const after = await countResidue(prefix);
    expect(Number(after.fo)).toBe(Number(before.fo));
    expect(Number(after.je)).toBe(Number(before.je));
    expect(Number(after.fa)).toBe(Number(before.fa));
  });
});
