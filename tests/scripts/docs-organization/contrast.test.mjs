import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeLuminance, contrastRatio, parseHex, resolveColor } from '../../../module/skills/docs-organization/scripts/contrast.mjs';
import { CSS_NAMED_COLORS } from '../../../module/skills/docs-organization/scripts/css-named-colors.mjs';

test('parseHex: parses 6-digit hex', () => {
  assert.deepEqual(parseHex('#ffffff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHex('#000000'), { r: 0, g: 0, b: 0 });
  assert.deepEqual(parseHex('#5b8def'), { r: 0x5b, g: 0x8d, b: 0xef });
});

test('parseHex: parses 3-digit hex', () => {
  assert.deepEqual(parseHex('#fff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHex('#000'), { r: 0, g: 0, b: 0 });
});

test('parseHex: rejects malformed input', () => {
  assert.throws(() => parseHex('not-a-color'));
  assert.throws(() => parseHex('#gg0000'));
  assert.throws(() => parseHex('#1234'));
});

test('relativeLuminance: white is 1.0', () => {
  assert.ok(Math.abs(relativeLuminance({ r: 255, g: 255, b: 255 }) - 1.0) < 1e-9);
});

test('relativeLuminance: black is 0.0', () => {
  assert.ok(Math.abs(relativeLuminance({ r: 0, g: 0, b: 0 }) - 0.0) < 1e-9);
});

test('contrastRatio: black on white is 21:1', () => {
  const ratio = contrastRatio('#000000', '#ffffff');
  assert.ok(Math.abs(ratio - 21) < 1e-6, `expected ~21, got ${ratio}`);
});

test('contrastRatio: white on white is 1:1', () => {
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
});

test('contrastRatio: order-independent', () => {
  assert.equal(
    contrastRatio('#5b8def', '#ffffff'),
    contrastRatio('#ffffff', '#5b8def')
  );
});

test('contrastRatio: known AA threshold case', () => {
  // #767676 on white = 4.54:1 per WCAG examples
  const ratio = contrastRatio('#767676', '#ffffff');
  assert.ok(ratio >= 4.5 && ratio < 4.6, `expected ~4.54, got ${ratio}`);
});

// --- resolveColor: hex as written, CSS named colors via the CSS Color 4 table ---

test('resolveColor: returns valid 3- and 6-digit hex unchanged', () => {
  assert.equal(resolveColor('#abc'), '#abc');
  assert.equal(resolveColor('#A1B2C3'), '#A1B2C3');
});

test('resolveColor: resolves CSS named colors case-insensitively', () => {
  // Spot checks against https://www.w3.org/TR/css-color-4/#named-colors
  assert.equal(resolveColor('yellow'), '#ffff00');
  assert.equal(resolveColor('White'), '#ffffff');
  assert.equal(resolveColor('aliceblue'), '#f0f8ff');
  assert.equal(resolveColor('rebeccapurple'), '#663399');
  assert.equal(resolveColor('lightgoldenrodyellow'), '#fafad2');
  assert.equal(resolveColor('gray'), '#808080');
  assert.equal(resolveColor('grey'), '#808080');
  assert.equal(resolveColor('yellowgreen'), '#9acd32');
});

test('CSS_NAMED_COLORS: holds exactly the 148 CSS Color 4 named colors', () => {
  assert.equal(Object.keys(CSS_NAMED_COLORS).length, 148);
  for (const [name, hex] of Object.entries(CSS_NAMED_COLORS)) {
    assert.match(name, /^[a-z]+$/, name);
    assert.match(hex, /^#[0-9a-f]{6}$/, `${name}: ${hex}`);
  }
});

test('resolveColor: returns null for values it cannot resolve', () => {
  for (const v of ['transparent', 'currentColor', 'constructor', 'toString', 'notacolor', '#abcd', '#12345678', 'rgb(1,2,3)', '', undefined]) {
    assert.equal(resolveColor(v), null, String(v));
  }
});
