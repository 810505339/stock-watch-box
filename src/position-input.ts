import type { Position } from './types';

/** Parse the complete two-field Webview message; never coerce an absent field to zero. */
export function parsePositionInput(quantity: unknown, cost: unknown): Position {
  if (typeof quantity !== 'string' || !/^\d+$/.test(quantity.trim())) {
    throw new Error('请输入完整的持仓数量，须为整数（单位：股 / 份）。');
  }
  if (typeof cost !== 'string' || !/^\d+(?:\.\d{1,8})?$/.test(cost.trim())) {
    throw new Error('请输入完整的每股 / 份成本，须为非负数字，最多 8 位小数。');
  }

  const parsedQuantity = Number(quantity.trim());
  const parsedCost = Number(cost.trim());
  // Match the portfolio domain limits here so invalid input stays in the form.
  // setPosition remains the final authority before any persistent state is changed.
  if (!Number.isSafeInteger(parsedQuantity) || parsedQuantity <= 0 || parsedQuantity > 1_000_000_000) {
    throw new Error('持仓数量须为 1–1,000,000,000 之间的整数（单位：股 / 份）。');
  }
  if (!Number.isFinite(parsedCost) || parsedCost < 0 || parsedCost > 1_000_000) {
    throw new Error('每股 / 份成本须为 0–1,000,000 之间的数字。');
  }
  if (parsedQuantity * parsedCost > Number.MAX_SAFE_INTEGER / 100) {
    throw new Error('持仓总成本超过安全计算范围，请检查数量和成本。');
  }
  return { quantity: parsedQuantity, cost: parsedCost };
}
