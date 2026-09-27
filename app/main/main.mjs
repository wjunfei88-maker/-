import { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, nativeTheme, utilityProcess } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import sharpLib from 'sharp';
import { probeImage, makeThumb, shortId, IMAGE_EXT } from './services/library.mjs';

const sharpMeta = (f) => sharpLib(f, { unlimited: true }).metadata();
import { planGroups, packCanvas, CANVAS_LIMIT, capacityHint, capacityExplain } from './services/layout.mjs';
import { renderCanvas, makeBaseName } from './services/export.mjs';
import { exportConcurrency, splitPlan, createLimiter } from './services/pool.mjs';
import { splitCanvas } from './services/split.mjs';
import { findManifestFor, planRecover, scanDirForCanvases } from './services/recover.mjs';
import { pruneSession, sessionPayload } from './services/session.mjs';
import {
  EXPORT_SUBDIR as SETTINGS_SUBDIR, RECOVER_SUBDIR,
  normalizeSettings, cleanPatch, exportDirOf, recoverDirOf,
} from './services/settings.mjs';
import { summarizeLedger } from './services/ledger.mjs';
import { batchProgress } from './services/progress.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !!DEV_URL;

/** 「全部导出」的 worker 入口（每个进程负责一张画布） */
const EXPORT_WORKER = path.join(import.meta.dirname, 'workers/export-worker.mjs');

let win = null;

// 自定义协议：渲染进程通过 pcfile:// 读取本地图片（http 源不能直接读 file://）
protocol.registerSchemesAsPrivileged([{
  scheme: 'pcfile',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
}]);

function userDir(...p) {
  const d = path.join(app.getPath('userData'), 'workbench', ...p);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function libraryFile() { return path.join(app.getPath('userData'), 'library.json'); }
function readLibrary() {
  try { return JSON.parse(fs.readFileSync(libraryFile(), 'utf8')); } catch { return { batches: [] }; }
}
function writeLibrary(data) {
  fs.mkdirSync(path.dirname(libraryFile()), { recursive: true });
  fs.writeFileSync(libraryFile(), JSON.stringify(data, null, 2));
}

/**
 * 导出位置与并发数设置。
 * 具体规则（子文件夹名、父目录失效怎么办、并发数怎么夹）都在 services/settings.mjs 里，
 * 那样才能被 npm test 覆盖 —— 这些规则一旦错都是"静默"的。
 */
const EXPORT_SUBDIR = SETTINGS_SUBDIR;

function settingsFile() { return path.join(app.getPath('userData'), 'settings.json'); }

function readSettings() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { /* 首次运行还没有这个文件 */ }
  return normalizeSettings(raw, { pictures: app.getPath('pictures'), exists: fs.existsSync });
}

function writeSettings(patch = {}) {
  const next = { ...readSettings(), ...cleanPatch(patch) };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

/** 界面要的那一份：设置 + 算好的两个目录 + 两个并发推导 */
/** 省额度账本：每条历史批次 = 一张画布 = 一次扣费，省下的次数在这里折成钱。 */
function ledgerView() {
  return summarizeLedger(readLibrary().batches, readSettings());
}

function settingsView() {
  const settings = readSettings();
  return {
    settings,
    ledger: ledgerView(),
    exportDir: exportDirOf(settings),
    recoverDir: recoverDirOf(settings),
    // 「默认」和「当前」要分开报给界面：用户曾经手选过一个自定义目录时，
    // 界面必须能看出来「这不是默认位置」—— 否则切回完他会去默认位置找，然后以为没切出来。
    defaultRecoverDir: path.join(settings.exportParent, RECOVER_SUBDIR),
    recoverSubdir: RECOVER_SUBDIR,
    subdir: EXPORT_SUBDIR,
    plan: {
      export: exportConcurrency([], settings.exportJobs),
      split: splitPlan(settings.splitJobs),
    },
  };
}

// ─────────────────────────── IPC ───────────────────────────
const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

ipcMain.handle('app:info', () => {
  let demoFiles = [];
  if (process.env.PC_DEMO) {
    try {
      demoFiles = fs.readdirSync(process.env.PC_DEMO)
        .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
        .map((f) => path.join(process.env.PC_DEMO, f))
        .sort();
    } catch { /* 目录不存在就算了 */ }
  }
  return {
    version: app.getVersion(),
    platform: process.platform,
    home: app.getPath('pictures'),
    limit: CANVAS_LIMIT,
    demoFiles,
    ...settingsView(),
  };
});

/**
 * 改设置。并发数改了要立刻把新的推导结果返回去，界面才能显示「你指定 8 个」。
 * 只传要改的字段即可（部分合并）；不认识的字段会被 cleanPatch 丢掉。
 */
ipcMain.handle('settings:set', (_e, patch = {}) => {
  writeSettings(patch);
  return settingsView();
});

ipcMain.handle('dialog:pickImages', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择要拼在一起的照片',
    defaultPath: app.getPath('pictures'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: [...IMAGE_EXT].map((e) => e.slice(1)) }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog:pickFolder', async (_e, title = '选择文件夹') => {
  const r = await dialog.showOpenDialog(win, {
    title, defaultPath: app.getPath('pictures'),
    // 必须是 openDirectory —— 写 openFolder 是无效值，Electron 会忽略它，
    // 结果就是"什么都没法选、右下角按钮一直灰着"，用户根本换不了保存位置。
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickFile', async (_e, title = '选择文件') => {
  const r = await dialog.showOpenDialog(win, {
    title, defaultPath: app.getPath('pictures'), properties: ['openFile'],
    filters: [{ name: 'TIFF', extensions: ['tif', 'tiff'] }, { name: '所有文件', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

// 像素蛋糕能导出的格式（切回时用户手里拿到的就是这些）
const RETURN_EXT = ['tif', 'tiff', 'jpg', 'jpeg', 'png',
  'arw', 'cr2', 'cr3', 'nef', 'nrw', 'raf', 'dng', 'orf', 'rw2', 'pef', 'srw'];

/** 选择像素蛋糕修完导出的文件（可多选 → 一次切回一整批） */
ipcMain.handle('dialog:pickReturned', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择像素蛋糕修完导出的文件（可按住 ⌘ 或 ⇧ 多选）',
    defaultPath: app.getPath('pictures'),
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '修完的成片', extensions: RETURN_EXT },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});

/** 导入：探测尺寸 + 生成缩略图 */
ipcMain.handle('images:import', async (_e, filePaths) => {
  const thumbDir = userDir('thumbs');
  const out = [];
  for (const f of filePaths) {
    try {
      if (!IMAGE_EXT.has(path.extname(f).toLowerCase())) continue;
      const st = fs.statSync(f);
      const probe = await probeImage(f);
      const th = await makeThumb(f, thumbDir, 1024);
      out.push({
        id: shortId(8),
        ...probe,
        size: st.size,
        ...th,
        url: 'pcfile://local' + encodeURI(th.thumbPath),
      });
    } catch (e) {
      out.push({ path: f, name: path.basename(f), error: e.message });
    }
  }
  return out;
});

/** 一键自动排版：算出一张画布怎么摆 */
ipcMain.handle('layout:pack', (_e, images, opts = {}) => {
  const r = packCanvas(images, { limit: CANVAS_LIMIT, gutter: opts.gutter ?? 24, allowRotate: !!opts.allowRotate });
  return { ...r, hint: r.placed.length ? capacityHint(r, CANVAS_LIMIT) : null };
});

/** 分组规划：装不下就拆成多张画布，最小化画布数量 */
ipcMain.handle('layout:plan', (_e, images, opts = {}) => {
  const allowRotate = !!opts.allowRotate;
  const plan = planGroups(images, { limit: CANVAS_LIMIT, gutter: opts.gutter ?? 24, allowRotate });
  return {
    allowRotate,
    canvases: plan.canvases.map((c) => ({
      ...c,
      hint: capacityHint(c, CANVAS_LIMIT),
      // image 是完整原对象，跨 IPC 传一遍纯属浪费；渲染层按 id 就能查回来
      placed: c.placed.map(({ image, ...rest }) => rest),
    })),
    unplaceable: plan.unplaceable,
  };
});

/** 容量说明：为什么一张画布只能放 N 张（用真实尺寸算给用户看） */
ipcMain.handle('layout:capacity', (_e, images, opts = {}) => {
  const withSize = images.filter((i) => i.width && i.height);
  if (!withSize.length) return { max: 0, rows: [] };
  // 同名尺寸归一类，取占比最大的那一类来解释
  const groups = new Map();
  for (const i of withSize) {
    const k = `${i.width}×${i.height}`;
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  const [topKey] = [...groups.entries()].sort((a, b) => b[1] - a[1])[0];
  const [w, h] = topKey.split('×').map(Number);
  return { ...capacityExplain([{ id: 'x', width: w, height: h }], CANVAS_LIMIT, opts.gutter ?? 24), size: topKey, kinds: groups.size };
});

/**
 * 写 manifest + 记历史批次。**只有主进程做这件事** ——
 * 导出 worker 是独立进程，让它们同时写 library.json 会互相覆盖。
 */
function recordExport({ payload, id, safe, base, outDir, canvasFile, previewFile, bytes, timings, elapsed }) {
  const { items, width, height, gutter } = payload;

  const manifest = {
    version: 2, id, name: safe, createdAt: new Date().toISOString(),
    canvas: { width, height }, limit: CANVAS_LIMIT, gutter,
    strategy: payload.strategy ?? null,
    items: items.map((it, i) => ({
      id: it.id ?? `item-${i}`, name: it.name, source: it.source, format: it.format ?? null,
      // 排版时转过 90° 的，切分时要转回来。natural 记用户看到的原始朝向尺寸。
      rotation: it.rotation ?? 0,
      natural: it.natural ?? { width: it.crop.width, height: it.crop.height },
      crop: { left: it.crop.left, top: it.crop.top, width: it.crop.width, height: it.crop.height },
    })),
  };
  const manifestFile = path.join(outDir, `${base}.manifest.json`);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const entry = {
    id, name: safe, createdAt: manifest.createdAt,
    canvasFile, manifestFile, previewFile,
    canvas: { width, height }, count: items.length,
    bytes, elapsed, timings,
  };
  const lib = readLibrary();
  lib.batches.unshift(entry);
  writeLibrary(lib);

  return {
    ...entry,
    url: 'pcfile://local' + encodeURI(canvasFile),
    previewUrl: 'pcfile://local' + encodeURI(previewFile),
    hint: capacityHint({ width, height, util: items.reduce((s, it) => s + it.crop.width * it.crop.height, 0) / (width * height) }, CANVAS_LIMIT),
  };
}

/**
 * 导出**一张**画布（在主进程里直接跑）：合成 TIFF + 写 manifest + 生成预览 + 记进历史批次。
 * 「全部导出」走的是 worker 进程版本，见 export:composeAll。
 */
async function exportOne(payload, { suffix = '', onProgress } = {}) {
  const { items, name } = payload;
  if (!items?.length) throw new Error('画布上还没有图片');
  // 导出位置一律由设置推导：<父目录>/像素拼图导出。
  // 不信任渲染层传来的路径 —— 两边不一致时成片会散落到别的地方，用户找不到。
  const outDir = exportDirOf(readSettings());
  fs.mkdirSync(outDir, { recursive: true });
  // 把推导出来的目录写回 payload —— renderCanvas 是按 payload.outDir 落盘的，
  // 不覆盖的话渲染层传了个旧路径就会写到别处去（成片和 manifest 分家）。
  payload = { ...payload, outDir };
  const id = shortId(6);
  const safe = (name || 'batch').replace(/[/\\:*?"<>|]/g, '_');
  const base = makeBaseName(name, id, suffix);
  const r = await renderCanvas({
    payload, base,
    onProgress: onProgress ?? ((p) => send('progress', p)),
  });
  return recordExport({ payload, id, safe, base, outDir, ...r });
}

/** 导出合成图 + manifest */
ipcMain.handle('export:compose', (_e, payload) => exportOne(payload));

/**
 * 在**独立进程**里跑一张画布。
 *
 * 为什么值得开进程：libvips 的 TIFF/JPEG 编码是单线程的（实测并行度 1.06×），
 * 一张画布再优化也只吃一个核。多开几个进程 = 把每张画布的压缩摊到多个核上。
 * 内存不够的机器 exportConcurrency() 会给出 1，那时退回主进程内顺序跑，行为跟以前完全一样。
 */
function runOneInWorker({ job, total, onProgress }) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { child?.kill(); } catch { /* 进程可能已经退了 */ }
      resolve(v);
    };

    try {
      child = utilityProcess.fork(EXPORT_WORKER, [], { serviceName: 'pixcake-export' });
    } catch (e) {
      resolve({ ok: false, error: `无法启动导出进程：${e.message}` });
      return;
    }

    child.on('message', (m) => {
      if (m?.type === 'progress') {
        onProgress({ index: job.index, total, progress: m.progress });
      } else if (m?.type === 'done') {
        finish({ ok: true, result: m.result });
      } else if (m?.type === 'error') {
        finish({ ok: false, error: m.error });
      }
    });
    child.on('exit', (code) => {
      if (!settled) finish({ ok: false, error: `导出进程异常退出（退出码 ${code}）` });
    });

    child.postMessage({
      jobId: job.index,
      payload: job.payload,
      base: job.base,
      panelConcurrency: job.panelConcurrency,
    });
  });
}

/**
 * 全部导出：一次把所有画布都产出（每张 = 一个 TIFF + 一个 manifest）。
 * 8 张画布 = 点一次。并行的进程数由内存和核数决定，低配 Mac 自动降到 1。
 */
ipcMain.handle('export:composeAll', async (_e, payload) => {
  const { canvases = [], ...rest } = payload;
  if (!canvases.length) return { total: 0, done: [], failed: [], workers: 0 };
  const settings = readSettings();
  // 同上：导出目录由设置推导，渲染层传什么都不作数
  const outDir = exportDirOf(settings);
  rest.outDir = outDir;
  fs.mkdirSync(outDir, { recursive: true });

  const jobs = canvases.map((c, i) => {
    const id = shortId(6);
    const suffix = canvases.length > 1 ? `_c${String(i + 1).padStart(2, '0')}` : '';
    return {
      index: i, id, suffix,
      safe: (rest.name || 'batch').replace(/[/\\:*?"<>|]/g, '_'),
      base: makeBaseName(rest.name, id, suffix),
      payload: { ...rest, ...c },
    };
  });

  const plan = exportConcurrency(canvases.map((c) => ({ width: c.width, height: c.height })), settings.exportJobs);
  // 多个进程同时开时，每个进程内部的解码并行度要收着点，否则 3 个进程 × 4 线程会把内存打满
  const perPanel = Math.max(1, Math.floor(plan.cores / plan.workers));
  for (const j of jobs) j.panelConcurrency = perPanel;

  const done = [];
  const failed = [];
  const active = new Map();        // index → 该画布内部的进度 0..1
  const liveTimings = new Map();   // index → 该画布当前的阶段耗时
  let lastDone = null;             // { index, timings } 最近完成的那张

  /**
   * 阶段耗时必须**钉住一张画布**显示。
   * 并行时三张画布各报各的，早期版本每帧都跟着最后一条消息换 ——
   * 结果上面的"第 N 张"和下面的阶段列表一起乱跳（用户报的"跳来跳去"就是这个）。
   * 规则：有在跑的就取序号最小的那张；全在收尾了就显示最近完成的那张。
   */
  const pickTimings = () => {
    const running = [...active.keys()].sort((a, b) => a - b);
    if (running.length) {
      const i = running[0];
      return { title: `阶段耗时（第 ${i + 1} 张画布）`, timings: liveTimings.get(i) ?? [], live: true };
    }
    if (lastDone) return { title: `阶段耗时（第 ${lastDone.index + 1} 张，已完成）`, timings: lastDone.timings, live: false };
    return { title: '', timings: [], live: false };
  };

  const broadcast = (extra) => {
    const finished = done.length + failed.length;
    const running = [...active.keys()].sort((a, b) => a - b).map((i) => i + 1);
    // 数字怎么算全部收在 progress.mjs 里（对着单测改，别在这里现推）
    const p = batchProgress({ total: jobs.length, finished, active: [...active.values()], running });

    const t = pickTimings();
    send('progress', {
      stage: 'batch', pct: p.pct, message: p.message,
      timings: t.timings, timingsTitle: t.title, timingsLive: t.live,
      workers: plan.workers, finished: p.finished, total: p.total, running,
      ...extra,
    });
  };

  const useWorkers = plan.workers > 1 && jobs.length > 1;
  broadcast({ title: `并行 ${plan.workers} 个进程（${plan.reason}）` });

  const finalize = (job, r) => {
    active.delete(job.index);
    liveTimings.delete(job.index);
    lastDone = { index: job.index, timings: r?.timings ?? [] };
    try {
      const entry = recordExport({ payload: job.payload, id: job.id, safe: job.safe, base: job.base, outDir, ...r });
      done.push({ index: job.index, ...entry });
    } catch (e) {
      failed.push({ index: job.index, error: e.message });
    }
  };

  if (!useWorkers) {
    // 顺序跑（内存吃紧的机器），行为和 v3 一样，只是多了阶段耗时
    for (const job of jobs) {
      try {
        const r = await renderCanvas({
          payload: job.payload, base: job.base,
          panelConcurrency: perPanel,
          onProgress: (p) => {
            active.set(job.index, p.pct ?? 0);
            liveTimings.set(job.index, p.timings ?? []);
            broadcast({});
          },
        });
        finalize(job, r);
      } catch (e) {
        active.delete(job.index);
        failed.push({ index: job.index, error: e.message });
      }
    }
  } else {
    const queue = [...jobs];
    const worker = async () => {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        const r = await runOneInWorker({
          job, total: jobs.length,
          onProgress: ({ progress }) => {
            active.set(job.index, progress.pct ?? 0);
            liveTimings.set(job.index, progress.timings ?? []);
            broadcast({});
          },
        });
        if (r.ok) {
          finalize(job, r.result);
          // 关键：finalize 之后必须再广播一次。
          // 否则"已完成 N/M"要等到下一张画布有进度时才更新 —— 最后一张永远追不上，
          // 浮层会一直停在旧数字上（实测 3 张并行时曾停在 0/3）。
          broadcast({});
        } else { active.delete(job.index); failed.push({ index: job.index, error: r.error }); broadcast({}); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(plan.workers, jobs.length) }, worker));
  }

  broadcast({ pct: 1 });
  return { total: jobs.length, done, failed, workers: useWorkers ? plan.workers : 1, plan };
});


/** 切回原图 */
ipcMain.handle('recover:split', async (_e, payload) => {
  const { manifestFile, returnedFile, outDir, format, quality, keepExif } = payload;
  const settings = readSettings();
  const dest = outDir || recoverDirOf(settings);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const report = await splitCanvas({
    returnedFile, manifest, outDir: dest,
    format: format || 'jpeg', quality: quality ?? 14, keepExif: keepExif !== false,
    concurrency: splitPlan(settings.splitJobs).workers,
    onProgress: (p) => send('progress', p),
  });
  const lib = readLibrary();
  const b = lib.batches.find((x) => x.id === manifest.id);
  if (b) { b.lastRecoverAt = new Date().toISOString(); b.lastRecoverOut = dest; writeLibrary(lib); }
  return report;
});

ipcMain.handle('library:list', () => {
  const lib = readLibrary();
  return { ...lib, ledger: ledgerView() };
});
ipcMain.handle('library:forget', (_e, id) => {
  const lib = readLibrary();
  lib.batches = lib.batches.filter((b) => b.id !== id);
  writeLibrary(lib);
  // 移除一条批次 = 把这一次省下的额度也从账上扣掉（用户"这批只是测试"的诉求）
  return { ...lib, ledger: ledgerView() };
});

/** 一键清空历史批次。只动 library.json，不删用户磁盘上的成片。 */
ipcMain.handle('library:clear', () => {
  writeLibrary({ batches: [] });
  return { batches: [], ledger: ledgerView() };
});

/**
 * 扫目录找成片。
 * 不传目录就扫当前的导出目录 —— 这是常规路径：用户刚导出的成片就在那儿，
 * 不该让他手动一个个挑。手选文件只留给特殊情况（换过目录、分批导过）。
 */
ipcMain.handle('recover:scan', (_e, dir) => {
  const target = dir || exportDirOf(readSettings());
  return { dir: target, ...scanDirForCanvases(target) };
});

/** 从一个文件反查它的 sidecar manifest（用户直接把修完的图拖进来时用） */
ipcMain.handle('manifest:findFor', (_e, file, opts) => findManifestFor(file, opts));

// ─────────────────────── 会话：退出重进别丢工作 ───────────────────────
// 用户的原话是「退出重进就所有东西都消失了」。导入 + 排版是花时间的事，
// 顺手存在本地，下次打开自动接上（PC_DEMO 演示模式除外）。
function sessionFile() { return path.join(app.getPath('userData'), 'session.json'); }

ipcMain.handle('session:save', (_e, data = {}) => {
  try {
    fs.writeFileSync(sessionFile(), JSON.stringify(sessionPayload(data)));
  } catch { /* 存不下就算了，不能因为会话存盘失败挡住用户干活 */ }
  return true;
});

ipcMain.handle('session:load', () => {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(sessionFile(), 'utf8')); } catch { return null; }
  return pruneSession(raw, { exists: (p) => fs.existsSync(p) });
});

ipcMain.handle('session:clear', () => {
  try { fs.unlinkSync(sessionFile()); } catch { /* 本来就没有 */ }
  return true;
});

/**
 * 批量切回 · 第一步：先只做「配对」，不动像素。
 * 让用户看清楚哪几个文件能切、各能切出几张、哪个配不上记录，再决定要不要全切。
 * 配不上就**不动**，绝不猜 —— 猜错会把别人的画布切坏。
 */
ipcMain.handle('recover:plan', (_e, { files = [], exactOnly = false } = {}) => planRecover(files, { exactOnly }));

/**
 * 批量切回 · 第二步：一次把所有画布都切回原图并搬回 EXIF。
 * 9 张画布 = 点一次，不用来回切 9 次。单个文件失败不影响其它文件。
 */
ipcMain.handle('recover:splitMany', async (_e, payload) => {
  const { files = [], outDir, format, quality, keepExif } = payload;
  if (!files.length) return { total: 0, done: [], failed: [], outputs: 0, lossless: 0, warnings: [] };
  const settings = readSettings();
  const dest = outDir || recoverDirOf(settings);

  // 一个**全局**闸门管住所有画布的所有刀，而不是每张画布各管各的：
  // 画布有的 4 刀有的 2 刀，按文件加锁会在小画布上跑不满 CPU。
  const concurrency = splitPlan(settings.splitJobs).workers;
  const gate = createLimiter(concurrency);

  const done = [];
  const failed = [];
  let finishedFiles = 0;

  await Promise.all(files.map(async (f, i) => {
    const label = `第 ${i + 1}/${files.length} 张画布`;
    try {
      send('progress', {
        stage: 'batch', pct: finishedFiles / files.length,
        message: `${label} · 正在读成片…（${path.basename(f)}）`,
        workers: concurrency, finished: finishedFiles, total: files.length,
      });
      const found = findManifestFor(f);
      if (!found) throw new Error('找不到配套的 .manifest.json');
      const report = await splitCanvas({
        returnedFile: f, manifest: found.manifest, outDir: dest,
        format: format || 'jpeg', quality: quality ?? 14, keepExif: keepExif !== false,
        limiter: gate,
        onProgress: (p) => {
          send('progress', {
            ...p,
            message: `${label} · ${p.message}`,
            workers: concurrency, finished: finishedFiles, total: files.length,
          });
        },
      });
      const lib = readLibrary();
      const b = lib.batches.find((x) => x.id === found.manifest.id);
      if (b) { b.lastRecoverAt = new Date().toISOString(); b.lastRecoverOut = dest; writeLibrary(lib); }
      done.push({
        index: i, file: f, name: path.basename(f), manifestFile: found.manifestFile,
        outputs: report.outputs.length,
        lossless: report.outputs.filter((o) => o.lossless).length,
        warnings: report.warnings,
        timings: report.timings,
      });
    } catch (e) {
      failed.push({ index: i, file: f, name: path.basename(f), error: e.message });
    }
    finishedFiles++;
    send('progress', {
      stage: 'batch', pct: finishedFiles / files.length,
      message: `已切回 ${finishedFiles}/${files.length} 张画布`,
      workers: concurrency, finished: finishedFiles, total: files.length,
    });
  }));

  done.sort((a, b) => a.index - b.index);
  failed.sort((a, b) => a.index - b.index);
  return {
    total: files.length, done, failed, workers: concurrency,
    outputs: done.reduce((s, d) => s + d.outputs, 0),
    lossless: done.reduce((s, d) => s + d.lossless, 0),
    warnings: done.flatMap((d) => d.warnings ?? []),
  };
});

ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));

// ─────────────────────────── 窗口 ───────────────────────────
function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1440, height: 920,
    minWidth: 1120, minHeight: 720,
    show: false,
    backgroundColor: '#131215',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(ROOT, 'dist/index.html'));
  }
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // 开发期 UI 冒烟：真的从界面点一次「导出合成图」，验证 IPC → sharp → 磁盘 整条链路
  if (process.env.PC_SMOKE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const log = (m) => console.log('[smoke]', m);
        try {
          const before = readLibrary().batches.length;
          const clicked = await win.webContents.executeJavaScript(`(() => {
            const label = (x) => x.textContent.trim();
            const b = [...document.querySelectorAll('button')].find(x =>
              ['导出合成图', '只导出当前这张'].includes(label(x)) || label(x).startsWith('全部导出'));
            if (!b) return 'no-button';
            if (b.disabled) return 'disabled';
            b.click(); return 'clicked:' + label(b);
          })()`);
          log('点击导出：' + clicked);
          // 「全部导出 (N)」要等 N 张画布全部写完，不能看到第一条批次就收工
          const expect = Number((clicked.match(/\((\d+)\)/) ?? [])[1] ?? 1);
          for (let i = 0; i < 240; i++) {
            await new Promise((r) => setTimeout(r, 1500));
            const lib = readLibrary();
            const fresh = lib.batches.slice(0, lib.batches.length - before);
            if (fresh.length >= expect) {
              for (const b of fresh.reverse()) {
                const ok = fs.existsSync(b.canvasFile) && fs.existsSync(b.manifestFile);
                const md = ok ? await sharpMeta(b.canvasFile) : null;
                log(`产物 OK=${ok} 文件=${path.basename(b.canvasFile)} 尺寸=${md ? md.width + '×' + md.height : '?'} 大小=${(b.bytes / 1024 / 1024).toFixed(0)}MB 耗时=${b.elapsed}ms`);
                log('  manifest 条目=' + JSON.parse(fs.readFileSync(b.manifestFile, 'utf8')).items.length);
              }
              log(`共产出 ${fresh.length}/${expect} 张画布`);
              if (process.env.PC_SHOT) {
                const img = await win.webContents.capturePage();
                fs.writeFileSync(process.env.PC_SHOT, img.toPNG());
                log('screenshot → ' + process.env.PC_SHOT);
              }
              app.exit(fresh.every((b) => fs.existsSync(b.canvasFile)) ? 0 : 2);
              return;
            }
          }
          log(`超时：360 秒内只等到 ${readLibrary().batches.length - before}/${expect} 张`);
          app.exit(3);
        } catch (e) {
          log('异常：' + e.message);
          app.exit(4);
        }
      }, Number(process.env.PC_SMOKE_DELAY || 6000));
    });
  }

  // 开发期验收用：PC_SHOT=/tmp/x.png 启动，自动截图后退出
  if (process.env.PC_SHOT && !process.env.PC_SMOKE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // PC_DRAGTEST=1：真的模拟一次拖动，验证"图能拖得动"（v1 的硬推挤让拖动等于没拖）。
          // 用 sendInputEvent 注入**真实鼠标输入** —— 合成 PointerEvent 进不了 React 的委托系统，
          // 而且真实输入才能验证 pointer capture / 事件链路。
          if (process.env.PC_DRAGTEST) {
            const info = JSON.parse(await win.webContents.executeJavaScript(`(() => {
              const els = [...document.querySelectorAll('.canvas-item')];
              if (!els.length) return JSON.stringify({ err: 'stage 上没有图片' });
              const items = window.__pcDebug?.items ?? [];
              const el = els[els.length - 1];
              const b = el.getBoundingClientRect();
              // 事件计数：判断 pointermove 到底有没有到达 .stage（与 React 无关）
              window.__mc = { move: 0, down: 0, up: 0 };
              const stage = document.querySelector('.stage');
              stage.addEventListener('pointermove', () => window.__mc.move++, true);
              stage.addEventListener('pointerdown', () => window.__mc.down++, true);
              stage.addEventListener('pointerup', () => window.__mc.up++, true);
              return JSON.stringify({
                before: items.map(i => ({ name: i.name, x: i.x, y: i.y })),
                name: items[items.length - 1]?.name,
                domItems: els.map(e => ({
                  alt: e.querySelector('img')?.alt,
                  left: e.style.left, top: e.style.top,
                  w: e.style.width, h: e.style.height,
                })),
                rect: document.querySelector('.canvas-rect')?.getBoundingClientRect().toJSON(),
                sx: Math.round(b.left + b.width / 2),
                sy: Math.round(b.top + b.height / 2),
              });
            })()`));

            if (info.err) {
              console.log('[drag] ✘', info.err);
            } else {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              // 先把光标移到目标上（真实鼠标一定有这一步，Chromium 也借此确定指针位置），
              // 否则第一次 mouseMove 可能被当成"建立位置"而丢掉。
              win.webContents.sendInputEvent({ type: 'mouseMove', x: info.sx, y: info.sy });
              await sleep(120);
              win.webContents.sendInputEvent({ type: 'mouseDown', x: info.sx, y: info.sy, button: 'left', clickCount: 1 });
              await sleep(220);
              if (process.env.PC_DEBUG) {
                const d = await win.webContents.executeJavaScript(
                  `JSON.stringify({ drag: window.__pcDrag ?? null, selected: window.__pcDebug?.selectedId ?? null, events: window.__mc })`);
                console.log('[drag] mousedown 之后：', d);
              }
              for (let k = 1; k <= 10; k++) {
                win.webContents.sendInputEvent({
                  type: 'mouseMove', x: info.sx + k * 24, y: info.sy + k * 24, button: 'left',
                });
                await sleep(70);
              }
              const ex = info.sx + 240, ey = info.sy + 240;
              win.webContents.sendInputEvent({ type: 'mouseMove', x: ex, y: ey, button: 'left' });
              await sleep(90);
              if (process.env.PC_DEBUG) {
                const d = await win.webContents.executeJavaScript(
                  `JSON.stringify({ drag: window.__pcDrag ?? null, events: window.__mc })`);
                console.log('[drag] mousemove 之后：', d);
              }
              win.webContents.sendInputEvent({ type: 'mouseUp', x: ex, y: ey, button: 'left', clickCount: 1 });
              await sleep(800);

              const after = JSON.parse(await win.webContents.executeJavaScript(
                `JSON.stringify({ items: (window.__pcDebug?.items ?? []).map(i => ({ name: i.name, x: i.x, y: i.y })), events: window.__mc })`));
              const b = info.before.find((i) => i.name === info.name);
              const a = after.items.find((i) => i.name === info.name);
              const moved = b && a && (b.x !== a.x || b.y !== a.y);
              const delivered = (after.events?.move ?? 0) > 0 && (after.events?.down ?? 0) > 0;

              if (!delivered) {
                // 注入的鼠标事件没送到页面 —— 这是测试环境的问题，不是 app 的问题，不能报失败
                console.log('[drag] ⚠ 无法判定：注入的鼠标事件没有送达渲染进程（交互需人工确认）');
              } else {
                console.log('[drag]', moved
                  ? `✔ 拖得动：${info.name} (${b.x},${b.y}) → (${a.x},${a.y})  [事件 move=${after.events.move} down=${after.events.down}]`
                  : `✘ 拖不动：${info.name} 停在 (${a?.x},${a?.y})  [事件 move=${after.events.move} down=${after.events.down}]`);
              }
            }
          }

          // PC_EVAL='<js>'：截图之前在页面里跑一段 JS（开发期验收用，比如点一下某个按钮）
          if (process.env.PC_EVAL) {
            const r = await win.webContents.executeJavaScript(process.env.PC_EVAL, true);
            console.log('[eval]', typeof r === 'string' ? r : JSON.stringify(r));
            await new Promise((res) => setTimeout(res, Number(process.env.PC_EVAL_WAIT || 900)));
          }

          const dump = await win.webContents.executeJavaScript(`(() => {
            const r = document.querySelector('.canvas-rect');
            const items = [...document.querySelectorAll('.canvas-item')];
            const wrap = document.querySelector('.canvas-wrap');
            return JSON.stringify({
              state: window.__pcDebug ? {
                items: window.__pcDebug.items.length,
                canvas: window.__pcDebug.canvas,
                canvases: window.__pcDebug.canvases,
                firstUrl: window.__pcDebug.items[0] && window.__pcDebug.items[0].url,
              } : null,
              rect: r ? r.getBoundingClientRect().toJSON() : null,
              rectStyle: r ? getComputedStyle(r).width + ' x ' + getComputedStyle(r).height : null,
              items: items.length,
              wrapTransform: wrap ? getComputedStyle(wrap).transform : null,
              canvasRows: document.querySelectorAll('.cl-row').length,
              capBig: document.querySelector('.cap-big')?.textContent ?? null,
              imgComplete: items.map(i => { const im = i.querySelector('img'); return im ? im.complete + ':' + im.naturalWidth : 'none'; }),
            });
          })()`);
          if (process.env.PC_DEBUG) console.log('[dom]', dump);
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.PC_SHOT, img.toPNG());
          console.log('screenshot →', process.env.PC_SHOT);
        } catch (e) { console.error('screenshot failed', e.message); }
        app.exit(0);
      }, Number(process.env.PC_SHOT_DELAY || 3000));
    });
  }
}

app.whenReady().then(() => {
  protocol.handle('pcfile', async (request) => {
    try {
      const u = new URL(request.url);
      // 正常情况：主机名是 local，真实路径在 pathname 里
      let p = decodeURIComponent(u.pathname);
      if (!fs.existsSync(p) && u.hostname && u.hostname !== 'local') {
        // 兜底：某些情况下首个路径段会被当成主机名，拼回来再试
        p = decodeURIComponent('/' + u.hostname + u.pathname);
      }
      if (process.env.PC_DEBUG) console.log('[pcfile]', p, fs.existsSync(p) ? 'OK' : 'MISSING');
      const data = await fs.promises.readFile(p);
      const ext = path.extname(p).toLowerCase();
      const mime = ext === '.png' ? 'image/png'
        : (ext === '.tif' || ext === '.tiff') ? 'image/tiff'
          : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
      return new Response(data, { headers: { 'content-type': mime, 'cache-control': 'no-cache' } });
    } catch (e) {
      return new Response('not found: ' + e.message, { status: 404 });
    }
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
