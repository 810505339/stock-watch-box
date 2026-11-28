(() => {
  'use strict';
  const fontPresets = {
    system: { label: '跟随 VS Code', stack: '' },
    yahei: { label: '微软雅黑', stack: '"Microsoft YaHei", "微软雅黑", "PingFang SC", sans-serif' },
    noto: { label: '思源黑体 / Noto Sans SC', stack: '"Source Han Sans SC", "Noto Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif' },
    simhei: { label: '黑体', stack: 'SimHei, "黑体", "Heiti SC", sans-serif' },
    simsun: { label: '宋体', stack: 'SimSun, "宋体", "Songti SC", serif' },
    kaiti: { label: '楷体', stack: 'KaiTi, "楷体", "Kaiti SC", serif' },
  };
  window.stockFontChoices = Object.entries(fontPresets).map(([key, value]) => [key, value.label]);
  window.stockCompactNumber = (value, unit) => {
    if (!Number.isFinite(value)) return '—';
    const divisor = value >= 1e8 ? 1e8 : value >= 1e4 ? 1e4 : 1;
    const prefix = divisor === 1e8 ? '亿' : divisor === 1e4 ? '万' : '';
    return `${(value / divisor).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${prefix}${unit}`;
  };
  window.applyStockAppearance = settings => {
    const root = document.body;
    root.dataset.stockTheme = settings.theme;
    root.style.setProperty('--stock-font', `${settings.fontSize}px`);
    const family = Object.hasOwn(fontPresets, settings.fontFamily) ? fontPresets[settings.fontFamily].stack : '';
    if (family) root.style.setProperty('--stock-font-family', family);
    else root.style.removeProperty('--stock-font-family');
    for (const [property, value] of [['--up', settings.up], ['--down', settings.down]]) {
      if (value && /^#[0-9a-f]{6}$/i.test(value)) root.style.setProperty(property, value);
      else root.style.removeProperty(property);
    }
  };
})();
