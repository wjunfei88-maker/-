import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { copyExifBetweenFiles } from './exif.mjs';
import { createLimiter } from './pool.mjs';

/**
 * 把像素蛋糕修完的合成图切回原图。
 *
 * 全部依据 manifest 里记录的**绝对裁剪矩形**做整数像素裁剪 —— 无损，不多不少。
 * 切割前会先校验尺寸：如果像素蛋糕改了尺寸（本轮 M0 已证明它不会，但要有兜底），
 * 直接拒绝并说明原因，绝不"猜着切"。
 *
 * 性能（实测，M1 Max）：切 4 刀 → JPEG q100 串行 5644ms / 并行 1754ms（4.46×）。
 * 每一刀都是一次"读一块区域 + 编码"，互相独立，所以这里并发切。
 * 并发闸门是**从外面传进来的全局闸门** —— 切回一整批时，每张画布有几刀不一样，
 * 按文件加锁会让只有 2 刀的画布跑不满，共用一个闸门才能一直喂满 CPU。
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
    limiter,                    // 全局闸门（批量切回时共用同一个）
    concurrency = 4,            // 没传 limiter 时自己建一个
  } = opts;

  if (!manifest?.items?.length) throw new Error('manifest 里没有图片记录');
  fs.mkdirSync(outDir, { recursive: true });

  const timings = [];
  let last = Date.now();
  const mark = (label) => { const t = Date.now(); timings.push({ label, ms: t - last }); last = t; };

  const md = await sharp(returnedFile, { unlimited: true, failOn: 'none' }).metadata();
  const expW = manifest.canvas.width, expH = manifest.canvas.height;
  mark('读取成片信息');

  const report = {
    returnedFile,
    expected: { width: expW, height: expH },
    actual: { width: md.width, height: md.height },
    dimsMatch: md.width === expW && md.height === expH,
    outputs: [],
    warnings: [],
    timings,
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

  const gate = limiter ?? createLimiter(Math.max(1, concurrency));
  const total = manifest.items.length;
  const outputs = new Array(total);
  let finished = 0;

  // 面积大的先切：最后只剩一块小的收尾，比反过来拖尾短
  const order = manifest.items
    .map((it, i) => i)
    .sort((a, b) => (manifest.items[b].crop.width * manifest.items[b].crop.height)
      - (manifest.items[a].crop.width * manifest.items[a].crop.height));

  await Promise.all(order.map((i) => gate.run(async () => {
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

    const t0 = Date.now();
    try {
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
      let exifNothingToCopy = false;
      if (keepExif && fmt === 'jpeg' && it.source && fs.existsSync(it.source)) {
        const r = await copyExifBetweenFiles(it.source, outFile);
        exifCopied = r === true;
        exifNothingToCopy = r === null;   // 原图没有 EXIF（比如某些导出/截图），不是错
      }
      // 转过 90° 的，输出尺寸要和原图对齐（宽高互换回来）再判定无损
      const outW = rotated ? height : width;
      const outH = rotated ? width : height;
      outputs[i] = {
        index: i,
        name: path.basename(outFile),
        file: outFile,
        size: `${outW}×${outH}`,
        natural: it.natural,
        rotation: it.rotation ?? 0,
        lossless: report.dimsMatch && outW === it.natural.width && outH === it.natural.height,
        exifCopied,
        exifNothingToCopy,
        source: it.source,
        ms: Date.now() - t0,
      };
    } catch (e) {
      // 单张失败不拖垮整张画布：其余照片照常交付
      outputs[i] = {
        index: i, name: stem, file: null, size: null, natural: it.natural,
        rotation: it.rotation ?? 0, lossless: false, exifCopied: false,
        source: it.source, error: e.message, ms: Date.now() - t0,
      };
    }

    finished++;
    onProgress({
      stage: 'split', pct: finished / total,
      message: `切分 ${it.name ?? i + 1}（${finished}/${total}）`,
      timings: [...timings, { label: '切分 + 重新编码', ms: Date.now() - last }],
    });
  })));

  report.outputs = outputs.filter(Boolean);
  mark(`切分 + 重新编码（${total} 张并行）`);

  const errored = report.outputs.filter((o) => o.error);
  if (errored.length) report.warnings.push(`${errored.length} 张切分失败：${errored.map((o) => o.name).join('、')}`);

  const lossy = report.outputs.filter((o) => !o.lossless && !o.error);
  if (lossy.length) report.warnings.push(`${lossy.length} 张的尺寸与原图不完全一致`);
  // 原图本来就没 EXIF 的不算失败，只有「明明有却搬不过去」才值得警告
  const noExif = report.outputs.filter((o) => !o.exifCopied && !o.exifNothingToCopy && keepExif && o.file?.endsWith('.jpg') && !o.error);
  if (noExif.length) report.warnings.push(`${noExif.length} 张没能搬回 EXIF（原文件可能已移动或格式不支持）`);

  return report;
}
