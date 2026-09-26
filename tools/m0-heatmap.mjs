#!/usr/bin/env node
/**
 * 差异热力图：把"像素蛋糕到底改了哪里"可视化出来
 *
 * 用法：
 *   node tools/m0-heatmap.mjs --name probeR5 --returned inbox/edited/probeR5.tif
 *   node tools/m0-heatmap.mjs --name probeR5 --returned inbox/edited/probeR5.tif --cell 256
 *
 * 输出：终端里的字符热力图 + probes/<name>.heatmap.png（可直接打开看）
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { readRaw } from '../src/lib/imageio.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = {};
process.argv.slice(2).forEach((t, i, a) => {
  if (t.startsWith('--')) args[t.slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
});

const name = args.name || 'probeR5';
const M = JSON.parse(fs.readFileSync(path.join(ROOT, 'probes', `${name}.manifest.json`), 'utf8'));
const CELL = Number(args.cell || 128);

const origRel = M.files.filter((f) => f.compression === 'none')[0]?.file || M.files[0].file;
const origPath = path.join(ROOT, origRel);
const retPath = path.isAbsolute(args.returned) ? args.returned : path.join(ROOT, args.returned);

const [O, R] = [await readRaw(origPath), await readRaw(retPath)];
if (O.width !== R.width || O.height !== R.height) {
  console.error(`尺寸不一致：${O.width}×${O.height} vs ${R.width}×${R.height}，无法做热力图`);
  process.exit(2);
}

const cols = Math.ceil(O.width / CELL);
const rows = Math.ceil(O.height / CELL);

// 逐格计算平均绝对差（同时对两边做格内均值，避免把压缩噪声当成结构差异）
const grid = Array.from({ length: rows }, () => new Float64Array(cols));
const gridO = Array.from({ length: rows }, () => new Float64Array(cols));
const gridR = Array.from({ length: rows }, () => new Float64Array(cols));

for (let y = 0; y < O.height; y++) {
  const cy = Math.floor(y / CELL);
  for (let x = 0; x < O.width; x++) {
    const cx = Math.floor(x / CELL);
    const i = (y * O.width + x) * 3;
    const a = (O.data[i] + O.data[i + 1] + O.data[i + 2]) / 3;
    const b = (R.data[i] + R.data[i + 1] + R.data[i + 2]) / 3;
    grid[cy][cx] += Math.abs(a - b);
    gridO[cy][cx] += a;
    gridR[cy][cx] += b;
  }
}

let gmax = 0;
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const n = CELL * CELL;
    grid[r][c] /= n; gridO[r][c] /= n; gridR[r][c] /= n;
    if (grid[r][c] > gmax) gmax = grid[r][c];
  }
}

console.log(`\n差异热力图  ${name}  格子 ${CELL}px  (${cols}×${rows})   最大格均值 ${gmax.toFixed(1)}/255`);
console.log(`画布 ${O.width}×${O.height}   面板分界 y=${M.panels[1]?.crop.top ?? '-'}  保护带 ${M.gutter}px`);
console.log();

const RAMP = ' .:-=+*#%@';
const legend = (v) => RAMP[Math.min(RAMP.length - 1, Math.round((v / Math.max(gmax, 1e-9)) * (RAMP.length - 1)))];

// 行标签（画布 y 坐标），左侧竖排
for (let r = 0; r < rows; r++) {
  const y = r * CELL;
  let line = String(y).padStart(6) + ' │';
  for (let c = 0; c < cols; c++) line += legend(grid[r][c]).repeat(1);
  const rowMax = Math.max(...grid[r]);
  line += `│ ${rowMax.toFixed(0).padStart(3)}`;
  // 标出面板分界
  if (M.panels[1] && y <= M.panels[1].crop.top && (r + 1) * CELL > M.panels[1].crop.top) {
    line += '  ← 面板0/1 分界（保护带）';
  }
  console.log(line);
}
console.log('      └' + '─'.repeat(cols) + '┘');
let xlab = '       ';
for (let c = 0; c < cols; c += 8) xlab += String(c * CELL).padEnd(8);
console.log(xlab);
console.log(`\n图例  ' '=0  .:-=+*#%@ 由浅到深   满格 = ${gmax.toFixed(0)}/255`);

// 输出 PNG 热力图：横轴=原图位置，颜色 = 差异强度（黑→红→黄→白）
const hm = Buffer.alloc(cols * rows * 3);
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const t = Math.min(1, grid[r][c] / Math.max(gmax, 1e-9));
    const i = (r * cols + c) * 3;
    // 简单 viridis-ish 渐变：黑 → 蓝 → 青 → 黄 → 白
    const stops = [[0, 0, 0], [30, 40, 140], [0, 160, 170], [250, 210, 60], [255, 255, 255]];
    const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    const f = t * (stops.length - 1) - seg;
    for (let k = 0; k < 3; k++) hm[i + k] = Math.round(stops[seg][k] + (stops[seg + 1][k] - stops[seg][k]) * f);
  }
}
const outPng = path.join(ROOT, 'probes', `${name}.heatmap.png`);
await sharp(hm, { raw: { width: cols, height: rows, channels: 3 } })
  .resize({ width: Math.min(1600, cols * 3), kernel: 'nearest' })
  .png()
  .toFile(outPng);
console.log(`\n热力图已存为 ${path.relative(ROOT, outPng)}（打开就能看到改动分布）`);

// 顺便给出"改动最集中的区域"摘要
const cells = [];
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ r, c, v: grid[r][c] });
cells.sort((a, b) => b.v - a.v);
console.log('\n改动最集中的 8 个格子：');
for (const cc of cells.slice(0, 8)) {
  console.log(`   x=${String(cc.c * CELL).padStart(5)}  y=${String(cc.r * CELL).padStart(5)}   格均值 ${cc.v.toFixed(1)}   原始亮度 ${gridO[cc.r][cc.c].toFixed(0)} → 返回 ${gridR[cc.r][cc.c].toFixed(0)}`);
}
const meanAll = cells.reduce((a, b) => a + b.v, 0) / cells.length;
const pct = (p) => cells[Math.floor(cells.length * p)].v;
console.log(`\n全图平均 ${meanAll.toFixed(2)}/255   中位格 ${pct(0.5).toFixed(2)}   p90 格 ${pct(0.1).toFixed(2)}   最高格 ${cells[0].v.toFixed(2)}`);
console.log();
