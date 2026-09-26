/** 图像比对指标：全部在 8bit RGB 上直接算，不做任何色彩转换（除非显式要求） */

export function diffStats(a, b) {
  const n = Math.min(a.length, b.length);
  let mse = 0, mae = 0, max = 0, gt2 = 0, gt8 = 0, changed = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d) changed++;
    mse += d * d; mae += d;
    if (d > max) max = d;
    if (d > 2) gt2++;
    if (d > 8) gt8++;
  }
  mse /= n; mae /= n;
  return {
    samples: n,
    mse: +mse.toFixed(5),
    psnr: mse === 0 ? Infinity : +(10 * Math.log10((255 * 255) / mse)).toFixed(3),
    mae: +mae.toFixed(5),
    max,
    pctGt2: +((gt2 / n) * 100).toFixed(4),
    pctGt8: +((gt8 / n) * 100).toFixed(4),
    pctChanged: +((changed / n) * 100).toFixed(4),
  };
}

function cropRegion(raw, rect) {
  const [x, y, w, h] = rect;
  const { data, width } = raw;
  const out = Buffer.alloc(w * h * 3);
  for (let yy = 0; yy < h; yy++) {
    const src = ((y + yy) * width + x) * 3;
    data.copy(out, yy * w * 3, src, src + w * 3);
  }
  return { data: out, width: w, height: h };
}
export { cropRegion };

export function regionMean(raw, rect) {
  const r = cropRegion(raw, rect);
  let s = [0, 0, 0];
  for (let i = 0; i < r.data.length; i += 3) { s[0] += r.data[i]; s[1] += r.data[i + 1]; s[2] += r.data[i + 2]; }
  const n = r.data.length / 3;
  return s.map((v) => +(v / n).toFixed(3));
}

export function luminanceHistogram(raw, rect) {
  const r = cropRegion(raw, rect);
  const hist = new Float64Array(256);
  for (let i = 0; i < r.data.length; i += 3) {
    const y = 0.2126 * r.data[i] + 0.7152 * r.data[i + 1] + 0.0722 * r.data[i + 2];
    hist[Math.max(0, Math.min(255, Math.round(y)))]++;
  }
  return hist;
}

function percentile(hist, p) {
  const total = hist.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= total * p) return i;
  }
  return 255;
}

/**
 * 光栅对比度 = p95 - p5 亮度差。
 * 理想 0/255 方波 ≈ 255；一旦被降采样/低通滤波，高频光栅的对比度会断崖式下跌。
 * 这是判断"像素蛋糕内部是否用低分辨率处理"最灵敏的指标。
 */
export function gratingContrast(raw, rect) {
  const hist = luminanceHistogram(raw, rect);
  return percentile(hist, 0.95) - percentile(hist, 0.05);
}

export function meanAbsLaplacian(raw, rect) {
  const r = cropRegion(raw, rect);
  const lum = (i) => 0.2126 * r.data[i] + 0.7152 * r.data[i + 1] + 0.0722 * r.data[i + 2];
  let sum = 0, n = 0;
  for (let y = 1; y < r.height - 1; y++) {
    for (let x = 1; x < r.width - 1; x++) {
      const i = (y * r.width + x) * 3;
      const v = 4 * lum(i) - lum(i - 3) - lum(i + 3) - lum(i - r.width * 3) - lum(i + r.width * 3);
      sum += Math.abs(v); n++;
    }
  }
  return +(sum / n).toFixed(4);
}

// ---- 色彩：sRGB -> Lab -> dE76 ----
function srgbToLinear(c) { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
export function srgbToLab([R, G, B]) {
  const r = srgbToLinear(R), g = srgbToLinear(G), b = srgbToLinear(B);
  let X = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  let Y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  let Z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;
  const wp = [0.95047, 1.0, 1.08883];
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X / wp[0]), fy = f(Y / wp[1]), fz = f(Z / wp[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function deltaE76(a, b) {
  const [l1, a1, b1] = srgbToLab(a), [l2, a2, b2] = srgbToLab(b);
  return +Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2).toFixed(3);
}

/**
 * 用 1D 自相关估计标尺条的基频周期，用来发现整体缩放。
 * 取"达到最大相关度 90% 的最小 lag"，这样在谐波之间不会来回跳。
 */
export function estimatePeriod(profile, maxLag = 400) {
  const n = profile.length;
  const mean = profile.reduce((a, b) => a + b, 0) / n;
  const v = profile.map((x) => x - mean);
  const corr = [];
  let best = -Infinity;
  const lo = 6, hi = Math.min(maxLag, Math.floor(n / 4));
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += v[i] * v[i + lag];
    s /= (n - lag);
    corr.push({ lag, s });
    if (s > best) best = s;
  }
  if (best <= 0) return 0;
  for (const c of corr) if (c.s >= best * 0.9) return c.lag;
  return corr.find((c) => c.s === best)?.lag ?? 0;
}

/** 取某一行或某一列的平均亮度剖面 */
export function profileRow(raw, y, x0, x1) {
  const out = new Float64Array(x1 - x0);
  for (let x = x0; x < x1; x++) {
    const i = (y * raw.width + x) * 3;
    out[x - x0] = 0.2126 * raw.data[i] + 0.7152 * raw.data[i + 1] + 0.0722 * raw.data[i + 2];
  }
  return Array.from(out);
}
export function profileCol(raw, x, y0, y1) {
  const out = new Float64Array(y1 - y0);
  for (let y = y0; y < y1; y++) {
    const i = (y * raw.width + x) * 3;
    out[y - y0] = 0.2126 * raw.data[i] + 0.7152 * raw.data[i + 1] + 0.0722 * raw.data[i + 2];
  }
  return Array.from(out);
}
