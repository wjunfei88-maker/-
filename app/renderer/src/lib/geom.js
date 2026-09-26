/**
 * 画布几何：自由拖动 + 贴边吸附 + 松手自动找空位
 *
 * v1 的做法是"硬推挤"：只要和别的图重叠，就沿最近的边把你推回去。
 * 结果是画布刚好装下时**拖了等于没拖** —— 用户反馈"我无法手动拖图片"。
 *
 * v2 改成 PS 式：
 *   · 拖动过程中完全跟手（只做轻微吸附），重叠会标红但不会被弹开
 *   · 松手时如果放不下，自动挪到**离落点最近的合法位置**（findFreeSpot）
 *   · 画布尺寸 = 内容的紧包围盒，所以你可以把图拖到外面，画布会跟着长大（上限 12000）
 *
 * 唯一不变的红线：最终画布里两张图之间必须留出保护带，且绝不重叠 ——
 * 重叠意味着被压住的像素在画布里根本不存在，切分时无处可取。
 */

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const overlaps = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 两张图在 x / y 方向上的间隙（负值代表已相交） */
const gapX = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
const gapY = (a, b) => Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));

/** 两张图是否"挨得太近"：两个方向都没有留出保护带 */
export const tooClose = (a, b, gutter) => gapX(a, b) < gutter && gapY(a, b) < gutter;

/** 统一矩形形状：{x,y,w,h} → {x,y,width,height} */
export const asRect = (p) => ({ x: p.x, y: p.y, w: p.w ?? p.width, h: p.h ?? p.height });

/**
 * 拖动过程中的贴边吸附（只是视觉磁吸，不做任何阻挡）。
 * 吸附目标都带上保护带，所以吸上去就是"留好缝"的合法位置。
 */
export function snapPosition(desired, size, others, limit, threshold, gutter = 24) {
  let x = clamp(desired.x, 0, Math.max(0, limit - size.width));
  let y = clamp(desired.y, 0, Math.max(0, limit - size.height));

  const xs = [0, limit - size.width];
  const ys = [0, limit - size.height];
  for (const o of others) {
    const r = asRect(o);
    xs.push(r.x, r.x + r.w - size.width, r.x + r.w + gutter, r.x - size.width - gutter,
      r.x + Math.round((r.w - size.width) / 2));
    ys.push(r.y, r.y + r.h - size.height, r.y + r.h + gutter, r.y - size.height - gutter,
      r.y + Math.round((r.h - size.height) / 2));
  }

  let bx = null, bxd = Infinity;
  for (const c of xs) { const d = Math.abs(x - c); if (d < threshold && d < bxd) { bxd = d; bx = c; } }
  let by = null, byd = Infinity;
  for (const c of ys) { const d = Math.abs(y - c); if (d < threshold && d < byd) { byd = d; by = c; } }

  return {
    x: Math.round(clamp(bx ?? x, 0, Math.max(0, limit - size.width))),
    y: Math.round(clamp(by ?? y, 0, Math.max(0, limit - size.height))),
    snapped: bx !== null || by !== null,
  };
}

/** 某个位置能不能放：在界内 + 和所有人都留够保护带 */
function isLegal(x, y, size, others, limit, gutter) {
  const w = size.width, h = size.height;
  if (x < 0 || y < 0 || x + w > limit || y + h > limit) return false;
  const me = { x, y, w, h };
  return others.every((o) => !tooClose(me, asRect(o), gutter));
}

/**
 * 松手落点求解：
 *   1) 落点合法 → 就放这儿
 *   2) 不合法   → 在落点附近找**最近的合法位置**（自动避让）
 *   3) 实在找不到 → 退回原位（origin），绝不留下重叠
 *
 * 候选位置 = 落点本身、画布四角，以及每张已有图片的"四周刚好留缝"的位置。
 */
export function findFreeSpot(desired, size, others, limit, gutter, origin) {
  const dx = Math.round(clamp(desired.x, 0, Math.max(0, limit - size.width)));
  const dy = Math.round(clamp(desired.y, 0, Math.max(0, limit - size.height)));

  if (isLegal(dx, dy, size, others, limit, gutter)) {
    return { x: dx, y: dy, moved: false, collided: false };
  }

  const xs = new Set([0, limit - size.width, dx]);
  const ys = new Set([0, limit - size.height, dy]);
  for (const o of others) {
    const r = asRect(o);
    xs.add(r.x - size.width - gutter);
    xs.add(r.x + r.w + gutter);
    xs.add(r.x);
    xs.add(r.x + r.w - size.width);
    ys.add(r.y - size.height - gutter);
    ys.add(r.y + r.h + gutter);
    ys.add(r.y);
    ys.add(r.y + r.h - size.height);
  }

  let best = null;
  for (const cx of xs) {
    for (const cy of ys) {
      const x = Math.round(clamp(cx, 0, Math.max(0, limit - size.width)));
      const y = Math.round(clamp(cy, 0, Math.max(0, limit - size.height)));
      if (!isLegal(x, y, size, others, limit, gutter)) continue;
      // 优先离落点近；同样近则优先"少动"（左上方向）
      const dist = Math.hypot(x - dx, y - dy);
      if (!best || dist < best.dist - 0.5) best = { x, y, dist };
    }
  }

  if (best) return { x: best.x, y: best.y, moved: true, collided: true, failed: false };

  // 兜底：原位。宁可不动，也绝不留下重叠
  const ox = origin?.x ?? dx, oy = origin?.y ?? dy;
  if (isLegal(ox, oy, size, others, limit, gutter)) {
    return { x: ox, y: oy, moved: true, collided: true, failed: true };
  }
  return { x: dx, y: dy, moved: false, collided: true, failed: true };
}

/** 校验整张画布：重叠 / 间距过小 */
export function validateCanvas(items, gutter = 24) {
  const problems = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = asRect(items[i]), b = asRect(items[j]);
      const gx = gapX(a, b), gy = gapY(a, b);
      if (overlaps(a, b)) problems.push({ type: 'overlap', a: items[i].id, b: items[j].id });
      else if (gx < gutter && gy < gutter) problems.push({ type: 'too-close', a: items[i].id, b: items[j].id, gapX: gx, gapY: gy });
    }
  }
  return problems;
}

/** 画布外包尺寸（紧凑贴合内容） */
export function tightBounds(items, gutter = 24) {
  if (!items.length) return { width: 0, height: 0 };
  let w = 0, h = 0;
  for (const it of items) {
    w = Math.max(w, it.x + (it.w ?? it.width));
    h = Math.max(h, it.y + (it.h ?? it.height));
  }
  return { width: w, height: h };
}
