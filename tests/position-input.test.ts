import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePositionInput } from '../src/position-input';

test('完整持仓字符串转为仅包含数量和成本的数字对象', () => {
  assert.deepEqual(parsePositionInput(' 1000 ', ' 12.50 '), { quantity: 1000, cost: 12.5 });
  assert.deepEqual(parsePositionInput('00100', '0003.125'), { quantity: 100, cost: 3.125 });
});

test('支持场内基金三位小数、八位小数成本及零成本', () => {
  assert.deepEqual(parsePositionInput('1200', '1.023'), { quantity: 1200, cost: 1.023 });
  assert.deepEqual(parsePositionInput('100', '0.00000001'), { quantity: 100, cost: 0.00000001 });
  assert.deepEqual(parsePositionInput('100', '0'), { quantity: 100, cost: 0 });
  assert.deepEqual(parsePositionInput('100', '0.00000000'), { quantity: 100, cost: 0 });
  assert.throws(() => parsePositionInput('100', '1.000000001'), /最多 8 位小数/);
});

test('协议只接收字符串，空值和布尔值不会隐式转换成零', () => {
  for (const missing of [undefined, null, true, false, 0, 100, [], {}, '', '   ']) {
    assert.throws(() => parsePositionInput(missing, '1'), /持仓数量/);
    assert.throws(() => parsePositionInput('100', missing), /成本/);
  }
});

test('数量拒绝小数、零、负数、指数、十六进制和非有限值', () => {
  for (const quantity of ['1.5', '100.0', '0', '000', '-1', '+1', '1e3', '0x10', 'Infinity', 'NaN', '1,000']) {
    assert.throws(() => parsePositionInput(quantity, '1'), /持仓数量/);
  }
});

test('成本拒绝指数、十六进制、负数及输入中的不完整小数', () => {
  for (const cost of ['-1', '-0', '+1', '1e2', '1e-8', '0x10', 'Infinity', 'NaN', '1.', '.5', '.', '1,000']) {
    assert.throws(() => parsePositionInput('100', cost), /成本/);
  }
});

test('数量与每份成本的上下限与领域规则一致', () => {
  assert.deepEqual(parsePositionInput('1', '1000000'), { quantity: 1, cost: 1_000_000 });
  assert.deepEqual(parsePositionInput('1000000000', '1'), { quantity: 1_000_000_000, cost: 1 });
  assert.throws(() => parsePositionInput('1000000001', '1'), /1,000,000,000/);
  assert.throws(() => parsePositionInput('1', '1000000.00000001'), /0–1,000,000/);
  assert.throws(() => parsePositionInput('9'.repeat(400), '1'), /持仓数量/);
  assert.throws(() => parsePositionInput('1', '9'.repeat(400)), /成本/);
});

test('双方单值合法时仍检查总成本安全边界', () => {
  assert.deepEqual(parsePositionInput('90071992', '1000000'), { quantity: 90_071_992, cost: 1_000_000 });
  assert.throws(() => parsePositionInput('90071993', '1000000'), /总成本超过安全计算范围/);
  assert.throws(() => parsePositionInput('1000000000', '1000000'), /总成本超过安全计算范围/);
});

test('半输入不会生成可保存的持仓对象', () => {
  assert.throws(() => parsePositionInput('100', undefined));
  assert.throws(() => parsePositionInput(undefined, '3.125'));
  assert.throws(() => parsePositionInput('100', ''));
  assert.throws(() => parsePositionInput('', '3.125'));
});
