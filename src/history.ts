import { normalizeSymbol, requestText } from './quotes';

export type Period = 'day' | 'week' | 'month';
export interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number | null; }
export interface History { candles: Candle[]; adjusted: boolean; }

export function parseHistory(raw: unknown, id: string, period: Period): History {
  const response = raw as { code?: number; data?: Record<string, Record<string, unknown>> } | null;
  const series = response?.code === 0 ? response.data?.[id] : undefined;
  const adjusted = series?.[`qfq${period}`];
  const rows = Array.isArray(adjusted) && adjusted.length ? adjusted : series?.[period];
  const values = new Map<string, Candle>();
  if (Array.isArray(rows)) for (const row of rows) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row[0])) continue;
    const [date, ...fields] = row;
    const [open, close, high, low, volume] = fields.slice(0, 5).map(field =>
      typeof field === 'number' || (typeof field === 'string' && field.trim()) ? Number(field) : NaN);
    if (![open, close, high, low].every(value => Number.isFinite(value) && value > 0) ||
        low > Math.min(open, close) || high < Math.max(open, close)) continue;
    values.set(date, { date, open, close, high, low, volume: Number.isFinite(volume) && volume >= 0 ? volume : null });
  }
  return { candles: [...values.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-300),
    adjusted: Array.isArray(adjusted) && rows === adjusted };
}

export function macd(candles: readonly Candle[]) {
  let fast = candles[0]?.close ?? 0;
  let slow = fast;
  let signal = 0;
  return candles.map(({ close }) => {
    fast += (close - fast) * 2 / 13;
    slow += (close - slow) * 2 / 27;
    const dif = fast - slow;
    signal += (dif - signal) * 2 / 10;
    return { dif, signal, histogram: 2 * (dif - signal) };
  });
}

export async function fetchHistory(symbol: string, period: Period, signal?: AbortSignal): Promise<History> {
  const id = normalizeSymbol(symbol);
  if (!id) throw new Error('此品种暂不提供 K 线');
  const endpoint = id.startsWith('hk') ? 'hkfqkline' : 'fqkline';
  const url = new URL(`https://web.ifzq.gtimg.cn/appstock/app/${endpoint}/get`);
  url.searchParams.set('param', `${id},${period},,,300,qfq`);
  const history = parseHistory(JSON.parse(await requestText(url.href, signal, 'utf-8')), id, period);
  if (!history.candles.length) throw new Error('腾讯暂未返回此周期的 K 线');
  return history;
}
