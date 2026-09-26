import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { orientedSource, probeImage } from './library.mjs';

/**
 * 合成画布。
 *
 * 用 libvips 的 composite 流式拼合，不在 JS 里开一张 89MP 的 Buffer ——
 * 那样峰值内存要 800MB+，libvips 走的是行式流水线，稳得多。
 *
 * 保护带（M0-结果.md 第 2 轮的结论）：
 *   液化/AI 形变是一个**全局平滑位移场**，会跨过接缝继续拉扯。
 *   所以保护带的作用不是"挡住"形变，而是让每一侧被拉扯时**取到自己的内容**。
 *   做法：每张图的四条边各向外铺 `ceil(gutter/2)` 宽的**自身镜像**。
 *
 *   为什么改成"每条边都铺"而不是"只铺对齐的邻居"：
 *     v2 的混尺寸装箱会产生 L 形和不规则的空隙，相邻面往往不对齐。
 *     旧写法在这种情况下会留下大片灰底 —— 灰底被拉进画面就是污染。
 *     现在每张图自带 12px 镜像护城河，无论邻居怎么摆都安全。
 */

const BG = { r: 128, g: 128, b: 128 };

/** 把一条边/角按需翻转，产出可以直接 composite 的小 buffer */
async function mirrorStrip(input, region, { flop = false, flip = false } = {}) {
  let s = sharp(input, { unlimited: true, failOn: 'none' }).extract(region);
  if (flop) s = s.flop();          // 水平镜像
  if (flip) s = s.flip();          // 垂直镜像
  return s.removeAlpha().toBuffer();
}

export async function composeCanvas(opts) {
  const {
    items,                 // [{ source, probe, rotation, crop:{left,top,width,height} }]
    width, height, gutter = 24,
    outFile, icc = 'srgb', compression = 'lzw',
    onProgress = () => {},
  } = opts;

  if (!items.length) throw new Error('画布上还没有图片');
  if (width > 12000 || height > 12000) {
    throw new Error(`画布 ${width}×${height} 超出像素蛋糕单边 12000px 上限`);
  }

  onProgress({ stage: 'prepare', pct: 0.05, message: '准备源图…' });

  // 1) 准备每张图的输入源（EXIF 方向先烤平；排布时旋转过的再转 90°）
  const panels = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const probe = it.probe ?? await probeImage(it.source);
    const src = await orientedSource(it.source, probe);
    let input = src.input;
    if (it.rotation === 90) {
      // 旋转是整数像素重排，无损；切分时会用 manifest 里的 rotation 转回来
      input = await sharp(src.input, { unlimited: true, failOn: 'none' })
        .rotate(90)
        .tiff({ compression: 'lzw' })
        .toBuffer();
    }
    panels.push({ ...it, probe, input, pw: it.crop.width, ph: it.crop.height });
    onProgress({ stage: 'prepare', pct: 0.05 + 0.25 * ((i + 1) / items.length), message: `准备 ${probe.name}` });
  }

  // 2) 每张图向外铺自身镜像（保护带）
  onProgress({ stage: 'gutter', pct: 0.35, message: '生成保护带…' });
  const half = Math.max(1, Math.ceil(gutter / 2));
  const composites = [];

  for (const p of panels) {
    const x = p.crop.left, y = p.crop.top;
    const wL = Math.min(half, x);                       // 左侧可用宽度
    const wR = Math.min(half, width - (x + p.pw));      // 右侧
    const hT = Math.min(half, y);                       // 上侧
    const hB = Math.min(half, height - (y + p.ph));     // 下侧

    const jobs = [];
    if (wL > 0) jobs.push([{ left: 0, top: 0, width: wL, height: p.ph }, { left: x - wL, top: y }, { flop: true }]);
    if (wR > 0) jobs.push([{ left: p.pw - wR, top: 0, width: wR, height: p.ph }, { left: x + p.pw, top: y }, { flop: true }]);
    if (hT > 0) jobs.push([{ left: 0, top: 0, width: p.pw, height: hT }, { left: x, top: y - hT }, { flip: true }]);
    if (hB > 0) jobs.push([{ left: 0, top: p.ph - hB, width: p.pw, height: hB }, { left: x, top: y + p.ph }, { flip: true }]);
    // 四个角：斜向镜像，把 L 形空隙的拐角也补上
    if (wL > 0 && hT > 0) jobs.push([{ left: 0, top: 0, width: wL, height: hT }, { left: x - wL, top: y - hT }, { flop: true, flip: true }]);
    if (wR > 0 && hT > 0) jobs.push([{ left: p.pw - wR, top: 0, width: wR, height: hT }, { left: x + p.pw, top: y - hT }, { flop: true, flip: true }]);
    if (wL > 0 && hB > 0) jobs.push([{ left: 0, top: p.ph - hB, width: wL, height: hB }, { left: x - wL, top: y + p.ph }, { flop: true, flip: true }]);
    if (wR > 0 && hB > 0) jobs.push([{ left: p.pw - wR, top: p.ph - hB, width: wR, height: hB }, { left: x + p.pw, top: y + p.ph }, { flop: true, flip: true }]);

    for (const [region, dest, fl] of jobs) {
      const buf = await mirrorStrip(p.input, region, fl);
      composites.push({ input: buf, left: dest.left, top: dest.top });
    }
  }

  // 3) 面板盖在保护带上面（顺序很重要：后画的在上层）
  for (const p of panels) {
    composites.push({ input: p.input, left: p.crop.left, top: p.crop.top });
  }

  // 4) 写 TIFF
  onProgress({ stage: 'encode', pct: 0.5, message: `编码 TIFF ${width}×${height}…` });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = outFile + '.part';
  await sharp({ create: { width, height, channels: 3, background: BG }, unlimited: true })
    .composite(composites)
    // libvips 的 composite 会把底图提升成 4 带（RGBA），这里压回 RGB —— 合成图不该带 alpha
    .removeAlpha()
    .withIccProfile(icc)
    .tiff({ compression, predictor: compression === 'lzw' || compression === 'deflate' ? 'horizontal' : undefined, bitdepth: 8, xres: 300, yres: 300, resolutionUnit: 'inch' })
    .toFile(tmp);
  fs.renameSync(tmp, outFile);

  onProgress({ stage: 'done', pct: 1, message: '完成' });
  return { outFile, bytes: fs.statSync(outFile).size };
}

/** 生成一张低分辨率预览图，供界面回显（不参与实际输出） */
export async function makeCanvasPreview(srcFile, outFile, maxSide = 1400) {
  await sharp(srcFile, { unlimited: true, failOn: 'none' })
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 86 })
    .toFile(outFile);
  return outFile;
}
