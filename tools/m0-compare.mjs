#!/usr/bin/env node
/**
 * M0 比对器
 *
 * 用法：
 *   # 第一轮：把像素蛋糕"原样导入原样导出"的结果拿来比对（不加任何效果）
 *   node tools/m0-compare.mjs --name probeA --returned inbox/probeA-roundtrip.tif
 *
 *   # 第二轮：只对上半张做美颜后导出，验证另一半有没有被"串味"
 *   node tools/m0-compare.mjs --name probeA --returned inbox/probeA-edited.tif --edited-panel 0
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  diffStats, cropRegion, regionMean, gratingContrast, meanAbsLaplacian,
  deltaE76, estimatePeriod, profileRow, profileCol,
} from '../src/lib/metrics.mjs';
import { readRaw, probe } from '../src/lib/imageio.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

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

// ── 自动找文件：不传 --returned 时，自动扫描 inbox 下最新的图片 ──
const IMG_RE = /\.(tif|tiff|png|jpg|jpeg)$/i;
function scanNewest(dirs) {
  const found = [];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (f.startsWith('.') || !IMG_RE.test(f)) continue;
      const p = path.join(abs, f);
      const st = fs.statSync(p);
      if (st.isFile()) found.push({ p, mtime: st.mtimeMs });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}

if (typeof args.returned !== 'string') {
  const cands = scanNewest(['inbox/roundtrip', 'inbox/edited', 'inbox']);
  if (!cands.length) {
    console.error('\n❌ inbox/ 里还没有图片。');
    console.error('   请先把像素蛋糕导出的文件放进  inbox/roundtrip/  再运行。\n');
    process.exit(1);
  }
  if (cands.length > 1) {
    console.log(`\nℹ️  找到 ${cands.length} 个文件，使用最新的一个：`);
    for (const c of cands.slice(0, 5)) console.log(`     ${path.relative(ROOT, c.p)}`);
  }
  args.returned = cands[0].p;
  console.log(`\nℹ️  自动选中：${path.relative(ROOT, args.returned)}`);
}

// ── 自动选 manifest：按画布尺寸匹配 ──
if (typeof args.name !== 'string') {
  const dir = path.join(ROOT, 'probes');
  const manifests = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.manifest.json'))
    : [];
  if (!manifests.length) { console.error('probes/ 里没有 manifest，先运行 m0-generate'); process.exit(1); }
  const retAbs = path.isAbsolute(args.returned) ? args.returned : path.join(ROOT, args.returned);
  const rmd = await probe(retAbs);
  let best = null;
  for (const f of manifests) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const exact = m.canvas.width === rmd.width && m.canvas.height === rmd.height;
    const ar = Math.abs((rmd.width / rmd.height) - (m.canvas.width / m.canvas.height));
    const score = exact ? -1 : ar;
    if (!best || score < best.score) best = { score, name: m.name, exact };
  }
  if (manifests.length > 1) {
    console.log(`ℹ️  自动匹配到探针：${best.name}${best.exact ? '（尺寸完全吻合）' : '（尺寸不吻合，仅按比例最接近推断）'}`);
  }
  args.name = best.name;
}

const name = typeof args.name === 'string' ? args.name : 'probeA';
const manifestPath = path.join(ROOT, 'probes', `${name}.manifest.json`);
if (!fs.existsSync(manifestPath)) { console.error('找不到 manifest：' + manifestPath); process.exit(1); }
const M = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const origRel = typeof args.original === 'string'
  ? args.original
  : M.files.filter((f) => f.compression === 'none')[0]?.file || M.files[0].file;const origPath = path.isAbsolute(origRel) ? origRel : path.join(ROOT, origRel);
if (typeof args.returned !== 'string') { console.error('需要 --returned <像素蛋糕导出的文件>'); process.exit(1); }
const retPath = path.isAbsolute(args.returned) ? args.returned : path.join(ROOT, args.returned);
if (!fs.existsSync(retPath)) { console.error('找不到文件：' + retPath); process.exit(1); }

const editedPanel = args['edited-panel'] !== undefined ? Number(args['edited-panel']) : null;
const { width: CW, height: CH } = M.canvas;

const line = (s = '') => console.log(s);
const H = (s) => { line(); line('─'.repeat(72)); line(s); line('─'.repeat(72)); };
const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 2) => (typeof v === 'number' ? v.toFixed(n) : String(v));

const report = { name, generatedAt: new Date().toISOString(), checks: [], verdict: [] };
const check = (id, ok, detail) => { report.checks.push({ id, ok, detail }); return ok; };

line(`\n🔬 M0 比对报告  —  ${name}`);
line(`  原始画布 : ${path.relative(ROOT, origPath)}  (${CW}×${CH})`);
line(`  返回文件 : ${path.relative(ROOT, retPath)}`);

// ───────────────────────── 1. 元信息 ─────────────────────────
const mdOrig = await probe(origPath);
const mdRet = await probe(retPath);
H('① 文件元信息');
line(`  ${pad('', 10)}${pad('原始', 22)}${pad('返回', 22)}`);
line(`  ${pad('格式', 10)}${pad(mdOrig.format, 22)}${pad(mdRet.format, 22)}`);
line(`  ${pad('尺寸', 10)}${pad(mdOrig.width + '×' + mdOrig.height, 22)}${pad(mdRet.width + '×' + mdRet.height, 22)}`);
line(`  ${pad('位深', 10)}${pad(mdOrig.depth, 22)}${pad(mdRet.depth, 22)}`);
line(`  ${pad('色彩空间', 10)}${pad(mdOrig.space, 22)}${pad(mdRet.space, 22)}`);
line(`  ${pad('ICC', 10)}${pad(mdOrig.iccName ?? '无', 22)}${pad(mdRet.iccName ?? '无', 22)}`);

const dimsMatch = mdRet.width === CW && mdRet.height === CH;
check('尺寸与导入时完全一致', dimsMatch,
  dimsMatch ? `${CW}×${CH} 逐像素对齐` : `返回 ${mdRet.width}×${mdRet.height}，期望 ${CW}×${CH}`);

if (!dimsMatch) {
  const rx = mdRet.width / CW, ry = mdRet.height / CH;
  line();
  line(`  ❌ 尺寸不一致：宽度比 ${num(rx, 6)}，高度比 ${num(ry, 6)}`);
  if (Math.abs(rx - ry) < 0.002 && Math.abs(rx - 1) > 0.002) {
    line(`     看起来像素蛋糕把整张图**等比缩放了 ${num(rx * 100, 2)}%** —— 这是最坏的情况，`);
    line(`     意味着每张子图都拿不到全分辨率。需要重新设计（输出端按比例放大 / 改用更大画布分组）。`);
  } else if (Math.abs(rx - 1) > 0.002 || Math.abs(ry - 1) > 0.002) {
    line(`     宽高比也变了，可能有裁切或补边。需要进一步定位。`);
  }
  report.verdict.push('FAIL: 尺寸不一致，后续像素比对无法进行');
  fs.writeFileSync(path.join(ROOT, 'probes', `${name}.report.json`), JSON.stringify(report, null, 2));
  process.exit(2);
}

line();
line('  ✔ 尺寸一致，继续做像素级比对。');

// ───────────────────────── 2. 读像素 ─────────────────────────
const [O, R] = [await readRaw(origPath), await readRaw(retPath)];
if (O.data.length !== R.data.length) { console.error('像素缓冲区长度不一致'); process.exit(2); }

/**
 * 局部对齐：先在特征块附近找一个最佳整数位移，再在位移后的位置度量。
 *
 * 为什么必须这样做：液化/AI液化会"移动内容"，而移动和"改色"是两码事。
 * 探针里的 1px 边框、1px 标尺、孤立亮点对亚像素位移极其敏感，
 * 不对齐就会把 0.9px 的位移误报成"色差 ΔE=220"。
 */
function bestAlign(rect, rad = 16, step = 2) {
  const [x, y, w, h] = rect;
  let best = { dx: 0, dy: 0, mad: Infinity }, zero = Infinity;
  for (let dy = -rad; dy <= rad; dy++) {
    for (let dx = -rad; dx <= rad; dx++) {
      let s = 0, n = 0;
      for (let yy = 0; yy < h; yy += step) {
        for (let xx = 0; xx < w; xx += step) {
          const i = ((y + yy) * O.width + (x + xx)) * 3;
          const j = ((y + yy + dy) * R.width + (x + xx + dx)) * 3;
          if (j < 0 || j + 2 >= R.data.length) continue;
          s += Math.abs(O.data[i] - R.data[j]) + Math.abs(O.data[i + 1] - R.data[j + 1]) + Math.abs(O.data[i + 2] - R.data[j + 2]);
          n += 3;
        }
      }
      const mad = n ? s / n : Infinity;
      if (dx === 0 && dy === 0) zero = mad;
      if (mad < best.mad) best = { dx, dy, mad };
    }
  }
  return { ...best, zero, gain: zero > 0 ? (1 - best.mad / zero) * 100 : 0 };
}
/** 把矩形按位移平移，用于在返回图上取值 */
const shiftRect = (rect, al) => [rect[0] + al.dx, rect[1] + al.dy, rect[2], rect[3]];

// ── 局部位移场：每一个特征块移动了多少 —— 这是"内容有没有被挪走"的直接证据 ──
H('⓪ 局部位移场（每个特征块被移动了多少像素）');
line('  位移 = 返回图相对原图的最佳整数位移。0/0 表示该特征完全没被碰过。');
line();
line(`  ${pad('特征', 14)}${pad('面板', 8)}${pad('位移 dx/dy', 14)}${pad('对齐前偏差', 14)}${pad('对齐后偏差', 14)}对齐收益`);
const shiftTable = [];
for (const pi of [0, 1]) {
  for (const k of ['rulerTop', 'rulerLeft', 'grating', 'impulse', 'flat', 'noise', 'wedge', 'colors', 'tag']) {
    const f = M.features.find((x) => x.kind === k && x.panelIndex === pi && x.rect);
    if (!f) continue;
    const al = bestAlign(f.rect);
    shiftTable.push({ kind: k, panel: pi, ...al });
    line(`  ${pad(k, 14)}${pad(pi, 8)}${pad(`${al.dx} / ${al.dy}`, 14)}${pad(num(al.zero, 2), 14)}${pad(num(al.mad, 2), 14)}${num(al.gain, 1)}%`);
  }
}
report.shiftTable = shiftTable;
/** 参与"未改动"判定的面板：指定了 --edited-panel 时，只判定没被编辑的那些 */
const judgePanelIdx = editedPanel !== null
  ? M.panels.map((p) => p.index).filter((i) => i !== editedPanel)
  : M.panels.map((p) => p.index);
const untouchedPanels = judgePanelIdx;
line();
line(`  ⚠️ 注意：探针里的 1px 边框 / 1px 标尺 / 孤立亮点是"位移放大器"，`);
line(`     它们对亚像素位移极其敏感。判断真实照片是否受损，要看下面的对齐后偏差。`);

// ───────────────────────── 3. 逐面板整体比对 ─────────────────────────
H('② 每个面板的整体像素差异');
const panelStats = [];
for (const p of M.panels) {
  const { left, top, width, height } = p.crop;
  const a = cropRegion(O, [left, top, width, height]).data;
  const b = cropRegion(R, [left, top, width, height]).data;
  const d = diffStats(a, b);
  panelStats.push({ index: p.index, ...d });
  const edited = editedPanel === p.index;
  const tag = edited ? '【本轮被美颜】' : (editedPanel === null ? '' : '【本轮未动】');
  line(`  面板 ${p.index} ${String(p.natural.width) + '×' + p.natural.height} ${tag}`);
  line(`     PSNR ${d.psnr === Infinity ? '∞ (逐像素完全一致)' : num(d.psnr) + ' dB'}   ` +
    `MAE ${num(d.mae, 4)}   最大偏差 ${d.max}   偏差>2 的样本 ${num(d.pctGt2, 3)}%`);
}
report.panelStats = panelStats;

if (editedPanel !== null) {
  const untouched = panelStats.filter((p) => p.index !== editedPanel).map((p) => p.index);
  // 用"低频特征 + 对齐后"判断真实损坏：灰度楔/色块/标记对应真实照片里的平滑区域，
  // 不像 1px 边框和光栅那样把亚像素位移放大成巨大差值。
  const lf = shiftTable.filter((s) => untouched.includes(s.panel) && ['wedge', 'colors', 'tag', 'flat'].includes(s.kind));
  const worstLf = lf.length ? Math.max(...lf.map((s) => s.mad)) : 0;
  const touched = shiftTable.filter((s) => untouched.includes(s.panel));
  const maxDisp = touched.length ? Math.max(...touched.map((s) => Math.max(Math.abs(s.dx), Math.abs(s.dy)))) : 0;
  const bleed = worstLf > 2.5 || maxDisp > 4;
  check('未编辑面板的内容未被改动', !bleed,
    `对齐后低频偏差 ${num(worstLf, 2)}/255，最大位移 ${maxDisp}px`);
  line();
  line(`  ℹ️ 上面第②节的原始 PSNR 之所以很低，是因为探针里有 1px 边框、1px 标尺、2px 光栅`);
  line(`     这类"位移放大器"。真实照片里没有这种内容，判断要以本节的低频指标为准。`);
} else {
  const worst = Math.min(...panelStats.map((p) => (p.psnr === Infinity ? 200 : p.psnr)));
  check('纯转存没有引入像素改动', worst > 60,
    `最差面板 PSNR ${num(worst)} dB${worst > 60 ? '（基本无损）' : '（有明显改动，检查是否误开了配色/裁剪）'}`);
}

// ───────────────────────── 4. 灵敏度特征 ─────────────────────────
H('③ 内部处理分辨率（看像素蛋糕有没有偷偷降采样）');
line('  光栅周期越小越容易被降采样抹掉。对比度 = p95-p5 亮度差，理想值 255。');
line();
line(`  ${pad('光栅周期', 12)}${pad('原始对比度', 14)}${pad('返回对比度', 14)}${pad('保留率', 12)}${pad('原始锐度', 12)}返回锐度`);
const gratings = M.features.filter((f) => f.kind === 'grating');
const gratingRows = [];
for (const g of gratings) {
  const c0 = gratingContrast(O, g.rect), c1 = gratingContrast(R, g.rect);
  const l0 = meanAbsLaplacian(O, g.rect), l1 = meanAbsLaplacian(R, g.rect);
  const keep = c0 ? c1 / c0 : 0;
  gratingRows.push({ period: g.period, c0, c1, keep });
  line(`  ${pad(g.period + ' px', 12)}${pad(c0, 14)}${pad(c1, 14)}${pad(num(keep * 100, 1) + '%', 12)}${pad(num(l0, 3), 12)}${num(l1, 3)}`);
}
const hiFreq = gratingRows.filter((r) => r.period <= 4);
const worstHi = Math.min(...hiFreq.map((r) => r.keep));
check('高频细节未被内部降采样抹掉', worstHi > 0.85,
  `周期≤4px 的光栅对比度保留率最低 ${num(worstHi * 100, 1)}%` +
  (worstHi > 0.85 ? '（全分辨率处理）' : '（内部疑似用低分辨率处理，子图细节会集体变糊）'));
report.gratings = gratingRows;

// 脉冲块：孤立单像素点最怕重采样
const impFeats = M.features.filter((f) => f.kind === 'impulse' && judgePanelIdx.includes(f.panelIndex));
if (impFeats.length) {
  let worstRatio = 1;
  for (const imp of impFeats) {
    const countBright = (raw) => {
      const r = cropRegion(raw, imp.rect);
      let n = 0;
      for (let i = 0; i < r.data.length; i += 3) if (r.data[i] > 200) n++;
      return n;
    };
    const n0 = countBright(O), n1 = countBright(R);
    const ratio = n0 ? n1 / n0 : 1;
    if (ratio < worstRatio) worstRatio = ratio;
    line(`  孤立亮点（脉冲）面板 ${imp.panelIndex}：原始 ${n0} 个，返回 ${n1} 个  →  保留 ${num(ratio * 100, 1)}%`);
  }
  check('孤立单像素点未被模糊', worstRatio > 0.85,
    `最低保留率 ${num(worstRatio * 100, 1)}%` +
    (worstRatio > 0.85 ? '：单像素结构完好' : '：单像素点被模糊（亚像素重采样的典型特征，真实照片里无此内容）'));
}

// ───────────────────────── 5. 几何 ─────────────────────────
H('④ 几何：有没有缩放、裁切、平移');
const ruler = M.features.find((f) => f.kind === 'rulerTop');
if (ruler) {
  const [, ry0, , rh] = ruler.rect;
  const midY = ry0 + Math.floor(rh / 2) - 6; // 避开中间的红色中线
  const p0 = profileRow(O, midY, 0, CW), p1 = profileRow(R, midY, 0, CW);
  const per0 = estimatePeriod(p0), per1 = estimatePeriod(p1);
  line(`  顶部标尺周期：原始 ${per0}px，返回 ${per1}px  →  ${per1 === per0 ? '✔ 无缩放' : '✘ 存在缩放'}`);
  check('无几何缩放', per1 === per0, `标尺周期 ${per0} → ${per1}`);
}
const border = M.features.find((f) => f.kind === 'border1px');
if (border) {
  const px = (raw, x, y) => { const i = (y * raw.width + x) * 3; return [raw.data[i], raw.data[i + 1], raw.data[i + 2]]; };
  const isMagenta = ([r, g, b]) => r > 150 && g < 100 && b > 150;
  let origOk = 0, retOk = 0, total = 0, blurry = 0;
  for (const p of M.panels.filter((p) => judgePanelIdx.includes(p.index))) {
    const { left, top, width, height } = p.crop;
    const corners = [
      [left, top], [left + width - 1, top],
      [left, top + height - 1], [left + width - 1, top + height - 1],
    ];
    for (const [x, y] of corners) {
      total++;
      if (isMagenta(px(O, x, y))) origOk++;
      if (isMagenta(px(R, x, y))) retOk++;
    }
    // 第二行/列是否仍是背景：若被重采样，1px 线会糊成 2~3px
    if (isMagenta(px(R, left + Math.floor(width / 2), top + 1))) blurry++;
    if (isMagenta(px(R, left + 1, top + Math.floor(height / 2)))) blurry++;
  }
  line(`  1px 品红边框：原始 ${origOk}/${total} 个角在位，返回 ${retOk}/${total} 个角在位`);
  line(`  边缘是否被模糊（1px 线糊成多行）：${blurry === 0 ? '未模糊 ✔' : `${blurry} 处被模糊 ✘`}`);
  check('边缘未被模糊/裁切', retOk === total && blurry === 0,
    `角点 ${retOk}/${total}，模糊处 ${blurry}`);
}

// ───────────────────────── 6. 色彩 ─────────────────────────
H('⑤ 色彩：色彩空间 / gamma 是否被改动');
const colorFeats = M.features.filter((f) => f.kind === 'colors' && judgePanelIdx.includes(f.panelIndex));
if (colorFeats.length) {
  let worst = -1, worstPanel = 0, worstGot = null, worstExpect = null;
  const rows = [];
  for (const colors of colorFeats) {
    const pi = colors.panelIndex;
    const S = colors.size;
    for (let i = 0; i < colors.values.length; i++) {
      const col = i % 8, row = Math.floor(i / 8);
      const inset = Math.max(2, Math.round(S * 0.15));
      const rect = [colors.rect[0] + col * S + inset, colors.rect[1] + row * S + inset, S - inset * 2, S - inset * 2];
      // 先局部对齐，再比色：把"内容被挪动"和"颜色被改"分开
      const al = bestAlign(rect, 20, 2);
      const m0 = regionMean(O, rect), m1 = regionMean(R, shiftRect(rect, al));
      const de = deltaE76(m0, m1);
      if (de > worst) { worst = de; worstPanel = pi; worstGot = m1; worstExpect = colors.values[i]; }
      rows.push({ panel: pi, i, expect: colors.values[i], got: m1, dE: de, shift: `${al.dx}/${al.dy}` });
    }
  }
  line(`  色块最大色差 ΔE76 = ${num(worst, 2)}（面板 ${worstPanel}，已局部对齐）`);
  line(`    最差块：期望 RGB ${worstExpect.join(',')}  →  返回 ${worstGot.map((v) => num(v, 1)).join(',')}`);
  const maxShift = Math.max(...rows.map((r) => Math.max(...r.shift.split('/').map((v) => Math.abs(+v)))));
  line(`    全部门板中出现的最大局部位移：${maxShift}px`);
  check('色彩未被改动', worst < 2,
    `最大 ΔE76 = ${num(worst, 2)}（面板 ${worstPanel}）` + (worst < 2 ? '：色彩空间与 gamma 保持' : '：色彩空间/gamma 被改动'));
  report.colors = rows;
}
const wedgeFeats = M.features.filter((f) => f.kind === 'wedge' && judgePanelIdx.includes(f.panelIndex));
if (wedgeFeats.length) {
  const deltas = [];
  for (const wedge of wedgeFeats) {
    const sw = wedge.step, hh = wedge.height;
    for (let i = 0; i < 32; i += 4) {
      const inset = Math.max(1, Math.round(Math.min(sw, hh) * 0.2));
      const rect = [wedge.rect[0] + i * sw + inset, wedge.rect[1] + inset, sw - 2 * inset, hh - 2 * inset];
      const al = bestAlign(rect, 20, 2);
      const m0 = regionMean(O, rect), m1 = regionMean(R, shiftRect(rect, al));
      deltas.push({ panel: wedge.panelIndex, in: i * 8, out: +m1[0].toFixed(1), d: +(m1[0] - m0[0]).toFixed(1) });
    }
  }
  line();
  line('  灰度楔（局部对齐后；输入 → 输出，理想为 0 偏差）：');
  for (const pi of judgePanelIdx) {
    const d = deltas.filter((x) => x.panel === pi);
    line(`    面板 ${pi}:  ` + d.map((x) => `${x.in}→${x.out}`).join('  '));
  }
  const maxWedge = Math.max(...deltas.map((x) => Math.abs(x.d)));
  check('灰阶未被拉伸/压缩', maxWedge <= 1.5, `最大灰阶偏差 ${num(maxWedge, 1)}（已局部对齐，仅统计未编辑面板）`);
  report.wedge = deltas;
}

// ───────────────────────── 7. 接缝污染 ─────────────────────────
if (editedPanel !== null && M.panels.length > 1) {
  H('⑥ 液化跨界：AI 的影响范围有多大（决定保护带要留多宽）');
  const untouchedIndex = M.panels.findIndex((p) => p.index !== editedPanel);
  const U = M.panels[untouchedIndex];
  const crop = U.crop;
  const seamTop = crop.top;                 // 未编辑面板的上边缘（紧邻保护带）
  const gutter = M.gutter || 0;
  line(`  未编辑面板 #${U.index} 的上边缘在画布第 ${seamTop} 行，保护带 ${gutter}px。`);
  line('  逐行统计该面板从接缝往下每一行的平均像素偏差：');
  line();
  const rowsToScan = Math.min(160, crop.height);
  const profile = [];
  for (let dy = 0; dy < rowsToScan; dy++) {
    const y = seamTop + dy;
    let s = 0;
    for (let x = crop.left; x < crop.left + crop.width; x += 1) {
      const i = (y * O.width + x) * 3;
      s += Math.abs(O.data[i] - R.data[i]) + Math.abs(O.data[i + 1] - R.data[i + 1]) + Math.abs(O.data[i + 2] - R.data[i + 2]);
    }
    profile.push(s / (crop.width * 3));
  }
  const bar = (v) => '█'.repeat(Math.min(40, Math.round(v * 2)));
  for (let dy = 0; dy < rowsToScan; dy += 8) {
    line(`    +${pad(dy + 'px', 6)} ${pad(num(profile[dy], 2), 7)} ${bar(profile[dy])}`);
  }
  // 找到偏差回落到 0.5 以内的距离
  let bleedDepth = 0;
  for (let dy = 0; dy < profile.length; dy++) if (profile[dy] > 0.5) bleedDepth = dy + 1;
  line();
  if (bleedDepth === 0) {
    line('  ✔ 接缝附近完全没有被改动 → 保护带可以设很小甚至为 0');
  } else {
    line(`  ⚠️  影响深入未编辑面板 ${bleedDepth} px → 建议保护带 ≥ ${Math.ceil(bleedDepth * 1.5)} px`);
  }
  // 逐行偏差会被探针自带的 1px 边框 / 1px 标尺放大，因此判定改用"实际位移量"
  const seamDisp = Math.max(...shiftTable
    .filter((s) => untouchedPanels.includes(s.panel))
    .map((s) => Math.max(Math.abs(s.dx), Math.abs(s.dy))));
  line();
  line(`  说明：上面的逐行偏差在 +0px 和 +120px 处爆表，是因为那里正好是探针的`);
  line(`        1px 品红边框和 1px 标尺——它们会把亚像素位移放大成 120/255 的差异。`);
  line(`        真实照片没有这种内容，判断请看"实际位移量"。`);
  line();
  if (seamDisp <= 1) {
    line('  ✔ 未编辑面板的实际位移 ≤ 1px → 液化形变场在跨过接缝后已衰减到亚像素级');
  } else if (seamDisp <= 4) {
    line(`  ~ 未编辑面板的实际位移 ${seamDisp}px → 轻微，肉眼不可辨，但建议液化时离接缝远一点`);
  } else {
    line(`  ⚠️  未编辑面板的实际位移达 ${seamDisp}px → 需要加宽保护带，或改用更大的分组间距`);
  }
  check('接缝无实质跨界污染', seamDisp <= 4,
    `未编辑面板实际最大位移 ${seamDisp}px（逐行偏差受探针放大器影响，不作判定依据）`);
  report.seamProfile = profile.slice(0, rowsToScan);
  report.bleedDepth = bleedDepth;
  report.seamDisplacement = seamDisp;
}

// ───────────────────────── 结论 ─────────────────────────
H('结论');
const failed = report.checks.filter((c) => !c.ok);
for (const c of report.checks) line(`  ${c.ok ? '✔' : '✘'} ${c.id}  —  ${c.detail}`);
line();
if (!failed.length) {
  line('  🎉 全部通过：像素蛋糕可以 1:1 无损地做你的"合成 → 美颜 → 切回"流程。');
  report.verdict.push('PASS');
} else {
  line(`  ⚠️  ${failed.length} 项未通过：`);
  for (const f of failed) line(`     · ${f.id}：${f.detail}`);
  report.verdict.push('ISSUES: ' + failed.map((f) => f.id).join(', '));
}

const rp = path.join(ROOT, 'probes', `${name}.report.json`);
fs.writeFileSync(rp, JSON.stringify(report, null, 2));
line(`\n  详细数据已写入 ${path.relative(ROOT, rp)}`);
line();
