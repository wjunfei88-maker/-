#!/usr/bin/env node
/**
 * 端到端回归测试（纯 Node，不启动 Electron）
 *
 * 覆盖：排版引擎 → 合成 TIFF → 模拟像素蛋糕改像素 → 切回原图 → EXIF 搬运 → 尺寸校验
 * 用法：node app/test/e2e.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import exifReader from 'exif-reader';

import { planGroups, packCanvas, assertNoOverlap } from '../main/services/layout.mjs';
import { composeCanvas } from '../main/services/render.mjs';
import { splitCanvas } from '../main/services/split.mjs';
import { extractExif, stripThumbnail, injectExif, hasExif } from '../main/services/exif.mjs';
import { probeImage } from '../main/services/library.mjs';

const TMP = path.join(os.tmpdir(), 'pixcake-tiler-e2e');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✔ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ✘ ${label}${extra ? '  —  ' + extra : ''}`); }
};
const H = (s) => { console.log(`\n${'─'.repeat(66)}\n${s}\n${'─'.repeat(66)}`); };

// ─────────────────────── 1. 排版引擎 ───────────────────────
H('① 排版引擎：12000px 约束下的几何');

const mk = (id, w, h) => ({ id, name: `${id}.jpg`, width: w, height: h, path: `/x/${id}.jpg` });

{
  // 42MP 横图：左右排超宽，上下叠正好 —— 上限必须是 2 张
  const imgs = [mk('a', 7952, 5304), mk('b', 7952, 5304)];
  const r = packCanvas(imgs, { limit: 12000, gutter: 24 });
  ok(r.placed.length === 2, '42MP 横图 2 张全部放下', `${r.width}×${r.height} · ${r.strategy}`);
  ok(r.width <= 12000 && r.height <= 12000, '画布未超 12000 单边', `${r.width}×${r.height}`);
  ok(r.placed.every((p) => p.w === 7952 && p.h === 5304), '每张都是 1:1 原尺寸（未缩放）');

  const three = packCanvas([mk('a', 7952, 5304), mk('b', 7952, 5304), mk('c', 7952, 5304)], { limit: 12000, gutter: 24 });
  ok(three.placed.length === 2, '42MP 横图塞不下第 3 张（这是数学，不是 bug）', `实际放下 ${three.placed.length}`);
}

{
  // 24MP 6000×4000 应该能放 6 张填满 12000×12000
  const imgs = Array.from({ length: 6 }, (_, i) => mk('i' + i, 6000, 4000));
  const r = packCanvas(imgs, { limit: 12000, gutter: 0 });
  ok(r.placed.length === 6, '24MP 横图 6 张全部放下', `${r.width}×${r.height} · ${r.strategy}`);
  ok(r.width <= 12000 && r.height <= 12000, '画布未超限', `${r.width}×${r.height}`);
}
{
  // 超限的图要能识别出来
  const r = packCanvas([mk('huge', 13000, 8000), mk('ok', 3000, 2000)], { limit: 12000, gutter: 24 });
  ok(r.skipped.length === 1 && r.skipped[0].id === 'huge', '单张就超 12000 的图被单独标记为无法处理');
}
{
  // 分组：10 张 42MP → 应该分成 5 个画布
  const imgs = Array.from({ length: 10 }, (_, i) => mk('g' + i, 7952, 5304));
  const plan = planGroups(imgs, { limit: 12000, gutter: 24 });
  ok(plan.canvases.length === 5, '10 张 42MP 自动分成 5 个画布', plan.canvases.map((c) => `${c.width}×${c.height}`).join(' | '));
  ok(plan.canvases.every((c) => c.placed.length === 2), '每个画布 2 张');
  ok(plan.canvases.every((c) => { try { assertNoOverlap(c.placed); return true; } catch { return false; } }), '所有画布内无重叠');
}
{
  // 混尺寸走货架打包
  const imgs = [mk('a', 7952, 5304), mk('b', 4000, 3000), mk('c', 4000, 3000), mk('d', 3000, 4000)];
  const r = packCanvas(imgs, { limit: 12000, gutter: 24 });
  ok(r.placed.length >= 3, '混尺寸能装下 3 张以上', `${r.placed.length} 张 · ${r.strategy} · ${r.width}×${r.height}`);
  ok(r.width <= 12000 && r.height <= 12000, '混尺寸画布未超限');
}

// ─────────────────────── 2. 造带 EXIF 的源图 ───────────────────────
H('② 造素材：两张带 EXIF 的 JPG');

const srcA = path.join(TMP, 'DSC01234.jpg');
const srcB = path.join(TMP, 'DSC01235.jpg');
for (const [f, base, tag] of [[srcA, [200, 120, 80], 'A'], [srcB, [80, 130, 200], 'B']]) {
  await sharp({ create: { width: 1400, height: 934, channels: 3, background: { r: base[0], g: base[1], b: base[2] } } })
    .composite([{
      input: Buffer.from(`<svg width="1400" height="934"><rect x="0" y="0" width="1400" height="934" fill="none"/>
        <circle cx="700" cy="420" r="240" fill="#e8b46a"/>
        <rect x="60" y="60" width="300" height="120" fill="#fff"/>
        <text x="80" y="140" font-size="70" font-family="Helvetica" fill="#000">${tag}</text></svg>`),
      top: 0, left: 0,
    }])
    .withExif({
      IFD0: { Make: 'Canon', Model: 'EOS R5', Copyright: `Photographer ${tag}`, Software: 'PixCakeTiler' },
      IFD2: { LensModel: 'RF24-70mm F2.8 L IS USM', ISO: '400', FNumber: '28/10', ExposureTime: '1/200', FocalLength: '50/1' },
    })
    .jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
    .toFile(f);
}
const probeA = await probeImage(srcA);
const probeB = await probeImage(srcB);
ok(probeA.width === 1400 && probeA.height === 934, '识别尺寸正确', `${probeA.width}×${probeA.height}`);
ok(hasExif(fs.readFileSync(srcA)), '源图确实带 EXIF');

// ─────────────────────── 3. EXIF 搬运 ───────────────────────
H('③ EXIF 搬运（含摘除内嵌缩略图）');

{
  const raw = extractExif(fs.readFileSync(srcA));
  ok(!!raw && raw.subarray(0, 6).toString('latin1') === 'Exif\0\0', '能取出 EXIF 载荷');
  const before = exifReader(raw);
  ok(before.Image?.Model === 'EOS R5', '解析到 Model', before.Image?.Model);

  const cleaned = stripThumbnail(raw);
  const T = 6;
  const little = cleaned.readUInt16BE(T) === 0x4949;
  const ifd0 = T + (little ? cleaned.readUInt32LE(T + 4) : cleaned.readUInt32BE(T + 4));
  const count = little ? cleaned.readUInt16LE(ifd0) : cleaned.readUInt16BE(ifd0);
  const nextPtr = ifd0 + 2 + count * 12;
  const nextVal = little ? cleaned.readUInt32LE(nextPtr) : cleaned.readUInt32BE(nextPtr);
  ok(nextVal === 0, 'IFD0 的 next-IFD 指针已清零（缩略图被断开）', `nextIFD = ${nextVal}`);
  const after = exifReader(cleaned);
  ok(after.Image?.Model === 'EOS R5' && after.Photo?.ExposureTime === 0.005 && after.Photo?.FNumber === 2.8, '摘缩略图后其它标签完好', `快门=${after.Photo?.ExposureTime} 光圈=${after.Photo?.FNumber} 焦距=${after.Photo?.FocalLength}`);

  // 注入到一张无 EXIF 的图
  const plain = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .jpeg({ quality: 90 }).toBuffer();
  ok(!hasExif(plain), '目标图原本没有 EXIF');
  const injected = injectExif(plain, cleaned);
  const readBack = exifReader(extractExif(injected));
  ok(readBack.Image?.Model === 'EOS R5', '注入后能读回 Model', readBack.Image?.Model);
  ok(readBack.Photo?.LensModel?.includes('RF24-70'), '镜头信息保真', readBack.exif?.LensModel);
  ok(injected.length > plain.length, '文件变大（EXIF 段已插入）', `${plain.length} → ${injected.length}`);
}

// ─────────────────────── 4. 合成 ───────────────────────
H('④ 合成 TIFF（含镜像保护带）');

const layout = packCanvas(
  [{ id: 'a', name: 'DSC01234.jpg', width: probeA.width, height: probeA.height, path: srcA, probe: probeA, format: 'jpeg' },
   { id: 'b', name: 'DSC01235.jpg', width: probeB.width, height: probeB.height, path: srcB, probe: probeB, format: 'jpeg' }],
  { limit: 12000, gutter: 24 }
);

const canvasFile = path.join(TMP, 'TILE_batch01_test.tif');
const composed = await composeCanvas({
  items: layout.placed.map((p) => ({ source: p.source, probe: p.probe, crop: { left: p.x, top: p.y, width: p.w, height: p.h } })),
  width: layout.width, height: layout.height, gutter: 24,
  outFile: canvasFile, icc: 'srgb', compression: 'lzw',
});
const cmd = await sharp(canvasFile).metadata();
ok(cmd.width === layout.width && cmd.height === layout.height, '合成图尺寸正确', `${cmd.width}×${cmd.height}`);
ok(cmd.format === 'tiff', '输出是 TIFF');
ok(cmd.channels === 3, '输出是 3 通道 RGB（不带多余的 alpha）', `${cmd.channels} 通道`);

// 核心断言：合成图里的每一张必须与**解码后的原图**逐像素完全一致
{
  let worst = 0, worstName = '';
  for (const p of layout.placed) {
    const src = await sharp(p.source, { unlimited: true }).removeAlpha().raw().toBuffer();
    const pane = await sharp(canvasFile, { unlimited: true })
      .extract({ left: p.x, top: p.y, width: p.w, height: p.h })
      .removeAlpha().raw().toBuffer();
    let maxd = 0;
    for (let i = 0; i < src.length; i++) {
      const d = Math.abs(src[i] - pane[i]);
      if (d > maxd) maxd = d;
      if (maxd > worst) { worst = maxd; worstName = p.name; }
    }
  }
  ok(worst === 0, '合成图里每张都与原图逐像素完全一致（1:1 无损）',
    worst === 0 ? '最大偏差 0' : `最大偏差 ${worst}（${worstName}）`);
}
ok(composed.bytes > 0, '文件已写出', `${(composed.bytes / 1024).toFixed(0)} KB`);
ok(layout.width <= 12000 && layout.height <= 12000, '画布在 12000 约束内', `${layout.width}×${layout.height} · ${layout.strategy}`);
ok(layout.placed.every((p) => p.w === probeA.width && p.h === probeA.height), '每张都是 1:1 原尺寸');
{ let ov = false; try { assertNoOverlap(layout.placed); } catch { ov = true; } ok(!ov, '画布内无重叠'); }
{
  // 保护带必须是"两侧各自的边缘镜像"，不能是纯灰
  const vertical = layout.strategy.includes('x') && layout.height > layout.width;
  const line = vertical
    ? await sharp(canvasFile).extract({ left: 0, top: probeA.height + 12, width: 400, height: 1 }).raw().toBuffer()
    : await sharp(canvasFile).extract({ left: probeA.width + 12, top: 0, width: 1, height: 400 }).raw().toBuffer();
  const uniform = line.every((v, i) => i === 0 || v === line[0]);
  ok(!uniform, '保护带不是纯色（填的是镜像内容，不是灰底）', vertical ? '纵向保护带' : '横向保护带');
}

// ─────────────────────── 5. 切分（模拟像素蛋糕原样返回）───────────────────────
H('⑤ 切回原图 + EXIF 还原');

const manifest = {
  version: 1, id: 'test', name: 'batch01',
  canvas: { width: layout.width, height: layout.height },
  limit: 12000, gutter: 24, strategy: layout.strategy,
  items: layout.placed.map((p, i) => ({
    id: p.id, name: p.name, source: p.source, format: 'jpeg',
    natural: { width: p.w, height: p.h },
    crop: { left: p.x, top: p.y, width: p.w, height: p.h },
  })),
};

const outDir = path.join(TMP, 'split');
const rep = await splitCanvas({ returnedFile: canvasFile, manifest, outDir, format: 'jpeg', quality: 14, keepExif: true });

ok(rep.dimsMatch, '尺寸校验通过');
ok(rep.outputs.length === 2, '切出 2 张');
for (const o of rep.outputs) {
  const md = await sharp(o.file).metadata();
  ok(md.width === 1400 && md.height === 934, `${o.name} 尺寸还原到原图`, `${md.width}×${md.height}`);
  ok(o.lossless, `${o.name} 标记为无损`);
  const buf = fs.readFileSync(o.file);
  ok(hasExif(buf), `${o.name} 带回了 EXIF`);
  const p = exifReader(extractExif(buf));
  const expectTag = o.name.includes('1234') ? 'A' : 'B';
  ok(p.Image?.Copyright === `Photographer ${expectTag}`, `${o.name} EXIF 来自正确的原图`, p.Image?.Copyright);
  ok(p.Photo?.LensModel?.includes('RF24-70'), `${o.name} 数值型标签保真`, `快门=${p.Photo?.ExposureTime}s 光圈=${p.Photo?.FNumber}`);
}

// ─────────────────────── 6. 尺寸不符的兜底 ───────────────────────
H('⑥ 兜底：像素蛋糕如果改了尺寸怎么办');

{
  const scaledFile = path.join(TMP, 'scaled.tif');
  await sharp(canvasFile).resize(Math.round(cmd.width * 0.75), Math.round(cmd.height * 0.75))
    .tiff({ compression: 'lzw' }).toFile(scaledFile);
  const r2 = await splitCanvas({ returnedFile: scaledFile, manifest, outDir: path.join(TMP, 'split-scaled'), keepExif: false });
  ok(!r2.dimsMatch, '检出尺寸不符');
  ok(r2.warnings.some((w) => w.includes('75.00%')), '识别出等比缩放比例', r2.warnings[0]);
  ok(r2.outputs.length === 2, '仍然尽力切出了 2 张（按比例换算）');
}

{
  // 宽高比也变了 → 必须拒绝
  const weirdFile = path.join(TMP, 'weird.tif');
  await sharp(canvasFile).resize(Math.round(cmd.width * 0.8), Math.round(cmd.height * 0.5))
    .tiff({ compression: 'lzw' }).toFile(weirdFile);
  let threw = false;
  try { await splitCanvas({ returnedFile: weirdFile, manifest, outDir: path.join(TMP, 'split-weird') }); }
  catch { threw = true; }
  ok(threw, '宽高比改变时拒绝切分并报错（绝不猜着切）');
}

// ─────────────────────── 结果 ───────────────────────
H('结果');
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log(`  测试产物：${TMP}\n`);
process.exit(fail ? 1 : 0);
