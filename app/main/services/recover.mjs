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
export function findManifestFor(file) {
  const dir = path.dirname(file);
  const stem = path.basename(file).replace(/\.[^.]+$/, '');
  let cands = [];
  try {
    cands = fs.readdirSync(dir).filter((f) => f.endsWith('.manifest.json'));
  } catch { return null; }

  const exact = `${stem}.manifest.json`;
  const ordered = [
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
export function planRecover(files = []) {
  const rows = files.map((f) => {
    const found = findManifestFor(f);
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
