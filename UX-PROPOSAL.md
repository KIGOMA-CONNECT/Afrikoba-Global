# Afrikoba — UX / Information Architecture Proposal (Staging Review Response)

Mwada huu ni jibu la review ya 2026-09-13. Umawazo: kubadilisha jinsi
Afrikoba inavyojiwasilisha — kutoka "dashboard ya modules" kuwa **modern,
global, trusted fintech platform** yenye intelligence na governance
iliyojengwa ndani.

Utaratibu wa delivery (kama ulivyoagizwa):
1. ✅ Proposal hii (dashboard + VICOBA IA) kwa review.
2. 🔧 P0 fix ya create-group (+ hardening za jirani) — tayari nimefanya,
   evidence imo chini.
3. ▶️ Workflow testing: VICOBA → ROSCA → SACCOS → Marketplace/BNPL → P2P →
   Payments → KYC → Security.

---

## 1. Dashboard — user-centric, siyo list ya modules

- Ondoa "Karibu! Chagua huduma..." kwenye kila load. Onboarding hiyo iwe
  **mara ya kwanza tu** (ama ihamie Settings → My Services).
- Dashboard mpya inaanza na:
  1. **Fedha zangu**: wallet balance, ya kikundi (VICOBA/SACCOS/ROSCA), misada.
  2. **Hivi punde**: alerts muhimu, maombi yanayosubiri, vitu vinavyofika hivi
     karibuni (mchango, mkopo, gawio, malipo).
  3. **Vikundi / Miradi / Agizo** zinazohusu user.
  4. Quick actions (Tuma, Lipa, Weka hisa, Unda kikundi, Nunua).
- Greeting itumie `full_name` halisi; "Staging Test User" ni data ya staging
  siyo brand.
- Visual: cards wazi, hierarchy ya typografia, spacing nzuri, mobile-first.

## 2. Navigation — grouped, sio 40 items kwa pamoja

Kikundi (modules hazipunguzwi, zinaunganishwa tu):

- **Dashboard**
- **Fedha** — Wallet, Budget, Vaults & Savings, Savings Challenges, P2P,
  Loans & Repayment, Multi-Currency/FX, Limit/Beneficiaries, Banking.
- **Vikundi** — VICOBA, SACCOS, ROSCA, Lending Circles, Network/Family,
  Group Governance, Social Fund.
- **Masoko** — Marketplace, Financing (BNPL), Procurement, Secondary Market,
  Merchant & QRs, Seller Verification, Disputes.
- **Biashara** — Business Accounts & Payroll, Agents & Bulk, Bills & Airtime,
  Bill Splits, Recurring, Cards, Micro-Insurance.
- **Miradi & Uwekezaji** — Projects & Crowdfunding, Kilimo, Vaults, Events &
  Investments, Referrals, Rewards.
- **Ujumbe & Taarifa** — Messages, Notifications, Documents, Statements &
  Exports, Reports.
- **Mipangilio** — Settings, Security, KYC, Devices & Trust, My Services
  (personalization), Language, Developer Portal, AI/Insights (Admin).

"My Services" iwe **settings/personalization** — siyo onboarding inayojirudia.

## 3. VICOBA — Information Architecture ndani ya group

Muundo mpya wa ukurasa wa kikundi (muhtasari USIOwe juu):

| Sehemu | Yaliyomo |
|---|---|
| **Uongozi na Muundo** | Viongozi (Mwenyekiti, Katibu, Mwekahazina), muundo, mzunguko, bei ya hisa, katiba mfupi |
| **Taarifa na Habari** | Matukio ya kikundi, matangazo kutoka viongozi |
| **Nyaraka za Kikundi** | Katiba, Kanuni, Kumbukumbu za Vikao, Maazimio, Ripoti za Magawio — **metadata, versions, audit trail, access control**; mnachama anaweza kupakua kwenye simu |
| **Hazina & Michango** | Salio, michango, hisa, adhabu, mweka hazina |
| **Mikutano & Maazimio** | Ratiba, ajenda, kumbukumbu, upigaji kura |
| **Wanachama** | Orodha, nafasi, hisa zinazoonekana kulingana na permissions |
| **Mikopo & Marejesho** | Maombi, idhini, marejesho, masharti |
| **Ripoti & Magawio** | Fedha za maazimio, utekelezaji, takwimu |

Nyaraka ziwe downloadable (PDF/print), accessible kwa role.

## 4. AI Financial Intelligence — nyuma ya pazia

- **Usiwe huduma ya kujiamhirimu** kwenye dashboard ya mtumiaji wa kawaida.
- AI iwe **intelligence layer**: inaonesha **matokeo** siyo mchakato:
  - Alert: "Vikundi vyako: kikundi A kina mzunguko kesho."
  - Financial health: "Gharama za mwezi huu zimeongezeka 12% vs mwezi uliopita."
  - Risk flag: "Mkopo wa TZS X una rating ya hatari Y — jambo la kuangalia."
  - Price insight: "Bei ya kahawa soko: wastani TZS X (asili: mauzo ya wiki hii)."
- Kutumia lugha ya kawaida; **RIA ni ya admin/backend** (ai platform endpoints).
- Maamuzi yanayohitaji mamlaka bado yapitie **human approval** (four-eyes).

## 5. Marketplace — global commerce experience

Muundo: **Gundua | Agizo Langu | Uza | Bei za Soko | Ufadhili | Ulinzi wa Muamala**.
- Price intelligence ionekane kama **wasoko wa soko**, si moduli ya AI.
- Seller verification, escrow/disputes, procurement viwe workflows zinazoeleweka.
- BNPL ionyeshe: mkuu wa deni, fees, kila mwezi, tarehe za malipo, jumla ya
  kulipa, hali ya mkataba (sio "Huna mkataba" pekee).

## 6. UX Writing — lugha sanifu

- "Panya Tena" → **"Jaribu Tena"** (hali ya kawaida ya Kiafrika/Swahili).
- Error messages: eleza kilichotokea + hatua inayofuata.
- Ondoa "Tatizo limehifadhiwa" (isiyo na maana kwa user) — tumia maudhui halisi.
- Terminology thabiti: **Mzunguko, Bei ya Hisa, Ada, Wanachama, Nyaraka,
  Kumbukumbu za Kikao, Maazimio, Magawio, Michango, Mikopo**.

## 7. P0 Incident — create VICOBA group

**Hitimisho la uchunguzi (evidence):**

- Backend `POST /api/v1/vicoba/groups` **inafanya kazi**: majaribio yangu
  (2026-09-13) → `201` na `{"success":true,"group":{id:2,"join_code":"6A7C0252",...}}`;
  mwanachama `MWENYEKITI` amepewa. Mawimbo ya log ya user kutoka 06:24:31 →
  `201 (13ms)`.
- Kwa hiyo "Kuna tatizo limejitokeza / Panya Tena" ni **ErrorBoundary ya
  frontend** (React render crash), si 4xx/5xx ya API.
- **Bug halisi iliyogunduliwa #1:** `GET /api/v1/vicoba/groups/:id` haiko
  `role_in_group` kwenye detail → viongozi **wanapoteza vitendo** (mialiko,
  mikopo, profit) baada ya kufungua kikundi. **Imerekebishwa.**
- **Bug ya kimuktadha #2:** `createGroup` haiko transaction → kama
  kuingiza mwenyekiti kushindwa, kikundi kikae peke yake. **Imebadilishwa
  kuwa transaction** (rollback ikiwa mwanachama ashindwe).
- **Hardening #3:** ErrorBoundary sasa inaonyesha taarifa ya kweli ya error
  (badala ya "Tatizo limehifadhiwa") + kitufe "Jaribu Tena" → mara inayofuata
  tunaiona sababu halisi ya crash.

**Checks za kile kinachohitajika kama validation zaidi (riski):**
- Ngoja mthibitisho wa screenshots/page unaoleta "Panya Tena" (sasa utaamushia
  Jina la Error) — ndio tunaweza kufunga crash yake kabisa.

## 8. Domain Separation (VICOBA / ROSCA / SACCOS / Events)

- Groups zibaki isolated: members, ledger, schedules, permissions, documents,
  transactions kwa kila group moja.
- Validation ya domain husika kwa kila aina (sio form moja bila uthibiti).
- Hakikisha una votes na governance per-type (tofautisha katiba choice, etc).