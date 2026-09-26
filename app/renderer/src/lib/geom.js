/**
 * 画布几何：贴边吸附 + 强制留缝 + 物理禁止重叠
 *
 * M0 结论：液化/AI 形变会产生一个**全局平滑位移场**，即使只在 A 图液化，
 * B 图边缘也会被亚像素级地拉扯。所以两张图之间必须留保护带，
 * 而且保护带里填的是各自边缘的镜像（合成时处理）——
 * 界面上就直接把这个缝显示出来，所见即所得。
 */

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const overlaps = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 供外部使用的矩形形式：{x,y,width,height} */
const asBox = (it) => ({ x: it.x, y: it.y, w: it.width, h: it.height });

/**
 * 拖拽落点计算：
 *  1) 先把矩形限制在画布内
 *  2) 再对其它图片做"贴边吸附"（吸附目标已经含 gutter，所以吸上就是留好缝的位置）
 *  3) 最后若仍与别人相交，沿最小位移方向推出去（并保证推完有 gutter 间隙）
 */
export function resolvePlacement(desired, size, others, canvas, gutter = 24, snapThreshold = 14) {
  let x = clamp(desired.x, 0, Math.max(0, canvas.width - size.width));
  let y = clamp(desired.y, 0, Math.max(0, canvas.height - size.height));

  // ── 贴边吸附 ──
  const xs = [0, canvas.width - size.width, Math.round((canvas.width - size.width) / 2)];
  const ys = [0, canvas.height - size.height, Math.round((canvas.height - size.height) / 2)];
  for (const o of others) {
    xs.push(o.x, o.x + o.width + gutter, o.x - size.width - gutter,
      o.x + o.width - size.width, o.x + Math.round((o.width - size.width) / 2));
    ys.push(o.y, o.y + o.height + gutter, o.y - size.height - gutter,
      o.y + o.height - size.height, o.y + Math.round((o.height - size.height) / 2));
  }
  let bestX = null, bestXd = Infinity;
  for (const c of xs) {
    const d = Math.abs(x - c);
    if (d < snapThreshold && d < bestXd) { bestXd = d; bestX = c; }
  }
  if (bestX !== null) x = bestX;
  let bestY = null, bestYd = Infinity;
  for (const c of ys) {
    const d = Math.abs(y - c);
    if (d < snapThreshold && d < bestYd) { bestYd = d; bestY = c; }
  }
  if (bestY !== null) y = bestY;

  // ── 推出重叠 ──
  let rect = { x, y, w: size.width, h: size.height };
  for (let iter = 0; iter < 16; iter++) {
    let moved = false;
    for (const o of others) {
      // 把别人膨胀 gutter/2，等价于"两张之间至少留 gutter"
      const pad = gutter / 2;
      const box = { x: o.x - pad, y: o.y - pad, w: o.width + gutter, h: o.height + gutter };
      if (!overlaps(rect, box)) continue;
      const pushRight = box.x + box.w - rect.x;
      const pushLeft = rect.x + rect.w - box.x;
      const pushDown = box.y + box.h - rect.y;
      const pushUp = rect.y + rect.h - box.y;
      const m = Math.min(pushRight, pushLeft, pushDown, pushUp);
      if (m === pushRight) rect.x = box.x + box.w;
      else if (m === pushLeft) rect.x = box.x - rect.w;
      else if (m === pushDown) rect.y = box.y + box.h;
      else rect.y = box.y - rect.h;
      moved = true;
    }
    if (!moved) break;
  }

  rect.x = Math.round(clamp(rect.x, 0, Math.max(0, canvas.width - rect.w)));
  rect.y = Math.round(clamp(rect.y, 0, Math.max(0, canvas.height - rect.h)));
  return { x: rect.x, y: rect.y, snapped: bestX !== null || bestY !== null, collided: rect.x !== x || rect.y !== y };
}

/** 校验整张画布没有任何两张相碰（含 gutter 间隙） */
export function validateCanvas(items, gutter = 24) {
  const problems = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const ax = { x: a.x, y: a.y, w: a.width, h: a.height };
      const bx = { x: b.x, y: b.y, w: b.width, h: b.height };
      const gapX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
      const gapY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
      if (overlaps(ax, bx)) problems.push({ type: 'overlap', a: a.id, b: b.id });
      else if (gapX < gutter && gapY < gutter) problems.push({ type: 'too-close', a: a.id, b: b.id, gapX, gapY });
    }
  }
  return problems;
}

/** 画布外包尺寸（紧凑贴合内容） */
export function tightBounds(items, gutter = 24) {
  if (!items.length) return { width: 0, height: 0 };
  let w = 0, h = 0;
  for (const it of items) {
    w = Math.max(w, it.x + it.width);
    h = Math.max(h, it.y + it.height);
  }
  return { width: w, height: h };
}
