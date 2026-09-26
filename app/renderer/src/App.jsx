import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Stage from './components/Stage.jsx';
import Filmstrip from './components/Filmstrip.jsx';
import CanvasList from './components/CanvasList.jsx';
import Inspector from './components/Inspector.jsx';
import { TopBar, StatusBar, Toasts, ProgressOverlay } from './components/Chrome.jsx';
import { findFreeSpot, validateCanvas, tightBounds } from './lib/geom.js';

const pc = window.pc;
const LIMIT = 12000;

/** 重算一张画布的尺寸/利用率（画布 = 内容的紧包围盒，可以随拖动长大） */
function withBounds(c) {
  const tb = tightBounds(c.placed);
  const used = c.placed.reduce((s, p) => s + p.w * p.h, 0);
  return { ...c, width: tb.width, height: tb.height, util: tb.width * tb.height ? used / (tb.width * tb.height) : 0 };
}

const STRATEGY_LABEL = {
  shelf: '货架排布',
  binpack: '紧密装箱',
};

export default function App() {
  const [images, setImages] = useState([]);       // 已导入的底片
  const [plan, setPlan] = useState(null);         // { canvases:[{placed,width,height,strategy}], unplaceable }
  const [planIndex, setPlanIndex] = useState(0);
  const [gutter, setGutter] = useState(24);
  const [allowRotate, setAllowRotate] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [library, setLibrary] = useState({ batches: [] });
  const [message, setMessage] = useState('就绪');
  const [capacity, setCapacity] = useState(null);

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

  // ── 派生状态 ──
  const canvases = plan?.canvases ?? [];
  const current = canvases[planIndex] ?? null;
  const canvas = { width: current?.width ?? 0, height: current?.height ?? 0 };

  /** 画布上的图（补上缩略图 url 和 Stage 需要的 width/height） */
  const items = useMemo(() => {
    const byId = new Map(images.map((i) => [i.id, i]));
    if (!current) return [];
    return current.placed.map((p) => {
      const src = byId.get(p.id) || {};
      return {
        ...p,
        name: src.name ?? p.name,
        url: src.url,
        width: p.w,
        height: p.h,
        natural: p.natural ?? { width: p.w, height: p.h },
      };
    });
  }, [current, images]);

  const thumbs = useMemo(() => {
    const m = {};
    for (const im of images) if (im.url) m[im.id] = im.url;
    return m;
  }, [images]);

  /** 已经被排进任意一张画布的底片 id */
  const placedIds = useMemo(
    () => new Set(canvases.flatMap((c) => c.placed.map((p) => p.id))),
    [canvases],
  );

  const canvasProblems = useMemo(
    () => canvases.map((c) => validateCanvas(c.placed.map((p) => ({ id: p.id, x: p.x, y: p.y, width: p.w, height: p.h })), gutter)),
    [canvases, gutter],
  );
  const problems = canvasProblems[planIndex] ?? [];

  const hint = useMemo(() => {
    if (!canvas.width) return null;
    const used = items.reduce((s, i) => s + i.width * i.height, 0);
    return {
      sizes: `${canvas.width}×${canvas.height}`,
      areaPct: (canvas.width * canvas.height) / (LIMIT * LIMIT) * 100,
      utilPct: canvas.width * canvas.height ? (used / (canvas.width * canvas.height)) * 100 : 0,
      remainW: LIMIT - canvas.width,
      remainH: LIMIT - canvas.height,
    };
  }, [canvas, items]);

  const rotCount = useMemo(() => canvases.reduce((s, c) => s + c.placed.filter((p) => p.rotation === 90).length, 0), [canvases]);

  /** 这批照片实际做到的最优：一张画布最多装了几张（可能比同尺寸网格更多） */
  const maxPerCanvas = useMemo(() => canvases.reduce((m, c) => Math.max(m, c.placed.length), 0), [canvases]);

  // ── 启动 ──
  const bootRef = useRef(false);
  useEffect(() => pc.info().then((i) => {
    setExp((e) => ({ ...e, outDir: i.home + '/像素拼图输出' }));
    setRec((r) => ({ ...r, outDir: i.home + '/像素拼图输出/切回' }));
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

  // ── 一键智能排版 ──
  const layoutFor = useCallback(async (imgs, opts = {}) => {
    if (!imgs?.length) return;
    const rot = opts.allowRotate ?? allowRotate;
    const gut = opts.gutter ?? gutter;
    setBusy(true); setMessage('正在搜索最优排版…');
    try {
      const r = await pc.planLayout(imgs.map((i) => ({
        id: i.id, name: i.name, path: i.path, width: i.width, height: i.height, format: i.format,
      })), { gutter: gut, allowRotate: rot });

      if (!r.canvases.length) {
        toast('排不下', '这些照片单张就超过了 12000px 上限。', 'err');
        return;
      }
      setPlan(r);
      setPlanIndex(0);
      setSelectedId(null);
      pc.capacity(imgs, { gutter: gut }).then(setCapacity).catch(() => setCapacity(null));

      const totalPlaced = r.canvases.reduce((s, c) => s + c.placed.length, 0);
      const savedPct = Math.round((1 - r.canvases.length / Math.max(1, totalPlaced)) * 100);
      const rotN = r.canvases.reduce((s, c) => s + c.placed.filter((p) => p.rotation === 90).length, 0);

      setMessage(r.canvases.length === 1
        ? `排成 1 张画布 · ${r.canvases[0].placed.length} 张`
        : `${totalPlaced} 张 → ${r.canvases.length} 张画布 · 省 ${savedPct}% 额度`);

      if (r.canvases.length > 1) {
        toast(`排成 ${r.canvases.length} 张画布`,
          `${totalPlaced} 张照片装不进一张画布（单边上限 12000px），已按最少画布数自动分组。` +
          `每张画布对应像素蛋糕的一次额度，比一张张修省 ${savedPct}%。` +
          (rotN ? `\n其中 ${rotN} 张被旋转 90° 以塞得更紧。` : ''), 'ok', 9000);
      } else if (rotN) {
        toast('排版完成', `其中 ${rotN} 张旋转 90° 以塞得更紧，切回原图时会自动转正。`, 'ok', 7000);
      }

      if (r.unplaceable.length) toast(`${r.unplaceable.length} 张无法处理`, '它们单边就超过了 12000px。', 'err');
      const unplaced = imgs.length - totalPlaced - r.unplaceable.length;
      if (unplaced > 0) toast('部分照片没排进去', `${unplaced} 张暂时放不下`, 'err');
    } catch (e) {
      toast('排版失败', e.message, 'err');
    } finally { setBusy(false); setProgress(null); }
  }, [gutter, allowRotate, toast]);

  const autoLayout = useCallback(() => layoutFor(images), [layoutFor, images]);

  const demoBoot = useCallback(async (files) => {
    const got = await importList(files);
    if (got?.length) layoutFor(got);
  }, []);

  const gotoPlan = (i) => {
    if (!plan?.canvases[i]) return;
    setPlanIndex(i);
    setSelectedId(null);
    setMessage(`第 ${i + 1} / ${plan.canvases.length} 张画布 · ${plan.canvases[i].placed.length} 张`);
  };

  // ── 编辑（改的是 plan 里那一张画布，切走再切回来不会丢）──
  const moveItem = useCallback((id, pos) => {
    const cur = plan?.canvases?.[planIndex];
    const it = cur?.placed.find((p) => p.id === id);
    if (!it) return;
    const others = cur.placed.filter((p) => p.id !== id);
    const r = findFreeSpot(
      { x: pos.x ?? it.x, y: pos.y ?? it.y },
      { width: it.w, height: it.h }, others, LIMIT, gutter, { x: it.x, y: it.y },
    );
    if (r.failed) {
      toast('这里放不下', '四周都被占满了。把别的图往外拖一点，或点「自动排版」重新分组。', 'err');
    }
    const placed = cur.placed.map((p) => (p.id === id ? { ...p, x: r.x, y: r.y } : p));
    setPlan((prev) => ({
      ...prev,
      canvases: prev.canvases.map((c, i) => (i === planIndex ? withBounds({ ...c, placed }) : c)),
    }));
  }, [plan, planIndex, gutter, toast]);

  const removeItem = useCallback((id) => {
    setPlan((prev) => {
      if (!prev?.canvases?.[planIndex]) return prev;
      return {
        ...prev,
        canvases: prev.canvases.map((c, i) => (i === planIndex
          ? withBounds({ ...c, placed: c.placed.filter((p) => p.id !== id) }) : c)),
      };
    });
    setSelectedId((s) => (s === id ? null : s));
  }, [planIndex]);

  const removeImage = useCallback((id) => {
    setImages((prev) => prev.filter((p) => p.id !== id));
    setPlan((prev) => (prev ? {
      ...prev,
      canvases: prev.canvases
        .map((c) => withBounds({ ...c, placed: c.placed.filter((p) => p.id !== id) }))
        .filter((c) => c.placed.length),
    } : prev));
  }, []);

  const clearAll = useCallback(() => {
    setImages([]); setPlan(null); setPlanIndex(0);
    setSelectedId(null); setCapacity(null); setMessage('已清空');
  }, []);

  /** 从底片条拖一张到画布上 */
  const addToCanvas = useCallback((id) => {
    const src = images.find((i) => i.id === id);
    if (!src) return;
    setPlan((prev) => {
      const c = prev?.canvases?.[planIndex];
      if (!c) return prev;
      if (c.placed.some((p) => p.id === id)) { toast('这张已经在画布上了', '它是从别的画布拖过来的话，请先用「自动排版」重排。', 'err'); return prev; }
      const tb = tightBounds(c.placed);
      let x = c.placed.length ? tb.width + gutter : 0;
      let y = 0;
      if (x + src.width > LIMIT) { x = 0; y = tb.height + gutter; }
      const r = findFreeSpot({ x, y }, { width: src.width, height: src.height }, c.placed, LIMIT, gutter, { x, y });
      if (r.failed) { toast('这张画布放不下了', '已经到 12000px 上限，请点「自动排版」重新分组。', 'err'); return prev; }
      const placed = [...c.placed, {
        id: src.id, name: src.name, source: src.path, format: src.format,
        x: r.x, y: r.y, w: src.width, h: src.height, rotation: 0,
        natural: { width: src.width, height: src.height },
      }];
      return { ...prev, canvases: prev.canvases.map((cc, i) => (i === planIndex ? withBounds({ ...cc, placed }) : cc)) };
    });
  }, [images, planIndex, gutter, toast]);

  // ── 导出 ──
  const toPayload = (c) => ({
    items: c.placed.map((p) => ({
      id: p.id, name: p.name, source: p.source, format: p.format,
      rotation: p.rotation ?? 0,
      natural: p.natural ?? { width: p.w, height: p.h },
      crop: { left: p.x, top: p.y, width: p.w, height: p.h },
    })),
    width: c.width, height: c.height, strategy: c.strategy ?? null,
  });

  const guardExport = useCallback(() => {
    if (!exp.outDir) { toast('还没选保存位置', '在右侧「导出」里选一个文件夹。', 'err'); return false; }
    const bad = canvasProblems.findIndex((p, i) => p.length > 0 && canvases[i]?.placed.length);
    if (bad >= 0) {
      setPlanIndex(bad);
      toast(`第 ${bad + 1} 张画布有问题`, '有图片重叠或间距过小。重叠区域的像素在画布里不存在，切不回来。', 'err');
      return false;
    }
    const over = canvases.findIndex((c) => c.width > LIMIT || c.height > LIMIT);
    if (over >= 0) {
      setPlanIndex(over);
      toast(`第 ${over + 1} 张画布超限`, `超过像素蛋糕单边 ${LIMIT}px 上限。`, 'err');
      return false;
    }
    return true;
  }, [exp.outDir, canvasProblems, canvases, toast]);

  const compose = useCallback(async () => {
    if (!current?.placed.length) return;
    if (!guardExport()) return;
    setBusy(true); setMessage('正在合成…');
    try {
      const r = await pc.compose({ ...toPayload(current), gutter, name: exp.name, outDir: exp.outDir, icc: exp.icc, compression: exp.compression });
      setLibrary(await pc.library());
      setRec((v) => ({ ...v, matched: { name: r.name, canvas: r.canvas, items: current.placed.map((i) => ({ name: i.name })) }, manifestFile: r.manifestFile }));
      toast('合成完成', `${r.canvas.width}×${r.canvas.height} · ${(r.bytes / 1024 / 1024).toFixed(0)}MB\n${r.canvasFile}`, 'ok', 9000);
      setMessage(`已导出 ${r.canvas.width}×${r.canvas.height}`);
    } catch (e) {
      toast('合成失败', e.message, 'err');
    } finally { setBusy(false); setProgress(null); }
  }, [current, gutter, exp, guardExport, toast]);

  const composeAll = useCallback(async () => {
    if (!canvases.length) return;
    if (!guardExport()) return;
    setBusy(true); setMessage(`正在导出 ${canvases.length} 张画布…`);
    try {
      const r = await pc.composeAll({
        canvases: canvases.map(toPayload),
        gutter, name: exp.name, outDir: exp.outDir, icc: exp.icc, compression: exp.compression,
      });
      setLibrary(await pc.library());
      if (r.done.length) {
        const first = r.done[0];
        setRec((v) => ({
          ...v,
          matched: { name: first.name, canvas: first.canvas, items: canvases[0].placed.map((i) => ({ name: i.name })) },
          manifestFile: first.manifestFile,
        }));
      }
      const totalMB = r.done.reduce((s, d) => s + d.bytes, 0) / 1024 / 1024;
      toast(`已导出 ${r.done.length} 张画布`,
        `${r.done.length} 个 TIFF + manifest 已写到 ${exp.outDir}\n共 ${totalMB.toFixed(0)}MB` +
        (r.failed.length ? `\n⚠️ ${r.failed.length} 张失败：${r.failed[0].error}` : ''),
        r.failed.length ? 'err' : 'ok', 10000);
      setMessage(`已导出 ${r.done.length}/${r.total} 张画布`);
    } catch (e) {
      toast('批量导出失败', e.message, 'err');
    } finally { setBusy(false); setProgress(null); }
  }, [canvases, exp, gutter, guardExport, toast]);

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
    setRec((v) => ({
      ...v,
      manifestFile: b.manifestFile,
      matched: { name: b.name, canvas: b.canvas, items: new Array(b.count).fill({}) },
      outDir: v.outDir || b.canvasFile.replace(/\/[^/]+$/, '/切回'),
    }));
    toast('已载入批次', `${b.name} · ${b.count} 张。把像素蛋糕导出的文件选进来即可切分。`);
  }, [toast]);

  const forget = useCallback(async (id) => setLibrary(await pc.forget(id)), []);

  // 切换「允许旋转」时立刻重排，让用户马上看到效果
  const toggleRotate = useCallback((v) => {
    setAllowRotate(v);
    if (images.length) layoutFor(images, { allowRotate: v });
  }, [images, layoutFor]);

  // 保护带变化也重排（缝宽直接影响能装几张）
  const changeGutter = useCallback((v) => {
    setGutter(v);
    if (images.length) layoutFor(images, { gutter: v });
  }, [images, layoutFor]);

  // ── 键盘 ──
  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (meta && e.key.toLowerCase() === 'o') { e.preventDefault(); addImages(null); }
      else if (meta && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); composeAll(); }
      else if (meta && e.key.toLowerCase() === 'e') { e.preventDefault(); compose(); }
      else if (meta && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); autoLayout(); }
      else if (!typing && (e.key === 'Backspace' || e.key === 'Delete')) { if (selectedId) removeItem(selectedId); }
      else if (!typing && e.key === 'Escape') setSelectedId(null);
      else if (!typing && (e.key === '[' || e.key === ']')) {
        const d = e.key === '[' ? -1 : 1;
        const next = planIndex + d;
        if (plan?.canvases[next]) { e.preventDefault(); gotoPlan(next); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, removeItem, addImages, compose, composeAll, autoLayout, planIndex, plan]);

  useEffect(() => {
    window.__pcDebug = { items, canvas, images, plan, planIndex, selectedId, canvases: canvases.length };
  });

  return (
    <div className="app">
      <TopBar
        onOpen={() => addImages(null)}
        onAutoLayout={autoLayout}
        onCompose={compose}
        onComposeAll={composeAll}
        onRecover={() => (rec.returnedFile ? recover() : pickReturned())}
        busy={busy}
        hasImages={images.length > 0}
        canCompose={items.length > 0 && !!exp.outDir}
        canvasCount={canvases.length}
        batch={canvases.length > 1 ? {
          index: planIndex, total: canvases.length,
          count: current?.placed.length ?? 0,
          onPrev: () => gotoPlan(planIndex - 1), onNext: () => gotoPlan(planIndex + 1),
        } : null}
      />

      <div className="body">
        <aside className="sidebar">
          <Filmstrip
            images={images} placedIds={placedIds}
            selectedId={selectedId}
            onSelect={setSelectedId} onRemove={removeImage}
            onAdd={addImages} onAutoLayout={autoLayout} onClear={clearAll}
          />
          <CanvasList
            canvases={canvases} index={planIndex} problems={canvasProblems} thumbs={thumbs}
            onSelect={gotoPlan}
          />
        </aside>

        <Stage
          items={items} canvas={canvas} gutter={gutter} limit={LIMIT}
          selectedId={selectedId} onSelect={setSelectedId}
          onMove={moveItem} onRemove={removeItem}
          onDropFiles={addImages} onAddToCanvas={addToCanvas}
          batch={canvases.length > 1 ? {
            index: planIndex, total: canvases.length,
            label: String(plan?.canvases?.[planIndex]?.strategy ?? '').startsWith('grid')
              ? '网格排布'
              : (STRATEGY_LABEL[plan?.canvases?.[planIndex]?.strategy] ?? plan?.canvases?.[planIndex]?.strategy ?? ''),
          } : null}
        />

        <Inspector
          items={items} canvas={canvas} hint={hint} gutter={gutter} setGutter={changeGutter}
          problems={problems} selectedId={selectedId} onMove={moveItem} onRemove={removeItem}
          allowRotate={allowRotate} setAllowRotate={toggleRotate} rotCount={rotCount}
          capacity={capacity} canvasCount={canvases.length} maxPerCanvas={maxPerCanvas}
          exp={{ ...exp, onPickDir: async () => { const d = await pc.pickFolder('选择合成图保存位置'); if (d) setExp((v) => ({ ...v, outDir: d })); } }}
          setExp={setExp} onCompose={compose} onComposeAll={composeAll} busy={busy}
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
