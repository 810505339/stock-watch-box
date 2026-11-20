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

export function macd(candles: readonly Pick<Candle, 'close'>[]) {
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

export interface MinutePoint { time: number; price: number; volume: number | null; }

export function parseIntraday(raw: unknown, id: string) {
  const response = raw as { code?: number; data?: Record<string, {
    data?: { date?: unknown; data?: unknown }; qt?: Record<string, unknown[]>;
  }> } | null;
  const series = response?.code === 0 ? response.data?.[id] : undefined;
  const session = series?.data;
  const date = typeof session?.date === 'string' && /^\d{8}$/.test(session.date)
    ? session.date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : '';
  const day = Date.parse(date + 'T00:00:00+08:00');
  if (!Number.isFinite(day) || !Array.isArray(session?.data) ||
      new Date(day + 8 * 3600_000).toISOString().slice(0, 10) !== date) {
    return { date: '', points: [], previousClose: null };
  }
  const rows = new Map<number, { time: number; price: number; cumulative: number | null }>();
  for (const value of session.data) {
    if (typeof value !== 'string') continue;
    const [clock, rawPrice, rawVolume] = value.trim().split(/\s+/);
    if (!/^([01]\d|2[0-3])[0-5]\d$/.test(clock)) continue;
    const price = Number(rawPrice);
    if (!Number.isFinite(price) || price <= 0) continue;
    const volume = Number(rawVolume);
    const time = day / 1000 + Number(clock.slice(0, 2)) * 3600 + Number(clock.slice(2)) * 60;
    rows.set(time, { time, price, cumulative: rawVolume && Number.isFinite(volume) && volume >= 0 ? volume : null });
  }
  let previous: number | null = 0;
  const points: MinutePoint[] = [...rows.values()].sort((a, b) => a.time - b.time).map(({ time, price, cumulative }) => {
    const volume = cumulative !== null && previous !== null && cumulative >= previous ? cumulative - previous : null;
    previous = cumulative;
    return { time, price, volume };
  });
  const close = Number(series?.qt?.[id]?.[4]);
  return { date, points, previousClose: close > 0 && Number.isFinite(close) ? close : null };
}

export class IntradayFeed {
  private readonly cache = new Map<string, { expires: number; value: Awaited<ReturnType<IntradayFeed['download']>> }>();
  private readonly pending = new Map<string, Promise<Awaited<ReturnType<IntradayFeed['download']>>>>();

  async load(symbol: string, retry = false) {
    const id = normalizeSymbol(symbol);
    if (!id) throw new Error('此品种暂不提供分时走势');
    const cached = this.cache.get(id);
    if (!retry && cached && Date.now() < cached.expires) return cached.value;
    const pending = this.pending.get(id);
    if (pending) return pending;
    const expires = Date.now() + 1_000;
    const request = this.download(id).then(value => {
      this.cache.delete(id);
      this.cache.set(id, { expires, value });
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
      return value;
    }).finally(() => this.pending.delete(id));
    this.pending.set(id, request);
    return request;
  }

  private async download(id: string) {
    const url = new URL('https://web.ifzq.gtimg.cn/appstock/app/minute/query');
    url.searchParams.set('code', id);
    const data = parseIntraday(JSON.parse(await requestText(url.href, undefined, 'utf-8')), id);
    if (!data.points.length) throw new Error('腾讯暂未返回此品种的分时数据');
    return { ...data, macd: macd(data.points.map(point => ({ close: point.price }))) };
  }
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
