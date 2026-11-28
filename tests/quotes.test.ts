import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { normalizeSymbol, parseQuoteTime, parseSearchResponse, parseTencentQuotes, parseTencentSecurities, fetchQuotes, searchSecurities } from '../src/quotes';
import type { Security } from '../src/types';

function fixture(id: string, fields: Record<number, string> = {}): string {
  const hk = id.includes('hk');
  const code = id.replace(/^(?:r_)?(?:hk|sh|sz|bj)/, '');
  const values = Array<string>(88).fill('');
  const base: Record<number, string> = { 0: hk ? '100' : '1', 1: hk ? '腾讯控股' : '沪深300ETF', 2: code, 3: '4.042', 4: '4.054', 30: hk ? '2026/11/17 16:08:19' : '20261117161455', 31: '-0.012', 32: '-0.30', [hk ? 63 : 61]: hk ? 'GP' : 'ETF', [hk ? 75 : 82]: hk ? 'HKD' : 'CNY' };
  for (const [key, value] of Object.entries({ ...base, ...fields })) values[Number(key)] = value;
  return `v_${id}="${values.join('~')}";`;
}

test('canonical IDs normalize HK prefixes and reject unqualified or malformed codes', () => {
  assert.equal(normalizeSymbol('r_hk00700'), 'hk00700');
  assert.equal(normalizeSymbol('HK700'), 'hk00700');
  assert.equal(normalizeSymbol('bj920002'), 'bj920002');
  assert.equal(normalizeSymbol('000001'), undefined);
  assert.equal(normalizeSymbol('sh600000;evil()'), undefined);
});

test('source timestamps have stable UTC+8 calendar dates and reject impossible dates', () => {
  assert.deepEqual(parseQuoteTime('20261117161455'), { date: '2026-11-17', time: '2026-11-17 16:14:55' });
  assert.deepEqual(parseQuoteTime('2026/11/17 16:08:19'), { date: '2026-11-17', time: '2026-11-17 16:08:19' });
  assert.deepEqual(parseQuoteTime('20260230120000'), { date: '', time: '' });
  assert.deepEqual(parseQuoteTime('garbage'), { date: '', time: '' });
});

test('search safely decodes names and permits mainland indices and ETF/LOF while excluding warrants and OTC funds', () => {
  const payload = 'sh~000001~上证指数~szzs~ZS^sz~000001~平安银行~payh~GP-A^sh~510300~沪深300ETF~hs300~ETF^sz~161725~白酒基金LOF~bj~LOF^sh~501018~南方原油LOF~nf~QDII-LOF^sh~513100~纳指ETF~nz~QDII-ETF^jj~000001~基金~jj~KJ^hk~13005~认购证~qz~QZ';
  const parsed = parseSearchResponse(`v_hint=${JSON.stringify(payload)};`);
  assert.deepEqual(parsed.map(s => s.id), ['sh000001', 'sz000001', 'sh510300', 'sz161725', 'sh501018', 'sh513100']);
  assert.equal(parsed[0].kind, 'index');
  assert.equal(parsed[1].kind, 'stock');
  assert.equal(parsed[2].kind, 'fund');
  assert.equal(parseSearchResponse('v_hint="sh~510300~\\u6caa\\u6df1300ETF~hs~ETF"')[0].name, '沪深300ETF');
  assert.deepEqual(parseSearchResponse('v_hint="N";'), []);
  assert.deepEqual(parseSearchResponse('v_hint="N";globalThis.injected=true;'), []);
});

test('mixed quotes preserve 3-decimal fund prices, normalize HK IDs and use actual currency', () => {
  const parsed = parseTencentQuotes(fixture('sh510300') + '\n' + fixture('r_hk80700', { 75: 'CNY' }), 123);
  assert.equal(parsed.sh510300.price, 4.042);
  assert.equal(parsed.sh510300.changePercent, -0.3);
  assert.equal(parsed.hk80700.currency, 'CNY');
  assert.equal(parsed.hk80700.fetchedAt, 123);
  assert.equal(parsed.hk80700.date, '2026-11-17');
  assert.equal(parsed.r_hk80700, undefined);
});

test('missing and zero prices remain null; flat changes remain zero', () => {
  const quote = parseTencentQuotes(fixture('sh510300', { 3: '0', 4: '', 31: '0', 32: '0' })).sh510300;
  assert.equal(quote.price, null);
  assert.equal(quote.previousClose, null);
  assert.equal(quote.change, 0);
  assert.equal(quote.changePercent, 0);
  assert.equal(parseTencentQuotes(fixture('sh510300', { 3: '12x' })).sh510300.price, null);
  assert.equal(parseTencentQuotes('v_pv_none_match="1";').sh510300, undefined);
});

test('quote metadata recognizes HK funds and excludes unsupported instruments/currencies', () => {
  const text = fixture('r_hk02800', { 63: 'GP-FUND' }) + fixture('sh501018', { 61: 'LOF' }) + fixture('sh000001', { 61: 'ZS' }) + fixture('r_hk13005', { 63: 'QZ-CALL' }) + fixture('r_hk09072', { 75: 'USD' });
  const parsed = parseTencentSecurities(text);
  assert.deepEqual(parsed.map(s => [s.id, s.kind]), [['hk02800', 'fund'], ['sh501018', 'fund'], ['sh000001', 'index']]);
  assert.equal(parseTencentQuotes(text).hk09072, undefined);
});

test('direct prefix lookups use quotation metadata, not ambiguous bare code inference', async t => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(fixture('sh000001', { 61: 'ZS', 1: 'Index' }));
  });
  assert.deepEqual((await searchSecurities('sh000001')).map(s => [s.id, s.kind]), [['sh000001', 'index']]);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /q=sh000001$/);
});

test('all three mainland benchmark indices retain identity and index kind', () => {
  const symbols = ['sh000001', 'sz399001', 'sz399006'];
  const text = symbols.map(id => fixture(id, { 61: 'ZS', 3: '3584.58' })).join('\n');
  assert.deepEqual(parseTencentSecurities(text).map(s => [s.id, s.kind]), symbols.map(id => [id, 'index']));
  const quotes = parseTencentQuotes(text);
  assert.equal(Object.keys(quotes).length, 3);
  assert.equal(quotes.sh000001.price, 3584.58);
  assert.deepEqual(parseTencentSecurities(fixture('r_hk00001', { 63: 'ZS' })), []);
});

test('bare 000001 search returns both Shanghai index and Shenzhen stock without merging', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (String(url).includes('smartbox')) {
      return new Response('v_hint="sh~000001~Index~index~ZS^sz~000001~Bank~bank~GP-A^jj~000001~OTC~otc~KJ"');
    }
    return new Response(fixture('sh000001', { 61: 'ZS', 1: 'Index' }) + fixture('sz000001', { 61: 'GP-A', 1: 'Bank' }));
  });
  assert.deepEqual((await searchSecurities('000001')).map(s => [s.id, s.kind]), [['sh000001', 'index'], ['sz000001', 'stock']]);
});

test('按市场解析成交量和成交额，保留精确金额并兼容 A 股万元字段', () => {
  const quotes = parseTencentQuotes(
    fixture('sh000001', { 35: '3606.49/634626966/929777242144', 36: '634626966', 37: '92977724' }) +
    fixture('sz159915', { 36: '1200', 37: '200' }) +
    fixture('r_hk00700', { 36: '35593034.0', 37: '12403560872.650' }),
  );
  assert.equal(quotes.sh000001.volume, 634626966);
  assert.equal(quotes.sh000001.turnover, 929777242144);
  assert.equal(quotes.sz159915.turnover, 2_000_000);
  assert.equal(quotes.hk00700.volume, 35593034);
  assert.equal(quotes.hk00700.turnover, 12403560872.65);
});

test('fetch batches at 50 and keeps successful data when another batch fails', async t => {
  const securities: Security[] = Array.from({ length: 51 }, (_, i) => ({ id: `sh${600000 + i}`, code: String(600000 + i), name: 'Stock', market: 'sh', kind: 'stock', currency: 'CNY' }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    calls++;
    const keys = String(url).split('q=')[1].split(',');
    assert.ok(keys.length <= 50);
    if (calls === 2) throw new Error('offline');
    return new Response(keys.map(id => fixture(id, { 1: 'Stock', 61: 'GP' })).join('\n'));
  });
  const result = await fetchQuotes(securities);
  assert.equal(calls, 2);
  assert.equal(Object.keys(result).length, 50);
  assert.equal(result.sh600050, undefined);
});

test('an already cancelled request never performs network I/O', async t => {
  const mocked = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchSecurities('510300', controller.signal), /取消/);
  assert.equal(mocked.mock.calls.length, 0);
});
