import sharp from 'sharp';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

sharp.cache({ memory: 256, files: 20, items: 100 });
sharp.concurrency(Math.max(2, Math.min(8, os.cpus().length - 1)));

export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp', '.avif', '.heic', '.heif', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2']);

export const shortId = (n = 6) =>
  crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, '').slice(0, n).toLowerCase();

/**
 * 读取一张图的基本信息。
 * 关键：orientation >= 5 时宽高互换，因为后续所有处理都会先把方向"烤"进像素，
 * manifest 里记的尺寸必须是用户实际看到的那个。
 */
export async function probeImage(file) {
  const md = await sharp(file, { unlimited: true, failOn: 'none' }).metadata();
  if (!md.width || !md.height) throw new Error(`无法识别图片：${path.basename(file)}`);
  const rotated = md.orientation != null && md.orientation >= 5;
  const width = rotated ? md.height : md.width;
  const height = rotated ? md.width : md.height;
  return {
    path: file,
    name: path.basename(file),
    dir: path.dirname(file),
    format: md.format,
    width,
    height,
    rawWidth: md.width,
    rawHeight: md.height,
    orientation: md.orientation ?? 1,
    space: md.space,
    hasProfile: !!md.icc,
    megapixels: (width * height) / 1e6,
  };
}

/** 生成缩略图（用于界面显示；画布渲染只吃缩略图，不吃原图） */
export async function makeThumb(file, outDir, maxSide = 1024) {
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${shortId(10)}.jpg`);
  const info = await sharp(file, { unlimited: true, failOn: 'none' })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#808080' })
    .jpeg({ quality: 84, chromaSubsampling: '4:4:4' })
    .toFile(out);
  return { thumbPath: out, thumbWidth: info.width, thumbHeight: info.height };
}

/** 返回一个 sharp 能吃的输入源；方向不是 1 的先烤平 */
export async function orientedSource(file, probe) {
  if (!probe || probe.orientation == null || probe.orientation === 1) {
    return { input: file, width: probe?.rawWidth ?? null, height: probe?.rawHeight ?? null, temp: null };
  }
  const buf = await sharp(file, { unlimited: true, failOn: 'none' })
    .rotate()
    .flatten({ background: '#808080' })
    .tiff({ compression: 'lzw' })
    .toBuffer();
  return { input: buf, width: probe.width, height: probe.height, temp: buf };
}

export async function writePreview(srcBufferOrPath, outFile, maxSide = 1600) {
  await sharp(srcBufferOrPath, { unlimited: true, failOn: 'none' })
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toFile(outFile);
  return outFile;
}
