import test from 'node:test';
import assert from 'node:assert/strict';
import { addGroup, addSecurity, chinaDate, clearPosition, createInitialState, moveSecurity, positionMetrics, removeGroup,
  removeSecurity, renameGroup, reorderGroup, reorderSecurity, setPosition, summarize, validateState } from '../src/portfolio';
import type { PortfolioState, Quote, Security } from '../src/types';

const TODAY = '2026-11-17';
function security(code = '600000', market: Security['market'] = 'sh', currency: Security['currency'] = 'CNY'): Security {
  return { id: `${market}${code}`, code, market, currency, kind: 'stock', name: `${market}${code}` };
}
function quote(id = 'sh600000', extra: Partial<Quote> = {}): Quote {
  return { id, name: id, price: 12, previousClose: 10, change: 2, changePercent: 20, currency: 'CNY',
    time: `${TODAY} 15:00:00`, date: TODAY, fetchedAt: 1, ...extra };
}
function withPosition(): PortfolioState {
  let state = createInitialState();
  state = addSecurity(state, state.groups[0].id, security());
  return setPosition(state, 'sh600000', { quantity: 100, cost: 8 });
}
function almost(actual: number | null, expected: number): void {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);
}

test('北京时间日期在 UTC 日界线附近正确', () => {
  assert.equal(chinaDate(new Date('2026-11-16T16:00:00Z')), TODAY);
  assert.equal(chinaDate(new Date('2026-11-17T15:59:59Z')), TODAY);
});

test('分类名称校验、不可变更新与重名约束', () => {
  const original = createInitialState();
  const next = addGroup(original, '  场内基金  ');
  assert.equal(original.groups.length, 1);
  assert.equal(next.groups[1].name, '场内基金');
  assert.throws(() => addGroup(next, '场内基金'), /同名/);
  assert.throws(() => addGroup(next, '  '), /1–30/);
  assert.throws(() => addGroup(next, 'a'.repeat(31)), /1–30/);
  assert.throws(() => renameGroup(next, next.groups[0].id, '场内基金'), /同名/);
  const renamed = renameGroup(next, next.groups[1].id, 'ETF');
  assert.equal(next.groups[1].name, '场内基金');
  assert.equal(renamed.groups[1].name, 'ETF');
});

test('第十只可添加、第十一只被拒绝；同组重复被拒绝', () => {
  let state = createInitialState();
  const id = state.groups[0].id;
  for (let i = 0; i < 10; i++) state = addSecurity(state, id, security(String(600000 + i)));
  assert.equal(state.groups[0].symbols.length, 10);
  assert.throws(() => addSecurity(state, id, security('600010')), /最多添加 10/);
  assert.throws(() => addSecurity(state, id, security('600000')), /已在此分类/);
});

test('移动证券保留持仓；目标满组及已有证券时拒绝且不改变原状态', () => {
  let state = addGroup(withPosition(), '目标');
  const [from, to] = state.groups;
  const moved = moveSecurity(state, from.id, to.id, 'sh600000');
  assert.deepEqual(moved.groups[0].symbols, []);
  assert.deepEqual(moved.groups[1].symbols, ['sh600000']);
  assert.equal(moved.positions.sh600000.quantity, 100);
  assert.deepEqual(state.groups[0].symbols, ['sh600000']);
  state = addSecurity(state, to.id, security());
  assert.throws(() => moveSecurity(state, from.id, to.id, 'sh600000'), /已包含/);
  state = removeSecurity(state, to.id, 'sh600000');
  for (let i = 1; i <= 10; i++) state = addSecurity(state, to.id, security(String(600000 + i)));
  assert.throws(() => moveSecurity(state, from.id, to.id, 'sh600000'), /已有 10/);
  assert.equal(state.groups[0].symbols.length, 1);
});

test('跨组共享持仓，最后一个引用删除后才清除证券与持仓', () => {
  let state = addGroup(withPosition(), '长期');
  state = addSecurity(state, state.groups[1].id, security());
  const oneLeft = removeSecurity(state, state.groups[0].id, 'sh600000');
  assert.equal(oneLeft.positions.sh600000.quantity, 100);
  const gone = removeGroup(oneLeft, state.groups[1].id);
  assert.equal(gone.securities.sh600000, undefined);
  assert.equal(gone.positions.sh600000, undefined);
  assert.equal(state.positions.sh600000.quantity, 100);
});

test('持仓校验为正整数股数及非负有限成本；清空仅清持仓', () => {
  const state = withPosition();
  for (const quantity of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => setPosition(state, 'sh600000', { quantity, cost: 10 }));
  }
  for (const cost of [-1, NaN, Infinity, 1e20]) {
    assert.throws(() => setPosition(state, 'sh600000', { quantity: 100, cost }));
  }
  assert.equal(setPosition(state, 'sh600000', { quantity: 1, cost: 0 }).positions.sh600000.cost, 0);
  assert.throws(() => setPosition(state, 'sz000001', { quantity: 1, cost: 1 }), /先添加/);
  const cleared = clearPosition(state, 'sh600000');
  assert.equal(cleared.positions.sh600000, undefined);
  assert.ok(cleared.securities.sh600000);
  assert.ok(state.positions.sh600000);
});

test('今日和持仓盈亏分别使用昨收与成本计算，涨跌平盘都正确', () => {
  const position = { quantity: 100, cost: 8 };
  assert.deepEqual(positionMetrics(position, quote(), TODAY), {
    daily: 200, dailyPercent: 20, profit: 400, profitPercent: 50, marketValue: 1200, costValue: 800,
  });
  const negative = positionMetrics(position, quote('sh600000', { price: 6 }), TODAY);
  assert.equal(negative.daily, -400);
  assert.equal(negative.profit, -200);
  assert.equal(negative.profitPercent, -25);
  assert.equal(positionMetrics(position, quote('sh600000', { price: 10 }), TODAY).daily, 0);
});

test('基金三位小数不提前舍入，零成本比例不除零', () => {
  const fund = positionMetrics({ quantity: 1200, cost: 1.012 }, quote('sh510300', { price: 1.023, previousClose: 1.018 }), TODAY);
  almost(fund.daily, 6);
  almost(fund.profit, 13.2);
  const zero = positionMetrics({ quantity: 100, cost: 0 }, quote(), TODAY);
  assert.equal(zero.profit, 1200);
  assert.equal(zero.profitPercent, null);
});

test('缺失或非法价格不是零元；昨收为零不计算今日盈亏', () => {
  for (const price of [null, 0, -1, NaN, Infinity]) {
    const metrics = positionMetrics({ quantity: 100, cost: 8 }, quote('sh600000', { price }), TODAY);
    assert.equal(metrics.daily, null);
    assert.equal(metrics.profit, null);
    assert.equal(metrics.marketValue, null);
  }
  assert.equal(positionMetrics({ quantity: 100, cost: 8 }).profit, null);
  const noClose = positionMetrics({ quantity: 100, cost: 8 }, quote('sh600000', { previousClose: 0 }), TODAY);
  assert.equal(noClose.daily, null);
  assert.equal(noClose.profit, 400);
});

test('历史/失败缓存报价不冒充今日收益，但保留持仓估值', () => {
  for (const extra of [{ date: '2026-11-16' }, { stale: true }]) {
    const metrics = positionMetrics({ quantity: 100, cost: 8 }, quote('sh600000', extra), TODAY);
    assert.equal(metrics.daily, null);
    assert.equal(metrics.dailyPercent, null);
    assert.equal(metrics.profit, 400);
  }
});

test('总百分比按金额加权，跨组同一持仓只计一次', () => {
  let state = addGroup(withPosition(), '重复展示');
  state = addSecurity(state, state.groups[1].id, security());
  state = addSecurity(state, state.groups[0].id, security('600001'));
  state = setPosition(state, 'sh600001', { quantity: 10, cost: 100 });
  const [summary] = summarize(state, { sh600000: quote(), sh600001: quote('sh600001', { price: 110, previousClose: 100 }) }, TODAY);
  assert.equal(summary.count, 2);
  assert.equal(summary.daily, 300);
  assert.equal(summary.dailyPercent, 15);
  assert.equal(summary.profit, 500);
  almost(summary.profitPercent, 500 / 1800 * 100);
  assert.equal(summary.incomplete, false);
});

test('按报价实际币种分组，港股人民币柜台归 CNY，场内基金与股票共用模型', () => {
  let state = withPosition();
  for (const item of [security('00700', 'hk', 'HKD'), security('80700', 'hk', 'HKD'), { ...security('510300'), kind: 'fund' as const }]) {
    state = addSecurity(state, state.groups[0].id, item);
    state = setPosition(state, item.id, { quantity: 100, cost: 8 });
  }
  const summaries = summarize(state, {
    sh600000: quote(), hk00700: quote('hk00700', { currency: 'HKD' }),
    hk80700: quote('hk80700', { currency: 'CNY' }), sh510300: quote('sh510300'),
  }, TODAY);
  assert.deepEqual(summaries.map(item => [item.currency, item.count, item.profit]), [['CNY', 3, 1200], ['HKD', 1, 400]]);
});

test('部分报价缺失时只对有效子集汇总并标注不完整；全部缺失不是零收益', () => {
  let state = withPosition();
  state = addSecurity(state, state.groups[0].id, security('600001'));
  state = setPosition(state, 'sh600001', { quantity: 100, cost: 8 });
  const [partial] = summarize(state, { sh600000: quote() }, TODAY);
  assert.equal(partial.daily, 200);
  assert.equal(partial.dailyPercent, 20);
  assert.equal(partial.profitPercent, 50);
  assert.equal(partial.incomplete, true);
  assert.equal(partial.validCount, 1);
  const [none] = summarize(state, {}, TODAY);
  assert.equal(none.daily, null);
  assert.equal(none.profit, null);
  assert.equal(none.validCount, 0);
  assert.equal(none.incomplete, true);
  assert.deepEqual(summarize(createInitialState(), {}, TODAY), []);
});

test('旧日期汇总标注实际日期，混合日期今日只计当天', () => {
  const state = withPosition();
  const [old] = summarize(state, { sh600000: quote('sh600000', { date: '2026-11-16' }) }, TODAY);
  assert.equal(old.daily, null);
  assert.equal(old.date, '2026-11-16');
  assert.equal(old.incomplete, true);
  assert.equal(old.profit, 400);
});

test('完整快照重启恢复；损坏版本/数据不静默清空；返回结构脱离输入', () => {
  const state = withPosition();
  const restored = validateState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored, state);
  restored.groups[0].symbols.length = 0;
  assert.equal(state.groups[0].symbols.length, 1);
  assert.equal(validateState(undefined).groups[0].name, '自选');
  assert.throws(() => validateState({ ...state, version: 2 }), /格式或版本/);
  assert.throws(() => validateState({ ...state, securities: {} }), /缺失/);
  assert.throws(() => validateState({ ...state, positions: { sh600000: { quantity: -1, cost: 1 } } }), /持股数量/);
  assert.throws(() => validateState({ ...state, groups: [{ ...state.groups[0], symbols: Array(11).fill('sh600000') }] }), /分类数据无效/);
});

test('分类拖拽支持插到目标之前、移到末尾和原位释放，不改变持仓', () => {
  const state = addGroup(addGroup(withPosition(), 'ETF'), '港股');
  const [a, b, c] = state.groups.map(group => group.id);
  const moved = reorderGroup(state, c, a);
  assert.deepEqual(moved.groups.map(group => group.id), [c, a, b]);
  assert.deepEqual(reorderGroup(moved, c).groups.map(group => group.id), [a, b, c]);
  const noOp = reorderGroup(state, b, b);
  assert.deepEqual(noOp, state);
  assert.notEqual(noOp, state);
  assert.deepEqual(moved.positions, state.positions);
  assert.deepEqual(moved.securities, state.securities);
  assert.deepEqual(state.groups.map(group => group.id), [a, b, c]);
});

test('分类拖拽的来源或目标失效时抛错且原状态不变', () => {
  const state = addGroup(withPosition(), 'ETF');
  const original = structuredClone(state);
  assert.throws(() => reorderGroup(state, 'missing', state.groups[0].id), /分类已不存在/);
  assert.throws(() => reorderGroup(state, state.groups[0].id, 'missing'), /分类已不存在/);
  assert.deepEqual(state, original);
});

test('同组十只证券仍可拖拽排序，持仓和证券信息保持不变', () => {
  let state = withPosition();
  const groupId = state.groups[0].id;
  for (let i = 1; i < 10; i++) state = addSecurity(state, groupId, security(String(600000 + i)));
  const originalOrder = [...state.groups[0].symbols];
  const moved = reorderSecurity(state, groupId, groupId, 'sh600009', 'sh600000');
  assert.deepEqual(moved.groups[0].symbols, ['sh600009', ...originalOrder.slice(0, 9)]);
  const last = reorderSecurity(moved, groupId, groupId, 'sh600009');
  assert.deepEqual(last.groups[0].symbols, originalOrder);
  assert.deepEqual(last.positions, state.positions);
  assert.deepEqual(last.securities, state.securities);
  assert.deepEqual(state.groups[0].symbols, originalOrder);
  const noOp = reorderSecurity(state, groupId, groupId, 'sh600000', 'sh600000');
  assert.deepEqual(noOp, state);
  assert.notEqual(noOp, state);
});

test('同组向后拖拽根据删除后的目标位置插入，不产生偏移', () => {
  let state = withPosition();
  const id = state.groups[0].id;
  state = addSecurity(addSecurity(state, id, security('600001')), id, security('600002'));
  assert.deepEqual(reorderSecurity(state, id, id, 'sh600000', 'sh600002').groups[0].symbols,
    ['sh600001', 'sh600000', 'sh600002']);
});

test('跨组拖拽按指定目标插入并保留唯一持仓，不产生重复证券', () => {
  let state = addGroup(withPosition(), 'ETF');
  const [fromId, toId] = state.groups.map(group => group.id);
  state = addSecurity(state, toId, security('600001'));
  state = addSecurity(state, toId, { ...security('510300'), kind: 'fund' });
  const moved = reorderSecurity(state, fromId, toId, 'sh600000', 'sh510300');
  assert.deepEqual(moved.groups[0].symbols, []);
  assert.deepEqual(moved.groups[1].symbols, ['sh600001', 'sh600000', 'sh510300']);
  assert.deepEqual(moved.positions, state.positions);
  assert.deepEqual(moved.securities, state.securities);
  assert.deepEqual(reorderSecurity(state, fromId, toId, 'sh600000').groups[1].symbols,
    ['sh600001', 'sh510300', 'sh600000']);
});

test('跨组拖拽拒绝目标重复与第十一只，同组限制不误伤移动', () => {
  let state = addGroup(withPosition(), '目标');
  const [fromId, toId] = state.groups.map(group => group.id);
  state = addSecurity(state, toId, security());
  assert.throws(() => reorderSecurity(state, fromId, toId, 'sh600000'), /已包含/);
  state = removeSecurity(state, toId, 'sh600000');
  for (let i = 1; i <= 10; i++) state = addSecurity(state, toId, security(String(600000 + i)));
  const before = structuredClone(state);
  assert.throws(() => reorderSecurity(state, fromId, toId, 'sh600000', 'sh600001'), /已有 10/);
  assert.deepEqual(state, before);
});

test('证券拖拽拒绝失效来源和目标，原始序列与持仓不改变', () => {
  const state = addGroup(withPosition(), '目标');
  const [fromId, toId] = state.groups.map(group => group.id);
  const before = structuredClone(state);
  assert.throws(() => reorderSecurity(state, fromId, toId, 'sh600001'), /来源分类/);
  assert.throws(() => reorderSecurity(state, fromId, toId, 'sh600000', 'sh600001'), /目标位置/);
  assert.throws(() => reorderSecurity(state, fromId, fromId, 'sh600000', 'sh600001'), /目标位置/);
  assert.throws(() => reorderSecurity(state, fromId, 'missing', 'sh600000'), /分类已不存在/);
  assert.throws(() => reorderSecurity(state, 'missing', toId, 'sh600000'), /分类已不存在/);
  assert.deepEqual(state, before);
});

test('沪深指数可添加和恢复但禁止持仓，不接受其他市场指数', () => {
  let state = createInitialState();
  const id = state.groups[0].id;
  const shIndex: Security = { ...security('000001'), name: '上证指数', kind: 'index' };
  const szIndex: Security = { ...security('399001', 'sz'), name: '深证成指', kind: 'index' };
  state = addSecurity(addSecurity(state, id, shIndex), id, szIndex);
  assert.deepEqual(validateState(state), state);
  for (const symbol of ['sh000001', 'sz399001']) {
    assert.throws(() => setPosition(state, symbol, { quantity: 100, cost: 1 }), /指数只供盯盘/);
    assert.throws(() => validateState({ ...state, positions: { [symbol]: { quantity: 100, cost: 1 } } }), /指数只供盯盘/);
  }
  assert.throws(() => addSecurity(state, id, { ...security('00001', 'hk', 'HKD'), kind: 'index' }), /证券信息无效/);
  assert.throws(() => addSecurity(state, id, { ...security('920002', 'bj'), kind: 'index' }), /证券信息无效/);
  assert.deepEqual(summarize(state, { sh000001: quote('sh000001') }, TODAY), []);
});
