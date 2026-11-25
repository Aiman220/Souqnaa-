import assert from 'assert';
import { parseNonNegativeMoney } from '../src/utils/non-negative-money.util';

assert.strictEqual(parseNonNegativeMoney(0), 0);
assert.strictEqual(parseNonNegativeMoney('12.50', 'Product price'), 12.5);
assert.throws(() => parseNonNegativeMoney(-0.01, 'Product price'), /non-negative/);
assert.throws(() => parseNonNegativeMoney('NaN', 'Product price'), /non-negative/);
assert.throws(() => parseNonNegativeMoney(Infinity, 'Product price'), /non-negative/);
assert.throws(() => parseNonNegativeMoney('', 'Product price'), /non-negative/);
assert.throws(() => parseNonNegativeMoney(null, 'Product price'), /non-negative/);
assert.throws(() => parseNonNegativeMoney(undefined, 'Product price'), /non-negative/);

console.log('Product price validation tests passed.');
