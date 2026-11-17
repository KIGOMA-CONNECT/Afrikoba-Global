#!/usr/bin/env node
'use strict';
/* SUPERSEDED (R35 (3), owner decision D-S5-12).
 * R30 F-D5-5 decision 4 tested the old creation rule: an officer (MWENYEKITI / MWEKAHAZINA / KATIBU)
 * created the loan request for a member and the creation itself was the chair step, so the creator
 * could not be the applicant. R34 S5 D(a) replaced that rule: the member submits their own request and
 * Katibu -> Mhasibu (MWEKAHAZINA) -> Mwenyekiti approve, three different people, never the applicant.
 *
 * The R30 (1) assertions this file carried (no self-approval by an officer applicant, body cannot
 * change the actor, string ids, the governance-style one-actor sequence, static ordering, parallel
 * attempts) were moved onto the new chain in
 *   tests/r35-3-r30-1-self-approval-carried-into-chain.phase71.test.js
 * and the chain itself is covered by tests/r34-s5-vicoba-loan-three-tier.phase71.test.js.
 * R30 D4 [5] (officer creates for a member; chair step at creation) is retired by D(a).
 * This file no longer touches a database.
 */
console.log('R30 D4: SUPERSEDED by R34 S5 D(a) / R35 (3); see tests/r35-3-r30-1-self-approval-carried-into-chain.phase71.test.js');
console.log('R30 D4: 0 passed, 0 failed (superseded)');
process.exit(0);
