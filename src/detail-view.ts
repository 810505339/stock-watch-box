import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { MarketInstrument, MarketQuote, Metrics, Position, Security } from './types';
import type { Preferences } from './preferences';
import { fetchHistory, macd, type History, type Period } from './history';

interface InstrumentDetail {
  instrument: Security | MarketInstrument;
  quote?: MarketQuote;
  position?: Position;
  metrics?: Metrics;
}

interface DetailTab {
  panel: vscode.WebviewPanel;
  detail: InstrumentDetail;
  ready: boolean;
  request?: AbortController;
}

export class DetailViews implements vscode.Disposable {
  private readonly tabs = new Map<string, DetailTab>();
  private readonly cache = new Map<string, { time: number; history: History }>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly lookup: (id: string) => InstrumentDetail | undefined,
    private readonly appearance: () => Preferences,
    private readonly iconPath: () => vscode.Uri | undefined,
    private readonly onVisibilityChanged: () => void,
  ) {}

  get visible(): boolean {
    return [...this.tabs.values()].some(tab => tab.panel.visible);
  }

  open(id: string): void {
    const previous = this.tabs.get(id);
    if (previous) { previous.panel.reveal(); return; }
    const detail = this.lookup(id);
    if (!detail) return;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel('stockWatch.detail', detail.instrument.name, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media, dist],
    });
    const tab: DetailTab = { panel, detail, ready: false };
    this.tabs.set(id, tab);
    const visibility = panel.onDidChangeViewState(() => {
      this.update(tab);
      this.onVisibilityChanged();
    });
    const listener = panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready') { tab.ready = true; this.update(tab); }
      if (message?.type === 'history' && ['day', 'week', 'month'].includes(message.period) &&
          Number.isSafeInteger(message.requestId) && tab.detail.instrument.kind !== 'metal') {
        void this.load(tab, id, message.period, message.requestId, message.retry === true);
      }
    });
    panel.onDidDispose(() => {
      tab.request?.abort();
      listener.dispose();
      visibility.dispose();
      this.tabs.delete(id);
      this.onVisibilityChanged();
    });
    const nonce = randomBytes(18).toString('hex');
    const resource = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, name));
    panel.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
      <title>证券详情</title><link rel="stylesheet" href="${resource('detail.css')}"></head>
      <body><main><header><p id="symbol"></p><h1 id="name"></h1><div id="price"></div><p id="source"></p></header>
      <dl id="metrics"></dl><section id="charts" hidden><nav aria-label="K 线周期" id="periods"></nav>
      <p id="status" role="status"></p><button id="retry" hidden>重试</button><p id="legend"></p>
      <div id="plot" tabindex="0" aria-label="K 线、成交量和 MACD，按左右键查看数据"></div></section>
      </main><script nonce="${nonce}" src="${resource('appearance.js')}"></script>
      <script nonce="${nonce}" src="${panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'detail.js'))}"></script></body></html>`;
    this.update(tab);
    this.onVisibilityChanged();
  }

  publish(): void {
    for (const [id, tab] of this.tabs) {
      const current = this.lookup(id);
      if (current) tab.detail = current;
      else tab.detail = { instrument: tab.detail.instrument };
      this.update(tab);
    }
  }

  private update(tab: DetailTab): void {
    const appearance = this.appearance();
    const { instrument } = tab.detail;
    tab.panel.title = [appearance.title, instrument.name].filter(Boolean).join(' · ');
    tab.panel.iconPath = this.iconPath();
    if (tab.ready) void tab.panel.webview.postMessage({ type: 'detail', ...tab.detail, appearance, visible: tab.panel.visible });
  }

  private async load(tab: DetailTab, id: string, period: Period, requestId: number, retry: boolean): Promise<void> {
    tab.request?.abort();
    const request = new AbortController();
    tab.request = request;
    const key = `${id}:${period}`;
    try {
      const cached = this.cache.get(key);
      const fresh = !retry && cached && Date.now() - cached.time < 15_000 ? cached : undefined;
      const history = fresh?.history ?? await fetchHistory(id, period, request.signal);
      if (request.signal.aborted) return;
      this.cache.delete(key);
      this.cache.set(key, { time: fresh?.time ?? Date.now(), history });
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
      await tab.panel.webview.postMessage({ type: 'history', requestId, ...history, macd: macd(history.candles) });
    } catch (error) {
      if (!request.signal.aborted) await tab.panel.webview.postMessage({
        type: 'history', requestId, error: error instanceof Error ? error.message : '获取 K 线失败',
      });
    }
  }

  dispose(): void {
    for (const tab of this.tabs.values()) tab.panel.dispose();
    this.cache.clear();
  }
}
