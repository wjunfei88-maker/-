#!/usr/bin/env node
/**
 * M0 探针生成器
 *
 * 用法：
 *   # A) 计量图：合成两张 8192×5464 的仪器化面板（上下叠放），用来验证像素是否 1:1
 *   node tools/m0-generate.mjs metrology --panel 8192x5464 --gutter 24 --name probeA
 *
 *   # B) 人像图：把你两张真实照片 1:1 拼起来，用来验证多人脸识别 / AI 跨图串味
 *   node tools/m0-generate.mjs portrait --inputs inbox/a.jpg,inbox/b.jpg --gutter 24 --name probeB
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createPanel } from '../src/lib/panel.mjs';
import { compose, CANVAS_LIMIT } from '../src/lib/compose.mjs';
import { readRaw, writeTiff, probe } from '../src/lib/imageio.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'probes');

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      a[k] = v;
    } else a._.push(t);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const mode = args._[0] || 'metrology';
const name = typeof args.name === 'string' ? args.name : (mode === 'metrology' ? 'probeA' : 'probeB');
const gutter = args.gutter ? Number(args.gutter) : 24;
const layout = typeof args.layout === 'string' ? args.layout : 'stack';
const compression = typeof args.compression === 'string' ? args.compression : 'none';
const icc = typeof args.icc === 'string' ? args.icc : 'srgb';

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
const t0 = Date.now();

let panels;
let identity;

if (mode === 'metrology') {
  const [pw, ph] = String(args.panel || '8192x5464').toLowerCase().split('x').map(Number);
  console.log(`生成两张计量面板 ${pw}×${ph} …`);
  // 两块面板除背景亮度(128 vs 132)和随机种子外完全相同，
  // 这样事后可以判断"到底哪一半被改动了"。
  panels = [
    { ...createPanel(pw, ph, { tag: 0 }), source: 'synthetic:panelA' },
    { ...createPanel(pw, ph, { seed: 0x51ed270b, bg: 132, tag: 1 }), source: 'synthetic:panelB' },
  ];
  identity = { kind: 'metrology', panel: { width: pw, height: ph } };
} else if (mode === 'portrait') {
  if (typeof args.inputs !== 'string') {
    console.error('portrait 模式需要 --inputs a.jpg,b.jpg');
    process.exit(1);
  }
  const files = args.inputs.split(',').map((s) => s.trim()).filter(Boolean);
  panels = [];
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.join(ROOT, f);
    if (!fs.existsSync(abs)) { console.error('找不到文件：' + abs); process.exit(1); }
    const md = await probe(abs);
    console.log(`读入 ${path.basename(abs)}  ${md.width}×${md.height} ${md.format}`);
    const raw = await readRaw(abs);
    panels.push({ ...raw, source: abs });
  }
  identity = { kind: 'portrait', sources: files };
} else {
  console.error(`未知模式：${mode}`);
  process.exit(1);
}

const composed = compose(panels, { layout, gutter, limit: CANVAS_LIMIT });
const { data, width, height, manifest, warnings } = composed;

console.log(`\n画布：${width} × ${height}  (${(width * height / 1e6).toFixed(1)} MP，未压缩 ${mb(data.length)})`);
console.log(`上限：单边 ${CANVAS_LIMIT}px  →  宽 ${width <= CANVAS_LIMIT ? '✔' : '✘'}  高 ${height <= CANVAS_LIMIT ? '✔' : '✘'}`);
for (const w of warnings) console.log('⚠️  ' + w);

// 把每个面板内的特征换算成画布绝对坐标，供比对器使用
const features = [];
manifest.panels.forEach((p, pi) => {
  for (const f of panels[pi].features || []) {
    const out = { ...f, panelIndex: pi };
    if (f.rect) {
      out.rect = [f.rect[0] + p.crop.left, f.rect[1] + p.crop.top, f.rect[2], f.rect[3]];
    }
    if (f.points) {
      out.points = f.points.map(([x, y]) => [x + p.crop.left, y + p.crop.top]);
    }
    features.push(out);
  }
});

fs.mkdirSync(OUT, { recursive: true });

const base = path.join(OUT, name);
const variants = compression === 'both' ? ['none', 'lzw'] : [compression];
const files = [];
for (const comp of variants) {
  const file = comp === 'none' ? `${base}.tif` : `${base}.${comp}.tif`;
  process.stdout.write(`写 TIFF (${comp}) … `);
  await writeTiff({ data, width, height }, file, { compression: comp, icc });
  const sz = fs.statSync(file).size;
  files.push({ file, compression: comp, bytes: sz });
  console.log(mb(sz));
}

const full = {
  ...manifest,
  name,
  identity,
  features,
  files: files.map((f) => ({ file: path.relative(ROOT, f.file), compression: f.compression, bytes: f.bytes })),
  howToVerify: '使用 tools/m0-compare.mjs 切割并比对',
};
const mf = `${base}.manifest.json`;
fs.writeFileSync(mf, JSON.stringify(full, null, 2));
console.log(`写 manifest  ${path.relative(ROOT, mf)}  (${features.length} 个特征点)`);

// 预览图：让你不用打开 250MB 的大文件也能看清长什么样
const pv = `${base}.preview.jpg`;
await sharp(data, { raw: { width, height, channels: 3 }, unlimited: true })
  .resize({ width: 1400, withoutEnlargement: true })
  .jpeg({ quality: 88 })
  .toFile(pv);
console.log(`写预览图    ${path.relative(ROOT, pv)}`);

console.log(`\n完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`下一步：把 probes/${name}.tif 拖进像素蛋糕。`);
