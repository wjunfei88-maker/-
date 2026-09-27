/**
 * 进度浮层的数字与那**一列进度条**（导出和切回共用）。
 *
 * 为什么值得单独一个文件 + 单测：这里的东西**看着简单，已经错过三次** ——
 *   ① 「已完成 x/y」停在旧数字不动：finalize 之后忘了广播，最后一张永远追不上。
 *   ② 进度条先冲到 100%，而「已完成 0/3」还挂着：每张画布内部的进度按 1.0 计入。
 *   ③ 切回时把**单张画布内部**的百分比直接当成整批的百分比发出去，
 *      于是进度条在 3/25 → 0.4 → 5/25 之间来回抽（用户报的"切回弹窗跳来跳去"）。
 *
 * 规则定死在这里：
 *   · 只要还有一张没到终态，总进度永远 < 1（封顶 0.99）—— 进度条不许先说"完事了"。
 *   · 每张的内部进度最多贡献 0.99，剩下的 0.01 由"真正处理完"来给。
 *   · 一列进度条按**序号**排，顺序不许变（不按谁先跑完排）。
 */

/** 单张的内部进度收敛到安全值：哪怕调用方给了 1，也只算 0.99。 */
function clampPiece(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(0.99, n);
}

const TERMINAL = new Set(['done', 'failed']);

/**
 * @param {object} o
 * @param {string} o.title  例如「正在导出画布」「正在切回原图」
 * @param {number} o.total  一共几张
 * @param {Array<{label?:string,pct?:number,state?:string,note?:string}>} o.items 每张的状态
 */
export function batchProgress({ title = '处理中', total, items = [] } = {}) {
  const n = Math.max(1, Math.round(Number(total)) || 1);
  const src = Array.isArray(items) ? items : [];

  const rows = [];
  let settled = 0;   // 到终态的张数（成功 + 失败）
  let failed = 0;
  let running = 0;
  let sum = 0;

  for (let i = 0; i < n; i++) {
    const it = src[i] && typeof src[i] === 'object' ? src[i] : {};
    const state = TERMINAL.has(it.state) ? it.state : null;
    const pct = state ? 1 : clampPiece(it.pct);
    if (state === 'done') settled++;
    else if (state === 'failed') { settled++; failed++; }
    else { sum += pct; if (pct > 0) running++; }

    rows.push({
      index: i,
      label: typeof it.label === 'string' && it.label ? it.label : `第 ${i + 1} 张`,
      pct,
      state: state ?? (pct > 0 ? 'running' : 'pending'),
      note: typeof it.note === 'string' ? it.note : '',
    });
  }

  const allDone = settled >= n;
  const pct = allDone ? 1 : Math.min(0.99, (settled + sum) / n);
  const head = allDone
    ? `${title} · 全部完成`
    : `${title} · 已完成 ${settled}/${n}${running > 1 ? ` · 正在并行 ${running} 张` : ''}`;

  return { title: head, pct, finished: settled, failed, total: n, rows };
}
