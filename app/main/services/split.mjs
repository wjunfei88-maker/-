import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { copyExifBetweenFiles } from './exif.mjs';

/**
 * 把像素蛋糕修完的合成图切回原图。
 *
 * 全部依据 manifest 里记录的**绝对裁剪矩形**做整数像素裁剪 —— 无损，不多不少。
 * 切割前会先校验尺寸：如果像素蛋糕改了尺寸（本轮 M0 已证明它不会，但要有兜底），
 * 直接拒绝并说明原因，绝不"猜着切"。
 */

function safeName(name, fallback) {
  const base = path.basename(name || fallback);
  return base.replace(/[/\\:*?"<>|]/g, '_');
}

export async function splitCanvas(opts) {
  const {
    returnedFile,
    manifest,
    outDir,
    format = 'jpeg',            // jpeg | tiff | png | original
    quality = 14,               // 对齐像素蛋糕的 1~14 档
    keepExif = true,
    onProgress = () => {},
  } = opts;

  if (!manifest?.items?.length) throw new Error('manifest 里没有图片记录');
  fs.mkdirSync(outDir, { recursive: true });

  const md = await sharp(returnedFile, { unlimited: true, failOn: 'none' }).metadata();
  const expW = manifest.canvas.width, expH = manifest.canvas.height;

  const report = {
    returnedFile,
    expected: { width: expW, height: expH },
    actual: { width: md.width, height: md.height },
    dimsMatch: md.width === expW && md.height === expH,
    outputs: [],
    warnings: [],
  };

  if (!report.dimsMatch) {
    const rx = md.width / expW, ry = md.height / expH;
    report.warnings.push(
      `返回文件尺寸 ${md.width}×${md.height} 与合成时 ${expW}×${expH} 不一致` +
      (Math.abs(rx - ry) < 0.002 ? `（整体等比 ${(rx * 100).toFixed(2)}%）` : '（宽高比也变了）')
    );
    // 等比缩放的情况仍然可以救：按比例映射裁剪框，代价是有一次重采样
    if (Math.abs(rx - ry) < 0.002) {
      report.warnings.push('已按比例换算裁剪框继续切分（这一份会有一次重采样，不是 1:1）');
    } else {
      throw new Error('尺寸与宽高比都变了，无法可靠切分。请检查是否在像素蛋糕里用了裁剪或排版模式。');
    }
  }

  const total = manifest.items.length;
  for (let i = 0; i < total; i++) {
    const it = manifest.items[i];
    const c = it.crop;
    const left = Math.round(c.left * (report.dimsMatch ? 1 : md.width / expW));
    const top = Math.round(c.top * (report.dimsMatch ? 1 : md.height / expH));
    const width = Math.round(c.width * (report.dimsMatch ? 1 : md.width / expW));
    const height = Math.round(c.height * (report.dimsMatch ? 1 : md.height / expH));

    const stem = safeName(it.name, `image-${i + 1}`).replace(/\.[^.]+$/, '');
    const fmt = format === 'original' ? (it.format === 'jpeg' ? 'jpeg' : it.format) : format;
    const ext = fmt === 'jpeg' ? '.jpg' : fmt === 'tiff' ? '.tif' : `.${fmt}`;
    const outFile = path.join(outDir, `${stem}${ext}`);

    let pipe = sharp(returnedFile, { unlimited: true })
      .extract({ left, top, width, height });
    // 排版时被转过 90° 的，这里必须转回来，否则交付的照片是躺着的。
    // 旋转是整数像素重排，不引入重采样 —— 仍然是无损的。
    const rotated = it.rotation === 90;
    if (rotated) pipe = pipe.rotate(-90);
    if (fmt === 'jpeg') {
      const q = Math.max(1, Math.min(100, Math.round(quality / 14 * 100)));
      pipe = pipe.flatten({ background: '#ffffff' }).jpeg({ quality: q, chromaSubsampling: '4:4:4', mozjpeg: false });
    } else if (fmt === 'tiff') {
      pipe = pipe.tiff({ compression: 'lzw', bitdepth: 8 });
    } else if (fmt === 'png') {
      pipe = pipe.png({ compressionLevel: 6 });
    } else if (fmt === 'webp') {
      pipe = pipe.webp({ quality: 95, lossless: false });
    }
    await pipe.toFile(outFile);

    let exifCopied = false;
    if (keepExif && fmt === 'jpeg' && it.source && fs.existsSync(it.source)) {
      exifCopied = await copyExifBetweenFiles(it.source, outFile);
    }
    // 转过 90° 的，输出尺寸要和原图对齐（宽高互换回来）再判定无损
    const outW = rotated ? height : width;
    const outH = rotated ? width : height;
    report.outputs.push({
      index: i,
      name: path.basename(outFile),
      file: outFile,
      size: `${outW}×${outH}`,
      natural: it.natural,
      rotation: it.rotation ?? 0,
      lossless: report.dimsMatch && outW === it.natural.width && outH === it.natural.height,
      exifCopied,
      source: it.source,
    });
    onProgress({ stage: 'split', pct: (i + 1) / total, message: `切分 ${it.name ?? i + 1}` });
  }

  const lossy = report.outputs.filter((o) => !o.lossless);
  if (lossy.length) report.warnings.push(`${lossy.length} 张的尺寸与原图不完全一致`);
  const noExif = report.outputs.filter((o) => !o.exifCopied && keepExif && o.file.endsWith('.jpg'));
  if (noExif.length) report.warnings.push(`${noExif.length} 张没能搬回 EXIF（原文件可能已移动或格式不支持）`);

  return report;
}
