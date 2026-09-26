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
  manual: '手工摆',
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
  const [sys, setSys] = useState(null);   // 这台机器打算用几个进程/几路并发（app:info 给的）

  const [exp, setExp] = useState({ name: 'batch', outDir: '', compression: 'lzw', icc: 'srgb' });
  const [rec, setRec] = useState({
    files: [], plan: null, outDir: '', format: 'jpeg', quality: 14, keepExif: true,
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
    setSys(i.plan ?? null);
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

    // 手工画布不参与自动排版：里面的照片被"钉住"，只重排剩下的，
    // 排完再把手工作品原样接在后面 —— 免得点一下「自动排版」就把手摆的活全冲掉
    const manual = (plan?.canvases ?? []).filter((c) => c.manual);
    const pinned = new Set(manual.flatMap((c) => c.placed.map((p) => p.id)));
    const free = imgs.filter((i) => !pinned.has(i.id));
    if (!free.length) {
      if (manual.length) toast('没有可自动排的照片', '照片都在手工画布里。想全部重排，先把手工画布里的照片拖出去。', 'err', 8000);
      return;
    }

    setBusy(true); setMessage('正在搜索最优排版…');
    try {
      const r = await pc.planLayout(free.map((i) => ({
        id: i.id, name: i.name, path: i.path, width: i.width, height: i.height, format: i.format,
      })), { gutter: gut, allowRotate: rot });

      if (!r.canvases.length) {
        toast('排不下', '这些照片单张就超过了 12000px 上限。', 'err');
        return;
      }
      const combined = [...r.canvases, ...manual];
      setPlan({ ...r, canvases: combined });
      setPlanIndex(0);
      setSelectedId(null);
      pc.capacity(free, { gutter: gut }).then(setCapacity).catch(() => setCapacity(null));

      const totalPlaced = combined.reduce((s, c) => s + c.placed.length, 0);
      const savedPct = Math.round((1 - combined.length / Math.max(1, totalPlaced)) * 100);
      const rotN = combined.reduce((s, c) => s + c.placed.filter((p) => p.rotation === 90).length, 0);

      setMessage(combined.length === 1
        ? `排成 1 张画布 · ${combined[0].placed.length} 张`
        : `${totalPlaced} 张 → ${combined.length} 张画布 · 省 ${savedPct}% 额度`);

      if (combined.length > 1) {
        toast(`排成 ${combined.length} 张画布`,
          `${totalPlaced} 张照片装不进一张画布（单边上限 12000px），已按最少画布数自动分组。` +
          `每张画布对应像素蛋糕的一次额度，比一张张修省 ${savedPct}%。` +
          (manual.length ? `\n其中 ${manual.length} 张是你手工摆的，没动。` : '') +
          (rotN ? `\n其中 ${rotN} 张被旋转 90° 以塞得更紧。` : ''), 'ok', 9000);
      } else if (rotN) {
        toast('排版完成', `其中 ${rotN} 张旋转 90° 以塞得更紧，切回原图时会自动转正。`, 'ok', 7000);
      }

      if (r.unplaceable.length) toast(`${r.unplaceable.length} 张无法处理`, '它们单边就超过了 12000px。', 'err');
      const unplaced = free.length - r.canvases.reduce((s, c) => s + c.placed.length, 0) - r.unplaceable.length;
      if (unplaced > 0) toast('部分照片没排进去', `${unplaced} 张暂时放不下`, 'err');
    } catch (e) {
      toast('排版失败', e.message, 'err');
    } finally { setBusy(false); setProgress(null); }
  }, [gutter, allowRotate, plan, toast]);

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
        .filter((c) => c.placed.length || c.manual),     // 手工画布即使空了也留着
    } : prev));
  }, []);

  const clearAll = useCallback(() => {
    setImages([]); setPlan(null); setPlanIndex(0);
    setSelectedId(null); setCapacity(null); setMessage('已清空');
  }, []);

  /** 新建一张空画布，照片自己往里面摆（不参与自动排版） */
  const addCanvas = useCallback(() => {
    const c = { placed: [], width: 0, height: 0, util: 0, strategy: 'manual', manual: true };
    setPlan((prev) => {
      const base = prev ?? { canvases: [], unplaceable: [], allowRotate, lowerBound: 0 };
      return { ...base, canvases: [...base.canvases, c] };
    });
    setPlanIndex(canvases.length);          // 新画布追加在末尾，索引就是原来的张数
    setSelectedId(null);
    setMessage('新建了 1 张空画布 · 把左边底片拖进来');
    toast('新建了 1 张空画布', '从左边底片条把照片拖到画布上，位置随你摆。', 'ok');
  }, [canvases.length, allowRotate, toast]);

  /** 删除一张空画布（有图的画布不给删，避免误点丢掉排版） */
  const removeCanvas = useCallback((i) => {
    if (!canvases[i] || canvases[i].placed.length) return;
    setPlan((prev) => ({ ...prev, canvases: prev.canvases.filter((_, k) => k !== i) }));
    setPlanIndex((k) => Math.max(0, k > i ? k - 1 : Math.min(k, canvases.length - 2)));
    setMessage('已删除空画布');
  }, [canvases]);

  /** 从底片条拖一张到画布上（已经在别的画布上就是移动过来） */
  const addToCanvas = useCallback((id) => {
    const src = images.find((i) => i.id === id);
    if (!src) return;
    setPlan((prev) => {
      const c = prev?.canvases?.[planIndex];
      if (!c) return prev;
      if (c.placed.some((p) => p.id === id)) { toast('这张已经在这张画布上了', '', 'err'); return prev; }
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
      // 同一张照片在一次导出里只能出现在一张画布上，所以从别处拖过来 = 从那张画布移走
      const canvases = prev.canvases.map((cc, i) => {
        if (i === planIndex) return withBounds({ ...cc, placed });
        if (cc.placed.some((p) => p.id === id)) {
          return withBounds({ ...cc, placed: cc.placed.filter((p) => p.id !== id) });
        }
        return cc;
      });
      return { ...prev, canvases };
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
      toast('合成完成',
        `${r.canvas.width}×${r.canvas.height} · ${(r.bytes / 1024 / 1024).toFixed(0)}MB\n${r.canvasFile}\n\n修完回来点「切回原图」，成片可以一次多选。`,
        'ok', 11000);
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
      const totalMB = r.done.reduce((s, d) => s + d.bytes, 0) / 1024 / 1024;
      toast(`已导出 ${r.done.length} 张画布`,
        `${r.done.length} 个 TIFF + manifest 已写到 ${exp.outDir}\n共 ${totalMB.toFixed(0)}MB\n\n修完回来点「切回原图」→「选整个文件夹」，一次全部切回。` +
        (r.failed.length ? `\n⚠️ ${r.failed.length} 张失败：${r.failed[0].error}` : ''),
        r.failed.length ? 'err' : 'ok', 12000);
      setMessage(`已导出 ${r.done.length}/${r.total} 张画布`);
    } catch (e) {
      toast('批量导出失败', e.message, 'err');
    } finally { setBusy(false); setProgress(null); }
  }, [canvases, exp, gutter, guardExport, toast]);

  // ── 切回原图（支持批量：一次选一整批，配对完一次全切回）──
  /**
   * 选定要切回的成片后先只做「配对」，不动像素：
   * 让用户先看清楚哪几个能切、各能切出几张、哪个配不上记录，再决定要不要全切。
   */
  const loadReturned = useCallback(async (files) => {
    if (!files || !files.length) return;
    const p = await pc.recoverPlan(files);
    setRec((v) => ({ ...v, files, plan: p }));
    const bad = p.total - p.okCount;
    if (!p.okCount) {
      toast('没找到合成记录', '选中的文件旁边要有导出时生成的 .manifest.json', 'err', 9000);
    } else if (bad) {
      toast(`配对成功 ${p.okCount} / ${p.total}`,
        `有 ${bad} 个文件旁边缺 .manifest.json，会被跳过。可切回 ${p.imageCount} 张原图。`, 'err', 9000);
    } else {
      toast(`已配对 ${p.okCount} 张画布`,
        `共可切回 ${p.imageCount} 张原图${p.okCount > 1 ? '，点一下全部切回' : ''}。`, 'ok');
    }
  }, [toast]);

  const pickReturned = useCallback(async () => loadReturned(await pc.pickReturned()), [loadReturned]);

  const recover = useCallback(async () => {
    const files = (rec.plan?.rows ?? []).filter((r) => r.ok).map((r) => r.file);
    if (!files.length) return;
    setBusy(true); setMessage(`正在切回 ${files.length} 张画布…`);
    try {
      const rep = await pc.splitMany({
        files, outDir: rec.outDir, format: rec.format, quality: rec.quality, keepExif: rec.keepExif,
      });
      const bad = rep.failed.length;
      toast(`切回 ${rep.outputs} 张原图`,
        `来自 ${rep.done.length} 张画布 · 无损 ${rep.lossless} 张 · 输出到 ${rec.outDir}` +
        (bad ? `\n⚠️ ${bad} 张画布失败：${rep.failed.map((f) => f.name).join('、')}` : '') +
        (rep.warnings.length ? `\n⚠️ ${rep.warnings.join('；')}` : ''),
        bad || rep.warnings.length ? 'err' : 'ok', 14000);
      setMessage(`已切回 ${rep.outputs} 张`);
      setLibrary(await pc.library());
    } catch (e) {
      toast('切分失败', e.message, 'err');
    } finally { setBusy(false); setProgress(null); }
  }, [rec, toast]);

  /** 从历史批次点进来：直接开文件选择 —— manifest 会自动按文件名配上，不用手动指 */
  const reuseBatch = useCallback(async (b) => {
    setRec((v) => ({ ...v, outDir: v.outDir || b.canvasFile.replace(/\/[^/]+$/, '/切回') }));
    toast('已载入批次', `${b.name} · ${b.count} 张。把像素蛋糕导出的成片选进来（可多选）。`);
    await loadReturned(await pc.pickReturned());
  }, [loadReturned, toast]);

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
        onRecover={() => ((rec.plan?.okCount ?? 0) > 0 ? recover() : pickReturned())}
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
            onAddCanvas={images.length ? addCanvas : null}
            onRemoveCanvas={removeCanvas}
          />
        </aside>

        <Stage
          items={items} canvas={canvas} gutter={gutter} limit={LIMIT}
          draft={!items.length && !!current}
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
          rec={rec} setRec={setRec} onRecover={recover}
          onPickReturned={pickReturned}
          onPickOutDir={async () => { const d = await pc.pickFolder('选择切分输出位置'); if (d) setRec((v) => ({ ...v, outDir: d })); }}
          library={library} onForget={forget} onReveal={pc.reveal} onReuseBatch={reuseBatch}
          sys={sys}
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
