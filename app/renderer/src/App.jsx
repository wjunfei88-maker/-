import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Stage from './components/Stage.jsx';
import Filmstrip from './components/Filmstrip.jsx';
import Inspector from './components/Inspector.jsx';
import { TopBar, StatusBar, Toasts, ProgressOverlay } from './components/Chrome.jsx';
import { resolvePlacement, validateCanvas, tightBounds } from './lib/geom.js';

const pc = window.pc;
const LIMIT = 12000;

export default function App() {
  const [images, setImages] = useState([]);       // 已导入的底片
  const [items, setItems] = useState([]);         // 画布上的图
  const [canvas, setCanvas] = useState({ width: 0, height: 0 });
  const [gutter, setGutter] = useState(24);
  const [selectedId, setSelectedId] = useState(null);
  const [plan, setPlan] = useState(null);         // { canvases: [...], unplaceable: [...] }
  const [planIndex, setPlanIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [library, setLibrary] = useState({ batches: [] });
  const [message, setMessage] = useState('就绪');

  const [exp, setExp] = useState({ name: 'batch', outDir: '', compression: 'lzw', icc: 'srgb' });
  const [rec, setRec] = useState({
    returnedFile: null, matched: null, outDir: '', format: 'jpeg', quality: 14, keepExif: true,
  });

  const toast = useCallback((title, body, kind = 'ok', ttl = 5200) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => (t.some((x) => x.title === title && x.body === body)
      ? t : [...t, { id, title, body, kind }]));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl);
  }, []);

  const bootRef = useRef(false);
  useEffect(() => pc.info().then((i) => {
    setExp((e) => ({ ...e, outDir: i.home + '/像素拼图输出' }));
    setRec((r) => ({ ...r, outDir: i.home + '/像素拼图输出/切回' }));
    // 开发期演示：PC_DEMO=<目录> 启动时自动导入并排版
    if (i.demoFiles?.length && !bootRef.current) {
      bootRef.current = true;
      setTimeout(() => demoBoot(i.demoFiles), 120);
    }
  }), []);

  useEffect(() => pc.library().then(setLibrary), []);
  useEffect(() => pc.onProgress((p) => setProgress(p)), []);

  // ── 导入 ──
  const importList = useCallback(async (list) => {
    setBusy(true); setMessage('正在读取照片…');
    try {
      const got = await pc.importImages(list);
      const good = got.filter((g) => !g.error);
      const bad = got.filter((g) => g.error);
      setImages((prev) => {
        const seen = new Set(prev.map((p) => p.path));
        return [...prev, ...good.filter((g) => !seen.has(g.path))];
      });
      if (bad.length) toast(`${bad.length} 张读取失败`, bad[0].error, 'err');
      setMessage(`已导入 ${good.length} 张`);
      return good;
    } catch (e) {
      toast('导入失败', e.message, 'err');
      return [];
    } finally { setBusy(false); setProgress(null); }
  }, [toast]);

  const addImages = useCallback(async (paths) => {
    const list = paths?.length ? paths : await pc.pickImages();
    if (!list?.length) return;
    return importList(list);
  }, [importList]);

  // ── 自动排版 ──
  const layoutFor = useCallback(async (imgs) => {
    setBusy(true); setMessage('正在计算排版…');
    try {
      const r = await pc.planLayout(imgs.map((i) => ({
        id: i.id, name: i.name, path: i.path, width: i.width, height: i.height, format: i.format,
      })), { gutter });
      if (!r.canvases.length) {
        toast('排不下', '这些照片单张就超过了 12000px 上限。', 'err');
        return;
      }
      setPlan(r);
      setPlanIndex(0);
      loadCanvas(r.canvases[0], imgs);
      const saved = imgs.length - r.canvases.reduce((s, c) => s + c.placed.length, 0);
      setMessage(r.canvases.length === 1
        ? `排成 1 张画布 · ${r.canvases[0].placed.length} 张`
        : `分成 ${r.canvases.length} 张画布（省 ${(100 - (r.canvases.length / imgs.length) * 100).toFixed(0)}% 额度）`);
      if (r.canvases.length > 1) {
        toast(`分成 ${r.canvases.length} 张画布`,
          `${imgs.length} 张照片装不进一张画布（单边上限 12000px），已自动分组。` +
          `每张画布对应像素蛋糕的一次额度。`, 'ok', 8000);
      }
      if (r.unplaceable.length) toast(`${r.unplaceable.length} 张无法处理`, '它们单边就超过了 12000px。', 'err');
      if (saved > 0 && !r.unplaceable.length) toast('部分照片没排进去', `${saved} 张暂时放不下`, 'err');
    } catch (e) {
      toast('排版失败', e.message, 'err');
    } finally { setBusy(false); setProgress(null); }
  }, [gutter, toast]);

  const autoLayout = useCallback(() => layoutFor(images), [layoutFor, images]);

  const demoBoot = useCallback(async (files) => {
    const got = await importList(files);
    if (got?.length) layoutFor(got);
  }, []);

  const loadCanvas = useCallback((c, imgs) => {
    const byId = new Map((imgs || []).map((i) => [i.id, i]));
    setItems(c.placed.map((p) => {
      const src = byId.get(p.id) || {};
      return {
        id: p.id, name: src.name || p.name || p.id,
        x: p.x, y: p.y, width: p.w, height: p.h,
        url: src.url, source: src.path, format: src.format,
      };
    }));
    setCanvas({ width: c.width, height: c.height });
    setSelectedId(null);
  }, []);

  const gotoPlan = (i) => {
    if (!plan?.canvases[i]) return;
    setPlanIndex(i);
    loadCanvas(plan.canvases[i], images);
    setMessage(`第 ${i + 1} / ${plan.canvases.length} 张画布 · ${plan.canvases[i].placed.length} 张`);
  };

  // ── 移动 / 移除 ──
  const moveItem = useCallback((id, pos) => {
    setItems((prev) => {
      const it = prev.find((p) => p.id === id);
      if (!it) return prev;
      const others = prev.filter((p) => p.id !== id);
      const r = resolvePlacement(
        { x: pos.x ?? it.x, y: pos.y ?? it.y },
        { width: it.width, height: it.height },
        others, canvas, gutter, 14 / 0.25,
      );
      return prev.map((p) => (p.id === id ? { ...p, x: r.x, y: r.y } : p));
    });
  }, [canvas, gutter]);

  const removeItem = useCallback((id) => {
    setItems((prev) => prev.filter((p) => p.id !== id));
    setSelectedId((s) => (s === id ? null : s));
  }, []);

  const removeImage = useCallback((id) => {
    setImages((prev) => prev.filter((p) => p.id !== id));
    setItems((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setImages([]); setItems([]); setCanvas({ width: 0, height: 0 });
    setPlan(null); setSelectedId(null); setMessage('已清空');
  }, []);

  // ── 导出 ──
  const compose = useCallback(async () => {
    if (!items.length) return;
    if (!exp.outDir) { toast('还没选保存位置', '在右侧「导出合成图」里选一个文件夹。', 'err'); return; }
    setBusy(true); setMessage('正在合成…');
    try {
      const r = await pc.compose({
        items: items.map((it) => ({
          id: it.id, name: it.name, source: it.source, format: it.format,
          crop: { left: it.x, top: it.y, width: it.width, height: it.height },
        })),
        width: canvas.width, height: canvas.height,
        gutter, name: exp.name, outDir: exp.outDir,
        icc: exp.icc, compression: exp.compression,
        strategy: plan?.canvases[planIndex]?.strategy ?? null,
      });
      setLibrary(await pc.library());
      setRec((v) => ({ ...v, matched: { name: r.name, canvas: r.canvas, items: items.map((i) => ({ name: i.name })) }, manifestFile: r.manifestFile }));
      toast('合成完成', `${r.canvas.width}×${r.canvas.height} · ${(r.bytes / 1024 / 1024).toFixed(0)}MB\n${r.canvasFile}`, 'ok', 9000);
      setMessage(`已导出 ${r.canvas.width}×${r.canvas.height}`);
    } catch (e) {
      toast('合成失败', e.message, 'err');
    } finally { setBusy(false); setProgress(null); }
  }, [items, canvas, gutter, exp, plan, planIndex, toast]);

  // ── 切回原图 ──
  const pickReturned = useCallback(async () => {
    const f = await pc.pickFile('选择像素蛋糕修完导出的文件');
    if (!f) return;
    const found = await pc.findManifestFor(f);
    setRec((v) => ({ ...v, returnedFile: f, matched: found?.manifest ?? null, manifestFile: found?.manifestFile ?? null }));
    if (!found) toast('没找到合成记录', '同目录下需要有导出时生成的 .manifest.json', 'err');
  }, [toast]);

  const recover = useCallback(async () => {
    if (!rec.returnedFile || !rec.manifestFile) return;
    setBusy(true); setMessage('正在切分…');
    try {
      const rep = await pc.split({
        manifestFile: rec.manifestFile, returnedFile: rec.returnedFile,
        outDir: rec.outDir, format: rec.format, quality: rec.quality, keepExif: rec.keepExif,
      });
      const lossless = rep.outputs.filter((o) => o.lossless).length;
      toast(`切回 ${rep.outputs.length} 张`,
        `无损 ${lossless} 张 · 输出到 ${rec.outDir}` +
        (rep.warnings.length ? `\n⚠️ ${rep.warnings.join('；')}` : ''),
        rep.warnings.length ? 'err' : 'ok', 9000);
      setMessage(`已切回 ${rep.outputs.length} 张`);
    } catch (e) {
      toast('切分失败', e.message, 'err');
    } finally { setBusy(false); setProgress(null); }
  }, [rec, toast]);

  const reuseBatch = useCallback(async (b) => {
    setRec((v) => ({ ...v, manifestFile: b.manifestFile, matched: { name: b.name, canvas: b.canvas, items: new Array(b.count).fill({}) } }));
    setRec((v) => ({ ...v, outDir: v.outDir || b.canvasFile.replace(/\/[^/]+$/, '/切回') }));
    toast('已载入批次', `${b.name} · ${b.count} 张。把像素蛋糕导出的文件选进来即可切分。`);
  }, [toast]);

  const forget = useCallback(async (id) => setLibrary(await pc.forget(id)), []);

  // ── 键盘 ──
  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'o') { e.preventDefault(); addImages(null); }
      else if (meta && e.key.toLowerCase() === 'e') { e.preventDefault(); compose(); }
      else if (e.key === 'Backspace' || e.key === 'Delete') { if (selectedId) removeItem(selectedId); }
      else if (e.key === 'Escape') setSelectedId(null);
      else if (meta && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); autoLayout(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, removeItem, addImages, compose, autoLayout]);

  useEffect(() => { window.__pcDebug = { items, canvas, images, plan }; });

  // ── 派生 ──
  const placedIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  const problems = useMemo(() => validateCanvas(items, gutter), [items, gutter]);
  const hint = useMemo(() => {
    if (!canvas.width) return null;
    const used = items.reduce((s, i) => s + i.width * i.height, 0);
    return {
      sizes: `${canvas.width}×${canvas.height}`,
      areaPct: (canvas.width * canvas.height) / (LIMIT * LIMIT) * 100,
      utilPct: (used / (canvas.width * canvas.height)) * 100,
    };
  }, [canvas, items]);

  return (
    <div className="app">
      <TopBar
        onOpen={() => addImages(null)}
        onAutoLayout={autoLayout}
        onCompose={compose}
        onRecover={() => (rec.returnedFile ? recover() : pickReturned())}
        busy={busy}
        hasImages={images.length > 0}
        canCompose={items.length > 0 && !!exp.outDir}
        batch={plan && plan.canvases.length > 1 ? {
          index: planIndex, total: plan.canvases.length,
          count: plan.canvases[planIndex]?.placed.length ?? 0,
          onPrev: () => gotoPlan(planIndex - 1), onNext: () => gotoPlan(planIndex + 1),
        } : null}
      />

      <div className="body">
        <Filmstrip
          images={images} placedIds={placedIds} selectedId={selectedId}
          onSelect={setSelectedId} onRemove={removeImage}
          onAdd={addImages} onAutoLayout={autoLayout} onClear={clearAll}
        />

        <Stage
          items={items} canvas={canvas} gutter={gutter} limit={LIMIT}
          selectedId={selectedId} onSelect={setSelectedId}
          onMove={moveItem} onRemove={removeItem} onDropFiles={addImages}
          batch={plan ? {
            index: planIndex, total: plan.canvases.length,
            label: { 'grid-1x2': '上下 2 张', 'grid-2x1': '左右 2 张', shelf: '混合排布' }[plan.canvases[planIndex]?.strategy]
              || plan.canvases[planIndex]?.strategy || '',
          } : null}
        />

        <Inspector
          items={items} canvas={canvas} hint={hint} gutter={gutter} setGutter={setGutter}
          problems={problems} selectedId={selectedId} onMove={moveItem} onRemove={removeItem}
          exp={{ ...exp, onPickDir: async () => { const d = await pc.pickFolder('选择合成图保存位置'); if (d) setExp((v) => ({ ...v, outDir: d })); } }}
          setExp={setExp} onCompose={compose} busy={busy}
          rec={rec} setRec={setRec} onRecover={recover} onPickReturned={pickReturned}
          onPickOutDir={async () => { const d = await pc.pickFolder('选择切分输出位置'); if (d) setRec((v) => ({ ...v, outDir: d })); }}
          library={library} onForget={forget} onReveal={pc.reveal} onReuseBatch={reuseBatch}
        />
      </div>

      <StatusBar
        images={images} items={items} canvas={canvas} hint={hint}
        problems={problems} busy={busy} message={message}
      />

      <Toasts list={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
      <ProgressOverlay progress={busy ? progress : null} />
    </div>
  );
}
