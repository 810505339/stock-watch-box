import type { Currency, Market, MarketInstrument, MarketQuote, Quote, Security } from './types';

const QUOTE_URL = 'https://qt.gtimg.cn/q=';
const SEARCH_URL = 'https://smartbox.gtimg.cn/s3/?t=all&q=';
const BATCH_SIZE = 50;
const REQUEST_TIMEOUT = 10_000;
const FUND_TYPES = /^(?:(?:QDII-)?(?:ETF|LOF)|FJ|GP-FUND|REIT|REITS)$/i;

function kindFromType(type: string, market: Market): Security['kind'] | undefined {
  if (FUND_TYPES.test(type.trim())) return 'fund';
  if (/^(?:GP|GP-A)$/i.test(type.trim())) return 'stock';
  if (type.trim().toUpperCase() === 'ZS' && (market === 'sh' || market === 'sz')) return 'index';
  return undefined;
}

/** Market-qualified IDs prevent collisions such as the two different 000001s. */
export function normalizeSymbol(input: string): string | undefined {
  const value = input.trim().toLowerCase().replace(/^r_hk/, 'hk');
  const hk = /^hk(\d{1,5})$/.exec(value);
  if (hk) return `hk${hk[1].padStart(5, '0')}`;
  return /^(sh|sz|bj)\d{6}$/.test(value) ? value : undefined;
}

function splitId(id: string): { market: Market; code: string } | undefined {
  const normalized = normalizeSymbol(id);
  if (!normalized) return undefined;
  return { market: normalized.slice(0, 2) as Market, code: normalized.slice(2) };
}

function currencyFromFields(fields: string[], market: Market): Currency | undefined {
  const value = (fields[market === 'hk' ? 75 : 82] ?? '').trim().toUpperCase();
  if (value === 'CNY' || value === 'RMB') return 'CNY';
  if (value === 'HKD') return 'HKD';
  // Unknown explicit currencies (e.g. USD counters) must not be mislabeled HKD.
  if (value) return undefined;
  return market === 'hk' ? undefined : 'CNY';
}

function numeric(value: string | undefined, positive = false): number | null {
  const text = value?.trim() ?? '';
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  if (!Number.isFinite(number) || (positive && number <= 0)) return null;
  return number;
}

export function parseQuoteTime(value: string): { date: string; time: string } {
  const compact = value.trim().replace(/[-/ :]/g, '');
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(compact);
  if (!match) return { date: '', time: '' };
  const [, year, month, day, hour, minute, second] = match;
  const date = `${year}-${month}-${day}`;
  const time = `${date} ${hour}:${minute}:${second}`;
  const check = new Date(`${date}T${hour}:${minute}:${second}Z`);
  if (!Number.isFinite(check.getTime()) || check.toISOString().slice(0, 19) !== time.replace(' ', 'T')) {
    return { date: '', time: '' };
  }
  // Both exchanges report their local wall time in UTC+08:00. Do not use the OS zone.
  return { date, time };
}

function rawRecords(text: string): Array<{ id: string; fields: string[]; market: Market; code: string }> {
  const result: Array<{ id: string; fields: string[]; market: Market; code: string }> = [];
  const pattern = /(?:^|[;\r\n])\s*v_((?:r_)?hk\d{5}|(?:sh|sz|bj)\d{6})="([^"\r\n]*)"/g;
  for (const match of text.matchAll(pattern)) {
    const id = normalizeSymbol(match[1]);
    if (!id) continue;
    const details = splitId(id)!;
    const fields = match[2].split('~');
    if (fields.length < 33 || fields[2]?.trim() !== details.code || !fields[1]?.trim()) continue;
    result.push({ id, fields, ...details });
  }
  return result;
}

/** Parse text, never execute the JavaScript assignment returned by Tencent. */
export function parseTencentQuotes(text: string, fetchedAt = Date.now()): Record<string, Quote> {
  const quotes: Record<string, Quote> = {};
  for (const { id, fields, market } of rawRecords(text)) {
    const currency = currencyFromFields(fields, market);
    if (!currency) continue;
    const price = numeric(fields[3], true);
    const previousClose = numeric(fields[4], true);
    const difference = price !== null && previousClose !== null ? price - previousClose : null;
    const change = numeric(fields[31]) ?? difference;
    const changePercent = numeric(fields[32]) ?? (difference !== null && previousClose !== null ? difference / previousClose * 100 : null);
    quotes[id] = {
      id, name: fields[1].trim(), price, previousClose, change, changePercent, currency,
      ...parseQuoteTime(fields[30] ?? ''), fetchedAt,
    };
  }
  return quotes;
}

/** Quote metadata also distinguishes HK ETFs, which smartbox labels simply GP. */
export function parseTencentSecurities(text: string): Security[] {
  const securities: Security[] = [];
  for (const { id, fields, market, code } of rawRecords(text)) {
    const currency = currencyFromFields(fields, market);
    const kind = kindFromType(fields[market === 'hk' ? 63 : 61] ?? '', market);
    if (!currency || !kind) continue;
    securities.push({ id, code, name: fields[1].trim(), market, kind, currency });
  }
  return securities;
}

export function parseSearchResponse(text: string): Security[] {
  const match = /^\s*(?:var\s+)?v_hint\s*=\s*"((?:\\.|[^"\\])*)"\s*;?\s*$/.exec(text);
  if (!match) return [];
  let decoded: string;
  try { decoded = JSON.parse(`"${match[1]}"`) as string; } catch { return []; }
  if (decoded === 'N') return [];
  const seen = new Set<string>();
  const result: Security[] = [];
  for (const entry of decoded.split('^')) {
    const [marketText, code, name, , type = ''] = entry.split('~');
    if (!/^(sh|sz|bj|hk)$/.test(marketText ?? '') || !name) continue;
    const id = normalizeSymbol(`${marketText}${code}`);
    const kind = kindFromType(type, marketText as Market);
    if (!id || !kind || seen.has(id)) continue;
    const market = marketText as Market;
    seen.add(id);
    // Search candidates are enriched with authoritative quote metadata before return.
    result.push({ id, code: id.slice(2), name, market, kind, currency: market === 'hk' ? 'HKD' : 'CNY' });
  }
  return result;
}

export async function requestText(url: string, signal?: AbortSignal, encoding = 'gb18030'): Promise<string> {
  if (signal?.aborted) throw new Error('请求已取消');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Referer: 'https://stockapp.finance.qq.com/' },
    });
    if (!response.ok) throw new Error(`腾讯行情请求失败（HTTP ${response.status}）`);
    return new TextDecoder(encoding).decode(await response.arrayBuffer());
  } catch (error) {
    if (signal?.aborted) throw new Error('请求已取消');
    if (controller.signal.aborted) throw new Error('腾讯行情请求超时，请稍后重试');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

async function requestQuotes(ids: string[], signal?: AbortSignal): Promise<string> {
  const unique = [...new Set(ids.map(normalizeSymbol).filter((id): id is string => !!id))];
  const texts: string[] = [];
  let failures = 0;
  let lastError: unknown;
  for (let start = 0; start < unique.length; start += BATCH_SIZE) {
    if (signal?.aborted) throw new Error('请求已取消');
    const keys = unique.slice(start, start + BATCH_SIZE).map(id => id.startsWith('hk') ? `r_${id}` : id);
    try { texts.push(await requestText(QUOTE_URL + keys.join(','), signal)); }
    catch (error) {
      if (signal?.aborted) throw error;
      failures++;
      lastError = error;
    }
  }
  // Preserve successful batches; missing entries let the caller mark only those stale.
  if (failures && !texts.length) throw lastError;
  return texts.join('\n');
}

export async function fetchQuotes(securities: Security[], signal?: AbortSignal): Promise<Record<string, Quote>> {
  if (!securities.length) return {};
  const ids = new Set(securities.map(security => security.id));
  const result = parseTencentQuotes(await requestQuotes([...ids], signal));
  return Object.fromEntries(Object.entries(result).filter(([id]) => ids.has(id)));
}

export const MARKET_INSTRUMENTS: readonly MarketInstrument[] = [
  { id: 'sh000001', code: '000001', name: '上证指数', market: 'sh', kind: 'index', currency: 'CNY' },
  { id: 'sz399006', code: '399006', name: '创业板指', market: 'sz', kind: 'index', currency: 'CNY' },
  { id: 'sh000688', code: '000688', name: '科创50', market: 'sh', kind: 'index', currency: 'CNY' },
  { id: 'hf_XAU', code: 'XAU', name: '伦敦金', market: 'london', kind: 'metal', currency: 'USD' },
  { id: 'hf_XAG', code: 'XAG', name: '伦敦银', market: 'london', kind: 'metal', currency: 'USD' },
];

export function parseMetalQuotes(text: string, fetchedAt = Date.now()): Record<string, MarketQuote> {
  const result: Record<string, MarketQuote> = {};
  for (const match of text.matchAll(/(?:^|[;\r\n])\s*v_(hf_XAU|hf_XAG)="([^"\r\n]*)"/g)) {
    const [, id, record] = match;
    const fields = record.split(',');
    const price = numeric(fields[0], true);
    const previousClose = numeric(fields[7], true);
    const change = price !== null && previousClose !== null ? price - previousClose : null;
    result[id] = {
      id, name: id === 'hf_XAU' ? '伦敦金' : '伦敦银', currency: 'USD', price, previousClose, change,
      changePercent: numeric(fields[1]) ?? (change !== null && previousClose ? change / previousClose * 100 : null),
      ...parseQuoteTime(`${fields[12] ?? ''}${fields[6] ?? ''}`), fetchedAt,
    };
  }
  return result;
}

export async function fetchMarketMetals(instruments: readonly MarketInstrument[], signal?: AbortSignal): Promise<Record<string, MarketQuote>> {
  const ids = MARKET_INSTRUMENTS.filter(item => item.kind === 'metal' && instruments.some(active => active.id === item.id))
    .map(item => item.id);
  return ids.length ? parseMetalQuotes(await requestText(QUOTE_URL + ids.join(','), signal)) : {};
}

export async function searchSecurities(query: string, signal?: AbortSignal): Promise<Security[]> {
  const term = query.trim();
  if (!term || term.length > 80) return [];
  const direct = normalizeSymbol(term);
  if (direct) {
    const result = parseTencentSecurities(await requestQuotes([direct], signal));
    return result.filter(security => security.id === direct);
  }
  const candidates = parseSearchResponse(await requestText(SEARCH_URL + encodeURIComponent(term), signal));
  const candidateIds = candidates.map(security => security.id);
  // Tencent smartbox sometimes omits Beijing listings entirely.
  if (/^(?:43|83|87|88|92)\d{4}$/.test(term)) candidateIds.push(`bj${term}`);
  if (!candidateIds.length) return [];
  const enriched = new Map(parseTencentSecurities(await requestQuotes(candidateIds, signal)).map(security => [security.id, security]));
  const unique = [...new Set(candidateIds)].map(id => enriched.get(id)).filter((security): security is Security => !!security);
  return unique.sort((a, b) => Number(b.code === term) - Number(a.code === term));
}
