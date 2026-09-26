import fs from 'node:fs';
import path from 'node:path';

/**
 * 切回原图 · 配对
 *
 * 像素蛋糕导出时保持原文件名不变（已实测），所以我们只需要：
 * 拿到修完的成片 → 在它旁边找导出时写下的 .manifest.json → 按记录切回去。
 *
 * 这里**只配对、不动像素**。先把「哪几个能切、各能切出几张、谁配不上」摆给用户看，
 * 配不上就明确报出来，绝不猜 —— 猜错会把别人的画布切坏。
 */

/**
 * 从一个文件反查它的 sidecar manifest（导出时生成的 .manifest.json 和成片同目录）。
 *
 * 优先**精确匹配**同名 manifest，再退回前缀匹配。
 * 为什么要分两步：用户常见的批次名是 batch、batch2、batch-2，
 * 单靠 startsWith 会让 batch2.tif 匹到 batch.manifest.json 上（前缀也是 batch），
 * 于是切出来的全是错图，而且尺寸校验还可能恰好通过（两张画布尺寸接近时）。
 */
export function findManifestFor(file, { exactOnly = false } = {}) {
  const dir = path.dirname(file);
  const stem = path.basename(file).replace(/\.[^.]+$/, '');
  let cands = [];
  try {
    cands = fs.readdirSync(dir).filter((f) => f.endsWith('.manifest.json'));
  } catch { return null; }

  const exact = `${stem}.manifest.json`;
  const ordered = exactOnly
    ? cands.filter((c) => c === exact)
    : [
      ...cands.filter((c) => c === exact),
      ...cands.filter((c) => c !== exact
        && (c.startsWith(stem) || stem.startsWith(c.replace('.manifest.json', '')))),
    ];

  for (const c of ordered) {
    try {
      const manifestFile = path.join(dir, c);
      return { manifestFile, manifest: JSON.parse(fs.readFileSync(manifestFile, 'utf8')) };
    } catch { /* 坏文件跳过，继续试下一个 */ }
  }
  return null;
}

/** 批量配对：给一串修完的文件，逐个找 manifest，返回可直接渲染成清单的行 */
export function planRecover(files = [], { exactOnly = false } = {}) {
  const rows = files.map((f) => {
    const found = findManifestFor(f, { exactOnly });
    return {
      file: f,
      name: path.basename(f),
      manifestFile: found?.manifestFile ?? null,
      canvas: found?.manifest?.canvas ?? null,
      count: found?.manifest?.items?.length ?? 0,
      ok: !!found,
      reason: found ? '' : '同目录下没找到配套的 .manifest.json',
    };
  });
  return {
    rows,
    total: rows.length,
    okCount: rows.filter((r) => r.ok).length,
    imageCount: rows.reduce((s, r) => s + r.count, 0),
  };
}

/** 像素蛋糕能导出的格式（切回时用户手里拿到的就是这些） */
const CANVAS_EXT = new Set(['.tif', '.tiff', '.jpg', '.jpeg', '.png']);

/**
 * 扫一个目录，把所有「旁边有 manifest 的成片」都找出来。
 *
 * 为什么需要它：正常情况下用户根本不该手选文件 —— 成片就是他刚导出的那些，
 * 直接扫导出目录就行。手选只留给特殊情况（换过目录、分批导过）。
 *
 * 这里用 exactOnly：只有 `<同名>.manifest.json` 才算，不做前缀兜底，
 * 免得把一个叫 batch 的普通照片误认成画布。
 */
export function scanDirForCanvases(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return planRecover([]); }

  const files = names
    .filter((n) => CANVAS_EXT.has(path.extname(n).toLowerCase()))
    .filter((n) => !n.endsWith('.preview.jpg'))   // 预览图不是成片
    .sort()
    .map((n) => path.join(dir, n));

  return planRecover(files, { exactOnly: true });
}
