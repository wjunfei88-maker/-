import fs from 'node:fs';
import path from 'node:path';
import { composeCanvas, makeCanvasPreview } from './render.mjs';

/**
 * 「导出一张画布」里**只跟像素有关**的那半步。
 *
 * 单独抽出来是因为它要在两个地方跑：
 *   1. 主进程（只导一张时）
 *   2. 导出 worker 进程（「全部导出」时，每张画布一个进程）
 *
 * 这里**绝不碰 library.json** —— 多个进程同时写那个文件会互相覆盖。
 * 写 manifest 和历史批次由主进程统一做（见 main.mjs 的 recordExport）。
 */

/** 预览图放这个子文件夹。它是给界面回显用的，不该混进你要交付的成片里。 */
export const PREVIEW_DIR = '预览图';

/** 后缀 _c01/_c02 方便和界面上的画布列表对上号 */
export function makeBaseName(name, id, suffix = '') {
  const safe = (name || 'batch').replace(/[/\\:*?"<>|]/g, '_');
  return `TILE_${safe}_${id}${suffix}`;
}

export async function renderCanvas({ payload, base, onProgress = () => {}, panelConcurrency } = {}) {
  const { items, width, height, gutter, outDir, icc, compression } = payload;
  if (!items?.length) throw new Error('画布上还没有图片');
  fs.mkdirSync(outDir, { recursive: true });

  const canvasFile = path.join(outDir, `${base}.tif`);
  const started = Date.now();

  const res = await composeCanvas({
    items, width, height, gutter,
    outFile: canvasFile, icc: icc || 'srgb', compression: compression || 'lzw',
    onProgress,
    ...(panelConcurrency ? { panelConcurrency } : {}),
  });

  // 预览图是**给界面回显用的**，不是你交付的成片。
  // 放到单独的子文件夹里，免得它混在成片目录中让你以为"怎么多了个低画质 jpg"。
  const previewFile = path.join(outDir, PREVIEW_DIR, `${base}.preview.jpg`);
  const tPrev = Date.now();
  await makeCanvasPreview(canvasFile, previewFile, 1400);
  const timings = [...(res.timings ?? []), { label: '生成预览图', ms: Date.now() - tPrev }];

  return { canvasFile, previewFile, bytes: res.bytes, timings, elapsed: Date.now() - started };
}
