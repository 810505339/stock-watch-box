import { randomUUID } from 'node:crypto';
import type { Currency, CurrencySummary, Group, Metrics, PortfolioState, Position, Quote, Security } from './types';

export const MAX_GROUP_SIZE = 10;
const MAX_QUANTITY = 1_000_000_000;
const MAX_COST = 1_000_000;
const SYMBOL = /^(?:(?:sh|sz|bj)\d{6}|hk\d{5})$/;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = <T>(object: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;

export function chinaDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function groupName(name: string): string {
  if (typeof name !== 'string' || !name.trim() || [...name.trim()].length > 30) {
    throw new Error('分类名称须为 1–30 个字符。');
  }
  return name.trim();
}

function assertPosition(position: unknown): asserts position is Position {
  if (!record(position) || !Number.isSafeInteger(position.quantity) ||
      (position.quantity as number) <= 0 || (position.quantity as number) > MAX_QUANTITY) {
    throw new Error('持股数量须为 1–1,000,000,000 之间的整数（单位：股 / 份）。');
  }
  if (typeof position.cost !== 'number' || !Number.isFinite(position.cost) ||
      position.cost < 0 || position.cost > MAX_COST ||
      position.cost * (position.quantity as number) > Number.MAX_SAFE_INTEGER / 100) {
    throw new Error('每股 / 份成本须为 0–1,000,000 之间的数字，且持仓总成本不能超过安全计算范围。');
  }
}

function assertSecurity(security: unknown): asserts security is Security {
  if (!record(security) || typeof security.id !== 'string' || !SYMBOL.test(security.id) ||
      !['sh', 'sz', 'bj', 'hk'].includes(String(security.market)) ||
      security.id !== `${security.market}${security.code}` ||
      typeof security.code !== 'string' || typeof security.name !== 'string' || !security.name.trim() ||
      !['stock', 'fund', 'index'].includes(String(security.kind)) || !['CNY', 'HKD'].includes(String(security.currency)) ||
      (security.kind === 'index' && security.market !== 'sh' && security.market !== 'sz')) {
    throw new Error('证券信息无效，请重新搜索添加。');
  }
}

function getGroup(state: PortfolioState, id: string): Group {
  const group = state.groups.find(item => item.id === id);
  if (!group) throw new Error('分类已不存在，请重试。');
  return group;
}

function assertUniqueName(state: PortfolioState, name: string, except?: string): void {
  if (state.groups.some(group => group.id !== except && group.name === name)) {
    throw new Error('已经存在同名分类。');
  }
}

function copy(state: PortfolioState): PortfolioState {
  return {
    version: 1,
    groups: state.groups.map(group => ({ ...group, symbols: [...group.symbols] })),
    securities: { ...state.securities },
    positions: { ...state.positions },
  };
}

function collectOrphans(state: PortfolioState): PortfolioState {
  const referenced = new Set(state.groups.flatMap(group => group.symbols));
  for (const symbol of Object.keys(state.securities)) {
    if (!referenced.has(symbol)) {
      delete state.securities[symbol];
      delete state.positions[symbol];
    }
  }
  return state;
}

export function createInitialState(): PortfolioState {
  return { version: 1, groups: [{ id: randomUUID(), name: '自选', symbols: [] }], securities: {}, positions: {} };
}

/** Validate the entire persisted snapshot before accepting it. Invalid saved data is never silently reset. */
export function validateState(input: unknown): PortfolioState {
  if (input === undefined || input === null) return createInitialState();
  if (!record(input) || input.version !== 1 || !Array.isArray(input.groups) ||
      !record(input.securities) || !record(input.positions)) {
    throw new Error('本地盯盘数据格式或版本不正确，原始数据已保留。');
  }
  const groups: Group[] = [];
  const groupIds = new Set<string>();
  const groupNames = new Set<string>();
  const references = new Set<string>();
  for (const value of input.groups) {
    if (!record(value) || typeof value.id !== 'string' || !value.id || value.id.length > 128 ||
        groupIds.has(value.id) || typeof value.name !== 'string' || !Array.isArray(value.symbols) ||
        value.symbols.length > MAX_GROUP_SIZE || new Set(value.symbols).size !== value.symbols.length ||
        value.symbols.some(symbol => typeof symbol !== 'string' || !SYMBOL.test(symbol))) {
      throw new Error('本地分类数据无效，原始数据已保留。');
    }
    const name = groupName(value.name);
    if (groupNames.has(name)) throw new Error('本地数据包含同名分类，原始数据已保留。');
    groupIds.add(value.id);
    groupNames.add(name);
    const symbols = value.symbols as string[];
    symbols.forEach(symbol => references.add(symbol));
    groups.push({ id: value.id, name, symbols: [...symbols] });
  }
  const securities: Record<string, Security> = {};
  for (const [symbol, value] of Object.entries(input.securities)) {
    assertSecurity(value);
    if (symbol !== value.id || !references.has(symbol)) {
      throw new Error('本地证券与分类不匹配，原始数据已保留。');
    }
    securities[symbol] = { id: value.id, code: value.code, name: value.name.trim(), market: value.market, kind: value.kind, currency: value.currency };
  }
  for (const symbol of references) {
    if (!own(securities, symbol)) throw new Error('本地分类引用的证券信息缺失，原始数据已保留。');
  }
  const positions: Record<string, Position> = {};
  for (const [symbol, value] of Object.entries(input.positions)) {
    if (!own(securities, symbol)) throw new Error('本地持仓引用的证券信息缺失，原始数据已保留。');
    if (securities[symbol].kind === 'index') throw new Error('指数只供盯盘，不能录入持仓；本地原始数据已保留。');
    assertPosition(value);
    positions[symbol] = { quantity: value.quantity, cost: value.cost };
  }
  return { version: 1, groups, securities, positions };
}

export function addGroup(state: PortfolioState, name: string): PortfolioState {
  name = groupName(name);
  assertUniqueName(state, name);
  const next = copy(state);
  next.groups.push({ id: randomUUID(), name, symbols: [] });
  return next;
}

export function renameGroup(state: PortfolioState, groupId: string, name: string): PortfolioState {
  getGroup(state, groupId);
  name = groupName(name);
  assertUniqueName(state, name, groupId);
  const next = copy(state);
  getGroup(next, groupId).name = name;
  return next;
}

export function removeGroup(state: PortfolioState, groupId: string): PortfolioState {
  getGroup(state, groupId);
  const next = copy(state);
  next.groups = next.groups.filter(group => group.id !== groupId);
  return collectOrphans(next);
}

/** Move a category immediately before another category, or to the end. */
export function reorderGroup(state: PortfolioState, groupId: string, beforeId?: string): PortfolioState {
  getGroup(state, groupId);
  if (beforeId !== undefined) getGroup(state, beforeId);
  const next = copy(state);
  if (groupId === beforeId) return next;
  const index = next.groups.findIndex(group => group.id === groupId);
  const [moving] = next.groups.splice(index, 1);
  const target = beforeId === undefined ? next.groups.length : next.groups.findIndex(group => group.id === beforeId);
  next.groups.splice(target, 0, moving);
  return next;
}

export function addSecurity(state: PortfolioState, groupId: string, security: Security): PortfolioState {
  assertSecurity(security);
  const group = getGroup(state, groupId);
  if (group.symbols.includes(security.id)) throw new Error('该证券已在此分类中。');
  if (group.symbols.length >= MAX_GROUP_SIZE) throw new Error('每个分类最多添加 10 只股票、场内基金或指数。');
  if (security.kind === 'index' && own(state.positions, security.id)) throw new Error('指数只供盯盘，不能录入持仓。');
  const next = copy(state);
  next.securities[security.id] = { ...security };
  getGroup(next, groupId).symbols.push(security.id);
  return next;
}

export function removeSecurity(state: PortfolioState, groupId: string, symbol: string): PortfolioState {
  const group = getGroup(state, groupId);
  if (!group.symbols.includes(symbol)) throw new Error('该证券已不在此分类中。');
  const next = copy(state);
  getGroup(next, groupId).symbols = group.symbols.filter(id => id !== symbol);
  return collectOrphans(next);
}

export function moveSecurity(state: PortfolioState, fromId: string, toId: string, symbol: string): PortfolioState {
  const source = getGroup(state, fromId);
  const target = getGroup(state, toId);
  if (!source.symbols.includes(symbol)) throw new Error('该证券已不在此分类中。');
  if (fromId === toId) return copy(state);
  if (target.symbols.includes(symbol)) throw new Error('目标分类已包含该证券。');
  if (target.symbols.length >= MAX_GROUP_SIZE) throw new Error('目标分类已有 10 只证券，请先移除一只。');
  const next = copy(state);
  getGroup(next, fromId).symbols = source.symbols.filter(id => id !== symbol);
  getGroup(next, toId).symbols.push(symbol);
  return next;
}

/** Reorder a row in its category or move it to an exact position in another category. */
export function reorderSecurity(state: PortfolioState, fromGroupId: string, toGroupId: string, symbol: string, beforeSymbol?: string): PortfolioState {
  const source = getGroup(state, fromGroupId);
  const target = getGroup(state, toGroupId);
  if (!source.symbols.includes(symbol)) throw new Error('该证券已不在来源分类中，请重试。');
  if (beforeSymbol !== undefined && !target.symbols.includes(beforeSymbol)) {
    throw new Error('目标位置的证券已不存在，请重试。');
  }
  const sameGroup = fromGroupId === toGroupId;
  if (!sameGroup) {
    if (target.symbols.includes(symbol)) throw new Error('目标分类已包含该证券。');
    if (target.symbols.length >= MAX_GROUP_SIZE) throw new Error('目标分类已有 10 只证券，请先移除一只。');
  }
  const next = copy(state);
  if (sameGroup && symbol === beforeSymbol) return next;
  const nextSource = getGroup(next, fromGroupId);
  const nextTarget = getGroup(next, toGroupId);
  nextSource.symbols = nextSource.symbols.filter(id => id !== symbol);
  const targetIndex = beforeSymbol === undefined ? nextTarget.symbols.length : nextTarget.symbols.indexOf(beforeSymbol);
  nextTarget.symbols.splice(targetIndex, 0, symbol);
  return next;
}

export function setPosition(state: PortfolioState, symbol: string, position: Position): PortfolioState {
  if (!own(state.securities, symbol)) throw new Error('请先添加该证券到自选分类。');
  if (state.securities[symbol].kind === 'index') throw new Error('指数只供盯盘，不能录入持仓。');
  assertPosition(position);
  const next = copy(state);
  next.positions[symbol] = { ...position };
  return next;
}

export function clearPosition(state: PortfolioState, symbol: string): PortfolioState {
  if (!own(state.securities, symbol)) throw new Error('证券已不存在。');
  const next = copy(state);
  delete next.positions[symbol];
  return next;
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const safe = (value: number): number | null => Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
const ratio = (value: number | null, base: number): number | null => value !== null && base > 0 ? safe(value / base * 100) : null;

export function positionMetrics(position: Position, quote?: Quote, today = chinaDate()): Metrics {
  assertPosition(position);
  const costValue = position.cost * position.quantity;
  const marketValue = positive(quote?.price) ? safe(quote.price * position.quantity) : null;
  const profit = marketValue !== null ? safe((quote!.price! - position.cost) * position.quantity) : null;
  const dailyValid = marketValue !== null && positive(quote?.previousClose) && !quote?.stale && quote?.date === today;
  const daily = dailyValid ? safe((quote!.price! - quote!.previousClose!) * position.quantity) : null;
  return {
    daily,
    dailyPercent: ratio(daily, (quote?.previousClose ?? 0) * position.quantity),
    profit,
    profitPercent: ratio(profit, costValue),
    marketValue,
    costValue,
  };
}

export function summarize(state: PortfolioState, quotes: Record<string, Quote>, today: string): CurrencySummary[] {
  const buckets = new Map<Currency, {
    count: number; validCount: number; profitCount: number; dailyCount: number;
    daily: number; previousValue: number; profit: number; costValue: number; marketValue: number;
    incomplete: boolean; dates: Set<string>;
  }>();
  // Positions are keyed by canonical security ID, so the same stock in several groups is counted once.
  for (const [symbol, position] of Object.entries(state.positions)) {
    const security = own(state.securities, symbol);
    if (!security || security.kind === 'index') continue;
    const quote = own(quotes, symbol);
    const currency = quote?.currency === 'CNY' || quote?.currency === 'HKD' ? quote.currency : security.currency;
    let bucket = buckets.get(currency);
    if (!bucket) {
      bucket = { count: 0, validCount: 0, profitCount: 0, dailyCount: 0, daily: 0, previousValue: 0,
        profit: 0, costValue: 0, marketValue: 0, incomplete: false, dates: new Set() };
      buckets.set(currency, bucket);
    }
    bucket.count++;
    const metrics = positionMetrics(position, quote, today);
    if (metrics.profit !== null && metrics.marketValue !== null) {
      bucket.profitCount++;
      bucket.profit += metrics.profit;
      bucket.costValue += metrics.costValue;
      bucket.marketValue += metrics.marketValue;
      if (quote?.date) bucket.dates.add(quote.date);
    }
    if (metrics.daily !== null) {
      bucket.dailyCount++;
      bucket.daily += metrics.daily;
      bucket.previousValue += quote!.previousClose! * position.quantity;
    }
    if (metrics.daily !== null && metrics.profit !== null) bucket.validCount++;
    else bucket.incomplete = true;
  }
  return (['CNY', 'HKD'] as const).flatMap(currency => {
    const bucket = buckets.get(currency);
    if (!bucket) return [];
    const daily = bucket.dailyCount ? safe(bucket.daily) : null;
    const profit = bucket.profitCount ? safe(bucket.profit) : null;
    const date = bucket.dates.size === 1 ? [...bucket.dates][0] : today;
    return [{
      currency, daily, dailyPercent: ratio(daily, bucket.previousValue),
      profit, profitPercent: ratio(profit, bucket.costValue),
      marketValue: bucket.profitCount ? safe(bucket.marketValue) : null,
      count: bucket.count, validCount: bucket.validCount,
      incomplete: bucket.incomplete || bucket.dates.size > 1 || profit === null,
      date,
    }];
  });
}
