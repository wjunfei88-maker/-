/**
 * 计量面板生成器
 *
 * 目的：造一张"仪器化"的测试图，用来回答 M0 的三个问题：
 *   1. 像素蛋糕导出后尺寸是否与导入完全一致（有没有内部缩放）
 *   2. 内部 AI 处理分辨率是否低于原图（高频光栅/脉冲会被抹平）
 *   3. 色彩空间 / gamma 是否被改动（色块与灰度楔会漂移）
 *
 * 所有特征的位置都写进 manifest，比对器据此逐项检查。
 * 布局按面板尺寸等比缩放，任何尺寸都能放下。
 */

export const BG = 128; // 18% 中性灰背景

/** 设计基准：这套常量在多大范围内排得下（用于算缩放系数） */
const DESIGN_W = 4736;
const DESIGN_H = 2104;

/** 确定性伪随机，保证每次生成完全一致 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Canvas {
  constructor(width, height, fill) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 3, fill);
  }
  set(x, y, r, g, b) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b;
  }
  fillRect(x, y, w, h, r, g, b) {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w)), y1 = Math.min(this.height, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) {
      let i = (yy * this.width + x0) * 3;
      for (let xx = x0; xx < x1; xx++) {
        this.data[i++] = r; this.data[i++] = g; this.data[i++] = b;
      }
    }
  }
  strokeRect(x, y, w, h, r, g, b, t = 1) {
    this.fillRect(x, y, w, t, r, g, b);
    this.fillRect(x, y + h - t, w, t, r, g, b);
    this.fillRect(x, y, t, h, r, g, b);
    this.fillRect(x + w - t, y, t, h, r, g, b);
  }
}

/** 光栅周期（像素）。周期越小越容易被内部降采样抹掉。 */
export const GRATING_PERIODS = [2, 3, 4, 5, 6, 8, 10, 16];

/** 色块：纯色 + 肤色 + 中性灰，用于检测色彩空间/gamma 是否被改 */
export const COLOR_PATCHES = [
  [255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 255, 255],
  [255, 0, 255], [255, 255, 0], [255, 255, 255], [0, 0, 0],
  [230, 180, 160], [210, 155, 130], [180, 120, 95], [120, 80, 60],
  [46, 46, 46], [92, 92, 92], [184, 184, 184], [235, 235, 235],
];

export const MIN_PANEL = 1200;

/**
 * 生成一张计量面板。
 * @param {number} width
 * @param {number} height
 * @param {{seed?:number, bg?:number, tag?:number}} opts
 *   seed/bg 让两块面板略有差异，便于事后判断"是哪一半被改动了"
 */
export function createPanel(width, height, opts = {}) {
  const { seed = 0x9e3779b9, bg = BG, tag = 0 } = opts;
  if (width < MIN_PANEL || height < MIN_PANEL) {
    throw new Error(`面板尺寸 ${width}×${height} 太小，至少 ${MIN_PANEL}×${MIN_PANEL}`);
  }

  const c = new Canvas(width, height, bg);
  const features = [];
  const rand = mulberry32(seed);

  // 等比缩放系数：保证所有特征在任意面板尺寸下都放得下且不越界
  const S = Math.min(1, (width - 80) / DESIGN_W, (height - 80) / DESIGN_H);
  const R = (v) => Math.max(1, Math.round(v * S));

  const BX = R(320), BY = R(320), BS = R(512), GAP = R(40);

  // ---- 1. 顶部标尺 & 左侧标尺：周期 20px 黑白条，用于检测缩放 ----
  const RULER = Math.max(24, Math.round(width * 0.0098));
  const RULER_OFF = Math.max(R(120), RULER + 8);
  const barP = Math.max(4, Math.round(20 * Math.max(S, 0.5))); // 条形周期
  c.fillRect(0, RULER_OFF, width, RULER, 255, 255, 255);
  for (let x = 0; x < width; x += barP) {
    c.fillRect(x, RULER_OFF, barP / 2, RULER, 0, 0, 0);
    if (Math.round(x / barP) % 5 === 0) c.fillRect(x + barP / 2, RULER_OFF, barP / 2, RULER, 0, 0, 0);
  }
  c.fillRect(0, RULER_OFF + Math.round(RULER / 2), width, 2, 255, 0, 0);
  features.push({ kind: 'rulerTop', rect: [0, RULER_OFF, width, RULER], period: barP });

  const lx = RULER_OFF, ly = RULER_OFF + RULER + R(40);
  c.fillRect(lx, ly, RULER, height - ly, 255, 255, 255);
  for (let y = ly; y < height; y += barP) {
    c.fillRect(lx, y, RULER, barP / 2, 0, 0, 0);
    if (Math.round((y - ly) / barP) % 5 === 0) c.fillRect(lx, y + barP / 2, RULER, barP / 2, 0, 0, 0);
  }
  features.push({ kind: 'rulerLeft', rect: [lx, 0, RULER, height], period: barP });

  // ---- 2. 上方 8 个光栅块（周期 2..16）：检测内部处理分辨率 ----
  for (let i = 0; i < GRATING_PERIODS.length; i++) {
    const p = GRATING_PERIODS[i];
    const x = BX + i * (BS + GAP), y = BY;
    const half = p / 2;
    for (let yy = 0; yy < BS; yy++) {
      // 直接按行写入，比逐像素 set 快得多
      let i0 = ((y + yy) * width + x) * 3;
      for (let xx = 0; xx < BS; xx++) {
        const v = Math.floor(xx / half) % 2 === 0 ? 255 : 0;
        c.data[i0++] = v; c.data[i0++] = v; c.data[i0++] = v;
      }
    }
    c.strokeRect(x, y, BS, BS, 255, 0, 0, Math.max(1, R(3)));
    features.push({ kind: 'grating', period: p, rect: [x, y, BS, BS] });
  }

  // ---- 3. 第二排：脉冲块（重采样的照妖镜）/ 纯平块 / 细密噪声块 ----
  {
    const y = BY + BS + GAP;
    // 脉冲：孤立白点
    const xa = BX;
    c.fillRect(xa, y, BS, BS, 0, 0, 0);
    let n = 0;
    for (let yy = 0; yy < BS; yy++) {
      for (let xx = 0; xx < BS; xx++) {
        if (rand() < 0.02) { c.set(xa + xx, y + yy, 255, 255, 255); n++; }
      }
    }
    c.strokeRect(xa, y, BS, BS, 255, 0, 0, Math.max(1, R(3)));
    features.push({ kind: 'impulse', count: n, rect: [xa, y, BS, BS] });

    // 纯平：检测噪声与色偏
    const xb = BX + BS + GAP;
    c.fillRect(xb, y, BS, BS, bg, bg, bg);
    c.strokeRect(xb, y, BS, BS, 255, 0, 0, Math.max(1, R(3)));
    features.push({ kind: 'flat', value: bg, rect: [xb, y, BS, BS] });

    // 细密噪声：模拟自然纹理
    const xc = BX + 2 * (BS + GAP);
    for (let yy = 0; yy < BS; yy++) {
      for (let xx = 0; xx < BS; xx++) {
        const v = Math.max(0, Math.min(255, Math.round(bg + (rand() - 0.5) * 90)));
        c.set(xc + xx, y + yy, v, v, v);
      }
    }
    c.strokeRect(xc, y, BS, BS, 255, 0, 0, Math.max(1, R(3)));
    features.push({ kind: 'noise', rect: [xc, y, BS, BS] });
  }

  // ---- 4. 灰度楔：32 级，检测 gamma / 色阶是否被改 ----
  {
    const y = BY + 2 * (BS + GAP);
    const step = Math.max(8, Math.round(BS / 4));
    const h = Math.max(8, Math.round(BS / 4));
    for (let i = 0; i < 32; i++) {
      const v = i * 8;
      c.fillRect(BX + i * step, y, step, h, v, v, v);
      c.strokeRect(BX + i * step, y, step, h, 255, 0, 0, 1);
    }
    features.push({ kind: 'wedge', steps: 32, step, height: h, rect: [BX, y, 32 * step, h] });
  }

  // ---- 5. 色块：检测色彩空间转换 ----
  {
    const step = Math.max(8, Math.round(BS / 2));
    const y0 = BY + 2 * (BS + GAP) + Math.max(8, Math.round(BS / 4)) + GAP;
    for (let i = 0; i < COLOR_PATCHES.length; i++) {
      const col = i % 8, row = Math.floor(i / 8);
      const x = BX + col * step, y = y0 + row * step;
      const [r, g, b] = COLOR_PATCHES[i];
      c.fillRect(x, y, step, step, r, g, b);
      c.strokeRect(x, y, step, step, 255, 0, 0, 1);
    }
    features.push({
      kind: 'colors', size: step, count: COLOR_PATCHES.length,
      rect: [BX, y0, 8 * step, 2 * step], values: COLOR_PATCHES,
    });
  }

  // ---- 6. 十字准星点阵：检测几何形变 / 局部平移 ----
  {
    const yStart = BY + 2 * (BS + GAP) + Math.max(8, Math.round(BS / 4)) + GAP + 2 * Math.max(8, Math.round(BS / 2)) + R(200);
    const stepX = R(600), stepY = R(600), arm = Math.max(4, R(20));
    const pts = [];
    for (let y = yStart; y < height - arm - 8; y += stepY) {
      for (let x = BX + arm; x < width - arm - 8; x += stepX) {
        c.fillRect(x - arm, y, arm * 2 + 1, 1, 255, 0, 0);
        c.fillRect(x, y - arm, 1, arm * 2 + 1, 255, 0, 0);
        pts.push([x, y]);
      }
    }
    features.push({ kind: 'crosshairs', arm, points: pts });
  }

  // ---- 7. 面板身份标记：0 号白块 / 1 号黑块，肉眼即可分辨 ----
  {
    const sz = R(240);
    const x = width - sz - R(320), y = height - sz - R(320);
    const v = tag === 0 ? 255 : 0;
    c.fillRect(x, y, sz, sz, v, v, v);
    c.strokeRect(x, y, sz, sz, 255, 0, 0, Math.max(2, R(6)));
    features.push({ kind: 'tag', tag, value: v, rect: [x, y, sz, sz] });
  }

  // ---- 8. 最外圈 1px 品红边框（必须最后画，否则会被角标盖掉）----
  // 任何重采样都会把它糊成 2~3px，是最灵敏的"是否被resize"指示器
  c.fillRect(0, 0, width, 1, 255, 0, 255);
  c.fillRect(0, height - 1, width, 1, 255, 0, 255);
  c.fillRect(0, 0, 1, height, 255, 0, 255);
  c.fillRect(width - 1, 0, 1, height, 255, 0, 255);
  features.push({ kind: 'border1px', rect: [0, 0, width, height] });

  return { data: c.data, width, height, features, scale: S };
}
