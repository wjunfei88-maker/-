/**
 * 批次进度（并行导出时那个浮层上的数字）。
 *
 * 为什么值得单独一个文件 + 单测：这里的东西**看着简单，已经错过两次** ——
 *   ① 「已完成 x/y」停在旧数字不动：finalize 之后忘了广播，最后一张永远追不上。
 *   ② 进度条先冲到 100%，而「已完成 0/3」还挂着：每张画布内部的进度按 1.0 计入，
 *      三张都跑到"完成"就等于 3/3 = 100%，可一张都还没真正落盘。
 *   ③ 标题跟着某一张画布的瞬时事件跳来跳去（第 3 张 → 第 1 张 → 第 2 张）。
 *
 * 规则定死在这里：
 *   · 只要还有画布没完成，pct 永远 < 1（封顶 0.99）—— 进度条不许先说"完事了"。
 *   · 每张画布的内部进度最多贡献 0.99，剩下的 0.01 由"真正完成"来给。
 *   · 标题只跟"有几张在跑"走，不跟"哪一张刚发了消息"走。
 */

/** 把 0..1 的内部进度收敛成一个安全值：哪怕调用方给了 1，也只算 0.99。 */
function clampPiece(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(0.99, n);
}

/**
 * @param {object} o
 * @param {number} o.total    这批一共几张画布
 * @param {number} o.finished 已经落盘的张数（成功 + 失败都算，失败也是"处理完了"）
 * @param {number[]} o.active 正在跑的那几张画布各自的内部进度 0..1
 * @param {number[]} o.running 正在跑的画布序号（1 起，用来显示"第 N 张"）
 */
export function batchProgress({ total, finished, active = [], running = [] } = {}) {
  const n = Math.max(1, Math.round(Number(total)) || 1);
  const fin = Math.max(0, Math.min(n, Math.round(Number(finished)) || 0));
  const pieces = Array.isArray(active) ? active : [];
  const run = (Array.isArray(running) ? running : []).filter((i) => Number.isFinite(i));

  let sum = 0;
  for (const v of pieces) sum += clampPiece(v);

  const allDone = fin >= n;
  const pct = allDone ? 1 : Math.min(0.99, (fin + sum) / n);

  const message = allDone
    ? `${n} 张画布全部完成`
    : run.length > 1
      ? `正在并行处理 ${run.length} 张画布 · 已完成 ${fin}/${n}`
      : `正在处理第 ${run[0] ?? Math.min(fin + 1, n)} 张画布 · 已完成 ${fin}/${n}`;

  return { pct, message, finished: fin, total: n };
}
