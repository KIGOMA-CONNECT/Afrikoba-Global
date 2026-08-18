const pool = require('../config/db');

const SERVICE_CATALOG = {
  WALLET: {
    key: 'WALLET',
    name: 'Wallet',
    swahili: 'Wallet ya Fedha',
    tagline: 'Malipo, salio na uhamisho wa papasapo - popote Tanzania.',
    description: 'Akaunti ya msingi ya fedha - salio, malipo, uhamisho na matumizi ya kila siku.',
    perks: [
      'Malipo na uhamisho wa papasapo (P2P)',
      'Kumbukumbu kamili ya kila shilingi',
      'Usalama wa juu na uthibitisho wa OTP/PIN',
    ],
    cta: 'Fungua Wallet Yako',
    requiresKyc: 1,
    icon: 'wallet',
    emoji: '💼',
    color: '#0b7a41',
    baseService: true,
  },
  VICOBA: {
    key: 'VICOBA',
    name: 'VICOBA',
    swahili: 'VICOBA (Kikundi)',
    tagline: 'Akiba na mikopo kwa nguvu ya pamoja - kikundi chako, usalama wako.',
    description: 'Jiunge na kikundi cha akiba na mikopo - weka hisa, pata mikopo yenye uwajibikaji wa pamoja.',
    perks: [
      'Weka hisa na pata mikopo ya kikundi',
      'Mikopo ya Multi-Signature (mikopo salama)',
      'Msimbo wa kujiunga + mialiko ya SMS',
    ],
    cta: 'Jiunge na Kikundi',
    requiresKyc: 1,
    icon: 'users',
    emoji: '🏦',
    color: '#155e9c',
    baseService: false,
  },
  ROSCA: {
    key: 'ROSCA',
    name: 'Upatu (ROSCA)',
    swahili: 'Upatu (ROSCA)',
    tagline: 'Upatu wa kisasa - zamu na malipo yako yote otomatiki.',
    description: 'Mzunguko wa fedha unaotegemewa - upatu wa kisasa wenye ratiba na malipo otomatiki.',
    perks: [
      'Ratiba ya zamu inajitengeneza otomatiki',
      'Malipo yanatoka moja kwa moja kwenye wallet',
      'Uwazi kamili - kila mzunguko unaonekana',
    ],
    cta: 'Anza Upatu Wako',
    requiresKyc: 2,
    icon: 'refresh',
    emoji: '🔄',
    color: '#0e8a8a',
    baseService: false,
  },
  P2P: {
    key: 'P2P',
    name: 'Uwekezaji (P2P)',
    swahili: 'Uwekezaji (P2P)',
    tagline: 'Wekeza kwenye biashara halisi upate faida - na pata mkopo kwa riba nafuu.',
    description: 'Wekeza kwenye miradi ya kibiashara na upate faida - na pata mikopo kwa riba nafuu.',
    perks: [
      'Miradi iliyohakikiwa kwa hatua 4',
      'Fedha zilizofungwa kwenye escrow',
      'Mkataba wa PDF wa kisheria kwa kila uwekezaji',
    ],
    cta: 'Wekeza Leo',
    requiresKyc: 2,
    icon: 'trending-up',
    emoji: '📈',
    color: '#6d3fb8',
    baseService: false,
  },
  KILIMO: {
    key: 'KILIMO',
    name: 'Kilimo (Agri-Finance)',
    swahili: 'Kilimo (Agri-Finance)',
    tagline: 'Fedha za kilimo, pembejeo na mkopo unaolipishwa baada ya mavuno.',
    description: 'Fedha za kilimo, pembejeo na mkopo unaolipishwa baada ya mavuno. (Phase 5)',
    perks: [
      'Mkopo unaolipishwa baada ya mavuno',
      'Pembejeo za kilimo kwa bei nzuri',
      'Mashamba na wakulima waliothibitishwa',
    ],
    cta: 'Inakuja hivi karibuni',
    requiresKyc: 2,
    icon: 'leaf',
    emoji: '🌾',
    color: '#b26a00',
    baseService: false,
    comingSoon: true,
  },
};

async function getUserServices(userId) {
  const res = await pool.query(
    `SELECT service_key, status, subscribed_at
     FROM user_service_subscriptions
     WHERE user_id = $1 AND status = 'ACTIVE'
     ORDER BY subscribed_at`,
    [userId]
  );
  return res.rows.map((r) => r.service_key);
}

async function isSubscribed(userId, serviceKey) {
  const res = await pool.query(
    `SELECT 1 FROM user_service_subscriptions
     WHERE user_id = $1 AND service_key = $2 AND status = 'ACTIVE'`,
    [userId, serviceKey]
  );
  return res.rows.length > 0;
}

async function subscribe(userId, serviceKey) {
  const svc = SERVICE_CATALOG[serviceKey];
  if (!svc) throw Object.assign(new Error('Huduma hiyo haipo.'), { statusCode: 400 });
  if (svc.comingSoon) {
    throw Object.assign(new Error('Huduma hii itapatikana hivi karibuni.'), { statusCode: 400 });
  }

  const userRes = await pool.query('SELECT kyc_level FROM users WHERE id = $1', [userId]);
  if (userRes.rows.length === 0) throw new Error('Mtumiaji hajapatikana.');
  const kycLevel = userRes.rows[0].kyc_level || 1;
  if (kycLevel < svc.requiresKyc) {
    throw Object.assign(
      new Error(`Kamilisha KYC Level ${svc.requiresKyc} kwanza ili ujiunge na ${svc.name}.`),
      { statusCode: 403, kycRequired: svc.requiresKyc }
    );
  }

  const res = await pool.query(
    `INSERT INTO user_service_subscriptions (user_id, service_key)
     VALUES ($1, $2)
     ON CONFLICT (user_id, service_key)
     DO UPDATE SET status = 'ACTIVE', subscribed_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [userId, serviceKey]
  );
  return res.rows[0];
}

async function unsubscribe(userId, serviceKey) {
  await pool.query(
    `UPDATE user_service_subscriptions
     SET status = 'SUSPENDED'
     WHERE user_id = $1 AND service_key = $2`,
    [userId, serviceKey]
  );
  return { success: true };
}

async function openWallet(userId) {
  await pool.query(
    `INSERT INTO user_service_subscriptions (user_id, service_key)
     VALUES ($1, 'WALLET')
     ON CONFLICT (user_id, service_key) DO NOTHING`,
    [userId]
  );
  return { success: true };
}

async function getCatalogForUser(userId) {
  const active = await getUserServices(userId);
  return Object.values(SERVICE_CATALOG).map((svc) => ({
    ...svc,
    active: active.includes(svc.key),
  }));
}

/**
 * Katalogi ya matangazo - ya umma (nje na ndani ya mfumo).
 * Haina data ya mtumiaji yeyote; salama kutumika kwenye landing pages, ads, banners.
 */
function getMarketingCatalog() {
  return Object.values(SERVICE_CATALOG).map(({ key, name, swahili, tagline, description, perks, cta, requiresKyc, emoji, color, baseService, comingSoon }) => ({
    key,
    name,
    swahili,
    tagline,
    description,
    perks,
    cta,
    requiresKyc,
    emoji,
    color,
    baseService,
    comingSoon: !!comingSoon,
  }));
}

module.exports = {
  SERVICE_CATALOG,
  getUserServices,
  isSubscribed,
  subscribe,
  unsubscribe,
  openWallet,
  getCatalogForUser,
  getMarketingCatalog,
};
