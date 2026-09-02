/**
 * AFRIKOBA SELLER VERIFICATION
 *
 * A trust/trust governance layer for the open marketplace. Every seller is
 * scored against five factors that draw on the AFRIKOBA ID (financial passport)
 * and real marketplace behaviour:
 *
 *   1. IDENTITY        - passport KYC level >= 2 AND phone verified
 *   2. FINANCIAL_HEALTH- passport afrikobaScore >= 300
 *   3. ACCOUNT_AGE     - account >= 30 days old
 *   4. SALES_HISTORY   - at least 1 confirmed order sold
 *   5. REPUTATION      - no open escrow dispute on an order they sold AND
 *                        (no reviews yet OR average rating >= 3.5)
 *
 * All five  -> AFRIKOBA_VERIFIED (display badge: "Afrikoba Verified Seller")
 * Three-four -> ESTABLISHED
 * else       -> UNVERIFIED
 *
 * Results are cached in seller_verification for 24h and refreshed by a daily
 * cron (recomputeAll). The listing read path LEFT JOINs the cache so it never
 * recomputes on view.
 */

const pool = require('../config/db');
const { getPassport } = require('./financialPassportService');
const { logAction } = require('./auditService');
const logger = require('../utils/logger');

const TTL_HOURS = 24;

/** Raw computation for one seller (does not read/write the cache). */
async function computeSellerVerification(userId) {
  const user = await pool.query(
    `SELECT id, created_at, kyc_level FROM users WHERE id=$1`, [userId]);
  if (!user.rows.length) throw Object.assign(new Error('Mtumiaji hapatikani.'), { statusCode: 404 });
  const u = user.rows[0];

  const accountAgeDays = Math.floor((Date.now() - new Date(u.created_at).getTime()) / 86400000);

  // Live behaviour reads (no cache dependency).
  const stats = await pool.query(
    `SELECT
        COUNT(*) FILTER (WHERE status='CONFIRMED')::int AS confirmed_orders,
        COUNT(*)::int AS total_orders
       FROM marketplace_orders WHERE seller_user_id=$1`, [userId]);
  const confirmed = stats.rows[0].confirmed_orders || 0;

  const rev = await pool.query(
    `SELECT COALESCE(AVG(r.rating)::numeric,0) AS avg_rating, COUNT(r.id)::int AS review_count
       FROM marketplace_reviews r
       JOIN marketplace_orders o ON o.id = r.order_id
      WHERE o.seller_user_id=$1`, [userId]);
  const avgRating = Number(rev.rows[0].avg_rating || 0);
  const reviewCount = rev.rows[0].review_count || 0;

  // Open marketplace escrow disputes against this seller (any order they sold).
  const disp = await pool.query(
    `SELECT COUNT(*)::int AS c
       FROM disputes d JOIN marketplace_orders o ON o.id = d.marketplace_order_id
      WHERE o.seller_user_id=$1 AND d.marketplace_order_id IS NOT NULL
        AND d.status NOT IN ('REJECTED','RESOLVED')`, [userId]);
  const openDisputes = disp.rows[0].c || 0;

  // AFRIKOBA ID factors.
  let passport = null;
  try { passport = await getPassport(userId); } catch (e) { passport = null; }
  const kycLevel = Number(passport?.identity?.kycLevel ?? u.kyc_level ?? 0);
  const phoneVerified = Boolean(passport?.identity?.phoneVerified);
  const score = Number(passport?.afrikobaScore ?? 0);

  const factors = [
    { key: 'IDENTITY', label: 'KYC Level 2+ & phone verified', ok: kycLevel >= 2 && phoneVerified, detail: `KYC ${kycLevel}, phone ${phoneVerified ? 'verified' : 'unverified'}` },
    { key: 'FINANCIAL_HEALTH', label: 'Passport score >= 300', ok: score >= 300, detail: `Score ${score}` },
    { key: 'ACCOUNT_AGE', label: 'Account >= 30 days', ok: accountAgeDays >= 30, detail: `${accountAgeDays} days` },
    { key: 'SALES_HISTORY', label: 'At least 1 confirmed sale', ok: confirmed >= 1, detail: `${confirmed} confirmed order(s)` },
    { key: 'REPUTATION', label: 'No open dispute & rating >= 3.5', ok: openDisputes === 0 && (reviewCount === 0 || avgRating >= 3.5), detail: openDisputes > 0 ? `${openDisputes} open dispute(s)` : (reviewCount ? `${avgRating.toFixed(1)} avg from ${reviewCount} review(s)` : 'No reviews yet') },
  ];

  const passed = factors.filter(f => f.ok).length;
  let tier = 'UNVERIFIED';
  if (passed === 5) tier = 'AFRIKOBA_VERIFIED';
  else if (passed >= 3) tier = 'ESTABLISHED';

  return {
    user_id: userId,
    verified: tier === 'AFRIKOBA_VERIFIED',
    tier,
    factor_count: passed,
    factors,
    summary: {
      confirmed_orders: confirmed,
      avg_rating: reviewCount ? avgRating : null,
      review_count: reviewCount,
      open_disputes: openDisputes,
      account_age_days: accountAgeDays,
    },
  };
}

/** Fresh profile for a seller, cached for 24h. */
async function getSellerVerification(userId) {
  const cached = await pool.query(
    `SELECT * FROM seller_verification WHERE user_id=$1`, [userId]);
  if (cached.rows.length) {
    const row = cached.rows[0];
    if (new Date(row.expires_at).getTime() > Date.now()) {
      return {
        user_id: userId, verified: row.verified, tier: row.tier,
        factors: row.factors, rated_at: row.rated_at, cached: true,
      };
    }
  }
  const fresh = await computeSellerVerification(userId);
  await pool.query(
    `INSERT INTO seller_verification (user_id, verified, tier, factors, rated_at, expires_at, updated_at)
     VALUES ($1,$2,$3,$4,NOW(), NOW() + INTERVAL '${TTL_HOURS} hours', NOW())
     ON CONFLICT (user_id) DO UPDATE SET verified=EXCLUDED.verified, tier=EXCLUDED.tier, factors=EXCLUDED.factors,
       rated_at=EXCLUDED.rated_at, expires_at=EXCLUDED.expires_at, updated_at=NOW()`,
    [userId, fresh.verified, fresh.tier, JSON.stringify(fresh.factors)]
  );
  if (fresh.verified) {
    logAction(userId, 'SELLER_VERIFIED', 'USER', userId, `Afrikoba Verified Seller (${fresh.factor_count}/5 factors)`);
  }
  return { ...fresh, cached: false };
}

/** Daily cron: recompute every seller that has at least one marketplace listing. */
async function recomputeAll() {
  const sellers = await pool.query(
    `SELECT DISTINCT seller_user_id AS id FROM marketplace_listings`);
  let verified = 0, established = 0, unverified = 0;
  for (const s of sellers.rows) {
    const p = await computeSellerVerification(s.id);
    await pool.query(
      `INSERT INTO seller_verification (user_id, verified, tier, factors, rated_at, expires_at, updated_at)
       VALUES ($1,$2,$3,$4,NOW(), NOW() + INTERVAL '${TTL_HOURS} hours', NOW())
       ON CONFLICT (user_id) DO UPDATE SET verified=EXCLUDED.verified, tier=EXCLUDED.tier, factors=EXCLUDED.factors,
         rated_at=EXCLUDED.rated_at, expires_at=EXCLUDED.expires_at, updated_at=NOW()`,
      [s.id, p.verified, p.tier, JSON.stringify(p.factors)]
    );
    if (p.tier === 'AFRIKOBA_VERIFIED') verified++;
    else if (p.tier === 'ESTABLISHED') established++;
    else unverified++;
  }
  logger.info('SELLER-VERIFY', `Recomputed ${sellers.rows.length} sellers (${verified} verified, ${established} established, ${unverified} unverified)`);
  return { total: sellers.rows.length, verified, established, unverified };
}

module.exports = { computeSellerVerification, getSellerVerification, recomputeAll, TTL_HOURS };