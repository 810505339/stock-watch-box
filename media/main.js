(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const collapsed = new Set(Array.isArray(saved.collapsed) ? saved.collapsed : []);
  const expanded = new Set(Array.isArray(saved.expanded) ? saved.expanded : []);
  const groupViews = new Map();
  const summaryViews = new Map();
  const header = document.getElementById('header');
  const summary = document.getElementById('summary');
  const groups = document.getElementById('groups');
  const footer = document.getElementById('footer');
  let snapshot;
  const dragMime = 'application/x-stock-watch-box-item';
  let dragState = null;
  let dropIndicator = null;
  let suppressClickUntil = 0;
  let intradaySequence = 0;

  const paths = {
    plus: 'M8 3v10M3 8h10',
    refresh: 'M13 6A5.2 5.2 0 0 0 4.2 3.8L2 6m0-4v4h4m-3 4a5.2 5.2 0 0 0 8.8 2.2L14 10m0 4v-4h-4',
    chevron: 'm6 3 5 5-5 5',
    more: 'M3 8h.01M8 8h.01M13 8h.01',
    chart: 'M2 12V4m0 8h12M5 9l3-4 3 2 3-5',
    settings: 'M2 4h12M2 8h12M2 12h12M5 2v4m5 0v4m-4 0v4',
    candles: 'M4 2v3m0 6v3M2 5h4v6H2zM10 2v2m0 5v5M8 4h4v5H8z',
    up: 'M8 13V3m-4 4 4-4 4 4',
    down: 'M8 3v10m-4-4 4 4 4-4',
    flat: 'M3 8h10',
    wallet: 'M2 4h11v9H2V4Zm0 0V2h9v2m-1 4h4v3h-4V8Z'
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', name === 'more' ? '3' : '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('icon');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[name] || paths.flat);
    svg.append(path);
    return svg;
  }

  function post(type, payload = {}) {
    vscode.postMessage({ type, ...payload });
  }

  function clearDropIndicator() {
    if (dropIndicator) dropIndicator.element.classList.remove(dropIndicator.className);
    dropIndicator = null;
  }

  function finishDrag() {
    clearDropIndicator();
    if (dragState) dragState.element.classList.remove('dragging');
    dragState = null;
    suppressClickUntil = Date.now() + 350;
  }

  function suppressDragClick(event) {
    if (Date.now() >= suppressClickUntil) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function beginDrag(event, item, element) {
    if (!event.dataTransfer || positionDialog.open) {
      event.preventDefault();
      return;
    }
    finishDrag();
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    dragState = { ...item, element, token };
    event.dataTransfer.setData(dragMime, token);
    event.dataTransfer.effectAllowed = 'move';
    element.classList.add('dragging');
    event.stopPropagation();
  }

  function validDrag(event, dropping = false) {
    if (!dragState || !event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes(dragMime)) return false;
    if (dropping && event.dataTransfer.getData(dragMime) !== dragState.token) return false;
    const source = snapshot?.state.groups.find(group => group.id === dragState.groupId);
    return Boolean(source && (dragState.kind === 'group' ||
      (source.symbols.includes(dragState.symbol) && snapshot.state.securities[dragState.symbol])));
  }

  function acceptDrop(event, target, element, className) {
    if (!validDrag(event) || dragState.kind !== target.kind) return;
    if (target.beforeId === 'market') return;
    if (target.kind === 'stock' && !manualSort(target.groupId)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    if (dropIndicator?.element === element && dropIndicator.className === className) return;
    clearDropIndicator();
    element.classList.add(className);
    dropIndicator = { element, className };
  }

  function performDrop(event, target) {
    if (!validDrag(event, true) || dragState.kind !== target.kind) return;
    if (target.beforeId === 'market') return;
    if (target.kind === 'stock' && !manualSort(target.groupId)) return;
    event.preventDefault();
    event.stopPropagation();
    const source = dragState;
    if (source.kind === 'group') {
      if (source.groupId !== target.beforeId) {
        post('reorderGroup', { groupId: source.groupId, ...(target.beforeId ? { beforeId: target.beforeId } : {}) });
      }
    } else {
      const destination = snapshot.state.groups.find(group => group.id === target.groupId);
      if (destination && (!target.beforeSymbol || destination.symbols.includes(target.beforeSymbol)) &&
        !(source.groupId === target.groupId && source.symbol === target.beforeSymbol)) {
        post('reorderStock', {
          fromGroupId: source.groupId, toGroupId: target.groupId, symbol: source.symbol,
          ...(target.beforeSymbol ? { beforeSymbol: target.beforeSymbol } : {})
        });
      }
    }
    finishDrag();
  }

  function persist() {
    vscode.setState({ collapsed: [...collapsed], expanded: [...expanded], scrollTop: groups.scrollTop });
  }

  function button(label, iconName, onClick, className = 'icon-button') {
    const element = node('button', className);
    element.type = 'button';
    element.title = label;
    element.setAttribute('aria-label', label);
    if (iconName) element.append(icon(iconName));
    element.addEventListener('click', onClick);
    return element;
  }

  function textButton(label, iconName, onClick, className = 'text-button') {
    const element = button(label, iconName, onClick, className);
    element.append(node('span', '', label));
    return element;
  }

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function number(value, decimals = 2) {
    return finite(value) ? value.toLocaleString('zh-CN', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }) : '—';
  }

  function signed(value, decimals = 2) {
    if (!finite(value)) return '—';
    const rounded = Number(value.toFixed(decimals));
    return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${number(Math.abs(rounded), decimals)}`;
  }

  function money(value, currency, withSign = false) {
    if (!finite(value)) return '—';
    const unit = currency === 'HKD' ? 'HK$' : '¥';
    return `${withSign ? signed(value) : number(value)} ${unit}`;
  }

  function percent(value) {
    return finite(value) ? `${signed(value)}\u2009%` : '—';
  }

  function namePrefix(value, limit) {
    let result = '';
    for (const part of value.match(/\d+|[^\d]/gu) || []) {
      if (Array.from(result).length >= limit) break;
      result += part;
    }
    return result;
  }

  function shortSecurityName(fullName, security) {
    let name = String(fullName || security.code || '').trim().replace(/\s+/g, '');
    if (security.kind === 'index') {
      const known = { sh000001: '上证', sz399001: '深成', sz399006: '创业板' }[security.id];
      return known || namePrefix(name.replace(/指数$/u, ''), 4) || name;
    }
    name = name.replace(/(?:[-－](?:SW|W|S|B|R))+$/i, '');
    const risk = name.match(/^(\*?ST)(?=\p{Script=Han})/iu)?.[1].toUpperCase() || '';
    if (risk) name = name.slice(risk.length);
    if (security.kind === 'fund') {
      const beforeType = name.split(/ETF|LOF/i)[0];
      if (beforeType) name = beforeType;
    }
    name = name.replace(/(?:股份有限公司|有限责任公司|有限公司|股份|控股|集团)+$/u, '');
    const known = {
      '中国重汽': '重汽', '华东医药': '华东', '兴业银锡': '兴业', '圆通速递': '圆通',
      '贵州茅台': '茅台', '中国平安': '平安', '阿里巴巴': '阿里'
    }[name];
    if (known) return `${risk}${known}`;
    if (/^[A-Za-z][A-Za-z0-9._-]*$/.test(name)) return name.slice(0, 4);
    return `${risk}${namePrefix(name, risk || security.kind === 'stock' ? 2 : 3)}` || String(fullName || security.code || '');
  }

  function costInputValue(value) {
    return finite(value) ? value.toFixed(8).replace(/\.?0+$/, '') || '0' : '';
  }

  function tone(element, value) {
    element.classList.toggle('positive', finite(value) && value > 0);
    element.classList.toggle('negative', finite(value) && value < 0);
    element.classList.toggle('neutral', !finite(value) || value === 0);
  }

  function setText(element, value) {
    const text = String(value);
    if (element.textContent !== text) element.textContent = text;
  }

  function dailyLabel(date, today) {
    if (!date) return '今日盈亏';
    return date === today ? '今日盈亏' : `${date} 盈亏`;
  }

  function quoteTime(quote) {
    if (!quote || !quote.time) return '等待行情';
    const value = quote.time;
    if (/^\d{14}$/.test(value)) {
      return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)} ${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}`;
    }
    return value.replaceAll('/', '-');
  }

  const heading = node('div', 'heading');
  const identity = node('div', 'custom-identity');
  const customIcon = node('span', 'custom-icon');
  const customTitle = node('span', 'custom-title');
  identity.append(customIcon, customTitle);
  const actions = node('div', 'header-actions');
  const refreshButton = button('刷新行情', 'refresh', () => post('refresh'));
  const createGroupButton = button('新建分类', 'plus', () => post('addGroup'));
  const settingsButton = button('设置', 'settings', () => openSettings());
  actions.append(refreshButton, createGroupButton, settingsButton);
  heading.append(identity, actions);
  header.append(heading);

  const settingsDialog = node('dialog', 'position-dialog settings-dialog');
  const settingsForm = node('form', 'position-form');
  const settingsTitle = node('h2', 'position-heading', '盯盘设置');
  settingsTitle.id = 'stock-settings-title';
  settingsDialog.setAttribute('aria-labelledby', settingsTitle.id);
  settingsForm.append(settingsTitle);
  settingsDialog.append(settingsForm);
  document.body.append(settingsDialog);
  const fields = {};
  function setting(label, key, type, options) {
    const field = node('label', 'position-field settings-field', label);
    const control = node(options ? 'select' : 'input', type === 'checkbox' ? '' : 'position-input');
    if (options) {
      for (const [value, name] of options) {
        const option = node('option', '', name);
        option.value = value;
        control.append(option);
      }
    } else control.type = type;
    field.append(control);
    settingsForm.append(field);
    fields[key] = control;
    return control;
  }
  const font = setting('字号（px）', 'fontSize', 'number');
  font.min = 8; font.max = 20; font.required = true;
  setting('字体', 'fontFamily', '', window.stockFontChoices);
  setting('主题', 'theme', '', [['system', '跟随 VS Code'], ['light', '浅色'], ['dark', '深色']]);
  for (const [key, label] of [['up', '上涨颜色'], ['down', '下跌颜色']]) {
    const input = setting(`${label}（留空跟随主题）`, key, 'text');
    input.placeholder = '#ad8b8e';
    input.pattern = '#[0-9a-fA-F]{6}';
  }
  setting('面板标题', 'title', 'text').maxLength = 40;
  const iconField = setting('图标', 'icon', '', [['none', '无'], ['activity', '趋势'], ['candles', 'K 线'], ['png', '本地 PNG']]);
  const choosePng = textButton('选择 PNG', null, () => post('chooseIcon'));
  settingsForm.append(choosePng);
  setting('显示伦敦金', 'gold', 'checkbox');
  setting('显示伦敦银', 'silver', 'checkbox');
  const settingsError = node('p', 'settings-error');
  settingsError.setAttribute('role', 'alert');
  const settingsActions = node('div', 'position-actions');
  const restoreSettings = textButton('恢复默认', null, () => {
    fillSettings({ fontSize: 8, fontFamily: 'system', theme: 'system', up: '', down: '', title: '', icon: 'none', png: '', gold: true, silver: true });
    previewSettings();
  });
  const cancelSettings = textButton('取消', null, () => settingsDialog.close());
  const submitSettings = node('button', 'text-button', '保存');
  submitSettings.type = 'submit';
  settingsActions.append(restoreSettings, cancelSettings, submitSettings);
  settingsForm.append(settingsError, settingsActions);
  let png = '';
  let displayedIcon = '';
  let savingSettings = false;
  function fillSettings(settings) {
    png = settings.png;
    for (const [key, control] of Object.entries(fields)) {
      if (control.type === 'checkbox') control.checked = settings[key];
      else control.value = key === 'fontFamily' ? settings[key] ?? 'system' : settings[key];
    }
  }
  function readSettings() {
    return { ...Object.fromEntries(Object.entries(fields).map(([key, control]) =>
      [key, control.type === 'checkbox' ? control.checked : control.value])),
    fontSize: Math.max(8, Math.min(20, Number(font.value) || 8)), png };
  }
  function applySettings(settings) {
    if (!settings) return;
    window.applyStockAppearance(settings);
    setText(customTitle, settings.title);
    customTitle.title = settings.title;
    const nextIcon = settings.icon === 'png' ? settings.png : settings.icon;
    if (nextIcon === displayedIcon) return;
    displayedIcon = nextIcon;
    customIcon.replaceChildren();
    if (settings.icon === 'png' && settings.png) {
      const image = node('img');
      image.alt = '';
      image.src = `data:image/png;base64,${settings.png}`;
      customIcon.append(image);
    } else if (settings.icon === 'activity' || settings.icon === 'candles') {
      customIcon.append(icon(settings.icon === 'activity' ? 'chart' : 'candles'));
    }
  }
  function previewSettings() {
    choosePng.hidden = iconField.value !== 'png';
    const settings = readSettings();
    applySettings(settings);
    previewMetalRows(settings);
  }
  function previewMetalRows(settings) {
    const rows = groupViews.get('market')?.rows;
    for (const [id, visible] of [['hf_XAU', settings.gold], ['hf_XAG', settings.silver]]) {
      const row = rows?.get(id);
      if (row) row.article.hidden = !visible;
    }
  }
  function openSettings() {
    if (!snapshot?.preferences || settingsDialog.open) return;
    fillSettings(snapshot.preferences);
    setText(settingsError, '');
    previewSettings();
    settingsDialog.showModal();
  }
  settingsForm.addEventListener('input', previewSettings);
  settingsForm.addEventListener('submit', event => {
    event.preventDefault();
    if (savingSettings) return;
    const settings = readSettings();
    if (settings.icon === 'png' && !settings.png) {
      setText(settingsError, '请先选择 PNG 图标');
      return;
    }
    savingSettings = true;
    submitSettings.disabled = true;
    post('saveSettings', { settings });
  });
  settingsDialog.addEventListener('close', () => {
    if (!snapshot?.preferences) return;
    applySettings(snapshot.preferences);
    previewMetalRows(snapshot.preferences);
  });

  function createSummary(currency) {
    const card = node('article', `summary-card currency-${currency.toLowerCase()}`);
    const top = node('div', 'summary-top');
    const title = node('span', 'summary-currency', currency === 'CNY' ? '人民币持仓' : '港币持仓');
    const badge = node('span', 'currency-badge', currency);
    top.append(title, badge);
    const dailyTitle = node('div', 'metric-label', '今日盈亏');
    const dailyRow = node('div', 'daily-value-row');
    const dailyValue = node('span', 'daily-value', '0.00');
    const dailyRate = node('span', 'daily-rate', '—');
    dailyRow.append(dailyTitle, dailyValue, dailyRate);
    const profitRow = node('div', 'profit-row');
    const profitValue = node('span', 'profit-value', '0.00');
    const profitRate = node('span', 'profit-rate', '—');
    profitRow.append(node('span', 'metric-label', '总盈亏'), profitValue, profitRate);
    const note = node('div', 'summary-note', '添加持仓后自动汇总');
    card.append(top, dailyRow, profitRow, note);
    card.hidden = currency === 'HKD';
    summary.append(card);
    summaryViews.set(currency, { card, dailyTitle, dailyValue, dailyRate, profitValue, profitRate, note });
  }

  createSummary('CNY');
  createSummary('HKD');

  const listHeading = node('div', 'list-heading');
  const listCount = node('span', 'list-count', '0 个分类');
  listHeading.append(node('span', '', '我的自选'), listCount);
  const groupList = node('div', 'group-list');
  const empty = node('div', 'empty-state');
  const emptyIcon = node('div', 'empty-icon');
  emptyIcon.append(icon('chart'));
  empty.append(emptyIcon, node('h2', '', '还没有自选分类'),
    node('p', '', '先创建一个分类，再添加股票。每个分类最多 10 只。'),
    textButton('创建第一个分类', 'plus', () => post('addGroup'), 'primary-button'));
  const emptyHint = node('p', 'empty-hint', '右键股票可添加持仓，自动计算盈亏。');
  empty.append(emptyHint);
  groups.append(listHeading, groupList, empty);

  const statusRow = node('div', 'status-row');
  const statusLeft = node('div', 'status-left');
  const statusDot = node('span', 'status-dot');
  const statusText = node('span', 'status-text', '连接行情中');
  const updated = node('span', 'updated-time');
  statusLeft.append(statusDot, statusText);
  statusRow.append(statusLeft, updated);
  const errorText = node('div', 'error-text');
  const footerHint = node('div', 'footer-hint', '右键股票管理持仓 · 数据仅供参考');
  footer.append(statusRow, errorText, footerHint);

  const positionDialog = node('dialog', 'position-dialog');
  positionDialog.setAttribute('aria-labelledby', 'position-title');
  const positionForm = node('form', 'position-form');
  positionForm.noValidate = true;
  const positionHeading = node('h2', 'position-heading', '添加持仓');
  positionHeading.id = 'position-title';
  const positionSecurity = node('div', 'position-security');
  const positionName = node('span', 'position-security-name');
  const positionCode = node('span', 'position-security-code');
  positionSecurity.append(positionName, positionCode);
  const positionFields = node('div', 'position-fields');
  const positionNotice = node('div', 'position-notice', '指数仅供盯盘，无需录入持仓。');
  positionNotice.hidden = true;
  const quantityLabel = node('label', 'position-field');
  const quantityCaption = node('span', '', '数量（股）');
  const quantityInput = node('input', 'position-input');
  quantityInput.type = 'text';
  quantityInput.inputMode = 'numeric';
  quantityInput.autocomplete = 'off';
  quantityInput.spellcheck = false;
  quantityInput.name = 'quantity';
  quantityInput.setAttribute('aria-describedby', 'position-error');
  quantityLabel.append(quantityCaption, quantityInput);
  const costLabel = node('label', 'position-field');
  const costCaption = node('span', '', '成本价（CNY）');
  const costInput = node('input', 'position-input');
  costInput.type = 'text';
  costInput.inputMode = 'decimal';
  costInput.autocomplete = 'off';
  costInput.spellcheck = false;
  costInput.name = 'cost';
  costInput.setAttribute('aria-describedby', 'position-error');
  costLabel.append(costCaption, costInput);
  positionFields.append(quantityLabel, costLabel);
  const positionError = node('div', 'position-error');
  positionError.id = 'position-error';
  positionError.setAttribute('role', 'alert');
  positionError.hidden = true;
  const positionActions = node('div', 'position-actions');
  const cancelPositionButton = textButton('取消', null, () => closePosition(), 'position-action');
  const savePositionButton = node('button', 'position-action position-save', '保存');
  savePositionButton.type = 'submit';
  positionActions.append(cancelPositionButton, savePositionButton);
  const positionManage = node('div', 'position-manage');
  const clearPositionButton = textButton('清空持仓', null, () => managePosition('clearPosition'), 'position-manage-button');
  const movePositionButton = textButton('移动分类', null, () => managePosition('move'), 'position-manage-button');
  const removePositionButton = textButton('移除自选', null, () => managePosition('remove'), 'position-manage-button');
  positionManage.append(clearPositionButton, movePositionButton, removePositionButton);
  positionForm.append(positionHeading, positionSecurity, positionNotice, positionFields, positionError, positionActions, positionManage);
  positionDialog.append(positionForm);
  document.body.append(positionDialog);
  let positionEditor = null;
  let positionRequestSequence = 0;
  const positionRequestSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  function setPositionSaving(saving) {
    if (!positionEditor) return;
    positionEditor.saving = saving;
    quantityInput.disabled = saving || positionEditor.isIndex;
    costInput.disabled = saving || positionEditor.isIndex;
    cancelPositionButton.disabled = saving;
    savePositionButton.disabled = saving || positionEditor.isIndex;
    clearPositionButton.disabled = saving || !positionEditor.hasPosition;
    movePositionButton.disabled = saving;
    removePositionButton.disabled = saving;
    setText(savePositionButton, saving ? '保存中…' : '保存');
    positionForm.setAttribute('aria-busy', String(saving));
  }

  function closePosition(force = false) {
    if (!positionEditor || (positionEditor.saving && !force)) return;
    const target = positionEditor.focusTarget;
    positionEditor = null;
    positionDialog.close();
    if (target?.isConnected) target.focus({ preventScroll: true });
    else createGroupButton.focus({ preventScroll: true });
  }

  function openPosition(groupId, symbol, focusTarget) {
    const security = snapshot?.state.securities[symbol];
    const group = snapshot?.state.groups.find(item => item.id === groupId && item.symbols.includes(symbol));
    if (!security || !group) return;
    if (positionEditor) {
      if (positionEditor.saving || (positionEditor.groupId === groupId && positionEditor.symbol === symbol)) return;
      closePosition();
    }
    const position = snapshot.state.positions[symbol];
    const quote = snapshot.quotes[symbol];
    const isIndex = security.kind === 'index';
    positionEditor = {
      groupId, symbol, saving: false, requestId: null, hasPosition: !isIndex && Boolean(position), isIndex,
      focusTarget: focusTarget || groupViews.get(groupId)?.rows.get(symbol)?.main || document.activeElement
    };
    setText(positionHeading, isIndex ? '管理指数' : position ? '修改持仓' : '添加持仓');
    const fullName = groupViews.get(groupId)?.rows.get(symbol)?.fullName || quote?.name || security.name;
    setText(positionName, fullName);
    positionName.title = fullName;
    setText(positionCode, security.code);
    setText(quantityCaption, `数量（${security.kind === 'fund' ? '份' : '股'}）`);
    setText(costCaption, `成本价（${quote?.currency || security.currency}）`);
    positionNotice.hidden = !isIndex;
    positionFields.hidden = isIndex;
    savePositionButton.hidden = isIndex;
    clearPositionButton.hidden = isIndex;
    setText(cancelPositionButton.lastElementChild, isIndex ? '关闭' : '取消');
    cancelPositionButton.setAttribute('aria-label', isIndex ? '关闭' : '取消');
    cancelPositionButton.title = isIndex ? '关闭' : '取消';
    quantityInput.value = position ? String(position.quantity) : '';
    costInput.value = position ? costInputValue(position.cost) : '';
    quantityInput.removeAttribute('aria-invalid');
    costInput.removeAttribute('aria-invalid');
    positionError.hidden = true;
    setText(positionError, '');
    setPositionSaving(false);
    positionDialog.showModal();
    if (isIndex) cancelPositionButton.focus();
    else {
      quantityInput.focus();
      quantityInput.select();
    }
  }

  function managePosition(type) {
    if (!positionEditor || positionEditor.saving) return;
    if (type === 'clearPosition' && positionEditor.isIndex) return;
    const { groupId, symbol } = positionEditor;
    closePosition();
    post(type, { groupId, symbol });
  }

  function showPositionError(message, field) {
    setText(positionError, message);
    positionError.hidden = false;
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    }
  }

  positionForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!positionEditor || positionEditor.saving || positionEditor.isIndex) return;
    quantityInput.removeAttribute('aria-invalid');
    costInput.removeAttribute('aria-invalid');
    const quantity = quantityInput.value.trim();
    const cost = costInput.value.trim();
    if (!/^\d+$/.test(quantity) || !Number.isSafeInteger(Number(quantity)) || Number(quantity) <= 0 || Number(quantity) > 1e9) {
      showPositionError('数量需为 1 至 1,000,000,000 的整数。', quantityInput);
      return;
    }
    if (!/^\d+(?:\.\d{1,8})?$/.test(cost) || !Number.isFinite(Number(cost)) || Number(cost) < 0 || Number(cost) > 1e6) {
      showPositionError('成本价需为 0 至 1,000,000 的普通数字，最多 8 位小数。', costInput);
      return;
    }
    positionError.hidden = true;
    const requestId = `position-${positionRequestSession}-${++positionRequestSequence}`;
    positionEditor.requestId = requestId;
    setPositionSaving(true);
    post('savePosition', { requestId, groupId: positionEditor.groupId, symbol: positionEditor.symbol, quantity, cost });
  });

  positionDialog.addEventListener('cancel', event => {
    event.preventDefault();
    closePosition();
  });

  function receivePositionResult(message) {
    if (!positionEditor?.saving || message.requestId !== positionEditor.requestId) return;
    positionEditor.requestId = null;
    setPositionSaving(false);
    if (message.ok === true) closePosition();
    else showPositionError(typeof message.error === 'string' && message.error ? message.error : '保存失败，请重试。');
  }

  function createGroup(group) {
    const section = node('section', 'watch-group');
    section.dataset.groupId = group.id;
    const groupHeader = node('div', 'group-header');
    groupHeader.setAttribute('data-vscode-context', JSON.stringify({
      webviewSection: 'group', groupId: group.id, preventDefaultContextMenuItems: true
    }));
    const toggle = button('折叠分类', 'chevron', event => {
      if (suppressDragClick(event)) return;
      if (collapsed.has(group.id)) collapsed.delete(group.id);
      else collapsed.add(group.id);
      updateCollapsed(view);
      persist();
    }, 'group-toggle');
    toggle.draggable = group.id !== 'market';
    toggle.addEventListener('dragstart', event => beginDrag(event, { kind: 'group', groupId: group.id }, toggle));
    toggle.addEventListener('dragend', finishDrag);
    groupHeader.addEventListener('dragover', event => {
      const target = dragState?.kind === 'group' ? { kind: 'group', beforeId: group.id } : { kind: 'stock', groupId: group.id };
      acceptDrop(event, target, groupHeader, target.kind === 'group' ? 'drop-before' : 'drop-tail');
    });
    groupHeader.addEventListener('drop', event => performDrop(event,
      dragState?.kind === 'group' ? { kind: 'group', beforeId: group.id } : { kind: 'stock', groupId: group.id }));
    const name = node('span', 'group-name');
    const count = node('span', 'group-count');
    toggle.append(name, count);
    const add = button('添加股票 / 场内基金', 'plus', () => post('addStock', { groupId: group.id }));
    const menu = button('分类操作', 'more', () => post('groupMenu', { groupId: group.id }));
    groupHeader.append(toggle, add, menu);
    if (group.id === 'market') {
      groupHeader.removeAttribute('data-vscode-context');
      add.hidden = true;
      menu.hidden = true;
    }
    const body = node('div', 'group-body');
    const stockList = node('div', 'stock-list');
    const addFirst = textButton('添加股票或基金', 'plus', () => post('addStock', { groupId: group.id }), 'group-empty');
    body.append(stockList, addFirst);
    body.addEventListener('dragover', event => acceptDrop(event, { kind: 'stock', groupId: group.id }, body, 'drop-tail'));
    body.addEventListener('drop', event => performDrop(event, { kind: 'stock', groupId: group.id }));
    section.append(groupHeader, body);
    const view = { section, toggle, name, count, add, body, stockList, addFirst, rows: new Map(), id: group.id };
    groupViews.set(group.id, view);
    return view;
  }

  function updateCollapsed(view) {
    const closed = collapsed.has(view.id);
    view.body.hidden = closed;
    view.toggle.setAttribute('aria-expanded', String(!closed));
    view.toggle.setAttribute('aria-label', `${closed ? '展开' : '折叠'} ${view.name.textContent}`);
    view.toggle.title = `${closed ? '展开' : '折叠'}分类`;
    view.section.classList.toggle('collapsed', closed);
  }

  function detail(label) {
    const item = node('div', 'detail-item');
    const value = node('dd', '', '—');
    item.append(node('dt', '', label), value);
    return { item, value };
  }

  function createStock(groupId, symbol) {
    const market = groupId === 'market';
    const key = JSON.stringify([groupId, symbol]);
    const article = node('article', 'stock');
    if (!market) article.setAttribute('data-vscode-context', JSON.stringify({
      webviewSection: 'stock', symbol, groupId, preventDefaultContextMenuItems: true
    }));
    let wasExpanded = false;
    const openDetail = () => post('openDetail', { groupId, symbol });
    const main = button('展开股票详情', null, event => {
      if (suppressDragClick(event)) return;
      if (event.detail > 1) return;
      wasExpanded = expanded.has(key);
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      updateExpanded(view);
      persist();
    }, 'stock-main');
    main.addEventListener('dblclick', event => {
      if (suppressDragClick(event)) return;
      if (wasExpanded) expanded.add(key);
      else expanded.delete(key);
      updateExpanded(view);
      persist();
      openDetail();
    });
    main.draggable = !market;
    main.addEventListener('dragstart', event => beginDrag(event, { kind: 'stock', groupId, symbol }, main));
    main.addEventListener('dragend', finishDrag);
    article.addEventListener('dragover', event => acceptDrop(event,
      { kind: 'stock', groupId, beforeSymbol: symbol }, article, 'drop-before'));
    article.addEventListener('drop', event => performDrop(event, { kind: 'stock', groupId, beforeSymbol: symbol }));
    main.addEventListener('contextmenu', event => {
      if (market) return;
      event.preventDefault();
      event.stopPropagation();
      openPosition(groupId, symbol, main);
    });
    main.addEventListener('keydown', event => {
      if (market) return;
      if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
        event.preventDefault();
        event.stopPropagation();
        openPosition(groupId, symbol, main);
      }
    });
    const name = node('span', 'stock-name');
    const code = node('span', 'stock-code');
    const fund = node('span', 'fund-tag', '场内基金');
    fund.title = '场内基金';
    const stale = node('span', 'quote-badge', '旧行情');
    const price = node('span', 'stock-price', '—');
    const priceDetail = node('span', 'detail-price', '—');
    const change = node('span', 'stock-change');
    const arrow = node('span', 'change-arrow');
    const changeText = node('span', '', '—');
    change.append(arrow, changeText);
    const pnl = node('span', 'position-strip');
    const pnlTitle = node('span', 'position-label', '今日盈亏');
    const pnlValue = node('span', 'position-value', '—');
    pnl.append(pnlTitle, pnlValue);
    main.append(change, price, name, pnl, code);

    const details = node('div', 'stock-details');
    const quoteHeader = node('div', 'detail-quote');
    quoteHeader.append(node('span', 'metric-label', '现价'), priceDetail, fund, stale);
    const detailGrid = node('dl', 'detail-grid');
    const fields = {};
    for (const [id, label] of [['previous', '昨日收盘'], ['change', '涨跌金额'], ['quantity', '持仓数量'],
      ['cost', '单位成本'], ['marketValue', '持仓市值'], ['profit', '持仓盈亏'],
      ['costValue', '持仓成本'], ['profitPercent', '持仓收益率']]) {
      const field = detail(label);
      fields[id] = field.value;
      detailGrid.append(field.item);
    }
    const positionButton = textButton('添加持仓', 'wallet', () => openPosition(groupId, symbol, main));
    const time = node('div', 'quote-time');
    const source = node('div', 'quote-source');
    const positionNote = node('div', 'position-note', '日盈亏按现有数量与昨收估算，不含交易和费用。');
    const chartButton = textButton('查看图表', 'chart', openDetail);
    const trend = node('section', 'inline-trend');
    const trendStatus = node('p', 'trend-status', '分时 · 成交量 · MACD');
    const trendLegend = node('p', 'trend-legend');
    const trendPlot = node('div', 'trend-plot');
    trendPlot.tabIndex = 0;
    trendPlot.setAttribute('aria-label', '分时走势、成交量和 MACD，按左右键查看数据');
    trendPlot.hidden = true;
    const trendRetry = textButton('重试分时', null, () => requestTrend(view, true));
    trendRetry.hidden = true;
    const trendCredits = node('a', 'trend-credits', 'TradingView Lightweight Charts™');
    trendCredits.href = 'https://www.tradingview.com/';
    trend.append(trendStatus, trendLegend, trendPlot, trendRetry, trendCredits);
    details.append(quoteHeader, detailGrid, positionButton, chartButton, trend, time, source, positionNote);
    article.append(main, details);
    const view = { key, article, main, name, code, fund, stale, price, priceDetail, change, arrow, changeText,
      pnl, pnlTitle, pnlValue, details, fields, positionButton, chartButton, time, source, positionNote, market, direction: '', fullName: '',
      groupId, symbol, trend, trendStatus, trendLegend, trendPlot, trendRetry, trendNext: 0, trendRequest: 0 };
    return view;
  }

  function updateExpanded(view) {
    const open = expanded.has(view.key);
    view.details.hidden = !open;
    view.main.setAttribute('aria-expanded', String(open));
    view.main.setAttribute('aria-label', `${view.changeText.textContent}，${view.fullName}，${view.code.textContent}，${open ? '收起' : '展开'}详情`);
    view.main.title = `${view.tooltip || view.fullName}\n点击${open ? '收起' : '展开'}摘要，双击打开详情`;
    view.article.classList.toggle('expanded', open);
    if (open && !collapsed.has(view.groupId) && !view.trend.hidden) requestTrend(view);
    else clearTrend(view);
  }

  function clearTrend(view) {
    view.trendRequest = 0;
    view.trendNext = 0;
    view.trendChart?.dispose();
    view.trendChart = undefined;
    view.trendPlot.hidden = true;
    view.trendRetry.hidden = true;
    setText(view.trendLegend, '');
  }

  function requestTrend(view, retry = false) {
    if (!window.StockWatchIntraday || view.trendRequest ||
        document.hidden || (!retry && Date.now() < view.trendNext)) return;
    view.trendRequest = ++intradaySequence;
    view.trendNext = Date.now() + 1_000;
    view.trendRetry.hidden = true;
    if (!view.trendChart) setText(view.trendStatus, '正在获取分时走势…');
    post('intraday', { groupId: view.groupId, symbol: view.symbol, requestId: view.trendRequest, retry });
  }

  function receiveTrend(message) {
    const view = groupViews.get(message.groupId)?.rows.get(message.symbol);
    if (!view || view.trendRequest !== message.requestId || view.details.hidden || collapsed.has(view.groupId)) return;
    view.trendRequest = 0;
    if (!message.data) {
      view.trendNext = Date.now() + 5_000;
      setText(view.trendStatus, view.trendChart ? '分时更新失败 · 保留上次数据' : message.error);
      view.trendRetry.hidden = false;
      return;
    }
    setText(view.trendStatus, `分时 · ${message.data.date} · 成交量 · MACD`);
    view.trendPlot.hidden = false;
    view.trendChart ??= window.StockWatchIntraday.createIntraday(view.trendPlot, view.trendLegend, true);
    view.trendChart.theme();
    view.trendChart.set(message.data);
  }

  setInterval(() => {
    if (document.hidden) return;
    for (const group of groupViews.values()) {
      if (collapsed.has(group.id)) continue;
      for (const row of group.rows.values()) {
        if (!row.details.hidden && !row.trend.hidden) requestTrend(row);
      }
    }
  }, 1_000);

  function updateStock(view, symbol, data) {
    const security = data.state.securities[symbol];
    if (!security) return;
    view.trend.hidden = security.kind === 'metal';
    view.isIndex = security.kind === 'index';
    const quote = data.quotes[symbol];
    const metrics = data.metrics[symbol];
    const position = view.market || security.kind === 'index' ? undefined : data.state.positions[symbol];
    const currency = security.kind === 'metal' ? '美元／金衡盎司' : quote?.currency || security.currency;
    const market = { sh: '沪', sz: '深', bj: '北', hk: '港' }[security.market] || '';
    const priceDecimals = security.market === 'hk' || security.kind === 'fund' ? 3 : 2;
    view.fullName = quote?.name || security.name;
    setText(view.name, view.market ? security.name : shortSecurityName(view.fullName, security));
    view.name.title = view.fullName;
    setText(view.code, security.code);
    view.code.title = `${market} ${security.code} · ${currency}`;
    view.fund.hidden = security.kind === 'stock';
    setText(view.fund, security.kind === 'metal' ? currency : security.kind === 'index' ? '指数' : '场内基金');
    view.fund.title = view.fund.textContent;
    const historical = Boolean(quote) && quote.date !== data.today;
    view.stale.hidden = Boolean(quote) && !quote.stale && !historical;
    setText(view.stale, !quote ? '…' : '!');
    view.stale.title = quote ? `行情时间 ${quoteTime(quote)} (UTC+8)；${historical ? '非今日行情' : '保留最近一次行情'}` : '尚未取得有效行情';
    setText(view.price, number(quote?.price, priceDecimals));
    setText(view.priceDetail, view.price.textContent);
    view.price.title = `现价 ${view.price.textContent} ${currency}\n行情时间 ${quoteTime(quote)}${historical ? ' · 非今日行情' : quote?.stale ? ' · 旧行情' : ''}`;
    setText(view.changeText, percent(quote?.changePercent));
    tone(view.change, quote?.changePercent);
    tone(view.price, quote?.changePercent);
    const changePercent = quote?.changePercent;
    const direction = finite(changePercent) ? changePercent > 0 ? 'up' : changePercent < 0 ? 'down' : 'flat' : 'flat';
    const arrowCount = direction === 'flat' ? 1 : Math.abs(changePercent) >= 6 ? 3 : Math.abs(changePercent) >= 3 ? 2 : 1;
    const arrowKey = `${direction}:${arrowCount}`;
    if (view.direction !== arrowKey) {
      view.arrow.replaceChildren(...Array.from({ length: arrowCount }, () => icon(direction)));
      view.direction = arrowKey;
    }
    view.pnl.hidden = !position;
    view.article.classList.toggle('has-position', Boolean(position));
    setText(view.pnlTitle, dailyLabel(quote?.date, data.today));
    setText(view.pnlValue, finite(metrics?.daily) ? signed(metrics.daily) : '—');
    view.pnl.title = `${dailyLabel(quote?.date, data.today)}估算：${finite(metrics?.daily) ? money(metrics.daily, currency, true) : '数据不足'}`;
    tone(view.pnlValue, metrics?.daily);
    setText(view.fields.previous, number(quote?.previousClose, priceDecimals));
    setText(view.fields.change, signed(quote?.change, priceDecimals));
    tone(view.fields.change, quote?.change);
    setText(view.fields.quantity, position ? `${number(position.quantity, 0)} ${security.kind === 'fund' ? '份' : '股'}` : '未设置');
    setText(view.fields.cost, position ? `${number(position.cost, priceDecimals)} ${currency}` : '—');
    setText(view.fields.marketValue, money(metrics?.marketValue, currency));
    setText(view.fields.costValue, position ? money(metrics?.costValue, currency) : '—');
    setText(view.fields.profit, money(metrics?.profit, currency, true));
    setText(view.fields.profitPercent, percent(metrics?.profitPercent));
    tone(view.fields.profit, metrics?.profit);
    tone(view.fields.profitPercent, metrics?.profitPercent);
    const positionLabel = position ? '修改持仓' : '添加持仓';
    view.positionButton.hidden = view.market || security.kind === 'index';
    const chartLabel = security.kind === 'metal' ? '查看报价详情' : '查看图表';
    setText(view.chartButton.lastElementChild, chartLabel);
    view.chartButton.setAttribute('aria-label', chartLabel);
    view.chartButton.title = chartLabel;
    setText(view.positionButton.lastElementChild, positionLabel);
    view.positionButton.title = positionLabel;
    view.positionButton.setAttribute('aria-label', `${positionLabel}：${view.fullName}`);
    setText(view.time, `行情时间 ${quoteTime(quote)}${quote ? ' (UTC+8)' : ''}`);
    setText(view.source, `腾讯行情${security.market === 'hk' ? ' · 港股行情可能延迟' : ''}${historical ? ' · 非今日行情' : quote?.stale ? ' · 数据已过期' : ''}`);
    view.positionNote.hidden = !position;
    view.tooltip = `${view.changeText.textContent} · ${view.fullName} · ${market}${security.code}\n现价 ${view.price.textContent} ${currency}${security.kind === 'index' ? ' · 指数' : security.kind === 'fund' ? ' · 场内基金' : ''}${position ? `\n${view.pnl.title}` : ''}\n${view.time.textContent}${historical || quote?.stale ? ' · 非最新行情' : ''}${security.market === 'hk' ? ' · 可能延迟' : ''}`;
    updateExpanded(view);
  }

  function manualSort(groupId) {
    return groupId !== 'market' && !['asc', 'desc'].includes(snapshot?.sorts?.[groupId]);
  }

  function reconcileGroups(data) {
    const market = { id: 'market', name: '市场行情', symbols: data.markets.map(item => item.id) };
    const marketData = { ...data, state: { securities: Object.fromEntries(data.markets.map(item => [item.id, item])), positions: {} },
      quotes: data.marketQuotes, metrics: {} };
    const definitions = [market, ...data.state.groups];
    const ids = new Set(definitions.map(group => group.id));
    for (const [id, view] of groupViews) {
      if (!ids.has(id)) {
        for (const row of view.rows.values()) clearTrend(row);
        view.section.remove();
        groupViews.delete(id);
      }
    }
    definitions.forEach((group, index) => {
      const view = groupViews.get(group.id) || createGroup(group);
      if (groupList.children[index] !== view.section) groupList.insertBefore(view.section, groupList.children[index] || null);
      setText(view.name, group.name);
      view.name.title = group.name;
      const isMarket = group.id === 'market';
      const order = data.sorts[group.id];
      setText(view.count, isMarket ? '' : `${group.symbols.length}/10${order === 'asc' ? ' ↑' : order === 'desc' ? ' ↓' : ''}`);
      view.add.disabled = group.symbols.length >= 10;
      view.add.title = view.add.disabled ? '分类已满（最多 10 只）' : `添加股票 / 场内基金到 ${group.name}`;
      view.add.setAttribute('aria-label', view.add.title);
      view.addFirst.hidden = isMarket || group.symbols.length > 0;
      updateCollapsed(view);
      const symbols = new Set(group.symbols);
      for (const [symbol, row] of view.rows) {
        if (!symbols.has(symbol)) {
          clearTrend(row);
          row.article.remove();
          view.rows.delete(symbol);
        }
      }
      const ordered = [...group.symbols];
      if (!isMarket && !manualSort(group.id)) ordered.sort((a, b) => {
        const x = data.quotes[a]?.changePercent;
        const y = data.quotes[b]?.changePercent;
        if (!finite(x)) return finite(y) ? 1 : 0;
        if (!finite(y)) return -1;
        return order === 'asc' ? x - y : y - x;
      });
      ordered.forEach((symbol, stockIndex) => {
        let row = view.rows.get(symbol);
        if (!row) {
          row = createStock(group.id, symbol);
          view.rows.set(symbol, row);
        }
        if (view.stockList.children[stockIndex] !== row.article) view.stockList.insertBefore(row.article, view.stockList.children[stockIndex] || null);
        row.main.draggable = manualSort(group.id);
        updateStock(row, symbol, isMarket ? marketData : data);
      });
    });
    empty.hidden = data.state.groups.length > 0;
    setText(listCount, `${data.state.groups.length} 个分类`);
  }

  function updateSummary(data) {
    const currencies = new Set(Object.values(data.state.securities).map(security => data.quotes[security.id]?.currency || security.currency));
    for (const item of data.summaries) if (item.count) currencies.add(item.currency);
    if (!currencies.size) currencies.add('CNY');
    summary.hidden = false;
    summary.classList.toggle('single-currency', currencies.size === 1);
    for (const [currency, view] of summaryViews) {
      view.card.hidden = !currencies.has(currency);
      const item = data.summaries.find(entry => entry.currency === currency);
      const hasPositions = Boolean(item?.count);
      setText(view.dailyTitle, '今日盈亏');
      setText(view.dailyValue, hasPositions ? signed(item.daily) : '0.00');
      setText(view.dailyRate, hasPositions ? percent(item.dailyPercent) : '—');
      setText(view.profitValue, hasPositions ? signed(item.profit) : '0.00');
      setText(view.profitRate, hasPositions ? percent(item.profitPercent) : '—');
      tone(view.dailyValue, hasPositions ? item.daily : null);
      tone(view.dailyRate, hasPositions ? item.daily : null);
      tone(view.profitValue, hasPositions ? item.profit : null);
      tone(view.profitRate, hasPositions ? item.profit : null);
      view.card.classList.toggle('no-position', !hasPositions);
      view.card.classList.toggle('incomplete', Boolean(item?.incomplete));
      view.note.classList.toggle('incomplete', Boolean(item?.incomplete));
      setText(view.note, !hasPositions ? '添加持仓后自动汇总' : item.incomplete
        ? `${item.count} 只持仓 · 数据不足，请核对行情`
        : `${item.count} 只持仓 · 市值 ${money(item.marketValue, currency)}`);
      view.card.title = `${currency === 'CNY' ? '人民币' : '港币'} · ${view.note.textContent}。行情日期 ${item?.date || '—'}。日盈亏按现有数量与昨收估算。`;
    }
  }

  function render(data) {
    if (!data?.state || !Array.isArray(data.state.groups) || !Array.isArray(data.summaries)) return;
    const first = !snapshot;
    snapshot = data;
    if (!settingsDialog.open) applySettings(data.preferences);
    updateSummary(data);
    reconcileGroups(data);
    refreshButton.disabled = data.refreshing;
    refreshButton.classList.toggle('refreshing', data.refreshing);
    refreshButton.setAttribute('aria-label', data.refreshing ? '正在刷新行情' : '刷新行情');
    statusDot.classList.toggle('warning', Boolean(data.error));
    statusDot.classList.toggle('loading', data.refreshing);
    setText(statusText, data.refreshing ? '正在刷新' : data.error ? '行情连接异常' : data.updatedAt ? '行情已更新' : '等待行情');
    let time = '';
    if (finite(data.updatedAt)) {
      time = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).format(new Date(data.updatedAt));
    }
    setText(updated, time ? `获取于 ${time}` : '');
    updated.title = '最近一次获取时间（UTC+8）；证券报价时间见详情';
    const errors = [data.error, data.marketError].filter(Boolean).join('。');
    errorText.hidden = !errors;
    setText(errorText, errors);
    setText(footerHint, Object.values(data.state.securities).some(security => security.market === 'hk')
      ? '港股行情可能延迟 · 右键股票管理持仓' : '右键股票管理持仓 · 数据仅供参考');
    if (first && finite(saved.scrollTop)) groups.scrollTop = saved.scrollTop;
  }

  let scrollTimer;
  groups.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(persist, 120);
  }, { passive: true });
  groups.addEventListener('dragover', event => {
    if (event.target !== groups && event.target !== groupList) return;
    acceptDrop(event, { kind: 'group' }, groupList, 'drop-tail');
  });
  groups.addEventListener('drop', event => {
    if (event.target !== groups && event.target !== groupList) return;
    performDrop(event, { kind: 'group' });
  });
  window.addEventListener('dragend', finishDrag);
  window.addEventListener('keydown', event => {
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'q') {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      closePosition(true);
      finishDrag();
      post('toggleVisibility');
    }
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'snapshot') render(message.payload);
    else if (message?.type === 'openPosition') openPosition(message.groupId, message.symbol);
    else if (message?.type === 'positionResult') receivePositionResult(message);
    else if (message?.type === 'intraday') receiveTrend(message);
    else if (message?.type === 'iconSelected' && settingsDialog.open) {
      png = message.png;
      setText(settingsError, '');
      previewSettings();
    } else if (message?.type === 'settingsSaved' || message?.type === 'settingsError') {
      savingSettings = false;
      submitSettings.disabled = false;
      if (message.type === 'settingsSaved') settingsDialog.close();
      else setText(settingsError, message.error);
    }
  });
  post('ready');
})();
