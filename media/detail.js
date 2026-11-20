import { CandlestickSeries, ColorType, HistogramSeries, LineSeries, createChart } from 'lightweight-charts';

(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const get = id => document.getElementById(id);
  const plot = get('plot');
  const periodButtons = new Map();
  const labels = { day: '日线', week: '周线', month: '月线' };
  let period = 'day';
  let requestId = 0;
  let candles = [];
  let indicators = [];
  let selected;
  let pending = false;
  let lastAttempt = 0;
  let chart, prices, volume, histogram, dif, dea;
  let chartColors;
  const format = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—';
  const signed = value => Number.isFinite(value) ? (value > 0 ? '+' : '') + format(value) : '—';
  const tone = value => value > 0 ? 'positive' : value < 0 ? 'negative' : '';
  const status = get('status');
  const retry = get('retry');

  for (const [key, label] of Object.entries(labels)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      if (period !== key) load(key);
    });
    periodButtons.set(key, button);
    get('periods').append(button);
  }
  retry.addEventListener('click', () => load(period, true, candles.length > 0));

  function load(key, again = false, background = false) {
    period = key;
    pending = true;
    lastAttempt = Date.now();
    for (const [id, button] of periodButtons) button.setAttribute('aria-pressed', String(id === key));
    retry.hidden = true;
    if (!background) {
      status.textContent = '正在获取 K 线…';
      plot.hidden = true;
      get('legend').textContent = '';
      selected = undefined;
      candles = [];
    }
    vscode.postMessage({ type: 'history', period, requestId: ++requestId, retry: again });
  }

  function updateDetail(data) {
    const { instrument, quote, position, metrics, appearance } = data;
    window.applyStockAppearance(appearance);
    const metal = instrument.kind === 'metal';
    const units = metal ? '美元／金衡盎司' : quote?.currency || instrument.currency;
    const digits = instrument.kind === 'fund' || instrument.market === 'hk' ? 3 : 2;
    get('symbol').textContent = instrument.code;
    get('name').textContent = quote?.name || instrument.name;
    const price = document.createElement('strong');
    price.textContent = format(quote?.price, digits);
    const pct = document.createElement('span');
    pct.textContent = Number.isFinite(quote?.changePercent) ? `${signed(quote.changePercent)}%` : '—';
    pct.className = tone(quote?.changePercent);
    get('price').replaceChildren(price, units, pct);
    get('source').textContent = `腾讯行情 · ${quote?.time || '暂无报价时间'}${quote?.stale ? ' · 保留上次报价' : ''}`;
    const fields = [['昨收', format(quote?.previousClose, digits)], ['涨跌额', format(quote?.change, digits), quote?.change]];
    if (position && metrics) fields.push(['持仓数量', position.quantity.toLocaleString('zh-CN')],
      ['持仓成本', format(position.cost, digits)], ['市值', format(metrics.marketValue)],
      ['日盈亏', signed(metrics.daily), metrics.daily], ['总盈亏', signed(metrics.profit), metrics.profit],
      ['总收益率', Number.isFinite(metrics.profitPercent) ? `${signed(metrics.profitPercent)}%` : '—', metrics.profitPercent]);
    get('metrics').replaceChildren(...fields.map(([label, value, change]) => {
      const item = document.createElement('div');
      const term = document.createElement('dt');
      const result = document.createElement('dd');
      term.textContent = label;
      result.textContent = value;
      result.className = tone(change);
      item.append(term, result);
      return item;
    }));
    get('charts').hidden = metal;
    if (!metal && !requestId) load('day');
    else if (!metal && data.visible && !pending && Date.now() - lastAttempt >= 15_000) load(period, false, true);
    if (chart) syncColors();
  }

  function syncColors() {
    const style = getComputedStyle(document.body);
    const colors = Object.fromEntries(['surface', 'foreground', 'muted', 'up', 'down'].map(key =>
      [key, style.getPropertyValue('--' + key).trim()]));
    if (chartColors && Object.keys(colors).every(key => colors[key] === chartColors[key])) return;
    chartColors = colors;
    const line = style.getPropertyValue('--line').trim();
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: colors.surface }, textColor: colors.muted },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderColor: line }, timeScale: { borderColor: line },
    });
    prices.applyOptions({ upColor: colors.up, downColor: colors.down, wickUpColor: colors.up, wickDownColor: colors.down,
      borderUpColor: colors.up, borderDownColor: colors.down });
    if (candles.length) renderHistograms();
  }

  function initializeChart() {
    chart = createChart(plot, {
      autoSize: true, localization: { locale: 'zh-CN' },
      layout: { attributionLogo: true },
      timeScale: { rightOffset: 3 },
    });
    const options = { priceLineVisible: false, lastValueVisible: false };
    prices = chart.addSeries(CandlestickSeries, options);
    volume = chart.addSeries(HistogramSeries, { ...options, title: '成交量', priceFormat: { type: 'volume' } }, 1);
    histogram = chart.addSeries(HistogramSeries, { ...options, title: 'MACD' }, 2);
    dif = chart.addSeries(LineSeries, { ...options, title: 'DIF', lineWidth: 1, color: '#879bcc' }, 2);
    dea = chart.addSeries(LineSeries, { ...options, title: 'DEA', lineWidth: 1, color: '#c09e6e' }, 2);
    const panes = chart.panes();
    panes[0].setStretchFactor(3);
    panes[1].setStretchFactor(1);
    panes[2].setStretchFactor(1.3);
    chart.subscribeCrosshairMove(event => {
      const index = candles.findIndex(item => item.date === event.time);
      selected = index >= 0 ? index : undefined;
      updateLegend();
    });
    syncColors();
  }

  function renderHistograms() {
    const { up, down } = chartColors;
    volume.setData(candles.map(item => item.volume === null ? { time: item.date } : {
      time: item.date, value: item.volume, color: item.close >= item.open ? up : down,
    }));
    histogram.setData(candles.map((item, index) => ({
      time: item.date, value: indicators[index].histogram, color: indicators[index].histogram >= 0 ? up : down,
    })));
  }

  function updateLegend() {
    const index = selected ?? candles.length - 1;
    const item = candles[index];
    if (!item) return;
    const indicator = indicators[index];
    get('legend').textContent = `${item.date} · 开 ${format(item.open)} · 高 ${format(item.high)} · 低 ${format(item.low)} · 收 ${format(item.close)} · 量 ${format(item.volume, 0)} · DIF ${format(indicator.dif, 3)} · DEA ${format(indicator.signal, 3)} · MACD ${format(indicator.histogram, 3)}`;
  }

  plot.addEventListener('keydown', event => {
    if (event.target !== plot || !candles.length || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const index = Math.max(0, Math.min(candles.length - 1,
      (selected ?? candles.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1)));
    const { close, date } = candles[index];
    chart.setCrosshairPosition(close, date, prices);
    selected = index;
    updateLegend();
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'detail') updateDetail(message);
    if (message?.type !== 'history' || message.requestId !== requestId) return;
    pending = false;
    lastAttempt = Date.now();
    if (message.error) {
      status.textContent = candles.length ? `保留上次 K 线 · ${message.error}` : message.error;
      retry.hidden = false;
      return;
    }
    const initial = !candles.length;
    const timeRange = initial ? null : chart.timeScale().getVisibleRange();
    candles = message.candles;
    indicators = message.macd;
    status.textContent = `${labels[period]} · ${message.adjusted ? '前复权' : '原始行情'} · MACD (12, 26, 9)`;
    plot.hidden = false;
    if (!chart) initializeChart();
    prices.setData(candles.map(item => ({
      time: item.date, open: item.open, high: item.high, low: item.low, close: item.close,
    })));
    renderHistograms();
    dif.setData(candles.map((item, index) => ({ time: item.date, value: indicators[index].dif })));
    dea.setData(candles.map((item, index) => ({ time: item.date, value: indicators[index].signal })));
    const scale = chart.timeScale();
    if (initial) scale.setVisibleLogicalRange({ from: Math.max(0, candles.length - 100), to: candles.length + 2 });
    else if (timeRange) scale.setVisibleRange(timeRange);
    updateLegend();
  });
  vscode.postMessage({ type: 'ready' });
})();
