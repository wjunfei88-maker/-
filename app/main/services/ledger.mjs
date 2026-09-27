import { unitPriceOf } from './settings.mjs';

/**
 * 省额度账本。
 *
 * 为什么单独一个文件、还要能被 npm test 覆盖：
 *   这里的每一行数字都是**钱**。像素蛋糕按「张」扣费，画布数 = 扣费次数。
 *   一批 N 张照片拼进 1 张画布 → 本来要扣 N 次，现在只扣 1 次，省 N-1 次。
 *   算错一次，用户就照着错数字决定要不要拼。所以它必须能脱离 Electron 单测。
 *
 * 每条历史批次 = 一次导出 = 一张画布 = 一次扣费。
 * 用户可以逐条移除（比如那批其实只是测试、根本没进像素蛋糕）。
 */

/** 一枚批次省了几次额度。拼 1 张图的画布不省也不亏（0）。 */
export function savedOf(batch) {
  const n = Number(batch?.count);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.round(n) - 1);
}

/**
 * 汇总账本。
 * `batches` 就是 library.json 里的数组（已被用户删掉的条目不在里面，
 * 所以"移除某一次"天然就等于把这笔钱从账上扣掉，不需要额外的账目表）。
 */
export function summarizeLedger(batches = [], settings = {}) {
  const list = Array.isArray(batches) ? batches : [];
  let photos = 0;
  let saved = 0;
  let bytes = 0;
  for (const b of list) {
    const n = Number(b?.count);
    if (Number.isFinite(n) && n > 0) photos += Math.round(n);
    saved += savedOf(b);
    const by = Number(b?.bytes);
    if (Number.isFinite(by) && by > 0) bytes += by;
  }
  const unitPrice = unitPriceOf(settings);
  return {
    batches: list.length,
    photos,                       // 拼进去的照片总数
    canvases: list.length,        // 实际扣费次数
    saved,                        // 省下的次数
    bytes,
    unitPrice,
    money: saved * unitPrice,     // 省下的钱（元）
    // 不拼的话要扣多少次 —— 用来在界面上说清"本来要扣 N 次"
    withoutTiling: photos,
  };
}
