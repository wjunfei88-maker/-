import os from 'node:os';

/**
 * 并发控制 + 机器自适应。
 *
 * 为什么要专门做这件事（实测数据，M1 Max / 10 核）：
 *   · 贴图（composite）这步 libvips 真会用多核 —— 并行度 7.27×
 *   · 但压缩是**单线程**的：TIFF LZW 并行度 1.06×，JPEG q100 是 1.04×
 *   所以一张画布的导出再优化也只能压到一个核上，想把机器用满就必须
 *   **让多张画布同时导**（每张画布 = 一个独立进程，各压各的）。
 *
 * 但并行数不能拍脑袋：一张 12000×12000 的画布光 raw 缓冲就 432MB，
 * 4 张同时导就是 3.2GB —— 8GB 的 MacBook 会开始换页，**反而更慢**。
 * 所以并发数由「内存预算」和「核数」一起决定，取小值。
 */

const MB = 1024 * 1024;
const GIB = 1024 * MB;

/** 每张画布导出大约需要多少内存：raw 缓冲 + libvips 编解码工作缓冲，实测约 2 倍 raw */
export function exportJobMB({ width = 12000, height = 12000 } = {}) {
  const rawMB = (width * height * 3) / MB;
  return Math.round(rawMB * 2 + 300);
}

/**
 * 按总内存定一个基线并发数。
 * 低配机器直接给 1 —— 也就是保持"一张一张导"的原有行为，绝不因为并行而卡死。
 */
function baseByRam(totalGB) {
  if (totalGB <= 9) return 1;     // 8GB 机器：不并行，稳字优先
  if (totalGB <= 18) return 2;    // 16GB
  if (totalGB <= 36) return 3;    // 32GB
  return 4;                       // 64GB 及以上
}

/**
 * 算出这台机器上「全部导出」最多同时开几个 worker。
 * 返回的不只是数字，还有推导过程 —— 界面上要如实告诉用户为什么是这个数。
 */
export function exportConcurrency(sizes = []) {
  const cores = os.cpus()?.length ?? 4;
  const totalGB = os.totalmem() / GIB;

  const base = baseByRam(totalGB);
  // 内存预算：macOS 自己、Electron、界面加起来要留出余量。按总内存的 55% 再减 1.2GB。
  const budgetMB = Math.max(600, totalGB * 1024 * 0.55 - 1200);
  const worstMB = Math.max(exportJobMB(), ...sizes.map((s) => exportJobMB(s)));
  const byMem = Math.max(1, Math.floor(budgetMB / worstMB));
  // 每个 worker 内部还会用几个核做贴图，所以核数上限取 cores-1，且不超过 4（再多收益递减，磁盘 IO 先饱和）
  const byCores = Math.max(1, Math.min(4, cores - 1));

  const envOverride = Number(process.env.PC_JOBS || 0);
  const workers = envOverride > 0
    ? Math.max(1, Math.min(16, envOverride))
    : Math.max(1, Math.min(base, byMem, byCores));

  return {
    workers, base, byMem, byCores, cores,
    totalGB: Math.round(totalGB * 10) / 10,
    budgetMB: Math.round(budgetMB),
    worstMB,
    reason: workers === 1
      ? (base === 1 ? `内存 ${Math.round(totalGB)}GB，并行不划算（容易换页）` : '内存预算不够同时开两张')
      : `内存 ${Math.round(totalGB)}GB · ${cores} 核 → 同时导 ${workers} 张`,
  };
}

/** 切分（切回原图）的并发数：每刀要解一块区域再编码，比导出轻得多 */
export function splitConcurrency() {
  const cores = os.cpus()?.length ?? 4;
  const totalGB = os.totalmem() / GIB;
  const envOverride = Number(process.env.PC_JOBS || 0);
  if (envOverride > 0) return Math.max(1, Math.min(16, envOverride));
  // 每刀峰值约 150MB（一块区域 raw + 编码器状态），按内存给上限
  const byMem = Math.max(1, Math.floor((totalGB * 1024 * 0.5 - 800) / 150));
  const byCores = Math.max(2, Math.min(6, cores - 2));
  return Math.max(1, Math.min(byMem, byCores));
}

/**
 * 一个极简的并发闸门：同时最多跑 size 个任务，多的排队。
 * 用全局一个闸门（而不是每层各一个）才能保证「在飞的编码数」是个确定值 ——
 * 切回时画布有多有少，按文件加锁会让小画布跑不满。
 */
export function createLimiter(size) {
  const limit = Math.max(1, size | 0);
  let active = 0;
  const queue = [];

  const pump = () => {
    while (active < limit && queue.length) {
      const job = queue.shift();
      active++;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => { active--; pump(); });
    }
  };

  return {
    size: limit,
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        pump();
      });
    },
    stats() { return { size: limit, active, pending: queue.length }; },
  };
}

/** 带并发上限的 map，保持输入顺序 */
export async function mapLimit(items, size, fn) {
  const limiter = createLimiter(size);
  return Promise.all(items.map((it, i) => limiter.run(() => fn(it, i))));
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
