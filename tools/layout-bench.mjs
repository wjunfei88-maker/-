#!/usr/bin/env node
/**
 * 排版引擎压测：画布数 vs 理论下界 · 填充率 · 耗时 · 确定性
 *
 * 用法：npm run bench
 *
 * 为什么值得留着这个脚本：
 * 用户的成本直接等于「画布张数」（每张画布 = 像素蛋糕的一次额度），
 * 而合装装箱是启发式算法 —— 换个排序、改个窗口大小就可能从 6 张变 9 张，
 * 成本涨 50%，而**功能测试全绿**（不重叠、不超限、不丢图，全都还成立）。
 * 所以每次动 layout.mjs 都要看这里的数字有没有退化。
 *
 * 下界有两重，取大者：
 *   · 面积下界 = ceil(总像素 / 12000²)
 *   · 张数下界 = ceil(照片数 / 单张画布的上限张数)
 * 到达下界就是这套几何能做到的最好结果，再优化只能靠缩放（违背 1:1 约束）。
 */
import { planGroups, assertNoOverlap, CANVAS_LIMIT } from '../app/main/services/layout.mjs';

const L = CANVAS_LIMIT, G = 24;

/** 常见机身/导出规格：[横, 竖] */
const SIZES = {
  L61: [9504, 6336], P61: [6336, 9504],   // 61MP
  L45: [8192, 5464], P45: [5464, 8192],   // 45MP
  L42: [7952, 5304], P42: [5304, 7952],   // 42MP  A7R3/R4
  L33: [7008, 4672], P33: [4672, 7008],   // 32.7MP A7M4
  L24: [6000, 4000], P24: [4000, 6000],   // 24MP
  L14: [4608, 3072], P14: [3072, 4608],   // 14.2MP
};

function mk(spec) {
  const out = [];
  for (const [k, count] of Object.entries(spec)) {
    const s = SIZES[k];
    if (!s) throw new Error(`未知规格 ${k}`);
    for (let i = 0; i < count; i++) out.push({ id: `${k}_${i}`, name: `${k}_${i}.jpg`, width: s[0], height: s[1] });
  }
  return out;
}

let hardFailures = 0;

function run(label, imgs, opts = {}) {
  const t0 = Date.now();
  const r = planGroups(imgs, { limit: L, gutter: G, ...opts });
  const ms = Date.now() - t0;

  const per = r.canvases.map((c) => c.placed.length).sort((a, b) => b - a);
  const placed = per.reduce((a, b) => a + b, 0);

  // 每张画布必须「无重叠 + 不超限」，否则后面所有数字都没意义
  let bad = 0;
  for (const c of r.canvases) {
    try { assertNoOverlap(c.placed); } catch { bad++; }
    if (c.width > L || c.height > L) bad++;
  }
  if (placed !== imgs.length) bad++;

  const fills = r.canvases.map((c) => (c.placed.reduce((s, p) => s + p.w * p.h, 0) / (c.width * c.height)) * 100);
  const avgFill = fills.reduce((a, b) => a + b, 0) / (fills.length || 1);
  const atBound = r.canvases.length <= r.lowerBound;
  const excess = r.canvases.length - r.lowerBound;
  if (bad) hardFailures++;

  console.log(
    `${label.padEnd(24)} ${String(imgs.length).padStart(3)}张 → ${String(r.canvases.length).padStart(2)} 画布` +
    `${atBound ? ' =下界✔' : `  (面积下界${r.lowerBound}, 多${excess}张)`}  ` +
    `每张[${per.join(',')}]  省${(100 - r.canvases.length / imgs.length * 100).toFixed(0)}%  ` +
    `填充${avgFill.toFixed(0)}%  异常${bad}  ${ms}ms`,
  );
  if (placed !== imgs.length) console.log(`   ⚠️ 有图没排进去: ${imgs.length - placed}`);
  if (bad) console.log('   ⚠️ 有画布重叠/超限 —— 这是硬 bug');
  return r;
}

console.log('\n═══ 真实场景：多机身混尺寸（默认不旋转，1:1 无损）═══');
run('25张 33MP 横10竖10+14MP横5', mk({ L33: 10, P33: 10, L14: 5 }));
run('25张 33MP 横竖对半', mk({ L33: 12, P33: 13 }));
run('25张 33MP 全横', mk({ L33: 25 }));
run('25张 四种尺寸混合', mk({ L33: 8, P33: 8, L14: 5, P14: 4 }));
run('40张 33MP 横竖对半', mk({ L33: 20, P33: 20 }));
run('12张 24MP 横竖对半', mk({ L24: 6, P24: 6 }));
run('8张  42MP 横竖对半', mk({ L42: 4, P42: 4 }));
run('4张  61MP 全横', mk({ L61: 4 }));

console.log('\n═══ 规模与性能 ═══');
run('100张 大杂烩', mk({ L33: 30, P33: 30, L14: 20, P14: 20 }));
run('400张 极限压测', mk({ L33: 100, P33: 100, L14: 100, P14: 100 }));

console.log('\n═══ 允许 90° 旋转（默认关闭：人脸会躺倒）═══');
run('40张 33MP 全横 可旋转', mk({ L33: 40 }), { allowRotate: true });
run('8张  42MP 横竖对半 可旋转', mk({ L42: 4, P42: 4 }), { allowRotate: true });

console.log('\n═══ 确定性：同一批照片每次必须排出一样的结果 ═══');
{
  const imgs = mk({ L33: 20, P33: 20 });
  const sig = (r) => r.canvases.map((c) => c.placed.map((p) => `${p.id}@${p.x},${p.y}`).join('|')).join('//');
  const a = planGroups(imgs, { limit: L, gutter: G });
  const b = planGroups(imgs, { limit: L, gutter: G });
  const same = sig(a) === sig(b);
  console.log(`  两次运行逐图坐标一致: ${same ? '✔ ' + a.canvases.length + ' 张画布' : '✘ 结果不稳定'}`);
  if (!same) hardFailures++;
}

// 面积下界假设「12000² 能被照片 100% 填满、保护带不占地方」，混尺寸时物理上做不到：
// 实测 100 张四种尺寸混合始终是 23 张画布（面积下界 18），
// 且把随机搜索轮数从 1 提到 200 结果一模一样 —— 瓶颈在每张画布的装箱构成，不在搜索深度。
// 所以下界只当参考，**硬指标是：无重叠、不超限、不丢图、结果确定**。
console.log(hardFailures === 0
  ? '\n✔ 无重叠 / 不超限 / 不丢图 / 结果确定\n'
  : `\n✘ ${hardFailures} 项硬性检查失败 —— 必须修\n`);
process.exit(hardFailures ? 1 : 0);
process.exit(0);
