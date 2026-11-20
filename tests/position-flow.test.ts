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

function activateHarness(memory = new Memory()) {
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
    Error, structuredClone, AbortController, TextDecoder, setTimeout, clearTimeout, console,
    fetch: async () => { networkCalls++; throw new Error('测试禁止网络请求'); },
  }, { filename: 'extension-under-test.cjs' });
  const api = module.exports.activate({ globalState: memory, extensionUri: 'file:///extension-test', subscriptions });
  assert.ok(provider, 'activation must register the actual Webview provider');
  const view = {
    visible: false,
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
    api, memory, messages,
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

test('保存外观并关闭金银后，重启仍保留设置与既有持仓', async t => {
  const memory = new Memory();
  const first = activateHarness(memory);
  await first.save({ quantity: '100', cost: '3.125' });
  const original = first.api.getSnapshot().state;
  first.emit({ type: 'saveSettings', settings: { fontSize: 18, theme: 'light', title: '行情', gold: false, silver: false } });
  await tick();
  assert.ok(first.messages.some(message => message.type === 'settingsSaved'));
  first.dispose();
  const restarted = activateHarness(memory);
  t.after(() => restarted.dispose());
  const snapshot = restarted.api.getSnapshot();
  assert.deepEqual(snapshot.state, original);
  assert.deepEqual(snapshot.markets.map(item => item.code), ['000001', '399006', '000688']);
  assert.equal(snapshot.preferences.fontSize, 18);
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
