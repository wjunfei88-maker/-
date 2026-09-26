import { BG } from './panel.mjs';

/**
 * 把多张图 1:1 拼进一张画布（绝不缩放），面板之间插入镜像保护带。
 *
 * 保护带的作用：像素蛋糕的液化/AI 修复会局部拉伸像素，两图紧贴会互相"偷"内容。
 * 用镜像延展填充（而不是纯黑），内容看起来连续，AI 也不会把它当成瑕疵。
 * 保护带在切分时被丢弃，不影响原图任何一个像素。
 */

export const CANVAS_LIMIT = 12000; // 像素蛋糕官方导入上限（单边）

/** 判断是纵向分层（stack）还是横向排列（row/grid） */
function fillGutterMirror(out, layout) {
  const { width, height, gutter, panels, direction } = layout;
  if (gutter <= 0) return;
  const half = Math.floor(gutter / 2);

  // 取源像素：i 从 0 开始，紧贴前一块面板
  const srcIndex = (i) => (i < half
    ? { panel: 0, local: -2 - i }        // 从前一块的边界往外镜像
    : { panel: 1, local: 1 + (gutter - 1 - i) }); // 从后一块的边界往外镜像

  for (let s = 0; s < panels.length - 1; s++) {
    const A = panels[s];
    const B = panels[s + 1];

    for (let i = 0; i < gutter; i++) {
      const { panel, local } = srcIndex(i);
      const src = panel === 0 ? A : B;
      const sy = panel === 0 ? A.height + local : local;
      const sx = panel === 0 ? A.width + local : local;
      if (sy < 0 || sx < 0) continue;

      if (direction === 'vertical') {
        const dstY = A.y + A.height + i;
        if (dstY < 0 || dstY >= height) continue;
        if (width === A.width && width === B.width) {
          const from = (sy * A.width) * 3;
          A.data.copy(out, dstY * width * 3, from, from + width * 3);
        } else {
          for (let x = 0; x < width; x++) {
            const sxi = Math.min(A.width - 1, x);
            const si = (sy * A.width + sxi) * 3;
            const di = (dstY * width + x) * 3;
            out[di] = A.data[si]; out[di + 1] = A.data[si + 1]; out[di + 2] = A.data[si + 2];
          }
        }
      } else {
        const dstX = A.x + A.width + i;
        if (dstX < 0 || dstX >= width) continue;
        for (let y = 0; y < height; y++) {
          const syy = Math.min(A.height - 1, y);
          const si = (syy * A.width + sx) * 3;
          const di = (y * width + dstX) * 3;
          out[di] = A.data[si]; out[di + 1] = A.data[si + 1]; out[di + 2] = A.data[si + 2];
        }
      }
    }
  }
}

/**
 * @param {Array<{data:Buffer,width:number,height:number,source?:string}>} panels
 * @param {{layout?:'stack'|'row'|'grid', gutter?:number, limit?:number}} opts
 */
export function compose(panels, opts = {}) {
  const { layout = 'stack', gutter = 24, limit = CANVAS_LIMIT } = opts;
  if (!panels.length) throw new Error('没有可拼的图片');

  const meta = panels.map((p, i) => ({
    index: i,
    source: p.source ?? null,
    width: p.width,
    height: p.height,
    data: p.data,
    x: 0, y: 0,
  }));

  let canvasW, canvasH;

  if (layout === 'stack') {
    const w = Math.max(...meta.map((m) => m.width));
    let y = 0;
    meta.forEach((m, i) => {
      if (i > 0) y += gutter;
      m.x = 0; m.y = y; y += m.height;
    });
    canvasW = w; canvasH = y;
  } else if (layout === 'row') {
    const h = Math.max(...meta.map((m) => m.height));
    let x = 0;
    meta.forEach((m, i) => {
      if (i > 0) x += gutter;
      m.x = x; m.y = 0; x += m.width;
    });
    canvasW = x; canvasH = h;
  } else if (layout === 'grid') {
    const cw = Math.max(...meta.map((m) => m.width));
    const ch = Math.max(...meta.map((m) => m.height));
    const n = meta.length;
    // 选一个最接近正方形、且不超限的行列组合
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const W = cols * cw + (cols - 1) * gutter;
      const H = rows * ch + (rows - 1) * gutter;
      if (W > limit || H > limit) continue;
      const waste = W * H - n * cw * ch;
      if (!best || waste < best.waste) best = { cols, rows, W, H, waste };
    }
    if (!best) throw new Error(`按 ${limit}px 上限排不下这些图，需要分组`);
    meta.forEach((m, i) => {
      const c = i % best.cols, r = Math.floor(i / best.cols);
      m.x = c * (cw + gutter);
      m.y = r * (ch + gutter);
    });
    canvasW = best.W; canvasH = best.H;
  } else {
    throw new Error(`未知 layout: ${layout}`);
  }

  // 保护带只在 stack 布局的竖直方向有意义；row/grid 同理在水平/双方向
  const out = Buffer.alloc(canvasW * canvasH * 3, BG);
  for (const m of meta) {
    const rowBytes = m.width * 3;
    for (let y = 0; y < m.height; y++) {
      const src = y * rowBytes;
      const dst = ((m.y + y) * canvasW + m.x) * 3;
      m.data.copy(out, dst, src, src + rowBytes);
    }
  }
  fillGutterMirror(out, {
    width: canvasW,
    height: canvasH,
    gutter,
    panels: meta,
    direction: layout === 'row' ? 'horizontal' : 'vertical',
  });

  const warnings = [];
  if (canvasW > limit || canvasH > limit) {
    warnings.push(`画布 ${canvasW}×${canvasH} 超出像素蛋糕单边 ${limit}px 上限，会被拒绝导入`);
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    canvas: { width: canvasW, height: canvasH },
    layout,
    gutter,
    limit,
    panels: meta.map((m) => ({
      index: m.index,
      source: m.source,
      // 原图尺寸（切分后必须还原到这个尺寸，一个像素都不能少）
      natural: { width: m.width, height: m.height },
      // 在画布中的位置；切分时按这个矩形裁剪
      crop: { left: m.x, top: m.y, width: m.width, height: m.height },
    })),
  };

  return { data: out, width: canvasW, height: canvasH, manifest, warnings };
}
