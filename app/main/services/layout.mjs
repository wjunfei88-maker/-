/**
 * 排版引擎 v2
 *
 * 硬约束：像素蛋糕单边 ≤ 12000px，且**绝不缩放**（每张图 1:1 嵌入）。
 * 于是"能拼几张"完全由几何决定，不是由总像素决定。
 *
 * 三种策略，谁装得多、谁装得紧就用谁：
 *   1) tryGrid      —— 均匀网格（同尺寸图最整齐，优先选中）
 *   2) tryShelf     —— 货架打包（经典按行摆放，支持混尺寸）
 *   3) tryMaxRects  —— MaxRects 装箱（最强，支持混尺寸 + 90° 旋转）
 *
 * 实测（用本模块穷举验证，见 README「为什么是几张」）：
 *   A7R3/R4 42MP  7952×5304 → 一张画布最多 2 张（混横竖也没用）
 *   A7M4    33MP  7008×4672 → 一张画布最多 **3 张**（必须 1横+2竖 这种混搭）
 *   A7M4 全横图允许旋转 → 3 张，40 张照片从 20 个画布降到 14 个
 *
 * ⚠️ 旋转是**整数像素重排，完全无损**，但画布里的脸是躺着的，
 *    像素蛋糕的人脸识别可能认不出。所以 allowRotate 默认 **false**，
 *    必须由用户显式打开，并且切分时会自动转回来。
 */

export const CANVAS_LIMIT = 12000;

const EPS = 1e-6;

const overlap = (a, b) =>
  a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS &&
  a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;

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

/** 判断一张图能不能进画布 */
const placeable = (img, limit) => img.width <= limit && img.height <= limit;

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
      rotation: 0,
    }));
    const util = utilization(placed, W, H);
    if (!best || util > best.util) best = { placed, width: W, height: H, util, strategy: `grid-${cols}x${rows}` };
  }
  return best;
}

// ─────────────────────────── 策略 2：货架打包 ───────────────────────────
function shelfPack(order, limit, gutter) {
  const placed = [];
  let x = 0, y = 0, shelfH = 0;
  for (const img of order) {
    if (x > 0 && x + img.width > limit) {
      y += shelfH + gutter;
      x = 0; shelfH = 0;
    }
    if (y + img.height > limit) break;      // 再往后也放不下（已按高排序）
    placed.push({ id: img.id, x, y, w: img.width, h: img.height, rotation: 0 });
    x += img.width + gutter;
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

// ─────────────────── 策略 3：MaxRects 装箱（混尺寸 + 可选旋转）───────────────────

/** 把一个空闲矩形减去已用矩形，切成最多 4 块（Jukka Jylänki 的标准切法） */
function splitFreeRect(free, used) {
  if (!overlap(free, used)) return [free];
  const out = [];
  if (used.x > free.x + EPS) out.push({ x: free.x, y: free.y, w: used.x - free.x, h: free.h });
  if (used.x + used.w < free.x + free.w - EPS) {
    out.push({ x: used.x + used.w, y: free.y, w: free.x + free.w - (used.x + used.w), h: free.h });
  }
  if (used.y > free.y + EPS) out.push({ x: free.x, y: free.y, w: free.w, h: used.y - free.y });
  if (used.y + used.h < free.y + free.h - EPS) {
    out.push({ x: free.x, y: used.y + used.h, w: free.w, h: free.y + free.h - (used.y + used.h) });
  }
  return out;
}

/** 丢掉被别的空闲矩形完全包住的那些（否则列表会指数膨胀） */
function pruneContained(list) {
  return list.filter((a, i) => !list.some((b, j) =>
    j !== i && b.x <= a.x + EPS && b.y <= a.y + EPS &&
    b.x + b.w >= a.x + a.w - EPS && b.y + b.h >= a.y + a.h - EPS));
}

/** 按顺序把图一张张塞进空位；塞不下的直接跳过 */
function maxRectsPack(order, limit, gutter, allowRotate) {
  let free = [{ x: 0, y: 0, w: limit, h: limit }];
  const placed = [];
  for (const img of order) {
    // 候选朝向：原样 / 90°（旋转是整数像素重排，无损）
    const orients = [{ w: img.width, h: img.height, rotation: 0 }];
    if (allowRotate && img.width !== img.height) {
      orients.push({ w: img.height, h: img.width, rotation: 90 });
    }
    let best = null;
    for (const o of orients) {
      const W = o.w + gutter, H = o.h + gutter;   // 膨胀保护带 → 自然留缝
      for (const fr of free) {
        if (W > fr.w + EPS || H > fr.h + EPS) continue;
        const lh = fr.w - W, lv = fr.h - H;
        // Best-Short-Side-Fit：优先让短边浪费最少
        const score = [Math.min(lh, lv), Math.max(lh, lv), fr.y, fr.x];
        if (!best || score[0] < best.score[0] ||
          (score[0] === best.score[0] && (score[1] < best.score[1] ||
            (score[1] === best.score[1] && (score[2] < best.score[2] ||
              (score[2] === best.score[2] && score[3] < best.score[3])))))) {
          best = { ...o, x: fr.x, y: fr.y, W, H, score };
        }
      }
    }
    if (!best) continue;                  // 这张放不下，留给下一张画布
    const used = { x: best.x, y: best.y, w: best.W, h: best.H };
    const next = [];
    for (const fr of free) next.push(...splitFreeRect(fr, used));
    free = pruneContained(next);
    if (free.length > 600) free = free.slice(0, 600);   // 安全阀，防病态输入
    placed.push({ id: img.id, x: best.x, y: best.y, w: best.w, h: best.h, rotation: best.rotation });
  }
  if (!placed.length) return null;
  const { width, height } = bounds(placed);
  return { placed, width, height, util: utilization(placed, width, height), strategy: 'binpack' };
}

function tryMaxRects(images, limit, gutter, allowRotate) {
  const keys = [
    (a, b) => b.width * b.height - a.width * a.height,          // 面积大优先
    (a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height),
    (a, b) => b.height - a.height,
    (a, b) => b.width - a.width,
    (a, b) => (b.width - b.height) - (a.width - a.height),
    (a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height),
  ];
  let best = null;
  for (const key of keys) {
    const r = maxRectsPack([...images].sort(key), limit, gutter, allowRotate);
    if (!r) continue;
    if (!best || r.placed.length > best.placed.length ||
      (r.placed.length === best.placed.length && r.util > best.util)) {
      best = { ...r, strategy: 'binpack' };
    }
    // 已经全部装下就不用再试了
    if (best.placed.length === images.length) break;
  }
  return best;
}

/** 把后续合成/切分需要的字段全部透传下来 */
function enrich(best, usable) {
  const byId = new Map(usable.map((i) => [i.id, i]));
  for (const p of best.placed) {
    const src = byId.get(p.id);
    if (!src) continue;
    p.natural = { width: src.width, height: src.height };   // 用户看到的原始朝向尺寸
    p.rotation = p.rotation ?? 0;
    p.source = src.path ?? src.source ?? null;
    p.name = src.name ?? null;
    p.format = src.format ?? null;
    p.probe = src.probe ?? null;
    p.thumbPath = src.thumbPath ?? null;
    p.image = src;
  }
}

/**
 * 把一组图排进**一张**画布，1:1 不缩放。
 * @returns {{placed, width, height, util, strategy, fit:boolean, skipped:[]}}
 */
export function packCanvas(images, opts = {}) {
  const { limit = CANVAS_LIMIT, gutter = 24, allowRotate = false } = opts;
  const usable = images.filter((i) => placeable(i, limit));
  const skipped = images.filter((i) => !placeable(i, limit));

  if (!usable.length) {
    return { placed: [], width: 0, height: 0, util: 0, strategy: 'none', fit: false, skipped, allowRotate };
  }

  const candidates = [
    tryGrid(usable, limit, gutter),
    tryShelf(usable, limit, gutter),
    tryMaxRects(usable, limit, gutter, allowRotate),
  ].filter(Boolean);

  if (!candidates.length) {
    return { placed: [], width: 0, height: 0, util: 0, strategy: 'none', fit: false, skipped, allowRotate };
  }

  // 先看"装下几张"，再看"利用率"；完全打平则保持上面的策略优先级（网格最整齐）
  candidates.sort((a, b) => (b.placed.length - a.placed.length) || (b.util - a.util));

  const best = candidates[0];
  enrich(best, usable);
  assertNoOverlap(best.placed);

  return {
    placed: best.placed,
    width: best.width,
    height: best.height,
    util: best.util,
    strategy: best.strategy,
    fit: best.placed.length === images.length,
    skipped,
    allowRotate,
  };
}

/**
 * 全局排版：把所有图分到尽量少的画布上（画布数 = 像素蛋糕扣费张数）。
 *
 * 做法：多套全局排序各贪心一遍，取画布数最少的那个；
 *       再做一轮"补漏"——试着把最空的那些画布里的图塞进别的画布，能塞进去就把画布省掉。
 */
export function planGroups(images, opts = {}) {
  const { limit = CANVAS_LIMIT, gutter = 24, allowRotate = false } = opts;
  const usable = images.filter((i) => placeable(i, limit));
  const unplaceable = images.filter((i) => !placeable(i, limit));
  if (!usable.length) return { canvases: [], unplaceable, allowRotate };

  const orders = [
    [...usable].sort((a, b) => b.width * b.height - a.width * a.height),
    [...usable].sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height)),
    [...usable].sort((a, b) => b.height - a.height),
    [...usable].sort((a, b) => b.width - a.width),
    [...usable].sort((a, b) => (b.width - b.height) - (a.width - a.height)),
    [...usable].sort((a, b) => b.width + b.height - (a.width + a.height)),
  ];

  const packOpts = { limit, gutter, allowRotate };
  let best = null;
  for (const order of orders) {
    const plan = greedyGroups(order, packOpts);
    if (!best || plan.length < best.length) best = plan;
  }

  best = refillPass(best, packOpts);
  best = refillPass(best, packOpts);      // 再来一轮，第二轮往往还能再省一张

  return { canvases: best, unplaceable, allowRotate };
}

/** 贪心：每轮用 packCanvas 尽量填满一张画布 */
function greedyGroups(order, packOpts) {
  const remaining = [...order];
  const canvases = [];
  let guard = 0;
  while (remaining.length && guard++ < 5000) {
    const r = packCanvas(remaining, packOpts);
    if (!r.placed.length) break;                     // 一张都放不下，收工
    canvases.push({
      placed: r.placed, width: r.width, height: r.height,
      util: r.util, strategy: r.strategy,
    });
    const used = new Set(r.placed.map((p) => p.id));
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (used.has(remaining[i].id)) remaining.splice(i, 1);
    }
  }
  return canvases;
}

/** 把一个已放置的条目还原成 packCanvas 能吃的描述符（尺寸取原始朝向） */
function placedToImage(p) {
  return {
    ...(p.image ?? {}),
    id: p.id,
    width: p.natural?.width ?? p.w,
    height: p.natural?.height ?? p.h,
  };
}

/**
 * 补漏：试着把最空的几张画布里的图塞进别的画布。
 * 全部塞进去就把这张画布省掉 —— 直接省一次像素蛋糕额度。
 *
 * 关键：整张画布必须**全部**搬走才能省掉，所以中途失败要整体回滚，
 * 否则会出现同一张图同时挂在两张画布上（切分时输出重复文件）。
 */
function refillPass(canvases, packOpts) {
  const out = canvases.map((c) => ({ ...c, placed: [...c.placed] }));
  const order = out.map((_, i) => i).sort((a, b) => out[a].placed.length - out[b].placed.length);

  for (const idx of order.slice(0, 4)) {          // 只试着消灭最空的 4 张，控制耗时
    const victim = out[idx];
    if (!victim || !victim.placed.length || victim.placed.length > 4) continue;

    const others = out.filter((c) => c !== victim && c.placed.length);
    if (!others.length) continue;

    const undo = [];
    let allMoved = true;

    for (const item of victim.placed) {
      let applied = null;
      for (const other of others) {
        const trial = [...other.placed.map(placedToImage), placedToImage(item)];
        const r = packCanvas(trial, packOpts);
        if (r.placed.length !== trial.length) continue;
        applied = { other, prev: { placed: other.placed, w: other.width, h: other.height, u: other.util, s: other.strategy } };
        other.placed = r.placed;
        other.width = r.width;
        other.height = r.height;
        other.util = r.util;
        other.strategy = r.strategy;
        break;
      }
      if (!applied) { allMoved = false; break; }
      undo.push(applied);
    }

    if (allMoved) {
      victim.placed = [];
    } else {
      // 回滚，保证不出现重复
      for (const u of undo.reverse()) {
        u.other.placed = u.prev.placed;
        u.other.width = u.prev.w;
        u.other.height = u.prev.h;
        u.other.util = u.prev.u;
        u.other.strategy = u.prev.s;
      }
    }
  }

  return out.filter((c) => c.placed.length > 0).map((c) => {
    const { width, height } = bounds(c.placed);
    return { ...c, width, height, util: utilization(c.placed, width, height) };
  });
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

/**
 * 一张画布"为什么只能放 N 张"——用真实尺寸把各种网格摆法算给用户看。
 * 注意：这里只算**同尺寸均匀网格**，是给用户的几何直觉；
 * 横竖混搭的装箱结果可能比它更多（A7M4 就是 2 → 3），那部分由实际排版给出。
 */
export function capacityExplain(images, limit = CANVAS_LIMIT, gutter = 24) {
  const usable = images.filter((i) => placeable(i, limit));
  if (!usable.length) return { max: 0, rows: [] };
  const cw = Math.max(...usable.map((i) => i.width));
  const ch = Math.max(...usable.map((i) => i.height));

  const all = [];
  for (let cols = 1; cols <= 8; cols++) {
    for (let rows = 1; rows <= 8; rows++) {
      const W = cols * cw + (cols - 1) * gutter;
      const H = rows * ch + (rows - 1) * gutter;
      all.push({
        text: `${cols} 列 × ${rows} 行`, count: cols * rows,
        width: W, height: H,
        ok: W <= limit && H <= limit,
        overBy: Math.max(0, W - limit, H - limit),
      });
    }
  }

  // 同一个张数只保留最能说明问题的一种摆法：
  //   放得下的 → 挑最紧凑的（面积最小）
  //   放不下的 → 挑**超出最少**的（"就差 72px" 远比 "8列×2行" 有说服力）
  const byCount = new Map();
  for (const a of all) {
    const prev = byCount.get(a.count);
    const better = !prev
      || (a.ok && !prev.ok)
      || (a.ok === prev.ok && (a.ok
        ? a.width * a.height < prev.width * prev.height
        : a.overBy < prev.overBy));
    if (better) byCount.set(a.count, a);
  }

  const counts = [...byCount.keys()].sort((a, b) => b - a);
  const fit = [...byCount.values()].filter((r) => r.ok);
  const max = fit.length ? Math.max(...fit.map((r) => r.count)) : 0;

  // 展示区间以 max 为中心：max 上面留 2 行说明"再多一张为什么不行"，下面留 2 行对照
  const lo = Math.max(1, max - 2);
  const hi = max > 0 ? max + 2 : 3;
  const rows = counts
    .filter((c) => c >= lo && c <= hi)
    .map((c) => byCount.get(c))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return { max, rows };
}
