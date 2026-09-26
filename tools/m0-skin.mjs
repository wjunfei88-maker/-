#!/usr/bin/env node
/**
 * 肤色平均实验：定量回答"像素蛋糕的全图自适应统计会不会把两张图拉向平均值"
 *
 * 实验设计（控制变量法）：
 *   用【同一张脸】做出两个版本 —— 正常版 与 暖亮版（模拟另一个人的肤色/另一种光线）。
 *   然后跑三次像素蛋糕，应用完全相同的一组功能：
 *     solo-N.tif   正常版单独一张     → 基准
 *     solo-W.tif   暖亮版单独一张     → 基准
 *     pair.tif     两版上下拼成一张   → 实验组
 *
 *   如果 pair 里的上半张 ≈ solo-N 的结果 → 没有平均，方案安全
 *   如果 pair 里的上半张被拉向暖亮版   → 证实"全图平均"，方案要改
 *
 * 用法：
 *   # 1) 生成三个文件
 *   node tools/m0-skin.mjs build --input inbox/face.jpg --name skin
 *   # 2) 三个文件都丢进像素蛋糕，应用【完全相同】的一组功能，各导出一次
 *   #    导出到 inbox/edited/
 *   # 3) 测量
 *   node tools/m0-skin.mjs measure --name skin \
 *        --solo-n inbox/edited/solo-N.tif \
 *        --solo-w inbox/edited/solo-W.tif \
 *        --pair   inbox/edited/pair.tif
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { readRaw, writeTiff } from '../src/lib/imageio.mjs';
import { srgbToLab, deltaE76 } from '../src/lib/metrics.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = { _: [] };
process.argv.slice(2).forEach((t, i, a) => {
  if (t.startsWith('--')) args[t.slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
  else args._.push(t);
});
const mode = args._[0];
const NAME = args.name || 'skin';
const PROBES = path.join(ROOT, 'probes');
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

/** 模拟"另一个人 / 另一种光线下"的肤色：整体提亮 + 偏暖 */
function gradePanel(src, brightness = 18, warm = 14) {
  const d = Buffer.from(src);
  const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let i = 0; i < d.length; i += 3) {
    d[i] = cl(d[i] + brightness + warm);
    d[i + 1] = cl(d[i + 1] + brightness);
    d[i + 2] = cl(d[i + 2] + brightness - warm);
  }
  return d;
}

/**
 * 皮肤像素检测 + 平均肤色。
 *
 * 注意：YCbCr 经典规则太宽松，会把"偏暖的中性灰"也判成皮肤（浅灰背景被整体调暖后就中招）。
 * 所以额外要求 R-B 有足够的暖差（真实肤色通常在 30~90，中性灰接近 0）。
 * 如果传了 --face 人脸框，则只在该框内统计，进一步排除背景干扰。
 */
export function skinStats(raw, rect, opts = {}) {
  const { minWarmth = 32 } = opts;
  const [x0, y0, w, h] = rect;
  let n = 0, sr = 0, sg = 0, sb = 0, total = 0;
  for (let y = y0; y < y0 + h; y += 2) {
    for (let x = x0; x < x0 + w; x += 2) {
      const i = (y * raw.width + x) * 3;
      const R = raw.data[i], G = raw.data[i + 1], B = raw.data[i + 2];
      total++;
      if (R - B < minWarmth) continue;                 // 排除中性灰与冷色
      const Y = 0.299 * R + 0.587 * G + 0.114 * B;
      const Cb = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B;
      const Cr = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B;
      if (Cr >= 133 && Cr <= 183 && Cb >= 75 && Cb <= 132 && Y > 50 && R > G && G >= B) {
        n++; sr += R; sg += G; sb += B;
      }
    }
  }
  if (!n) return { count: 0, coverage: 0, mean: null, lab: null };
  const mean = [sr / n, sg / n, sb / n];
  return { count: n, coverage: n / total, mean, lab: srgbToLab(mean) };
}

/** 解析 --face x,y,w,h */
function faceBox(spec, W, H) {
  if (typeof spec !== 'string') return null;
  const p = spec.split(',').map(Number);
  if (p.length !== 4 || p.some((v) => !isFinite(v))) return null;
  return [Math.max(0, p[0]), Math.max(0, p[1]), Math.min(p[2], W - p[0]), Math.min(p[3], H - p[1])];
}

if (mode === 'build') {
  if (typeof args.input !== 'string') { console.error('需要 --input <一张有人脸的照片>'); process.exit(1); }
  const src = path.isAbsolute(args.input) ? args.input : path.join(ROOT, args.input);
  if (!fs.existsSync(src)) { console.error('找不到：' + src); process.exit(1); }

  const raw = await readRaw(src);
  const { width: W, height: H, data } = raw;
  console.log(`输入 ${path.basename(src)}  ${W}×${H}  (${(W * H / 1e6).toFixed(1)} MP)`);

  const B = Number(args.brightness ?? 18), WM = Number(args.warm ?? 14);
  const graded = gradePanel(data, B, WM);

  // 拼图：上下两张，带镜像保护带
  const gutter = Number(args.gutter ?? 24);
  const CW = W, CH = H * 2 + gutter;
  if (CW > 12000 || CH > 12000) {
    console.error(`❌ 拼起来是 ${CW}×${CH}，超出像素蛋糕单边 12000px 上限。请先裁小一点。`);
    process.exit(1);
  }
  const canvas = Buffer.alloc(CW * CH * 3, 128);
  for (let y = 0; y < H; y++) {
    data.copy(canvas, y * CW * 3, y * W * 3, (y + 1) * W * 3);                    // 上半：正常版
  }
  const top2 = H + gutter;
  for (let y = 0; y < H; y++) {
    graded.copy(canvas, (top2 + y) * CW * 3, y * W * 3, (y + 1) * W * 3);         // 下半：暖亮版
  }
  // 保护带：两侧各自镜像自己的边缘像素，避免形变跨边界拉扯隔壁内容
  const half = Math.floor(gutter / 2);
  for (let i = 0; i < gutter; i++) {
    const srcY = i < half ? H - 2 - i : 1 + (gutter - 1 - i);
    const srcBuf = i < half ? data : graded;
    srcBuf.copy(canvas, (H + i) * CW * 3, srcY * W * 3, (srcY + 1) * W * 3);
  }

  fs.mkdirSync(PROBES, { recursive: true });
  const outs = [];
  for (const [tag, buf] of [['solo-N', data], ['solo-W', graded]]) {
    const f = path.join(PROBES, `${NAME}-${tag}.tif`);
    await writeTiff({ data: buf, width: W, height: H }, f, { compression: 'lzw' });
    outs.push([`${NAME}-${tag}.tif`, fs.statSync(f).size, `${W}×${H}`]);
  }
  const pf = path.join(PROBES, `${NAME}-pair.tif`);
  await writeTiff({ data: canvas, width: CW, height: CH }, pf, { compression: 'lzw' });
  outs.push([`${NAME}-pair.tif`, fs.statSync(pf).size, `${CW}×${CH}`]);

  // 预先算出三个基准面板的肤色，存进 manifest
  const FB = faceBox(args.face, W, H);
  const boxIn = FB || [0, 0, W, H];
  const baseN = skinStats({ data, width: W }, boxIn);
  const baseW = skinStats({ data: graded, width: W }, boxIn);
  const manifest = {
    name: NAME, width: W, height: H, gutter, canvas: { width: CW, height: CH },
    grade: { brightness: B, warm: WM },
    faceBox: FB,
    panels: [
      { index: 0, role: 'solo-N（正常版）', crop: { left: 0, top: 0, width: W, height: H }, baselineSkin: baseN },
      { index: 1, role: 'solo-W（暖亮版）', crop: { left: 0, top: H + gutter, width: W, height: H }, baselineSkin: baseW },
    ],
    files: outs.map(([f, bytes, dim]) => ({ file: `probes/${f}`, bytes, dim })),
  };
  fs.writeFileSync(path.join(PROBES, `${NAME}.skin.json`), JSON.stringify(manifest, null, 2));

  console.log('\n生成完毕：');
  for (const [f, bytes, dim] of outs) console.log(`  probes/${f.padEnd(22)} ${dim.padStart(12)}  ${mb(bytes)}`);
  console.log(`\n基准肤色（检测到的皮肤像素平均色）：`);
  console.log(`  正常版  RGB ${baseN.mean ? baseN.mean.map((v) => v.toFixed(1)).join(',') : '未检测到'}   覆盖 ${(baseN.coverage * 100).toFixed(1)}%`);
  console.log(`  暖亮版  RGB ${baseW.mean ? baseW.mean.map((v) => v.toFixed(1)).join(',') : '未检测到'}   覆盖 ${(baseW.coverage * 100).toFixed(1)}%`);
  if (baseN.lab && baseW.lab) {
    console.log(`  两版之间的肤色差：ΔE76 = ${deltaE76(baseN.mean, baseW.mean)}  ← 这就是"平均"要抹平的差距`);
  }
  console.log(`\n下一步：把这三个文件都丢进像素蛋糕，应用【完全相同】的一组功能（重点测「肤色统一」「AI色彩」），`);
  console.log(`        各导出一次 TIFF 到 inbox/edited/，然后跑 measure。`);
} else if (mode === 'measure') {
  const mf = path.join(PROBES, `${NAME}.skin.json`);
  if (!fs.existsSync(mf)) { console.error('先跑 build'); process.exit(1); }
  const M = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const need = { 'solo-n': `${NAME}-solo-N.tif`, 'solo-w': `${NAME}-solo-W.tif`, pair: `${NAME}-pair.tif` };
  const got = {};
  for (const [k, dflt] of Object.entries(need)) {
    const v = typeof args[k] === 'string' ? args[k] : `inbox/edited/${dflt}`;
    const p = path.isAbsolute(v) ? v : path.join(ROOT, v);
    if (!fs.existsSync(p)) { console.error(`找不到 ${k}: ${path.relative(ROOT, p)}`); process.exit(1); }
    got[k] = p;
  }
  const soloN = await readRaw(got['solo-n']);
  const soloW = await readRaw(got['solo-w']);
  const pair = await readRaw(got.pair);

  const full = (raw) => [0, 0, raw.width, raw.height];
  const p0 = M.panels[0].crop, p1 = M.panels[1].crop;
  const FB = M.faceBox;
  // solo 文件是独立的整图，人脸框用原坐标；pair 文件里下半张要加上面板偏移
  const afterSoloN = skinStats(soloN, FB || full(soloN));
  const afterSoloW = skinStats(soloW, FB || full(soloW));
  const afterPairN = skinStats(pair, FB
    ? [FB[0] + p0.left, FB[1] + p0.top, FB[2], FB[3]]
    : [p0.left, p0.top, p0.width, p0.height]);
  const afterPairW = skinStats(pair, FB
    ? [FB[0] + p1.left, FB[1] + p1.top, FB[2], FB[3]]
    : [p1.left, p1.top, p1.width, p1.height]);

  const fmt = (s) => (s.mean ? s.mean.map((v) => v.toFixed(1)).join(', ') : '未检测到');
  const de = (a, b) => (a.mean && b.mean ? deltaE76(a.mean, b.mean) : NaN);

  console.log('\n════════════════════════════════════════════════════════════');
console.log('   肤色平均实验 · 结果');
  console.log('════════════════════════════════════════════════════════════\n');
  console.log('【基准】单独一张处理后的肤色：');
  console.log(`  正常版单独处理   RGB ${fmt(afterSoloN)}`);
  console.log(`  暖亮版单独处理   RGB ${fmt(afterSoloW)}`);
  console.log(`  → 单独处理时两版的肤色差 ΔE76 = ${de(afterSoloN, afterSoloW).toFixed(2)}\n`);

  console.log('【实验组】拼在一张画布上处理后的肤色：');
  console.log(`  上半（正常版）   RGB ${fmt(afterPairN)}`);
  console.log(`  下半（暖亮版）   RGB ${fmt(afterPairW)}`);
  console.log(`  → 拼图处理时两版的肤色差 ΔE76 = ${de(afterPairN, afterPairW).toFixed(2)}\n`);

  const driftN = de(afterSoloN, afterPairN);
  const driftW = de(afterSoloW, afterPairW);
  const shrink = de(afterSoloN, afterSoloW) - de(afterPairN, afterPairW);

  console.log('【判定】拼图 vs 单独，同一张脸的结果差了多少：');
  console.log(`  正常版被改变了  ΔE76 = ${driftN.toFixed(2)}`);
  console.log(`  暖亮版被改变了  ΔE76 = ${driftW.toFixed(2)}`);
  console.log(`  两版差距缩小了  ΔE76 = ${shrink.toFixed(2)}  ← 正值表示确实被"往中间拉"了\n`);

  const verdict = shrink < 1.5 && Math.max(driftN, driftW) < 2
    ? '✅ 没有全图平均：拼图处理的结果与单独处理基本一致 → 方案安全'
    : shrink > 3 || Math.max(driftN, driftW) > 3
      ? '❌ 存在明显的全图平均：拼图会改变每一张成片的效果 → 需要改方案'
      : '⚠️ 存在轻微影响：建议只用逐人脸功能，或缩小单张拼图数量';
  console.log(verdict);
  console.log('\n建议同时用眼睛对比三张成片——尤其看拼图那张的肤色和你单独修的那张是否一致。\n');
} else {
  console.error('用法：\n  node tools/m0-skin.mjs build --input inbox/face.jpg --name skin\n  node tools/m0-skin.mjs measure --name skin');
  process.exit(1);
}
