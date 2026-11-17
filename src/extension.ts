import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { Group, PortfolioState, Quote, Security, Snapshot } from './types';
import * as domain from './portfolio';
import { fetchQuotes, searchSecurities } from './quotes';
import { parsePositionInput } from './position-input';

const STORAGE_KEY = 'portfolio.v1';
interface RowContext { groupId: string; symbol: string; }
interface SearchItem extends vscode.QuickPickItem { security?: Security; }

class Board implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private state: PortfolioState;
  private quotes: Record<string, Quote> = {};
  private error = '';
  private updatedAt: number | null = null;
  private refreshing = false;
  private failures = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private disposed = false;
  private editing = false;
  private toggling = false;
  private readonly subscriptions: vscode.Disposable[] = [];
  constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.OutputChannel) {
    const raw = context.globalState.get<unknown>(STORAGE_KEY);
    try { this.state = raw === undefined ? domain.createInitialState() : domain.validateState(raw); }
    catch {
      this.state = domain.createInitialState();
      void context.globalState.update('portfolio.recoveryBackup', raw);
      void vscode.window.showWarningMessage('盯盘盒子：本地数据格式异常，已保留恢复备份并使用空自选。');
    }
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('stockWatch.refreshSeconds')) this.schedule();
    }));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    const nonce = randomBytes(18).toString('hex');
    const resource = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
    view.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${view.webview.cspSource};"><link rel="stylesheet" href="${resource('main.css')}"><title>盯盘盒子</title></head><body><main id="app"><header id="header"></header><section id="summary" aria-label="持仓总览"></section><section id="groups" aria-label="自选分类"></section><footer id="footer"></footer></main><script nonce="${nonce}" src="${resource('main.js')}"></script></body></html>`;
    const listener = view.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const m = message as Record<string, unknown>;
      switch (m.type) {
        case 'ready': this.publish(); void this.refresh(); break;
        case 'refresh': void this.refresh(); break;
        case 'addGroup': void this.edit(() => this.addGroup()); break;
        case 'addStock': void this.edit(() => this.addStock(m)); break;
        case 'groupMenu': void this.edit(() => this.groupMenu(m)); break;
        case 'position': void this.edit(() => this.position(m)); break;
        case 'savePosition': void this.savePosition(m); break;
        case 'clearPosition': void this.edit(() => this.clearPosition(m)); break;
        case 'move': void this.edit(() => this.move(m)); break;
        case 'remove': void this.edit(() => this.remove(m)); break;
        case 'toggleVisibility': void this.toggleVisibility(); break;
        case 'reorderGroup': void this.edit(async () => {
          if (typeof m.groupId !== 'string' || (m.beforeId !== undefined && typeof m.beforeId !== 'string')) throw new Error('分类排序参数无效。');
          await this.save(domain.reorderGroup(this.state, m.groupId, m.beforeId as string | undefined));
        }); break;
        case 'reorderStock': void this.edit(async () => {
          if (typeof m.fromGroupId !== 'string' || typeof m.toGroupId !== 'string' || typeof m.symbol !== 'string' || (m.beforeSymbol !== undefined && typeof m.beforeSymbol !== 'string')) throw new Error('自选排序参数无效。');
          await this.save(domain.reorderSecurity(this.state, m.fromGroupId, m.toGroupId, m.symbol, m.beforeSymbol as string | undefined));
        }); break;
      }
    });
    const visibility = view.onDidChangeVisibility(() => {
      if (view.visible) { this.publish(); void this.refresh(); }
      else { this.stopTimer(); this.request?.abort(); }
    });
    view.onDidDispose(() => {
      listener.dispose(); visibility.dispose();
      if (this.view === view) { this.view = undefined; this.stopTimer(); this.request?.abort(); }
    });
  }

  snapshot(): Snapshot {
    const today = domain.chinaDate();
    return {
      state: this.state, quotes: this.quotes,
      metrics: Object.fromEntries(Object.entries(this.state.positions).map(([id, p]) => [id, domain.positionMetrics(p, this.quotes[id])])),
      summaries: domain.summarize(this.state, this.quotes, today),
      refreshing: this.refreshing, error: this.error, updatedAt: this.updatedAt, today,
    };
  }
  private publish(): void {
    if (!this.disposed) void this.view?.webview.postMessage({ type: 'snapshot', payload: this.snapshot() });
  }
  async toggleVisibility(): Promise<void> {
    if (this.toggling) return;
    this.toggling = true;
    try {
      await vscode.commands.executeCommand(this.view?.visible ? 'workbench.view.explorer' : 'stockWatch.board.focus');
    } finally { this.toggling = false; }
  }
  private stopTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private schedule(): void {
    this.stopTimer();
    if (!this.view?.visible || this.disposed) return;
    const configured = vscode.workspace.getConfiguration('stockWatch').get<number>('refreshSeconds', 5);
    const seconds = Math.max(5, Math.min(60, Number.isFinite(configured) ? configured : 5));
    this.timer = setTimeout(() => void this.refresh(), Math.min(60, seconds * 2 ** Math.min(this.failures, 4)) * 1000);
  }
  async refresh(): Promise<void> {
    if (this.refreshing || this.disposed) return;
    this.stopTimer();
    const securities = Object.values(this.state.securities);
    if (!securities.length) { this.error = ''; this.publish(); this.schedule(); return; }
    this.refreshing = true;
    const controller = new AbortController(); this.request = controller;
    this.publish();
    try {
      const incoming = await fetchQuotes(securities, controller.signal);
      if (controller.signal.aborted || this.disposed) return;
      const missing: string[] = [];
      for (const security of securities) {
        if (!this.state.securities[security.id]) continue;
        const q = incoming[security.id];
        if (q && q.price !== null) this.quotes[security.id] = q;
        else {
          missing.push(security.code);
          if (this.quotes[security.id]) this.quotes[security.id] = { ...this.quotes[security.id], stale: true };
        }
      }
      this.error = missing.length ? `${missing.length} 只证券暂无有效报价，保留上次数据` : '';
      this.failures = missing.length ? this.failures + 1 : 0;
      this.updatedAt = Date.now();
    } catch (error) {
      if (!controller.signal.aborted) {
        this.failures++;
        this.error = '行情连接失败，已保留上次数据 · 稍后自动重试';
        for (const id of Object.keys(this.quotes)) this.quotes[id] = { ...this.quotes[id], stale: true };
        this.log.appendLine(`行情请求失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      this.refreshing = false;
      if (this.request === controller) this.request = undefined;
      this.publish(); this.schedule();
    }
  }

  async edit(operation: () => Promise<void>): Promise<void> {
    if (this.editing) return;
    this.editing = true;
    try { await operation(); }
    catch (error) { void vscode.window.showErrorMessage(`盯盘盒子：${error instanceof Error ? error.message : String(error)}`); }
    finally { this.editing = false; }
  }
  private async save(next: PortfolioState): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, next);
    this.state = next;
    for (const id of Object.keys(this.quotes)) if (!next.securities[id]) delete this.quotes[id];
    this.publish();
  }
  private groupFrom(value: unknown): Group | undefined {
    const id = value && typeof value === 'object' ? (value as Record<string, unknown>).groupId : undefined;
    return this.state.groups.find(group => group.id === id);
  }
  private rowFrom(value: unknown): RowContext | undefined {
    const group = this.groupFrom(value);
    const symbol = value && typeof value === 'object' ? (value as Record<string, unknown>).symbol : undefined;
    return group && typeof symbol === 'string' && group.symbols.includes(symbol) ? { groupId: group.id, symbol } : undefined;
  }
  private async pickGroup(): Promise<Group | undefined> {
    const item = await vscode.window.showQuickPick(this.state.groups.map(group => ({ label: group.name, description: `${group.symbols.length}/10`, group })), { title: '选择自选分类', placeHolder: '每个分类最多 10 只证券' });
    return item?.group;
  }
  private validGroupName(value: string, except?: string): string | undefined {
    if (!value.trim() || value.trim().length > 30) return '分类名称需要 1–30 个字符';
    if (this.state.groups.some(g => g.id !== except && g.name === value.trim())) return '已经有同名分类';
    return undefined;
  }
  async addGroup(): Promise<void> {
    const name = await vscode.window.showInputBox({ title: '新建分类', prompt: '给这组自选起个名字', placeHolder: '例如：核心持仓、ETF、港股', validateInput: value => this.validGroupName(value) });
    if (name !== undefined) await this.save(domain.addGroup(this.state, name));
  }
  async renameGroup(value: unknown): Promise<void> {
    const group = this.groupFrom(value); if (!group) return;
    const name = await vscode.window.showInputBox({ title: '重命名分类', value: group.name, validateInput: input => this.validGroupName(input, group.id) });
    if (name !== undefined) await this.save(domain.renameGroup(this.state, group.id, name));
  }
  async deleteGroup(value: unknown): Promise<void> {
    const group = this.groupFrom(value); if (!group) return;
    const lost = group.symbols.filter(id => this.state.positions[id] && !this.state.groups.some(g => g.id !== group.id && g.symbols.includes(id)));
    const choice = await vscode.window.showWarningMessage(`删除分类“${group.name}”？${lost.length ? ` 将同时删除 ${lost.length} 笔只在此分类中的持仓记录。` : ''}`, { modal: true }, '删除分类');
    if (choice === '删除分类') await this.save(domain.removeGroup(this.state, group.id));
  }
  async groupMenu(value: unknown): Promise<void> {
    if (!this.groupFrom(value)) return;
    const choice = await vscode.window.showQuickPick(['重命名分类', '删除分类'], { placeHolder: '分类管理' });
    if (choice === '重命名分类') await this.renameGroup(value);
    if (choice === '删除分类') await this.deleteGroup(value);
  }

  async addStock(value?: unknown): Promise<void> {
    let group = this.groupFrom(value) ?? await this.pickGroup();
    if (!group && this.state.groups.length === 0) {
      await this.addGroup(); group = this.state.groups[this.state.groups.length - 1];
    }
    if (!group) return;
    if (group.symbols.length >= 10) throw new Error('这个分类已满 10 只，请选择其他分类。');
    const security = await this.search();
    if (!security) return;
    await this.save(domain.addSecurity(this.state, group.id, security));
    void this.refresh();
  }
  private search(): Promise<Security | undefined> {
    return new Promise(resolve => {
      const picker = vscode.window.createQuickPick<SearchItem>();
      picker.title = '添加股票 / 指数 / 场内基金';
      picker.placeholder = '名称或代码，如 上证指数、sh000001、腾讯、510300';
      picker.matchOnDescription = true; picker.matchOnDetail = true;
      picker.ignoreFocusOut = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let request: AbortController | undefined;
      let generation = 0, done = false;
      const finish = (security?: Security) => {
        if (done) return; done = true;
        if (timer) clearTimeout(timer); request?.abort();
        change.dispose(); accept.dispose(); hide.dispose(); picker.dispose(); resolve(security);
      };
      const change = picker.onDidChangeValue(input => {
        generation++; const current = generation;
        if (timer) clearTimeout(timer); request?.abort(); picker.items = [];
        if (!input.trim()) { picker.busy = false; return; }
        picker.busy = true;
        timer = setTimeout(async () => {
          request = new AbortController();
          try {
            const found = await searchSecurities(input.trim(), request.signal);
            if (done || current !== generation) return;
            picker.items = found.length ? found.map(security => ({ label: security.name, description: `${security.code} · ${security.market.toUpperCase()} · ${{fund: '场内基金', index: '指数', stock: '股票'}[security.kind]}`, detail: `${security.id} · ${security.currency === 'CNY' ? '人民币' : '港币'}`, security, alwaysShow: true })) : [{ label: '没有找到股票、指数或场内基金', detail: '可尝试完整代码，如 sh000001、sh510300、hk00700', alwaysShow: true }];
          } catch (error) {
            if (done || current !== generation) return;
            picker.items = [{ label: '搜索暂时不可用', detail: error instanceof Error ? error.message : '请检查网络后重试', alwaysShow: true }];
          } finally { if (!done && current === generation) picker.busy = false; }
        }, 300);
      });
      const accept = picker.onDidAccept(() => { const selected = picker.selectedItems[0]?.security; if (selected) finish(selected); });
      const hide = picker.onDidHide(() => finish());
      picker.show();
    });
  }
  async position(value: unknown): Promise<void> {
    const row = this.rowFrom(value); if (!row) return;
    this.view?.show(false);
    this.publish();
    await this.view?.webview.postMessage({ type: 'openPosition', ...row });
  }
  private async savePosition(message: Record<string, unknown>): Promise<void> {
    const requestId = message.requestId;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 100) return;
    const reply = (ok: boolean, error?: string) => this.view?.webview.postMessage({ type: 'positionResult', requestId, ok, error });
    if (this.editing) { await reply(false, '正在处理其他操作，请稍后保存。'); return; }
    this.editing = true;
    try {
      const row = this.rowFrom(message);
      if (!row) throw new Error('证券已不在此分类中，请关闭面板后重试。');
      const position = parsePositionInput(message.quantity, message.cost);
      await this.save(domain.setPosition(this.state, row.symbol, position));
      await reply(true);
    } catch (error) {
      await reply(false, error instanceof Error ? error.message : '保存失败，请重试。');
    } finally { this.editing = false; }
  }
  async clearPosition(value: unknown): Promise<void> {
    const row = this.rowFrom(value); if (!row || !this.state.positions[row.symbol]) return;
    const answer = await vscode.window.showWarningMessage(`清空“${this.state.securities[row.symbol].name}”的持仓记录？自选仍会保留。`, { modal: true }, '清空持仓');
    if (answer === '清空持仓') await this.save(domain.clearPosition(this.state, row.symbol));
  }
  async remove(value: unknown): Promise<void> {
    const row = this.rowFrom(value); if (!row) return;
    const last = !this.state.groups.some(g => g.id !== row.groupId && g.symbols.includes(row.symbol));
    if (last && this.state.positions[row.symbol]) {
      const answer = await vscode.window.showWarningMessage(`移除“${this.state.securities[row.symbol].name}”会同时删除它的持仓记录。`, { modal: true }, '移除并删除持仓');
      if (answer !== '移除并删除持仓') return;
    }
    await this.save(domain.removeSecurity(this.state, row.groupId, row.symbol));
  }
  async move(value: unknown): Promise<void> {
    const row = this.rowFrom(value); if (!row) return;
    const groups = this.state.groups.filter(g => g.id !== row.groupId && g.symbols.length < 10 && !g.symbols.includes(row.symbol));
    if (!groups.length) throw new Error('没有可用的目标分类，请先新增分类或腾出位置。');
    const target = await vscode.window.showQuickPick(groups.map(g => ({ label: g.name, description: `${g.symbols.length}/10`, group: g })), { title: '移至其他分类' });
    if (target) await this.save(domain.moveSecurity(this.state, row.groupId, target.group.id, row.symbol));
  }
  dispose(): void {
    this.disposed = true; this.stopTimer(); this.request?.abort();
    this.subscriptions.forEach(item => item.dispose());
  }
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('盯盘盒子');
  const board = new Board(context, output);
  context.subscriptions.push(output, board, vscode.window.registerWebviewViewProvider('stockWatch.board', board));
  context.subscriptions.push(vscode.commands.registerCommand('stockWatch.open', () => vscode.commands.executeCommand('stockWatch.board.focus')));
  context.subscriptions.push(vscode.commands.registerCommand('stockWatch.refresh', () => board.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand('stockWatch.toggleVisibility', () => board.toggleVisibility()));
  const commands: Record<string, (arg: unknown) => Promise<void>> = {
    addGroup: () => board.addGroup(), addStock: arg => board.addStock(arg), position: arg => board.position(arg),
    clearPosition: arg => board.clearPosition(arg), move: arg => board.move(arg), remove: arg => board.remove(arg),
    renameGroup: arg => board.renameGroup(arg), deleteGroup: arg => board.deleteGroup(arg),
  };
  for (const [name, handler] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(`stockWatch.${name}`, arg => board.edit(() => handler(arg))));
  return { getSnapshot: () => structuredClone(board.snapshot()) };
}
export function deactivate() { /* Resources are owned by ExtensionContext.subscriptions. */ }
