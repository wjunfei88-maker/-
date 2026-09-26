/**
 * 会话：退出重进别丢工作。
 *
 * 用户的原话是「退出重进就所有东西都消失了」。导入 + 排版是花时间的活，
 * 顺手把它存在本地，下次打开自动接上。
 *
 * 这个文件刻意不依赖 electron —— 会话恢复里最容易错的是「原图被删了怎么办」，
 * 那种分支只能靠单测钉住，起不了 Electron 的测试等于没有测试。
 */

/** 只留还活在磁盘上的照片（原图或缩略图没了就丢掉，否则一启动满屏黑块） */
function survivingImages(raw, exists) {
  // 会话文件是纯本地 JSON，可能被手改坏/写一半 —— 这里必须扛得住脏数据
  const list = Array.isArray(raw?.images) ? raw.images : [];
  return list.filter((i) => i?.id && i?.path
    && exists(i.path) && i.thumbPath && exists(i.thumbPath));
}

/** 画布列表同样要防脏数据 */
function canvasList(raw) {
  const list = raw?.plan?.canvases;
  return Array.isArray(list) ? list : [];
}

/**
 * 清理一份会话数据：丢掉死引用，再丢掉因此变空、而且不是手工画的画布。
 * 返回 null 表示「这份会话没用了」（一张能用的图都没有）。
 */
export function pruneSession(raw, { exists = () => true } = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const images = survivingImages(raw, exists);
  if (!images.length) return null;

  const ids = new Set(images.map((i) => i.id));
  const canvases = canvasList(raw)
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({ ...c, placed: (c.placed ?? []).filter((p) => p?.id && ids.has(p.id)) }))
    // 空的手工画布是用户特意留的，留着；空的自动画布没意义
    .filter((c) => c.placed.length || c.manual);

  const maxIndex = Math.max(0, canvases.length - 1);
  return {
    images,
    plan: { ...(raw.plan ?? {}), canvases },
    planIndex: Math.max(0, Math.min(Number(raw.planIndex) || 0, maxIndex)),
    allowRotate: !!raw.allowRotate,
    gutter: Number.isFinite(Number(raw.gutter)) ? Number(raw.gutter) : 24,
    name: raw.name || 'batch',
    savedAt: raw.savedAt ?? null,
  };
}

/** 存盘时只挑这些字段（别把整个 plan 里的像素级字段乱塞） */
export function sessionPayload(data = {}) {
  return {
    savedAt: new Date().toISOString(),
    images: data.images ?? [],
    plan: data.plan ?? null,
    planIndex: data.planIndex ?? 0,
    allowRotate: !!data.allowRotate,
    gutter: data.gutter ?? 24,
    name: data.name || 'batch',
  };
}
