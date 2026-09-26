import { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import sharpLib from 'sharp';
import { probeImage, makeThumb, shortId, IMAGE_EXT } from './services/library.mjs';

const sharpMeta = (f) => sharpLib(f, { unlimited: true }).metadata();
import { planGroups, packCanvas, CANVAS_LIMIT, capacityHint } from './services/layout.mjs';
import { composeCanvas, makeCanvasPreview } from './services/render.mjs';
import { splitCanvas } from './services/split.mjs';

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
  const r = packCanvas(images, { limit: CANVAS_LIMIT, gutter: opts.gutter ?? 24 });
  return { ...r, hint: r.placed.length ? capacityHint(r, CANVAS_LIMIT) : null };
});

/** 分组规划：装不下就拆成多张画布，最小化画布数量 */
ipcMain.handle('layout:plan', (_e, images, opts = {}) => {
  const plan = planGroups(images, { limit: CANVAS_LIMIT, gutter: opts.gutter ?? 24 });
  return {
    canvases: plan.canvases.map((c) => ({ ...c, hint: capacityHint(c, CANVAS_LIMIT) })),
    unplaceable: plan.unplaceable,
  };
});

/** 导出合成图 + manifest */
ipcMain.handle('export:compose', async (_e, payload) => {
  const { items, width, height, gutter, name, outDir, icc, compression } = payload;
  fs.mkdirSync(outDir, { recursive: true });
  const id = shortId(6);
  const safe = (name || 'batch').replace(/[/\\:*?"<>|]/g, '_');
  const base = `TILE_${safe}_${id}`;
  const canvasFile = path.join(outDir, `${base}.tif`);

  const started = Date.now();
  const res = await composeCanvas({
    items, width, height, gutter,
    outFile: canvasFile, icc: icc || 'srgb', compression: compression || 'lzw',
    onProgress: (p) => send('progress', p),
  });

  const manifest = {
    version: 1, id, name: safe, createdAt: new Date().toISOString(),
    canvas: { width, height }, limit: CANVAS_LIMIT, gutter,
    strategy: payload.strategy ?? null,
    items: items.map((it, i) => ({
      id: it.id ?? `item-${i}`, name: it.name, source: it.source, format: it.format ?? null,
      natural: { width: it.crop.width, height: it.crop.height },
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
ipcMain.handle('manifest:findFor', (_e, file) => {
  const dir = path.dirname(file);
  const stem = path.basename(file).replace(/\.[^.]+$/, '');
  const cands = fs.readdirSync(dir).filter((f) => f.endsWith('.manifest.json'));
  for (const c of cands) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, c), 'utf8'));
      if (m.canvas && (c.startsWith(stem) || stem.startsWith(c.replace('.manifest.json', '')))) {
        return { manifestFile: path.join(dir, c), manifest: m };
      }
    } catch { /* 跳过坏文件 */ }
  }
  return null;
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
            const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '导出合成图');
            if (!b) return 'no-button';
            if (b.disabled) return 'disabled';
            b.click(); return 'clicked';
          })()`);
          log('点击导出：' + clicked);
          for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 1500));
            const lib = readLibrary();
            if (lib.batches.length > before) {
              const b = lib.batches[0];
              const ok = fs.existsSync(b.canvasFile) && fs.existsSync(b.manifestFile);
              const md = ok ? await sharpMeta(b.canvasFile) : null;
              log(`产物 OK=${ok} 文件=${path.basename(b.canvasFile)} 尺寸=${md ? md.width + '×' + md.height : '?'} 大小=${(b.bytes / 1024 / 1024).toFixed(0)}MB 耗时=${b.elapsed}ms`);
              log('manifest 条目=' + JSON.parse(fs.readFileSync(b.manifestFile, 'utf8')).items.length);
              if (process.env.PC_SHOT) {
                const img = await win.webContents.capturePage();
                fs.writeFileSync(process.env.PC_SHOT, img.toPNG());
                log('screenshot → ' + process.env.PC_SHOT);
              }
              app.exit(ok ? 0 : 2);
              return;
            }
          }
          log('超时：60 秒内没等到产物');
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
          const dump = await win.webContents.executeJavaScript(`(() => {
            const r = document.querySelector('.canvas-rect');
            const items = [...document.querySelectorAll('.canvas-item')];
            const wrap = document.querySelector('.canvas-wrap');
            return JSON.stringify({
              state: window.__pcDebug ? {
                items: window.__pcDebug.items.length,
                canvas: window.__pcDebug.canvas,
                firstUrl: window.__pcDebug.items[0] && window.__pcDebug.items[0].url,
                firstImgSrc: items[0] && items[0].querySelector('img') && items[0].querySelector('img').src,
              } : null,
              rect: r ? r.getBoundingClientRect().toJSON() : null,
              rectStyle: r ? getComputedStyle(r).width + ' x ' + getComputedStyle(r).height + ' bg=' + getComputedStyle(r).backgroundColor : null,
              items: items.length,
              wrapTransform: wrap ? getComputedStyle(wrap).transform : null,
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
