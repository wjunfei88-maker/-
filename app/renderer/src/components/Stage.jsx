import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { resolvePlacement, clamp } from '../lib/geom.js';

/**
 * 画布舞台
 *
 * 关键交互约束（来自 M0 实测结论）：
 *  · 拖到接近另一张图时自动吸附，吸附目标**已经含了保护带**，所以吸上就是留好缝的位置
 *  · 任何情况下都不允许两张图相碰 —— 落点会被沿最小位移方向推出去
 *  · 画布上永远不会有"看不见的隐藏像素"，这是能切回原图的前提
 */
export default function Stage({
  items, canvas, gutter, limit, selectedId, batch,
  onSelect, onMove, onRemove, onDropFiles,
}) {
  const stageRef = useRef(null);
  const [fit, setFit] = useState(1);
  const [zoom, setZoom] = useState(1);       // 用户额外缩放倍率
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState(null);    // { id, dx, dy, ghost }
  const [hot, setHot] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);

  const scale = fit * zoom;

  // 自动适配
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || !canvas.width || !canvas.height) return;
    const ro = new ResizeObserver(() => {
      const pad = 96;
      const w = el.clientWidth - pad, h = el.clientHeight - pad;
      const s = Math.min(w / canvas.width, h / canvas.height);
      setFit(Number.isFinite(s) && s > 0 ? s : 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvas.width, canvas.height]);

  useEffect(() => { setPan({ x: 0, y: 0 }); }, [canvas.width, canvas.height]);

  // 空格键 = 抓手平移
  useEffect(() => {
    const dn = (e) => { if (e.code === 'Space' && !e.repeat) { setSpaceDown(true); e.preventDefault(); } };
    const up = (e) => { if (e.code === 'Space') setSpaceDown(false); };
    window.addEventListener('keydown', dn);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', up); };
  }, []);

  const toCanvasSpace = useCallback((clientX, clientY) => {
    const r = stageRef.current?.querySelector('.canvas-rect')?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
  }, [scale]);

  const [panning, setPanning] = useState(null);
  const dragItem = drag ? items.find((i) => i.id === drag.id) : null;

  // ── 拖动图片 ──
  const onPointerDown = (e, it) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect(it.id);
    const p = toCanvasSpace(e.clientX, e.clientY);
    setDrag({ id: it.id, grabX: p.x - it.x, grabY: p.y - it.y, x: it.x, y: it.y, collided: false });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (drag) {
      const p = toCanvasSpace(e.clientX, e.clientY);
      const desired = { x: p.x - drag.grabX, y: p.y - drag.grabY };
      const others = items.filter((i) => i.id !== drag.id);
      const r = resolvePlacement(desired, { width: dragItem?.width ?? 0, height: dragItem?.height ?? 0 },
        others, canvas, gutter, 14 / Math.max(scale, 0.05));
      setDrag((d) => ({ ...d, x: r.x, y: r.y, collided: r.collided }));
    } else if (panning) {
      setPan({ x: panning.px + (e.clientX - panning.sx), y: panning.py + (e.clientY - panning.sy) });
    }
  };

  const endDrag = () => {
    if (drag) { onMove(drag.id, { x: drag.x, y: drag.y }); setDrag(null); }
    setPanning(null);
  };

  const onStageDown = (e) => {
    if (e.target.closest('.canvas-item')) return;
    onSelect(null);
    if (spaceDown || e.button === 1 || e.target.closest('.canvas-rect') === null && e.button === 0) {
      setPanning({ sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y });
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
  };

  // ── 滚轮缩放 ──
  const onWheel = (e) => {
    if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
    e.preventDefault();
    const k = Math.exp(-e.deltaY * 0.0016);
    setZoom((z) => clamp(z * k, 0.15, 8));
  };

  // ── 文件拖入 ──
  const onDragOver = (e) => { e.preventDefault(); setHot(true); };
  const onDragLeave = (e) => { if (e.currentTarget === e.target) setHot(false); };
  const onDrop = (e) => {
    e.preventDefault(); setHot(false);
    const files = [...(e.dataTransfer?.files ?? [])].map((f) => f.path || window.pc?.pathForFile(f)).filter(Boolean);
    if (files.length) onDropFiles(files);
  };

  const W = canvas.width, H = canvas.height;
  const overW = W > limit, overH = H > limit;
  const empty = items.length === 0;

  return (
    <div
      ref={stageRef}
      className={`stage${hot ? ' hot' : ''}`}
      style={{ cursor: spaceDown ? (panning ? 'grabbing' : 'grab') : 'default' }}
      onPointerDown={onStageDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onWheel={onWheel}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {empty ? (
        <div className="empty">
          <div className="empty-mark">
            <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
              <rect x="3.5" y="3.5" width="27" height="12" rx="2.5" stroke="#DDA45C" strokeWidth="1.6" />
              <rect x="3.5" y="18.5" width="27" height="12" rx="2.5" stroke="rgba(255,255,255,0.32)" strokeWidth="1.6" strokeDasharray="3 3" />
              <path d="M17 14.5v4" stroke="rgba(255,255,255,0.42)" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="2 2" />
            </svg>
          </div>
          <h2>把照片拖进来</h2>
          <p>
            从访达拖入，或按 <span className="kbd">⌘O</span> 选择。
            软件会按像素蛋糕 12000px 的单边上限自动排版，全程 1:1 不缩放。
          </p>
          <button className="btn primary" onClick={() => onDropFiles(null)}>选择照片…</button>
        </div>
      ) : (
        <div
          className="canvas-wrap"
          style={{
            width: Math.max(1, Math.round(W * scale)),
            height: Math.max(1, Math.round(H * scale)),
            transform: `translate(${pan.x}px, ${pan.y}px)`,
          }}
        >
          {/* 内层保持 1:1 的逻辑尺寸，从左上角缩放 —— 这样布局盒永远不会是 7952px，
              不会把 CSS Grid 的 1fr 列撑爆（那是画布跑出屏幕的根因） */}
          <div
            className="canvas-rect"
            style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: '0 0' }}
          >
            {items.map((it) => {
              const live = drag && drag.id === it.id ? { ...it, x: drag.x, y: drag.y } : it;
              return (
                <div
                  key={it.id}
                  className={`canvas-item${selectedId === it.id ? ' selected' : ''}`}
                  style={{ left: live.x, top: live.y, width: it.width, height: it.height, cursor: 'grab' }}
                  onPointerDown={(e) => onPointerDown(e, it)}
                  onDoubleClick={() => onRemove(it.id)}
                  title={`${it.name}\n${it.width}×${it.height}`}
                >
                  <img src={it.url} alt={it.name} draggable={false} />
                  <div className="grip">✕</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!empty && (
        <div className="stage-batch">
          {batch && batch.total > 1 && <span className="badge">画布 {batch.index + 1}/{batch.total}</span>}
          <span style={{ fontFamily: 'var(--mono)' }}>{W} × {H}</span>
          <span className="sep" />
          <span>{items.length} 张 · 1:1 无损</span>
          {batch?.label && <><span className="sep" /><span className="muted">{batch.label}</span></>}
          {batch && batch.total > 1 && <><span className="sep" /><span className="muted">每张 = 1 次额度</span></>}
        </div>
      )}

      {!empty && (
        <div className="stage-toolbar">
          <button className="btn ghost sm" onClick={() => setZoom((z) => clamp(z / 1.25, 0.15, 8))} title="缩小">−</button>
          <button className="btn ghost sm" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} style={{ minWidth: 52, justifyContent: 'center' }}>
            {Math.round(scale * 100)}%
          </button>
          <button className="btn ghost sm" onClick={() => setZoom((z) => clamp(z * 1.25, 0.15, 8))} title="放大">+</button>
          <div style={{ width: 1, background: 'var(--line)', margin: '2px 3px' }} />
          <button className="btn ghost sm" onClick={() => onDropFiles(null)}>添加</button>
        </div>
      )}

      {(overW || overH) && !empty && (
        <div style={{
          position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)',
          padding: '7px 13px', borderRadius: 9, fontSize: 12,
          background: 'rgba(232,119,111,0.14)', border: '0.5px solid rgba(232,119,111,0.45)',
          color: '#f0a49e', backdropFilter: 'blur(14px)',
        }}>
          画布 {W}×{H} 超出像素蛋糕单边 {limit}px 上限{overW ? '（宽）' : ''}{overH ? '（高）' : ''}
        </div>
      )}
    </div>
  );
}
