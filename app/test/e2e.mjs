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

import { planGroups, packCanvas, assertNoOverlap, capacityExplain } from '../main/services/layout.mjs';
import { composeCanvas } from '../main/services/render.mjs';
import { splitCanvas } from '../main/services/split.mjs';
import { extractExif, stripThumbnail, injectExif, hasExif, normalizeOrientation } from '../main/services/exif.mjs';
import { probeImage } from '../main/services/library.mjs';
import {
  findFreeSpot, snapPosition, tightBounds, validateCanvas, tooClose, asRect, overlaps,
} from '../renderer/src/lib/geom.js';

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

// ─────────────────────── 7. 排版 v2：混横竖 + 旋转 + 全局最优 ───────────────────────
H('⑦ 排版 v2：混横竖装箱 · 可旋转 · 全局最少画布数');

{
  const M4L = (i) => mk('L' + i, 7008, 4672);      // A7M4 横
  const M4P = (i) => mk('P' + i, 4672, 7008);      // A7M4 竖

  // 同尺寸网格只能 2 张，横竖混搭能到 3 张 —— 这是 v2 的核心增益
  const two = packCanvas([M4L(0), M4L(1)], { limit: 12000, gutter: 24 });
  ok(two.placed.length === 2, 'A7M4 两张横图 2 张（同尺寸上限）', `${two.width}×${two.height}`);

  const three = packCanvas([M4L(0), M4P(0), M4P(1)], { limit: 12000, gutter: 24 });
  ok(three.placed.length === 3, 'A7M4 混横竖能放进 3 张', `${three.width}×${three.height} · ${three.strategy}`);
  ok(three.width <= 12000 && three.height <= 12000, '混横竖画布未超限', `${three.width}×${three.height}`);
  { let ov = false; try { assertNoOverlap(three.placed); } catch { ov = true; } ok(!ov, '混横竖摆放无重叠'); }

  const four = packCanvas([M4L(0), M4L(1), M4P(0), M4P(1)], { limit: 12000, gutter: 24 });
  ok(four.placed.length === 3, 'A7M4 4 张放不下（上限就是 3，几何决定）', `实际放下 ${four.placed.length}`);

  const r3 = packCanvas([mk('a', 7952, 5304), mk('b', 5304, 7952), mk('c', 5304, 7952)], { limit: 12000, gutter: 24 });
  ok(r3.placed.length === 2, 'A7R 42MP 混横竖也最多 2 张', `实际放下 ${r3.placed.length}`);
}

{
  const M4L = (i) => mk('L' + i, 7008, 4672);
  const M4P = (i) => mk('P' + i, 4672, 7008);
  const mixed = planGroups([...Array.from({ length: 20 }, (_, i) => M4L(i)), ...Array.from({ length: 20 }, (_, i) => M4P(i))],
    { limit: 12000, gutter: 24 });
  const allL = planGroups(Array.from({ length: 40 }, (_, i) => M4L(i)), { limit: 12000, gutter: 24 });

  ok(mixed.canvases.length < allL.canvases.length, '混横竖比全横显著更省画布',
    `混 ${mixed.canvases.length} 张（省 ${(100 - mixed.canvases.length / 40 * 100).toFixed(0)}%）vs 全横 ${allL.canvases.length} 张（省 ${(100 - allL.canvases.length / 40 * 100).toFixed(0)}%）`);
  ok(mixed.canvases.reduce((s, c) => s + c.placed.length, 0) === 40, '混横竖没有丢图');
  { let bad = 0; for (const c of mixed.canvases) { try { assertNoOverlap(c.placed); } catch { bad++; } } ok(bad === 0, '混横竖每张画布都无重叠'); }
  ok(mixed.canvases.every((c) => c.width <= 12000 && c.height <= 12000), '混横竖每张画布都未超限');
  ok(allL.canvases.every((c) => c.placed.every((p) => (p.rotation ?? 0) === 0)), '默认不旋转任何照片');

  const rot = planGroups(Array.from({ length: 40 }, (_, i) => M4L(i)), { limit: 12000, gutter: 24, allowRotate: true });
  ok(rot.canvases.length < allL.canvases.length, '允许 90° 旋转后画布数进一步下降',
    `${allL.canvases.length} → ${rot.canvases.length} 张`);
  const rotCount = rot.canvases.reduce((s, c) => s + c.placed.filter((p) => p.rotation === 90).length, 0);
  ok(rotCount > 0, '确实有照片被旋转', `${rotCount} 张`);
  ok(rot.canvases.every((c) => c.placed.every((p) => p.rotation !== 90 || (p.w === p.natural.height && p.h === p.natural.width))),
    '旋转的照片严格宽高互换（整数像素重排 = 无损）');
  ok(rot.canvases.every((c) => c.placed.every((p) => p.w * p.h === p.natural.width * p.natural.height)),
    '旋转没有改变像素总数');
}

{
  const cap = capacityExplain([{ id: 'x', width: 7952, height: 5304 }], 12000, 24);
  ok(cap.max === 2, '容量说明：42MP 一张画布上限 2 张', `max=${cap.max}`);
  ok(cap.rows.some((r) => r.ok) && cap.rows.some((r) => !r.ok),
    '容量说明同时列出"放得下"和"差多少"两种摆法', cap.rows.map((r) => r.text.replace(/ /g, '') + (r.ok ? '✔' : '✘')).join(' '));
  const cap24 = capacityExplain([{ id: 'x', width: 6000, height: 4000 }], 12000, 24);
  ok(cap24.max === 2, '容量说明诚实反映保护带的代价：6000×4000 留 24px 缝时只能 2 张（缝为 0 才能 6 张）', `max=${cap24.max}`);
}

// ─────────────────────── 8. 拖动落点几何 ───────────────────────
H('⑧ 拖动：跟手 + 松手自动找空位 + 画布可长大');

{
  const others = [{ id: 'a', x: 0, y: 0, w: 1000, h: 800 }];
  const size = { width: 500, height: 400 };
  const origin = { x: 0, y: 0 };

  const legal = findFreeSpot({ x: 2000, y: 2000 }, size, others, 12000, 24, origin);
  ok(legal.x === 2000 && legal.y === 2000 && !legal.moved, '合法落点原样保留（不再被硬推挤）', `(${legal.x},${legal.y})`);

  const blocked = findFreeSpot({ x: 200, y: 200 }, size, others, 12000, 24, origin);
  ok(!blocked.failed, '落在别人身上时能找到替代位置');
  const bx = asRect({ x: blocked.x, y: blocked.y, w: size.width, h: size.height });
  ok(!overlaps(bx, asRect(others[0])), '替代位置不与别人重叠', `(${blocked.x},${blocked.y})`);
  ok(!tooClose(bx, asRect(others[0]), 24), '替代位置留足了保护带', `(${blocked.x},${blocked.y})`);

  const far = findFreeSpot({ x: 9000, y: 9000 }, size, others, 12000, 24, origin);
  ok(far.x === 9000 && far.y === 9000, '把图拖到远处（画布随之长大）不被拦', `(${far.x},${far.y})`);

  const clamped = findFreeSpot({ x: 99999, y: 99999 }, size, others, 12000, 24, origin);
  ok(clamped.x + size.width <= 12000 && clamped.y + size.height <= 12000,
    '落点被限制在 12000 单边上限内', `(${clamped.x},${clamped.y})`);

  const near = findFreeSpot({ x: 1004, y: 0 }, size, others, 12000, 24, origin);
  ok(!tooClose(asRect({ x: near.x, y: near.y, w: size.width, h: size.height }), asRect(others[0]), 24),
    '贴着别人放会被挪到留出保护带的位置', `(${near.x},${near.y})`);

  // 真的挤满时：宁可不动，也绝不留下重叠
  const full = Array.from({ length: 3 }, (_, i) => ({ id: 'f' + i, x: i * 4024, y: 0, w: 4000, h: 11976 }));
  const noRoom = findFreeSpot({ x: 100, y: 100 }, { width: 4000, height: 11976 }, full, 12000, 24, { x: 0, y: 0 });
  ok(noRoom.failed, '实在没地方时明确报告失败（不静默留下重叠）', `(${noRoom.x},${noRoom.y}) failed=${noRoom.failed}`);

  const tb = tightBounds([{ x: 0, y: 0, w: 100, h: 50 }, { x: 200, y: 80, w: 100, h: 50 }]);
  ok(tb.width === 300 && tb.height === 130, '画布尺寸 = 内容紧包围盒（拖动后跟着变）', `${tb.width}×${tb.height}`);

  const snapped = snapPosition({ x: 3, y: 1000 }, size, others, 12000, 20, 24);
  ok(snapped.x === 0, '靠近边缘时轻微吸附到 0', `x=${snapped.x}`);

  const probs = validateCanvas([
    { id: 'a', x: 0, y: 0, width: 100, height: 100 },
    { id: 'b', x: 50, y: 50, width: 100, height: 100 },
  ], 24);
  ok(probs.some((p) => p.type === 'overlap'), '重叠能被检出并阻止导出');
}

// ─────────────────────── 9. 旋转往返：合成 → 切分 ───────────────────────
H('⑨ 旋转 90° 排版：合成后必须能原样转回来');

{
  const rotSrc = path.join(TMP, 'rot-src.jpg');
  await sharp({ create: { width: 1000, height: 600, channels: 3, background: { r: 30, g: 90, b: 160 } } })
    .composite([{
      input: Buffer.from('<svg width="1000" height="600"><rect x="40" y="40" width="300" height="120" fill="#fff"/><circle cx="700" cy="400" r="150" fill="#e8b46a"/></svg>'),
      top: 0, left: 0,
    }])
    .jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toFile(rotSrc);
  const rp = await probeImage(rotSrc);

  const rotCanvas = path.join(TMP, 'TILE_rot.tif');
  await composeCanvas({
    items: [{ source: rotSrc, probe: rp, rotation: 90, crop: { left: 0, top: 0, width: rp.height, height: rp.width } }],
    width: rp.height, height: rp.width, gutter: 24, outFile: rotCanvas, icc: 'srgb', compression: 'lzw',
  });
  const rm = await sharp(rotCanvas).metadata();
  ok(rm.width === rp.height && rm.height === rp.width, '画布里的这张是宽高互换的', `${rm.width}×${rm.height}`);

  const rotManifest = {
    version: 2, canvas: { width: rm.width, height: rm.height }, gutter: 24,
    items: [{
      id: 'r1', name: 'rot-src.jpg', source: rotSrc, format: 'jpeg', rotation: 90,
      natural: { width: rp.width, height: rp.height },
      crop: { left: 0, top: 0, width: rp.height, height: rp.width },
    }],
  };
  const rotOut = path.join(TMP, 'split-rot');
  const rrep = await splitCanvas({ returnedFile: rotCanvas, manifest: rotManifest, outDir: rotOut, format: 'tiff', keepExif: false });
  const backFile = path.join(rotOut, 'rot-src.tif');
  const om = await sharp(backFile, { unlimited: true }).metadata();
  ok(om.width === rp.width && om.height === rp.height, '切分时自动转回原朝向', `${om.width}×${om.height}`);
  ok(rrep.outputs[0].lossless, '旋转切分仍判定为无损', rrep.outputs[0].size);

  // 像素级：转回来的必须和原图逐像素一致（TIFF 输出，无重编码损失）
  const origRaw = await sharp(rotSrc, { unlimited: true }).removeAlpha().raw().toBuffer();
  const backRaw = await sharp(backFile, { unlimited: true }).removeAlpha().raw().toBuffer();
  let maxd = 0;
  for (let i = 0; i < origRaw.length; i++) { const d = Math.abs(origRaw[i] - backRaw[i]); if (d > maxd) maxd = d; }
  ok(maxd === 0, '旋转往返后逐像素完全一致（旋转是整数像素重排）', `最大偏差 ${maxd}`);
}

// ─────────────────────── 10. EXIF 朝向：竖拍照片不能躺倒 ───────────────────────
H('⑩ EXIF 朝向：导入烤平后必须把 Orientation 归一到 1');

/** 手工构造 EXIF 载荷（sharp 的 withExif 会强制覆盖 Orientation，造不出竖拍样本） */
function exifWith(orientation, make = 'Sony') {
  const T = 6;
  const makeBytes = Buffer.from(make + '\0', 'latin1');
  const entries = [
    { tag: 0x010f, type: 2, count: makeBytes.length, data: makeBytes },
    { tag: 0x0112, type: 3, count: 1, inline: orientation },
  ].sort((a, b) => a.tag - b.tag);
  const n = entries.length;
  const ifdOffset = 8;
  const ifdSize = 2 + n * 12 + 4;
  const buf = Buffer.alloc(T + ifdOffset + ifdSize + makeBytes.length);
  buf.write('Exif\0\0', 0, 'latin1');
  buf.write('II', T, 'latin1');
  buf.writeUInt16LE(42, T + 2);
  buf.writeUInt32LE(ifdOffset, T + 4);
  const ifd = T + ifdOffset;
  buf.writeUInt16LE(n, ifd);
  let dp = T + ifdOffset + ifdSize;
  entries.forEach((e, i) => {
    const o = ifd + 2 + i * 12;
    buf.writeUInt16LE(e.tag, o);
    buf.writeUInt16LE(e.type, o + 2);
    buf.writeUInt32LE(e.count, o + 4);
    if (e.inline != null) buf.writeUInt16LE(e.inline, o + 8);
    else { buf.writeUInt32LE(dp - T, o + 8); e.data.copy(buf, dp); dp += e.data.length; }
  });
  buf.writeUInt32LE(0, ifd + 2 + n * 12);
  return buf;
}

{
  const base = await sharp({ create: { width: 800, height: 534, channels: 3, background: { r: 200, g: 120, b: 80 } } })
    .jpeg({ quality: 94 }).toBuffer();
  const portrait = path.join(TMP, 'portrait.jpg');
  fs.writeFileSync(portrait, injectExif(base, exifWith(6)));

  const pp = await probeImage(portrait);
  ok(pp.orientation === 6 && pp.width === 534 && pp.height === 800,
    '导入时识别为竖拍并互换宽高', `${pp.width}×${pp.height} orientation=${pp.orientation}`);

  const direct = normalizeOrientation(extractExif(fs.readFileSync(portrait)), 1);
  ok(exifReader(direct).Image?.Orientation === 1, 'normalizeOrientation 把朝向改成 1');
  ok(exifReader(direct).Image?.Make === 'Sony', '归一朝向不影响其它标签', exifReader(direct).Image?.Make);

  const pf = path.join(TMP, 'TILE_portrait.tif');
  await composeCanvas({
    items: [{ source: portrait, probe: pp, rotation: 0, crop: { left: 0, top: 0, width: pp.width, height: pp.height } }],
    width: pp.width, height: pp.height, gutter: 24, outFile: pf, icc: 'srgb', compression: 'lzw',
  });
  const pManifest = {
    version: 2, canvas: { width: pp.width, height: pp.height }, gutter: 24,
    items: [{
      id: 'p1', name: 'portrait.jpg', source: portrait, format: 'jpeg', rotation: 0,
      natural: { width: pp.width, height: pp.height },
      crop: { left: 0, top: 0, width: pp.width, height: pp.height },
    }],
  };
  const pOut = path.join(TMP, 'split-portrait');
  await splitCanvas({ returnedFile: pf, manifest: pManifest, outDir: pOut, format: 'jpeg', quality: 14, keepExif: true });
  const outFile = path.join(pOut, 'portrait.jpg');
  const oExif = exifReader(extractExif(fs.readFileSync(outFile)));
  const omd = await sharp(outFile).metadata();
  ok((oExif.Image?.Orientation ?? 1) === 1,
    '搬回 EXIF 时朝向已归一到 1（否则访达/微信会再转一次，竖拍照片躺倒）', `Orientation=${oExif.Image?.Orientation ?? 1}`);
  ok(omd.width === pp.width && omd.height === pp.height, '输出像素尺寸与原图一致', `${omd.width}×${omd.height}`);
  ok(oExif.Image?.Make === 'Sony', '朝向归一后其它 EXIF 仍然保真', oExif.Image?.Make);
}

// ─────────────────────── 结果 ───────────────────────
H('结果');
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log(`  测试产物：${TMP}\n`);
process.exit(fail ? 1 : 0);
