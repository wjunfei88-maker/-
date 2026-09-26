import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { orientedSource, probeImage } from './library.mjs';
import { createLimiter } from './pool.mjs';

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
 *
 * 性能（实测，见 README）：
 *   · 贴图这步 libvips 会用多核（并行度 7.27×）
 *   · 但 TIFF LZW / JPEG 编码是**单线程**的（并行度 1.06× / 1.04×）—— 单张画布的天花板
 *   · 所以单张画布内部能省的是"重复解码"：以前每条边都单独 extract 一次，
 *     一张图要被整个解码 4 次（左右两条竖边各要全高）。现在每张图只解一次。
 */

const BG = { r: 128, g: 128, b: 128 };

/**
 * 把一张图四条边 + 四个角要用的镜像小条，从**一份已解码的 raw** 里切出来。
 * 传入 raw 而不是文件路径，是为了避免每条边都把整张图解一遍。
 */
async function buildMirrorStrips(raw, info, { x, y, pw, ph }, half, width, height) {
  const wL = Math.min(half, x);
  const wR = Math.min(half, width - (x + pw));
  const hT = Math.min(half, y);
  const hB = Math.min(half, height - (y + ph));

  const jobs = [];
  if (wL > 0) jobs.push([{ left: 0, top: 0, width: wL, height: ph }, { left: x - wL, top: y }, { flop: true }]);
  if (wR > 0) jobs.push([{ left: pw - wR, top: 0, width: wR, height: ph }, { left: x + pw, top: y }, { flop: true }]);
  if (hT > 0) jobs.push([{ left: 0, top: 0, width: pw, height: hT }, { left: x, top: y - hT }, { flip: true }]);
  if (hB > 0) jobs.push([{ left: 0, top: ph - hB, width: pw, height: hB }, { left: x, top: y + ph }, { flip: true }]);
  // 四个角：斜向镜像，把 L 形空隙的拐角也补上
  if (wL > 0 && hT > 0) jobs.push([{ left: 0, top: 0, width: wL, height: hT }, { left: x - wL, top: y - hT }, { flop: true, flip: true }]);
  if (wR > 0 && hT > 0) jobs.push([{ left: pw - wR, top: 0, width: wR, height: hT }, { left: x + pw, top: y - hT }, { flop: true, flip: true }]);
  if (wL > 0 && hB > 0) jobs.push([{ left: 0, top: ph - hB, width: wL, height: hB }, { left: x - wL, top: y + ph }, { flop: true, flip: true }]);
  if (wR > 0 && hB > 0) jobs.push([{ left: pw - wR, top: ph - hB, width: wR, height: hB }, { left: x + pw, top: y + ph }, { flop: true, flip: true }]);

  const out = [];
  for (const [region, dest, fl] of jobs) {
    const r = {
      left: Math.max(0, Math.min(region.left, info.width - 1)),
      top: Math.max(0, Math.min(region.top, info.height - 1)),
      width: Math.max(1, Math.min(region.width, info.width - Math.max(0, Math.min(region.left, info.width - 1)))),
      height: Math.max(1, Math.min(region.height, info.height - Math.max(0, Math.min(region.top, info.height - 1)))),
    };
    let s = sharp(raw, { raw: info }).extract(r);
    if (fl.flop) s = s.flop();
    if (fl.flip) s = s.flip();
    // 统一成 sRGB 三通道：灰度图 / 带 alpha 的 PNG 都要归一，否则下游按 3 通道读会整体错位
    const { data, info: si } = await s.toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
    out.push({
      input: data,
      raw: { width: si.width, height: si.height, channels: si.channels },
      left: dest.left, top: dest.top,
    });
  }
  return out;
}

export async function composeCanvas(opts) {
  const {
    items,                 // [{ source, probe, rotation, crop:{left,top,width,height} }]
    width, height, gutter = 24,
    outFile, icc = 'srgb', compression = 'lzw',
    onProgress = () => {},
    panelConcurrency = 2,  // 同一张画布内同时解码几张源图（多进程导出时再调小）
  } = opts;

  if (!items.length) throw new Error('画布上还没有图片');
  if (width > 12000 || height > 12000) {
    throw new Error(`画布 ${width}×${height} 超出像素蛋糕单边 12000px 上限`);
  }

  // 阶段耗时埋点：界面上要如实显示时间花在哪一步，而不是只转一个假圈
  const timings = [];
  let last = Date.now();
  const mark = (label) => { const t = Date.now(); timings.push({ label, ms: t - last }); last = t; };
  const tick = (stage, pct, message) => onProgress({ stage, pct, message, timings: timings.map((x) => ({ ...x })) });

  // ── 1) 准备每张图（EXIF 方向先烤平；排布时旋转过的再转 90°）──
  tick('prepare', 0.02, '准备源图…');
  const panels = new Array(items.length);
  {
    const limiter = createLimiter(Math.max(1, panelConcurrency));
    let finished = 0;
    await Promise.all(items.map((it, i) => limiter.run(async () => {
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
      panels[i] = { ...it, probe, input, pw: it.crop.width, ph: it.crop.height };
      finished++;
      tick('prepare', 0.02 + 0.3 * (finished / items.length), `准备 ${probe.name}`);
    })));
  }
  mark('解码源图');

  // ── 2) 每张图向外铺自身镜像（保护带）──
  tick('gutter', 0.35, '生成保护带…');
  const half = Math.max(1, Math.ceil(gutter / 2));
  const composites = [];
  {
    // 解码是一次性的重活，切条是极轻的内存操作；这里把两者都放进同一个闸门，
    // 单个 panel 的峰值内存 = 一张源图的 raw（42MP ≈ 126MB）
    const limiter = createLimiter(Math.max(1, panelConcurrency));
    const strips = await Promise.all(panels.map((p) => limiter.run(async () => {
      const { data, info } = await sharp(p.input, { unlimited: true, failOn: 'none' })
        .toColourspace('srgb')
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const s = await buildMirrorStrips(data, info, { x: p.crop.left, y: p.crop.top, pw: p.pw, ph: p.ph }, half, width, height);
      return s;
    })));
    for (const s of strips) composites.push(...s);
  }
  mark('保护带镜像');

  // ── 3) 面板盖在保护带上面（顺序很重要：后画的在上层）──
  // input 可能是文件路径，也可能是旋转后转存的 TIFF buffer —— sharp 两种都吃，都会自己解码。
  for (const p of panels) {
    composites.push({ input: p.input, left: p.crop.left, top: p.crop.top });
  }

  // ── 4) 贴图 + 编码写 TIFF ──
  tick('encode', 0.5, `贴图并编码 TIFF ${width}×${height}…`);
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
  mark('贴图 + LZW 压缩');

  tick('done', 1, '完成');
  return { outFile, bytes: fs.statSync(outFile).size, timings };
}

/** 生成一张低分辨率预览图，供界面回显（不参与实际输出） */
export async function makeCanvasPreview(srcFile, outFile, maxSide = 1400) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await sharp(srcFile, { unlimited: true, failOn: 'none' })
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 86 })
    .toFile(outFile);
  return outFile;
}
