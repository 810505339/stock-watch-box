import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { macd, parseHistory } from '../src/history';
import { fetchMarketMetals, MARKET_INSTRUMENTS, parseMetalQuotes } from '../src/quotes';

test('Tencent K lines normalize OHLC field order and discard malformed candles', () => {
  const result = parseHistory({ code: 0, data: { sh600519: { qfqday: [
    ['2026-11-20', '10', '12', '13', '9', '120'],
    ['2026-11-19', '9', '10', '11', '8', ''],
    ['2026-11-18', '12', '13', '11', '9', '120'],
  ] } } }, 'sh600519', 'day');
  assert.equal(result.adjusted, true);
  assert.deepEqual(result.candles, [
    { date: '2026-11-19', open: 9, high: 11, low: 8, close: 10, volume: null },
    { date: '2026-11-20', open: 10, high: 13, low: 9, close: 12, volume: 120 },
  ]);
  assert.equal(parseHistory({ code: 0, data: { sh000688: { day: [
    ['2026-11-20', '10', '12', '13', '9', '120'],
  ] } } }, 'sh000688', 'day').adjusted, false);
});

test('MACD uses EMA 12, EMA 26, signal EMA 9 and the doubled histogram', () => {
  const result = macd([10, 12, 12].map(close => ({ date: '', open: close, close, high: close, low: close, volume: null })));
  assert.deepEqual(result[0], { dif: 0, signal: 0, histogram: 0 });
  const rounded = (number: number) => Number(number.toFixed(6));
  assert.deepEqual(result.slice(1).map(item => Object.values(item).map(rounded)),
    [[0.159544, 0.031909, 0.255271], [0.282725, 0.082072, 0.401306]]);
});

test('London quotes use the spot symbols, dollar pricing and Tencent timestamp', async () => {
  const raw = 'v_hf_XAU="3545.03,-2.21,3545.03,3545.38,3636.63,3514.62,00:22:00,3625.01,3628.88,0,0,0,2026-11-21,伦敦金";';
  const quote = parseMetalQuotes(raw, 1).hf_XAU;
  assert.equal(quote.name, '伦敦金');
  assert.equal(quote.currency, 'USD');
  assert.equal(quote.time, '2026-11-21 00:22:00');
  assert.equal(quote.changePercent, -2.21);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await fetchMarketMetals(MARKET_INSTRUMENTS.filter(item => item.kind === 'index'), controller.signal), {});
});
