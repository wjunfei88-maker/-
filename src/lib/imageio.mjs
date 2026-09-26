import sharp from 'sharp';

sharp.cache(false);
sharp.concurrency(4);

/** 读成 raw RGB（不做色彩空间转换，保留原始像素值） */
export async function readRaw(file) {
  const { data, info } = await sharp(file, { unlimited: true, failOn: 'none' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** 读元信息（不解码像素） */
export async function probe(file) {
  const md = await sharp(file, { unlimited: true, failOn: 'none' }).metadata();
  return {
    format: md.format,
    width: md.width,
    height: md.height,
    channels: md.channels,
    depth: md.depth,
    space: md.space,
    hasProfile: md.hasProfile,
    iccName: md.icc ? `embedded(${md.icc.length}B)` : null,
    density: md.density,
    compression: md.compression,
    isPalette: md.isPalette,
  };
}

/** 写 TIFF */
export async function writeTiff(raw, out, opts = {}) {
  const { width, height, data } = raw;
  const {
    compression = 'none', // none | lzw | deflate | jpeg
    predictor = compression === 'lzw' || compression === 'deflate' ? 'horizontal' : undefined,
    icc = 'srgb',
    xres = 300, yres = 300,
    effort,
  } = opts;
  let p = sharp(data, { raw: { width, height, channels: 3 }, unlimited: true })
    .tiff({ compression, predictor, bitdepth: 8, xres, yres, resolutionUnit: 'inch', effort });
  if (icc) p = p.withIccProfile(icc);
  await p.toFile(out);
  return out;
}

/** 写 PNG（无损备选） */
export async function writePng(raw, out, opts = {}) {
  const { width, height, data } = raw;
  let p = sharp(data, { raw: { width, height, channels: 3 }, unlimited: true })
    .png({ compressionLevel: 6, effort: 4 });
  if (opts.icc !== null) p = p.withIccProfile(opts.icc || 'srgb');
  await p.toFile(out);
  return out;
}
