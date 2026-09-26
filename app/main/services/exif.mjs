/**
 * EXIF 搬运
 *
 * 为什么不用 sharp 的 withExif：它只接受字符串值（ISO/光圈/快门这类数值标签会被破坏），
 * 而且官方明确写了"EXIF metadata is unsupported for TIFF output"。
 *
 * 这里走最忠实的路线：**整体搬运原图的 EXIF APP1 段字节**，
 * MakerNotes / GPS / 镜头数据全部原样保留，零转换风险。
 *
 * 额外做一件重要的事：**摘掉原图内嵌的缩略图**。
 * 否则相机/调色软件在 EXIF 里存的那张未修小图会跟着交付出去——
 * 客户在访达或微信里看到的会是没修过的版本。
 */

import fs from 'node:fs';

const EXIF_MAGIC = Buffer.from('Exif\0\0');
const SOI = 0xffd8;

/** 遍历 JPEG 段，找到 EXIF APP1（返回段头和段尾，不含 2 字节 SOI） */
function findExifApp1(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== SOI) return null;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    if (marker === 0xda) return null;                       // 到了压缩数据
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    if (marker === 0xe1) {
      const payload = buf.subarray(i + 4, i + 2 + len);
      if (payload.length >= 6 && payload.subarray(0, 6).equals(EXIF_MAGIC)) {
        return { start: i, end: i + 2 + len, payload };
      }
    }
    i += 2 + len;
  }
  return null;
}

/** 取出一张 JPEG 的 EXIF 载荷（以 "Exif\0\0" 开头），没有则返回 null */
export function extractExif(jpegBuffer) {
  const a = findExifApp1(jpegBuffer);
  return a ? Buffer.from(a.payload) : null;
}

/**
 * 把 EXIF 里 IFD0 指向 IFD1（缩略图）的 next-IFD 指针清零，
 * 从而彻底断开内嵌缩略图。缩略图字节会变成无人引用的死数据，无害。
 */
export function stripThumbnail(exifPayload) {
  const T = 6; // 跳过 "Exif\0\0"
  if (exifPayload.length < T + 8) return exifPayload;
  const out = Buffer.from(exifPayload);
  const little = out.readUInt16BE(T) === 0x4949;
  const rd32 = (o) => (little ? out.readUInt32LE(o) : out.readUInt32BE(o));
  const rd16 = (o) => (little ? out.readUInt16LE(o) : out.readUInt16BE(o));
  if (rd16(T + 2) !== 42) return out;                 // 非法 TIFF 头，原样返回
  const ifd0 = T + rd32(T + 4);
  if (ifd0 + 2 > out.length) return out;
  const count = rd16(ifd0);
  const nextPtr = ifd0 + 2 + count * 12;
  if (nextPtr + 4 > out.length) return out;
  if (little) out.writeUInt32LE(0, nextPtr); else out.writeUInt32BE(0, nextPtr);
  return out;
}

/** 把 EXIF 载荷注入一张 JPEG（会先移除目标里已有的 EXIF APP1） */
export function injectExif(jpegBuffer, exifPayload) {
  if (!exifPayload || !exifPayload.length) return jpegBuffer;
  const segLen = exifPayload.length + 2;
  if (segLen > 0xffff) return jpegBuffer;             // 段长上限，放弃注入
  const seg = Buffer.alloc(4 + exifPayload.length);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(segLen, 2);
  exifPayload.copy(seg, 4);

  const body = jpegBuffer.subarray(2);                 // 去掉 SOI
  const existing = findExifApp1(jpegBuffer);
  let rest;
  if (existing) {
    // existing 的 start/end 是相对整个 buffer 的，转成相对 body 的偏移
    rest = Buffer.concat([
      body.subarray(0, existing.start - 2),
      body.subarray(existing.end - 2),
    ]);
  } else {
    rest = body;
  }
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg, rest]);
}

/** 一站式：把 srcFile 的 EXIF（去掉缩略图）搬到 destFile */
export async function copyExifBetweenFiles(srcFile, destFile) {
  try {
    const src = fs.readFileSync(srcFile);
    const dest = fs.readFileSync(destFile);
    if (src.readUInt16BE(0) !== SOI || dest.readUInt16BE(0) !== SOI) return false;
    const exif = extractExif(src);
    if (!exif) return false;
    const cleaned = stripThumbnail(exif);
    fs.writeFileSync(destFile, injectExif(dest, cleaned));
    return true;
  } catch {
    return false;
  }
}

/** 读出一张图里有没有 EXIF（用于校验） */
export function hasExif(jpegBuffer) {
  return !!findExifApp1(jpegBuffer);
}
