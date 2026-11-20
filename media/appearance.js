(() => {
  'use strict';
  window.applyStockAppearance = settings => {
    const root = document.body;
    root.dataset.stockTheme = settings.theme;
    root.style.setProperty('--stock-font', `${settings.fontSize}px`);
    for (const [property, value] of [['--up', settings.up], ['--down', settings.down]]) {
      if (value && /^#[0-9a-f]{6}$/i.test(value)) root.style.setProperty(property, value);
      else root.style.removeProperty(property);
    }
  };
})();
