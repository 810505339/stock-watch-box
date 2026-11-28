import type { MarketInstrument } from './types';

type Market = MarketInstrument['market'];
export const MARKETS: readonly Market[] = ['sh', 'sz', 'bj', 'hk', 'london'];

// https://www.sse.com.cn/disclosure/dealinstruc/closed/
const mainlandHolidays = new Set([
  '2026-01-01', '2026-01-02', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-23', '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
]);
// HKEX securities market notices CT/075/25 and CT/077/26.
const hongKongHolidays = new Set([
  '2026-01-01', '2026-02-17', '2026-02-18', '2026-02-19', '2026-04-03', '2026-04-06',
  '2026-04-07', '2026-05-01', '2026-05-25', '2026-06-19', '2026-07-01', '2026-10-01',
  '2026-10-19', '2026-12-25', '2027-01-01', '2027-02-08', '2027-02-09', '2027-03-26',
  '2027-03-29', '2027-04-05', '2027-05-13', '2027-06-09', '2027-07-01', '2027-09-16',
  '2027-10-01', '2027-10-08', '2027-12-27',
]);
const hongKongHalfDays = new Set(['2026-02-16', '2026-12-24', '2026-12-31', '2027-02-05', '2027-12-24', '2027-12-31']);
const newYork = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// Spot metals have no exchange-wide session. Use the published New York XAU/XAG schedule.
function metalsOpen(now: number): boolean {
  const { year, month, day, weekday, hour, minute } =
    Object.fromEntries(newYork.formatToParts(now).map(part => [part.type, part.value]));
  const clock = Number(hour) * 60 + Number(minute);
  const date = `${year}-${month}-${day}`;
  const holiday = month === '12' && day === '25' || month === '01' && day === '01';
  // FTMO × OANDA's 2026 Thanksgiving schedule lists 21:30 / 21:45 (GMT+2).
  const close = date === '2026-11-26' ? 14 * 60 + 30 : date === '2026-11-27' ? 14 * 60 + 45 : 16 * 60 + 59;
  return weekday !== 'Sat' && ((!holiday && weekday !== 'Sun' && clock < close) ||
    (weekday !== 'Fri' && clock >= 18 * 60 + 5));
}

const CHINA_OFFSET = 8 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;
type Session = readonly [start: number, end: number];

function stockSessions(market: Exclude<Market, 'london'>, local: Date): readonly Session[] {
  const weekday = local.getUTCDay();
  if (weekday === 0 || weekday === 6) return [];
  const date = local.toISOString().slice(0, 10);
  if (market === 'hk') {
    if (hongKongHolidays.has(date)) return [];
    return hongKongHalfDays.has(date) ? [[540, 730]] : [[540, 720], [780, 970]];
  }
  return mainlandHolidays.has(date) ? [] : [[555, 690], [780, 900]];
}

export function marketIsOpen(market: Market, now = Date.now()): boolean {
  if (market === 'london') return metalsOpen(now);
  const local = new Date(now + CHINA_OFFSET);
  const clock = local.getUTCHours() * 60 + local.getUTCMinutes();
  return stockSessions(market, local).some(([start, end]) => start <= clock && clock < end);
}

export function lastStockClose(market: Exclude<Market, 'london'>, now = Date.now()): number {
  let midnight = Math.floor((now + CHINA_OFFSET) / DAY) * DAY;
  while (true) {
    const closes = stockSessions(market, new Date(midnight)).map(([, end]) => midnight - CHINA_OFFSET + end * 60_000);
    const close = closes.filter(time => time <= now).at(-1);
    if (close !== undefined) return close;
    midnight -= DAY;
  }
}
