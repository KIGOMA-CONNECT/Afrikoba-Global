'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const source = fs.readFileSync('src/services/familyService.js', 'utf8');
const start = source.indexOf('function parseCurrencyAmount(amount) {');
const marker = '\n}\n\n// G1: FAMILY / SHARED WALLETS';
const end = source.indexOf(marker, start);

assert.ok(start >= 0 && end >= 0, 'helper must exist in expected location');

const helperSource = source.slice(start, end + 2);
const context = {};
vm.runInNewContext(
  helperSource + '\nthis.parseCurrencyAmount = parseCurrencyAmount;',
  context
);

const parse = context.parseCurrencyAmount;
let passed = 0;

for (const [label, input, expected] of [
  ['integer', 12, 12],
  ['string integer', '12', 12],
  ['two decimals', '12.34', 12.34],
  ['one decimal', '0.5', 0.5],
  ['trimmed decimal', ' 7.20 ', 7.2]
]) {
  assert.equal(parse(input), expected, label);
  passed++;
  console.log('PASS:', label);
}

for (const [label, input] of [
  ['zero', '0'],
  ['negative', '-1'],
  ['too many decimal places', '1.239'],
  ['leading decimal point', '.50'],
  ['trailing decimal point', '1.'],
  ['exponent notation', '1e2'],
  ['NaN string', 'NaN'],
  ['Infinity string', 'Infinity'],
  ['empty string', ''],
  ['boolean', true],
  ['null', null],
  ['undefined', undefined],
  ['numeric NaN', NaN],
  ['numeric Infinity', Infinity]
]) {
  assert.throws(
    () => parse(input),
    error => error && error.statusCode === 400,
    label
  );
  passed++;
  console.log('PASS: rejects', label);
}

console.log('PASS:', passed, 'validation cases');
