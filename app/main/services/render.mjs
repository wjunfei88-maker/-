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
 * 保护带用"两侧各自的边缘镜像"填充（见 M0-结果.md 第 2 轮结论）：
 * 液化/AI 形变跨过接缝拉扯时，取到的是这张图自己的内容，而不是隔壁照片的。
 */

const BG = { r: 128, g: 128, b: 128 };

export async function composeCanvas(opts) {
  const {
    items,                 // [{ source, probe, crop:{left,top,width,height} }]
    width, height, gutter = 24,
    outFile, icc = 'srgb', compression = 'lzw',
    onProgress = () => {},
  } = opts;

  if (!items.length) throw new Error('画布上还没有图片');
  if (width > 12000 || height > 12000) {
    throw new Error(`画布 ${width}×${height} 超出像素蛋糕单边 12000px 上限`);
  }

  onProgress({ stage: 'prepare', pct: 0.05, message: '准备源图…' });

  // 1) 准备每张图的输入源（方向不为 1 的先烤平）
  const panels = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const probe = it.probe ?? await probeImage(it.source);
    const src = await orientedSource(it.source, probe);
    panels.push({
      ...it, probe,
      input: src.input,
      pw: it.crop.width,
      ph: it.crop.height,
      sameWidthAsNext: null,
    });
    onProgress({ stage: 'prepare', pct: 0.05 + 0.25 * ((i + 1) / items.length), message: `准备 ${probe.name}` });
  }

  const composites = [];
  for (const p of panels) {
    composites.push({ input: p.input, left: p.crop.left, top: p.crop.top });
  }

  // 2) 相邻面板之间铺镜像保护带（纵、横两个方向都要）
  onProgress({ stage: 'gutter', pct: 0.35, message: '生成保护带…' });

  // 纵向：上下相邻
  const byTop = [...panels].sort((a, b) => a.crop.top - b.crop.top);
  for (let i = 0; i < byTop.length - 1; i++) {
    const A = byTop[i], B = byTop[i + 1];
    const gap = B.crop.top - (A.crop.top + A.ph);
    if (gap <= 0) continue;
    if (A.crop.left !== B.crop.left || A.pw !== B.pw) continue;
    const half = Math.floor(gap / 2);
    if (half > 0) {
      const strip = await sharp(A.input, { unlimited: true })
        .extract({ left: 0, top: A.ph - half, width: A.pw, height: half })
        .removeAlpha().toBuffer();
      composites.push({ input: strip, left: A.crop.left, top: A.crop.top + A.ph });
    }
    const rest = gap - half;
    if (rest > 0) {
      const strip = await sharp(B.input, { unlimited: true })
        .extract({ left: 0, top: 0, width: B.pw, height: rest })
        .removeAlpha().toBuffer();
      composites.push({ input: strip, left: B.crop.left, top: B.crop.top - rest });
    }
  }

  // 横向：左右相邻
  const byLeft = [...panels].sort((a, b) => a.crop.left - b.crop.left);
  for (let i = 0; i < byLeft.length - 1; i++) {
    const A = byLeft[i], B = byLeft[i + 1];
    const gap = B.crop.left - (A.crop.left + A.pw);
    if (gap <= 0) continue;
    if (A.crop.top !== B.crop.top || A.ph !== B.ph) continue;
    const half = Math.floor(gap / 2);
    if (half > 0) {
      const strip = await sharp(A.input, { unlimited: true })
        .extract({ left: A.pw - half, top: 0, width: half, height: A.ph })
        .removeAlpha().toBuffer();
      composites.push({ input: strip, left: A.crop.left + A.pw, top: A.crop.top });
    }
    const rest = gap - half;
    if (rest > 0) {
      const strip = await sharp(B.input, { unlimited: true })
        .extract({ left: 0, top: 0, width: rest, height: B.ph })
        .removeAlpha().toBuffer();
      composites.push({ input: strip, left: B.crop.left - rest, top: B.crop.top });
    }
  }

  // 3) 写 TIFF
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
