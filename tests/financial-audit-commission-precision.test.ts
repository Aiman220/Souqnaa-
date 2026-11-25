import assert from 'assert';
import { TaxMath } from '../src/modules/tax/tax.math';

// Regression invariant for ratio rates with more precision than two decimals.
// Current production behavior rounds 0.105 to 0.11 inside TaxMath.multiply.
const commissionBase = 1000;
const commissionRate = 0.105;
const expectedCommission = 105;
const actualCommission = TaxMath.multiply(commissionBase, commissionRate);

assert.strictEqual(
  actualCommission,
  expectedCommission,
  `A 10.5% commission on 1,000 must be 105; got ${actualCommission}`
);

console.log('Commission precision regression passed.');
