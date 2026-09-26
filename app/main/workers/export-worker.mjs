/**
 * 导出 worker（Electron utilityProcess 子进程）。
 *
 * 为什么必须开进程而不是在主进程里排队：TIFF LZW / JPEG 编码在 libvips 里是
 * **单线程**的（实测并行度 1.06×），一张画布再快也只用到一个核。
 * 想让整台机器跑起来，只能让多张画布**各占一个进程**同时压。
 *
 * 每个进程的内存是独立的，主进程只按内存预算决定开几个（见 services/pool.mjs），
 * 低配 Mac 会自动降到 1 个 —— 也就是回到"一张一张导"，绝不因为并行而卡死。
 *
 * 这里只做像素，不写 manifest、不碰 library.json（那是主进程的活，避免并发覆盖）。
 */
import { renderCanvas } from '../services/export.mjs';

process.parentPort.on('message', async (e) => {
  const msg = e?.data ?? e;
  const { jobId, payload, base, panelConcurrency } = msg ?? {};

  if (msg?.type === 'cancel') {
    process.exit(0);
    return;
  }

  try {
    const r = await renderCanvas({
      payload,
      base,
      panelConcurrency,
      onProgress: (p) => process.parentPort.postMessage({ type: 'progress', jobId, progress: p }),
    });
    process.parentPort.postMessage({ type: 'done', jobId, result: r });
  } catch (err) {
    process.parentPort.postMessage({ type: 'error', jobId, error: err?.message ?? String(err) });
  }
});
