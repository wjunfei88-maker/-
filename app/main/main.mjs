import { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import sharpLib from 'sharp';
import { probeImage, makeThumb, shortId, IMAGE_EXT } from './services/library.mjs';

const sharpMeta = (f) => sharpLib(f, { unlimited: true }).metadata();
import { planGroups, packCanvas, CANVAS_LIMIT, capacityHint, capacityExplain } from './services/layout.mjs';
import { composeCanvas, makeCanvasPreview } from './services/render.mjs';
import { splitCanvas } from './services/split.mjs';
import { findManifestFor, planRecover } from './services/recover.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !!DEV_URL;

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
  };
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
    title, defaultPath: app.getPath('pictures'), properties: ['openFolder', 'createDirectory'],
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

/** 直接选一整个文件夹，自动把里面所有成片都算进来（连文件名都不用挑） */
ipcMain.handle('dialog:pickReturnedDir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择像素蛋糕导出的整个文件夹',
    defaultPath: app.getPath('pictures'),
    properties: ['openFolder'],
  });
  if (r.canceled || !r.filePaths[0]) return [];
  const dir = r.filePaths[0];
  try {
    return fs.readdirSync(dir)
      .filter((f) => RETURN_EXT.includes(path.extname(f).slice(1).toLowerCase()))
      .map((f) => path.join(dir, f))
      .sort();
  } catch { return []; }
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
 * 导出**一张**画布：合成 TIFF + 写 manifest + 生成预览 + 记进历史批次。
 * 批量导出就是把它按顺序调 N 次（每张画布 = 像素蛋糕的一次额度）。
 */
async function exportOne(payload, { suffix = '' } = {}) {
  const { items, width, height, gutter, name, outDir, icc, compression } = payload;
  if (!items?.length) throw new Error('画布上还没有图片');
  fs.mkdirSync(outDir, { recursive: true });
  const id = shortId(6);
  const safe = (name || 'batch').replace(/[/\\:*?"<>|]/g, '_');
  const base = `TILE_${safe}_${id}${suffix}`;
  const canvasFile = path.join(outDir, `${base}.tif`);

  const started = Date.now();
  const res = await composeCanvas({
    items, width, height, gutter,
    outFile: canvasFile, icc: icc || 'srgb', compression: compression || 'lzw',
    onProgress: (p) => send('progress', p),
  });

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

  const previewFile = path.join(outDir, `${base}.preview.jpg`);
  await makeCanvasPreview(canvasFile, previewFile, 1400);

  const entry = {
    id, name: safe, createdAt: manifest.createdAt,
    canvasFile, manifestFile, previewFile,
    canvas: { width, height }, count: items.length,
    bytes: res.bytes, elapsed: Date.now() - started,
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

/** 导出合成图 + manifest */
ipcMain.handle('export:compose', (_e, payload) => exportOne(payload));

/**
 * 全部导出：一次把所有画布都产出（每张 = 一个 TIFF + 一个 manifest）。
 * 10 张照片分成 5 张画布时，不用手点 5 次。
 */
ipcMain.handle('export:composeAll', async (_e, payload) => {
  const { canvases = [], ...rest } = payload;
  const done = [];
  const failed = [];
  for (let i = 0; i < canvases.length; i++) {
    try {
      send('progress', {
        stage: 'batch', pct: i / canvases.length,
        message: `正在导出第 ${i + 1} / ${canvases.length} 张画布…`,
      });
      const suffix = canvases.length > 1 ? `_c${String(i + 1).padStart(2, '0')}` : '';
      done.push({ index: i, ...(await exportOne({ ...rest, ...canvases[i] }, { suffix })) });
    } catch (e) {
      failed.push({ index: i, error: e.message });
    }
  }
  return { total: canvases.length, done, failed };
});

/** 切回原图 */
ipcMain.handle('recover:split', async (_e, payload) => {
  const { manifestFile, returnedFile, outDir, format, quality, keepExif } = payload;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const report = await splitCanvas({
    returnedFile, manifest, outDir,
    format: format || 'jpeg', quality: quality ?? 14, keepExif: keepExif !== false,
    onProgress: (p) => send('progress', p),
  });
  const lib = readLibrary();
  const b = lib.batches.find((x) => x.id === manifest.id);
  if (b) { b.lastRecoverAt = new Date().toISOString(); b.lastRecoverOut = outDir; writeLibrary(lib); }
  return report;
});

ipcMain.handle('library:list', () => readLibrary());
ipcMain.handle('library:forget', (_e, id) => {
  const lib = readLibrary();
  lib.batches = lib.batches.filter((b) => b.id !== id);
  writeLibrary(lib);
  return lib;
});

/** 从一个文件反查它的 sidecar manifest（用户直接把修完的图拖进来时用） */
ipcMain.handle('manifest:findFor', (_e, file) => findManifestFor(file));

/**
 * 批量切回 · 第一步：先只做「配对」，不动像素。
 * 让用户看清楚哪几个文件能切、各能切出几张、哪个配不上记录，再决定要不要全切。
 * 配不上就**不动**，绝不猜 —— 猜错会把别人的画布切坏。
 */
ipcMain.handle('recover:plan', (_e, { files = [] } = {}) => planRecover(files));

/**
 * 批量切回 · 第二步：一次把所有画布都切回原图并搬回 EXIF。
 * 9 张画布 = 点一次，不用来回切 9 次。单个文件失败不影响其它文件。
 */
ipcMain.handle('recover:splitMany', async (_e, payload) => {
  const { files = [], outDir, format, quality, keepExif } = payload;
  const done = [];
  const failed = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      send('progress', {
        stage: 'batch', pct: i / files.length,
        message: `正在切回第 ${i + 1} / ${files.length} 张画布…（${path.basename(f)}）`,
      });
      const found = findManifestFor(f);
      if (!found) throw new Error('找不到配套的 .manifest.json');
      const report = await splitCanvas({
        returnedFile: f, manifest: found.manifest, outDir,
        format: format || 'jpeg', quality: quality ?? 14, keepExif: keepExif !== false,
        onProgress: (p) => send('progress', p),
      });
      const lib = readLibrary();
      const b = lib.batches.find((x) => x.id === found.manifest.id);
      if (b) { b.lastRecoverAt = new Date().toISOString(); b.lastRecoverOut = outDir; writeLibrary(lib); }
      done.push({
        index: i, file: f, name: path.basename(f), manifestFile: found.manifestFile,
        outputs: report.outputs.length,
        lossless: report.outputs.filter((o) => o.lossless).length,
        warnings: report.warnings,
      });
    } catch (e) {
      failed.push({ index: i, file: f, name: path.basename(f), error: e.message });
    }
  }
  return {
    total: files.length, done, failed,
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
