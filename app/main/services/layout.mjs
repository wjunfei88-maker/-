/**
 * 排版引擎
 *
 * 硬约束：像素蛋糕单边 ≤ 12000px，且**绝不缩放**（每张图 1:1 嵌入）。
 * 于是"能拼几张"完全由几何决定，不是由总像素决定。
 *
 * 例：42MP 横图 7952×5304
 *   上下叠 2 张 → 7952×10608 ✔（宽 1 列、高 2 行）
 *   左右排 2 张 → 15904×5304 ✘（超 12000）
 *   所以上限就是 2 张/画布，省 50% —— 这是数学，不是实现问题。
 *
 * 本模块做两件事：
 *   1. packCanvas  —— 把一组图排进一张画布，返回每张的 1:1 位置
 *   2. planGroups  —— 装不下时自动拆成多个画布，最小化画布数量（= 最少扣费张数）
 */

export const CANVAS_LIMIT = 12000;

const overlap = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 检查一组摆放是否真的两两不重叠（防算法 bug） */
export function assertNoOverlap(placements) {
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      if (overlap(placements[i], placements[j])) {
        throw new Error(`内部错误：第 ${i} 张与第 ${j} 张重叠了`);
      }
    }
  }
  return true;
}

/** 用画布尺寸和已放置的矩形算外接边界 */
function bounds(placed) {
  let w = 0, h = 0;
  for (const p of placed) {
    w = Math.max(w, p.x + p.w);
    h = Math.max(h, p.y + p.h);
  }
  return { width: w, height: h };
}

function utilization(placed, width, height) {
  const used = placed.reduce((s, p) => s + p.w * p.h, 0);
  return width * height > 0 ? used / (width * height) : 0;
}

// ─────────────────────────── 策略 1：均匀网格 ───────────────────────────
function tryGrid(images, limit, gutter) {
  const n = images.length;
  if (!n) return null;
  const cw = Math.max(...images.map((i) => i.width));
  const ch = Math.max(...images.map((i) => i.height));
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const W = cols * cw + (cols - 1) * gutter;
    const H = rows * ch + (rows - 1) * gutter;
    if (W > limit || H > limit) continue;
    const placed = images.map((img, k) => ({
      id: img.id,
      x: (k % cols) * (cw + gutter),
      y: Math.floor(k / cols) * (ch + gutter),
      w: img.width,
      h: img.height,
    }));
    const util = utilization(placed, W, H);
    if (!best || util > best.util) best = { placed, width: W, height: H, util, strategy: `grid-${cols}x${rows}` };
  }
  return best;
}

// ─────────────────────────── 策略 2：货架打包（支持混尺寸）───────────────────────────
function shelfPack(order, limit, gutter) {
  const placed = [];
  let x = 0, y = 0, shelfH = 0, rowW = 0;
  for (const img of order) {
    if (x > 0 && x + img.width > limit) {
      y += shelfH + gutter;
      x = 0; shelfH = 0;
    }
    if (y + img.height > limit) break;      // 再往后也放不下（已按高排序）
    placed.push({ id: img.id, x, y, w: img.width, h: img.height });
    x += img.width + gutter;
    rowW = Math.max(rowW, x - gutter);
    shelfH = Math.max(shelfH, img.height);
  }
  if (!placed.length) return null;
  const { width, height } = bounds(placed);
  return { placed, width, height, util: utilization(placed, width, height), strategy: 'shelf' };
}

function tryShelf(images, limit, gutter) {
  const orders = [
    [...images].sort((a, b) => b.height - a.height),
    [...images].sort((a, b) => b.width - a.width),
    [...images].sort((a, b) => b.width * b.height - a.width * a.height),
    [...images].sort((a, b) => a.height - b.height),
  ];
  let best = null;
  for (const order of orders) {
    const r = shelfPack(order, limit, gutter);
    if (!r) continue;
    if (!best || r.placed.length > best.placed.length ||
      (r.placed.length === best.placed.length && r.util > best.util)) {
      best = { ...r, strategy: 'shelf' };
    }
  }
  return best;
}

/**
 * 把一组图排进**一张**画布，1:1 不缩放。
 * @returns {{placed, width, height, util, strategy, fit:boolean, skipped:[]}}
 */
export function packCanvas(images, opts = {}) {
  const { limit = CANVAS_LIMIT, gutter = 24 } = opts;
  const usable = images.filter((i) => i.width <= limit && i.height <= limit);
  const skipped = images.filter((i) => i.width > limit || i.height > limit);

  if (!usable.length) {
    return { placed: [], width: 0, height: 0, util: 0, strategy: 'none', fit: false, skipped };
  }

  const candidates = [tryGrid(usable, limit, gutter), tryShelf(usable, limit, gutter)].filter(Boolean);
  if (!candidates.length) {
    return { placed: [], width: 0, height: 0, util: 0, strategy: 'none', fit: false, skipped };
  }

  // 先看"装下几张"，再看"利用率"
  candidates.sort((a, b) =>
    (b.placed.length - a.placed.length) || (b.util - a.util));

  const best = candidates[0];
  const byId = new Map(usable.map((i) => [i.id, i]));
  for (const p of best.placed) {
    const src = byId.get(p.id);
    p.natural = { width: src.width, height: src.height };
    // 把后续合成/切分需要的字段全部透传下来
    p.source = src.path ?? src.source ?? null;
    p.name = src.name ?? null;
    p.format = src.format ?? null;
    p.probe = src.probe ?? null;
    p.thumbPath = src.thumbPath ?? null;
    p.image = src;
  }
  assertNoOverlap(best.placed);

  return {
    placed: best.placed,
    width: best.width,
    height: best.height,
    util: best.util,
    strategy: best.strategy,
    fit: best.placed.length === images.length,
    skipped,
  };
}

/**
 * 全部排进一张画布；装不下就自动拆成多张，最小化画布数量。
 * 贪心：每轮从剩余图里取"能装下的最大子集"。
 * @returns {{canvases:[{placed,width,height,util,strategy}], unplaceable:[]}}
 */
export function planGroups(images, opts = {}) {
  const { limit = CANVAS_LIMIT, gutter = 24 } = opts;
  const remaining = images.filter((i) => i.width <= limit && i.height <= limit);
  const unplaceable = images.filter((i) => i.width > limit || i.height > limit);
  const canvases = [];

  while (remaining.length) {
    // 从大到小试着塞：先假设全放得下，装不下就逐个剔除最大的那张重试
    let attempt = [...remaining].sort((a, b) => b.width * b.height - a.width * a.height);
    let result = null;
    while (attempt.length) {
      const r = packCanvas(attempt, { limit, gutter });
      if (r.placed.length === attempt.length) { result = r; break; }
      attempt = attempt.slice(1);           // 剔掉最大的一张
    }
    if (!result || !result.placed.length) break;

    canvases.push({
      placed: result.placed,
      width: result.width,
      height: result.height,
      util: result.util,
      strategy: result.strategy,
    });
    const used = new Set(result.placed.map((p) => p.id));
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (used.has(remaining[i].id)) remaining.splice(i, 1);
    }
  }

  return { canvases, unplaceable };
}

/** 给定画布和上限，算出"还能再塞几张同级图"的直观提示 */
export function capacityHint(canvas, limit = CANVAS_LIMIT) {
  return {
    usedMP: (canvas.width * canvas.height) / 1e6,
    limitMP: (limit * limit) / 1e6,
    utilPct: canvas.util * 100,
    areaPct: ((canvas.width * canvas.height) / (limit * limit)) * 100,
    sizes: `${canvas.width}×${canvas.height}`,
    overW: canvas.width > limit,
    overH: canvas.height > limit,
  };
}
