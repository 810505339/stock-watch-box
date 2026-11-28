import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import type { PortfolioState, Snapshot } from '../src/types';

// Exercise the actual extension entry point and its Webview message boundary,
// without starting Electron or allowing any real network/storage side effects.
const extensionCode = buildSync({
  entryPoints: [resolve(__dirname, '../src/extension.ts')],
  bundle: true, write: false, platform: 'node', format: 'cjs',
  target: 'node18', external: ['vscode'], logLevel: 'silent',
}).outputFiles[0].text;
const nodeRequire = createRequire(resolve(__dirname, 'position-flow.test.ts'));
const STORAGE_KEY = 'portfolio.v1';
const ROW = { groupId: 'funds', symbol: 'sh510300' };
const tick = () => new Promise<void>(done => setImmediate(done));

function fixture(): PortfolioState {
  return {
    version: 1,
    groups: [{ id: ROW.groupId, name: '场内基金', symbols: [ROW.symbol] }],
    securities: {
      sh510300: { id: ROW.symbol, code: '510300', name: '沪深300ETF', market: 'sh', kind: 'fund', currency: 'CNY' },
    },
    positions: {},
  };
}

class Memory {
  readonly values = new Map<string, unknown>([[STORAGE_KEY, fixture()]]);
  readonly updates: Array<{ key: string; value: unknown }> = [];
  failUpdates = false;
  get(key: string): unknown { return structuredClone(this.values.get(key)); }
  async update(key: string, value: unknown): Promise<void> {
    if (this.failUpdates) throw new Error('本地存储写入失败');
    const saved = structuredClone(value);
    this.updates.push({ key, value: saved });
    this.values.set(key, saved);
  }
}

interface Disposable { dispose(): void; }
interface Provider { resolveWebviewView(view: unknown): void; }
interface Response { type: 'positionResult'; requestId: string; ok: boolean; error?: string; }
type Message = Record<string, unknown>;

function activateHarness(memory = new Memory(), options?: { now: number; visible: boolean; response?: (url: string) => globalThis.Response }) {
  const disposable = (): Disposable => ({ dispose() {} });
  const messages: Message[] = [];
  const commands = new Map<string, (arg?: unknown) => unknown>();
  const pending = new Map<string, (response: Response) => void>();
  const subscriptions: Disposable[] = [];
  let provider: Provider | undefined;
  let receive: ((message: unknown) => void) | undefined;
  let inputBoxCalls = 0;
  let shown = 0;
  let networkCalls = 0;
  const requested: string[] = [];
  const Clock = class extends Date {
    constructor(value?: string | number) { super(value ?? options!.now); }
    static now() { return options!.now; }
  };
  const fakeVscode = {
    Uri: { joinPath: (base: unknown, ...segments: string[]) => `${String(base)}/${segments.join('/')}` },
    workspace: {
      onDidChangeConfiguration: () => disposable(),
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      registerWebviewViewProvider: (_id: string, value: Provider) => { provider = value; return disposable(); },
      showInputBox: async () => { inputBoxCalls++; throw new Error('持仓操作不应调用原生输入框'); },
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showQuickPick: async () => undefined,
      createQuickPick: () => { throw new Error('此流程不应搜索股票'); },
    },
    commands: {
      registerCommand: (name: string, command: (arg?: unknown) => unknown) => { commands.set(name, command); return disposable(); },
      executeCommand: async (name: string, arg?: unknown) => commands.get(name)?.(arg),
    },
  };
  const module = { exports: {} as { activate(context: unknown): { getSnapshot(): Snapshot } } };
  runInNewContext(extensionCode, {
    module, exports: module.exports,
    require: (id: string) => id === 'vscode' ? fakeVscode : nodeRequire(id),
    Error, structuredClone, AbortController, TextDecoder, setTimeout, clearTimeout, console, URL,
    Date: options ? Clock : Date,
    fetch: async (url: string) => {
      networkCalls++;
      requested.push(url);
      if (options?.response) return options.response(url);
      throw new Error('测试禁止网络请求');
    },
  }, { filename: 'extension-under-test.cjs' });
  const api = module.exports.activate({ globalState: memory, extensionUri: 'file:///extension-test', subscriptions });
  assert.ok(provider, 'activation must register the actual Webview provider');
  const view = {
    visible: options?.visible ?? false,
    show: () => { shown++; },
    onDidChangeVisibility: () => disposable(),
    onDidDispose: () => disposable(),
    webview: {
      options: {}, html: '', cspSource: 'vscode-webview://test',
      asWebviewUri: (uri: unknown) => String(uri),
      onDidReceiveMessage: (handler: (message: unknown) => void) => { receive = handler; return disposable(); },
      postMessage: async (message: Message) => {
        const saved = structuredClone(message);
        messages.push(saved);
        if (saved.type === 'positionResult' && typeof saved.requestId === 'string') {
          pending.get(saved.requestId)?.(saved as unknown as Response);
          pending.delete(saved.requestId);
        }
        return true;
      },
    },
  };
  provider.resolveWebviewView(view);
  assert.ok(receive, 'the provider must listen to Webview messages');
  let sequence = 0;
  return {
    api, memory, messages, requested,
    stats: () => ({ inputBoxCalls, shown, networkCalls }),
    emit: (message: unknown) => receive!(message),
    async save(fields: Message = {}): Promise<Response> {
      const requestId = `save-${++sequence}`;
      const response = await new Promise<Response>((done, reject) => {
        const timer = setTimeout(() => reject(new Error(`No positionResult for ${requestId}`)), 1000);
        pending.set(requestId, value => { clearTimeout(timer); done(value); });
        receive!({ type: 'savePosition', ...ROW, quantity: '100', cost: '3.125', ...fields, requestId });
      });
      await tick();
      return response;
    },
    async command(name: string, arg?: unknown): Promise<void> {
      const handler = commands.get(name);
      assert.ok(handler, `missing command ${name}`);
      await handler(arg);
      await tick();
    },
    dispose() { for (const subscription of [...subscriptions].reverse()) subscription.dispose(); },
  };
}

function marketResponse(url: string) {
  if (url.includes('/day/query')) {
    return Response.json({ code: 0, data: { sh510300: { data: [
      { date: '20261126', data: ['1500 4.1 160'] }, { date: '20261127', data: ['1500 4.2 180'] },
    ] } } });
  }
  const symbols = url.split('q=')[1].split(',');
  return new Response(symbols.map(id => {
    if (id.startsWith('hf_')) return `v_${id}="35,1,0,0,0,0,15:00:00,34,0,0,0,0,2026-11-27";`;
    const fields = Array<string>(83).fill('');
    Object.assign(fields, { 1: 'TEST', 2: id.slice(2), 3: '4.2', 4: '4.1', 30: '20261127150000' });
    return `v_${id}="${fields.join('~')}";`;
  }).join(''));
}

test('周末无缓存时补取一次收盘报价与分时，重启后直接读报价缓存', async t => {
  const opts = { now: Date.parse('2026-11-28T10:00:00+08:00'), visible: true, response: marketResponse };
  const memory = new Memory();
  const harness = activateHarness(memory, opts);
  t.after(() => harness.dispose());
  harness.emit({ type: 'ready' });
  await tick();
  assert.equal(harness.api.getSnapshot().quotes.sh510300?.price, 4.2);
  assert.equal(harness.api.getSnapshot().quotes.sh510300?.date, '2026-11-27');
  assert.equal(harness.api.getSnapshot().marketQuotes.hf_XAU?.price, 35);
  assert.deepEqual(Array.from(harness.api.getSnapshot().openMarkets), []);
  harness.emit({ type: 'intraday', ...ROW, requestId: 2 });
  await tick();
  harness.emit({ type: 'intraday', ...ROW, requestId: 3 });
  harness.emit({ type: 'refresh' });
  await tick();
  assert.equal(harness.requested.length, 3);
  assert.ok(harness.requested.some(url => url.includes('/day/query?code=sh510300')));
  const trend = harness.messages.find(message => message.type === 'intraday' && message.requestId === 3);
  assert.equal(trend?.closed, true);
  assert.equal((trend?.data as { date?: string } | undefined)?.date, '2026-11-27');
  harness.dispose();
  const reloaded = activateHarness(memory, opts);
  t.after(() => reloaded.dispose());
  reloaded.emit({ type: 'ready' });
  await tick();
  assert.deepEqual(reloaded.requested, []);
  assert.equal(reloaded.api.getSnapshot().quotes.sh510300?.price, 4.2);
});

test('股票跨过新收盘点时补取一次，随后只有开市的金银继续请求', async t => {
  const opts = { now: Date.parse('2026-11-30T20:00:00+08:00'), visible: true, response: marketResponse };
  const harness = activateHarness(new Memory(), opts);
  t.after(() => harness.dispose());
  harness.emit({ type: 'ready' });
  await tick();
  assert.equal(harness.requested.length, 2);
  harness.emit({ type: 'ready' });
  await tick();
  assert.deepEqual(harness.requested.slice(2), ['https://qt.gtimg.cn/q=hf_XAU,hf_XAG']);
});

test('完整双字段消息一次保存，成功回应与快照一致', async t => {
  const harness = activateHarness();
  t.after(() => harness.dispose());
  const result = await harness.save({ quantity: '1200', cost: '1.023' });
  assert.equal(result.ok, true);
  assert.equal(result.requestId, 'save-1');
  assert.equal(result.error, undefined);
  assert.deepEqual(harness.api.getSnapshot().state.positions.sh510300, { quantity: 1200, cost: 1.023 });
  assert.equal(harness.memory.updates.length, 1);
  assert.deepEqual((harness.memory.get(STORAGE_KEY) as PortfolioState).positions.sh510300, { quantity: 1200, cost: 1.023 });
  const published = harness.messages.find(message => message.type === 'snapshot')?.payload as Snapshot;
  assert.deepEqual(published.state.positions.sh510300, { quantity: 1200, cost: 1.023 });
  assert.equal(harness.stats().networkCalls, 0);
});

test('空字段、半输入、非法值与未知证券不提交存储，返回对应请求错误', async t => {
  const harness = activateHarness();
  t.after(() => harness.dispose());
  const before = harness.api.getSnapshot().state;
  const invalid: Message[] = [
    { quantity: '' }, { cost: '' }, { cost: undefined }, { quantity: null }, { cost: false },
    { quantity: '0' }, { quantity: '1.5' }, { cost: '1e2' }, { cost: '-1' },
    { quantity: '1000000001' }, { cost: '1000001' },
    { symbol: 'sz159915' }, { groupId: 'removed-group' },
  ];
  for (const fields of invalid) {
    const result = await harness.save(fields);
    assert.equal(result.ok, false, JSON.stringify(fields));
    assert.ok(result.error, JSON.stringify(fields));
  }
  assert.deepEqual(harness.api.getSnapshot().state, before);
  assert.equal(harness.memory.updates.length, 0);
  assert.equal(harness.stats().networkCalls, 0);
});

test('不合法请求 ID 不触发任何持仓写入', async t => {
  const harness = activateHarness();
  t.after(() => harness.dispose());
  for (const requestId of [undefined, null, 123, '', 'x'.repeat(101)]) {
    harness.emit({ type: 'savePosition', ...ROW, quantity: '100', cost: '3.125', requestId });
  }
  await tick();
  assert.equal(harness.memory.updates.length, 0);
  assert.deepEqual(harness.api.getSnapshot().state.positions, {});
  assert.equal(harness.messages.some(message => message.type === 'positionResult'), false);
});

test('存储写入失败不提前改变快照，返回错误后仍可重试保存', async t => {
  const harness = activateHarness();
  t.after(() => harness.dispose());
  await harness.save({ quantity: '100', cost: '3.125' });
  const before = harness.api.getSnapshot().state;
  harness.memory.failUpdates = true;
  const failed = await harness.save({ quantity: '200', cost: '4.123' });
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? '', /本地存储写入失败/);
  assert.deepEqual(harness.api.getSnapshot().state, before);
  assert.deepEqual(harness.memory.get(STORAGE_KEY), before);
  assert.equal(harness.memory.updates.length, 1);
  harness.memory.failUpdates = false;
  const retried = await harness.save({ quantity: '200', cost: '0' });
  assert.equal(retried.ok, true);
  assert.deepEqual(harness.api.getSnapshot().state.positions.sh510300, { quantity: 200, cost: 0 });
});

test('原生持仓命令只打开内嵌表单，不启动输入框、不改变持仓', async t => {
  const harness = activateHarness();
  t.after(() => harness.dispose());
  await harness.command('stockWatch.position', ROW);
  assert.deepEqual(harness.messages.find(message => message.type === 'openPosition'), { type: 'openPosition', ...ROW });
  assert.equal(harness.stats().inputBoxCalls, 0);
  assert.equal(harness.stats().shown, 1);
  assert.equal(harness.stats().networkCalls, 0);
  assert.equal(harness.memory.updates.length, 0);
  assert.deepEqual(harness.api.getSnapshot().state.positions, {});
});

test('分组排序图标循环切换并保留原始手动顺序', async t => {
  const harness = activateHarness();
  t.after(() => harness.dispose());
  const original = harness.api.getSnapshot().state;
  for (const mode of ['asc', 'desc', 'default']) {
    harness.emit({ type: 'cycleGroupSort', groupId: ROW.groupId });
    await tick();
    assert.equal(harness.api.getSnapshot().sorts[ROW.groupId], mode);
    assert.deepEqual(harness.api.getSnapshot().state, original);
  }
  assert.equal(harness.memory.updates.length, 3);
});

test('隐藏侧栏时延迟分时请求，且不访问行情接口', async t => {
  const harness = activateHarness();
  t.after(() => harness.dispose());
  harness.emit({ type: 'intraday', ...ROW, requestId: 1 });
  await tick();
  assert.equal(harness.stats().networkCalls, 0);
  assert.deepEqual(harness.messages.at(-1), { type: 'intraday', ...ROW, requestId: 1, skipped: true });
});

test('保存外观并关闭金银后，重启仍保留设置与既有持仓', async t => {
  const memory = new Memory();
  const first = activateHarness(memory);
  await first.save({ quantity: '100', cost: '3.125' });
  const original = first.api.getSnapshot().state;
  first.emit({ type: 'saveSettings', settings: { fontSize: 18, fontFamily: 'yahei', theme: 'light', title: '行情', gold: false, silver: false } });
  await tick();
  assert.ok(first.messages.some(message => message.type === 'settingsSaved'));
  first.dispose();
  const restarted = activateHarness(memory);
  t.after(() => restarted.dispose());
  const snapshot = restarted.api.getSnapshot();
  assert.deepEqual(snapshot.state, original);
  assert.deepEqual(snapshot.markets.map(item => item.code), ['000001', '399006', '000688']);
  assert.equal(snapshot.preferences.fontSize, 18);
  assert.equal(snapshot.preferences.fontFamily, 'yahei');
  assert.equal(snapshot.preferences.theme, 'light');
  assert.equal(snapshot.preferences.title, '行情');
});

test('保存后重新激活扩展，从同一 Memento 恢复完整持仓', async t => {
  const memory = new Memory();
  const first = activateHarness(memory);
  await first.save({ quantity: '1500', cost: '1.01234567' });
  const before = first.api.getSnapshot().state;
  first.dispose();
  const restarted = activateHarness(memory);
  t.after(() => restarted.dispose());
  assert.deepEqual(restarted.api.getSnapshot().state, before);
  assert.deepEqual(restarted.api.getSnapshot().state.positions.sh510300, { quantity: 1500, cost: 1.01234567 });
  assert.equal(memory.updates.length, 1);
  assert.equal(restarted.stats().networkCalls, 0);
});
