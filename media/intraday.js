import { ColorType, HistogramSeries, LineSeries, createChart } from 'lightweight-charts';

const timeText = time => new Date((time + 8 * 3600) * 1000).toISOString().slice(11, 16);
const priceText = (value, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : '—';

export function createIntraday(plot, legend, compact = false) {
  const chart = createChart(plot, {
    autoSize: true,
    layout: { attributionLogo: !compact, fontSize: compact ? 9 : 12,
      panes: { enableResize: !compact, separatorColor: 'transparent', separatorHoverColor: 'transparent' } },
    localization: { timeFormatter: timeText },
    timeScale: { timeVisible: true, secondsVisible: false, tickMarkFormatter: timeText, rightOffset: 0, minBarSpacing: 0.3 },
    handleScroll: !compact,
    handleScale: !compact,
  });
  const options = { priceLineVisible: false, lastValueVisible: false };
  const price = chart.addSeries(LineSeries, { ...options, lineWidth: 2 });
  const volume = chart.addSeries(HistogramSeries, { ...options, priceFormat: { type: 'volume' } }, 1);
  const histogram = chart.addSeries(HistogramSeries, options, 2);
  const dif = chart.addSeries(LineSeries, { ...options, lineWidth: 1 }, 2);
  const dea = chart.addSeries(LineSeries, { ...options, lineWidth: 1, color: '#cc9348' }, 2);
  const panes = chart.panes();
  panes[0].setStretchFactor(3);
  panes[1].setStretchFactor(1);
  panes[2].setStretchFactor(1.4);
  const chartElement = chart.chartElement();
  const separators = panes.slice(1).map(pane => {
    const line = document.createElement('div');
    line.className = 'stock-chart-divider';
    line.setAttribute('aria-hidden', 'true');
    chartElement.append(line);
    return { pane, line };
  });
  const separatorObserver = new ResizeObserver(() => {
    const top = chartElement.getBoundingClientRect().top;
    for (const { pane, line } of separators) {
      const element = pane.getHTMLElement();
      if (element) line.style.top = `${Math.round(element.getBoundingClientRect().top - top) - 1}px`;
    }
  });
  separatorObserver.observe(chartElement);
  for (const pane of panes) {
    const element = pane.getHTMLElement();
    if (element) separatorObserver.observe(element);
  }

  let data;
  let colors;
  let baseline;
  let selected;

  function showLegend() {
    if (!data) return;
    const index = selected ?? data.points.length - 1;
    const item = data.points[index];
    const indicator = data.macd[index];
    if (!item || !indicator) return;
    const shownVolume = item.volume == null ? '—' : item.volume.toLocaleString('zh-CN');
    legend.textContent = `${timeText(item.time)} · 价 ${priceText(item.price)} · 量 ${shownVolume} · MACD ${priceText(indicator.histogram)} · DIF ${priceText(indicator.dif)} · DEA ${priceText(indicator.signal)}`;
  }

  function columns() {
    if (!data) return;
    const { up, down } = colors;
    volume.setData(data.points.map((item, index) => item.volume == null ? { time: item.time } : {
      time: item.time, value: item.volume,
      color: item.price >= (data.points[index - 1]?.price ?? data.previousClose ?? item.price) ? up : down,
    }));
    histogram.setData(data.points.map(({ time }, index) => {
      const value = data.macd[index].histogram;
      return { time, value, color: value >= 0 ? up : down };
    }));
  }

  function theme() {
    const style = getComputedStyle(document.body);
    const next = Object.fromEntries(['surface', 'foreground', 'muted', 'up', 'down', 'line'].map(key =>
      [key, style.getPropertyValue('--' + key).trim()]));
    next.fontFamily = style.fontFamily;
    if (colors && Object.keys(next).every(key => colors[key] === next[key])) return;
    colors = next;
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: colors.surface }, textColor: colors.muted, fontFamily: colors.fontFamily },
      grid: { vertLines: { color: colors.line }, horzLines: { color: colors.line } },
      timeScale: { borderColor: colors.line }, rightPriceScale: { borderColor: colors.line },
    });
    price.applyOptions({ color: colors.foreground });
    dif.applyOptions({ color: colors.foreground });
    baseline?.applyOptions({ color: colors.muted });
    columns();
  }

  chart.subscribeCrosshairMove(event => {
    const index = data?.points.findIndex(point => point.time === event.time) ?? -1;
    selected = index < 0 ? undefined : index;
    showLegend();
  });
  function keyboard(event) {
    if (event.target !== plot || !data || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const index = Math.max(0, Math.min(data.points.length - 1,
      (selected ?? data.points.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1)));
    const item = data.points[index];
    chart.setCrosshairPosition(item.price, item.time, price);
    selected = index;
    showLegend();
  }
  plot.addEventListener('keydown', keyboard);
  theme();
  return {
    theme,
    set(next) {
      const fit = !data || data.date !== next.date || compact;
      data = next;
      if (selected >= data.points.length) selected = undefined;
      price.setData(data.points.map(({ time, price: value }) => ({ time, value })));
      if (baseline) price.removePriceLine(baseline);
      baseline = data.previousClose == null ? undefined : price.createPriceLine({
        price: data.previousClose, color: colors.muted, lineStyle: 2, lineWidth: 1, axisLabelVisible: !compact, title: '昨收',
      });
      columns();
      dif.setData(data.points.map(({ time }, index) => ({ time, value: data.macd[index].dif })));
      dea.setData(data.points.map(({ time }, index) => ({ time, value: data.macd[index].signal })));
      if (fit) chart.timeScale().fitContent();
      showLegend();
    },
    dispose() {
      plot.removeEventListener('keydown', keyboard);
      separatorObserver.disconnect();
      chart.remove();
    },
  };
}
