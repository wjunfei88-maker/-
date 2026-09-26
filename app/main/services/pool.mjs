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

/**
 * 并发的硬上限。不是"算出来的"，是拍的一个天花板 —— 理由：
 *   · 导出进程再多也不会比核多更快（压缩是 CPU 密集的单线程活）
 *   · 但同时开太多会让界面掉帧、风扇起飞，而且磁盘 IO 会先饱和
 * 12 是给 12 核以上的机器留的余量；核数少于 12 时以核数为准。
 */
const HARD_MAX = 12;

/** 每张画布导出大约需要多少内存：raw 缓冲 + libvips 编解码工作缓冲，实测约 2 倍 raw */
export function exportJobMB({ width = 12000, height = 12000 } = {}) {
  const rawMB = (width * height * 3) / MB;
  return Math.round(rawMB * 2 + 300);
}

/**
 * 按总内存定一个**推荐**基线并发数。
 * 低配机器直接给 1 —— 也就是保持"一张一张导"的原有行为，绝不因为并行而卡死。
 * 注意这是"推荐值"，不是"上限"：用户可以在界面上自己往高了调（内存和核数仍然兜底）。
 */
function baseByRam(totalGB) {
  if (totalGB <= 9) return 1;     // 8GB 机器：不并行，稳字优先
  if (totalGB <= 18) return 2;    // 16GB
  if (totalGB <= 36) return 3;    // 32GB
  return 4;                       // 64GB 及以上
}

/** 把用户手选的并发数夹到安全范围内，并如实报告有没有被夹 */
function clampChoice(choice, max) {
  const want = Math.max(1, Math.round(choice));
  return { value: Math.min(want, max), clamped: want > max, want };
}

/**
 * 算出这台机器上「全部导出」的并发数。
 *
 * 返回的不只是数字，还有整个推导过程 —— 界面上要如实告诉用户为什么是这个数，
 * 并且让他能自己往上调（`override`，0 = 用推荐值）。
 *
 * 三个数要分清：
 *   · recommended —— 保守值，开箱即用，给界面留核
 *   · max         —— 用户手动能调到多大（内存和核数是硬约束，调不上去）
 *   · workers     —— 这次实际用几个
 */
export function exportConcurrency(sizes = [], override = 0) {
  const cores = os.cpus()?.length ?? 4;
  const totalGB = os.totalmem() / GIB;

  const base = baseByRam(totalGB);
  // 内存预算：macOS 自己、Electron、界面加起来要留出余量。按总内存的 55% 再减 1.2GB。
  const budgetMB = Math.max(600, totalGB * 1024 * 0.55 - 1200);
  const worstMB = Math.max(exportJobMB(), ...sizes.map((s) => exportJobMB(s)));
  const byMem = Math.max(1, Math.floor(budgetMB / worstMB));

  // 推荐值：每个 worker 内部还会用几个核做贴图，所以留一个核给界面，且不超过 4
  const recommended = Math.max(1, Math.min(base, byMem, Math.max(1, Math.min(4, cores - 1))));
  // 上限：大胆给到核数那么多（每个进程内部接下来只开很少的贴图线程，见 main.mjs 的 perPanel）
  const max = Math.max(1, Math.min(HARD_MAX, cores, byMem));

  const envOverride = Number(process.env.PC_JOBS || 0);
  const asked = envOverride > 0 ? envOverride : Number(override || 0);
  let workers = recommended;
  let clamped = false;
  if (asked > 0) {
    const c = clampChoice(asked, max);
    workers = c.value;
    clamped = c.clamped;
  }

  const overridden = asked > 0 && workers !== recommended;

  return {
    workers, recommended, max, base, byMem, byCores: Math.max(1, Math.min(HARD_MAX, cores)),
    cores, totalGB: Math.round(totalGB * 10) / 10,
    budgetMB: Math.round(budgetMB), worstMB,
    overridden, clamped, asked: asked || 0,
    reason: workers === 1
      ? (base === 1 ? `内存 ${Math.round(totalGB)}GB，并行不划算（容易换页）` : '内存预算不够同时开两张')
      : `内存 ${Math.round(totalGB)}GB · ${cores} 核 → ${overridden ? '你指定' : '推荐'} ${workers} 张`,
    clampNote: clamped ? `内存/核数只够开到 ${max} 个，已经按 ${max} 算` : '',
  };
}

/** 切回原图并发的完整推导（界面要给用户选项，所以不能只返回一个数） */
export function splitPlan(override = 0) {
  const cores = os.cpus()?.length ?? 4;
  const totalGB = os.totalmem() / GIB;
  // 每刀峰值约 150MB（一块区域 raw + 编码器状态），按内存给上限
  const byMem = Math.max(1, Math.floor((totalGB * 1024 * 0.5 - 800) / 150));
  const recommended = Math.max(1, Math.min(byMem, Math.max(2, Math.min(6, cores - 2))));
  const max = Math.max(1, Math.min(HARD_MAX, cores, byMem));

  const envOverride = Number(process.env.PC_JOBS || 0);
  const asked = envOverride > 0 ? envOverride : Number(override || 0);
  let workers = recommended;
  let clamped = false;
  if (asked > 0) {
    const c = clampChoice(asked, max);
    workers = c.value;
    clamped = c.clamped;
  }

  const overridden = asked > 0 && workers !== recommended;
  return {
    workers, recommended, max, byMem, byCores: Math.max(1, Math.min(HARD_MAX, cores)),
    cores, totalGB: Math.round(totalGB * 10) / 10,
    overridden, clamped, asked: asked || 0,
    reason: `内存 ${Math.round(totalGB)}GB · ${cores} 核 → ${overridden ? '你指定' : '推荐'} ${workers} 路`,
    clampNote: clamped ? `内存/核数只够开到 ${max} 路，已经按 ${max} 算` : '',
  };
}

/** 切分（切回原图）的并发数：每刀要解一块区域再编码，比导出轻得多 */
export function splitConcurrency(override = 0) {
  return splitPlan(override).workers;
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
