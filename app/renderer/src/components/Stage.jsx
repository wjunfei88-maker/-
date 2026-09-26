import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { snapPosition, tooClose, asRect, clamp } from '../lib/geom.js';

/**
 * 画布舞台（PS 式自由拖动）
 *
 * 与 v1 的关键差别：
 *   · 拖动**完全跟手** —— 不再有"撞到别人就被弹开"的硬推挤
 *   · 与别的图重叠时描红警告，松手后由 App 调用 findFreeSpot 自动挪到最近的合法位置
 *   · 画布尺寸 = 内容包围盒，所以可以把图拖到外面，画布跟着长大（单边上限 12000）
 *
 * 不变的红线：画布里永远不能有重叠 —— 被压住的像素根本不存在，切分时无处可取。
 */
export default function Stage({
  items, canvas, gutter, limit, selectedId, batch, draft,
  onSelect, onMove, onRemove, onDropFiles, onAddToCanvas,
}) {
  const stageRef = useRef(null);
  const [fit, setFit] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState(null);
  const [hot, setHot] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);

  const scale = fit * zoom;

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

  useEffect(() => {
    const dn = (e) => {
      if (e.code === 'Space' && !e.repeat && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
        setSpaceDown(true); e.preventDefault();
      }
    };
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

  // 验收探针：把拖动中的状态暴露出去，方便 PC_DRAGTEST 判断事件有没有真的进来
  useEffect(() => {
    window.__pcDrag = drag ? { id: drag.id, x: drag.x, y: drag.y, colliding: drag.colliding } : null;
  }, [drag]);

  /** setPointerCapture 在合成事件 / 极端情况下会抛，包一层别让它打断拖动 */
  const capture = (el, pointerId) => { try { el?.setPointerCapture?.(pointerId); } catch { /* 忽略 */ } };

  // ── 拖动图片（自由跟随，只做轻微吸附）──
  const onPointerDown = (e, it) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect(it.id);
    const p = toCanvasSpace(e.clientX, e.clientY);
    setDrag({ id: it.id, grabX: p.x - it.x, grabY: p.y - it.y, x: it.x, y: it.y, colliding: false });
    capture(e.currentTarget, e.pointerId);
  };

  const onPointerMove = (e) => {
    if (drag) {
      const p = toCanvasSpace(e.clientX, e.clientY);
      const desired = { x: p.x - drag.grabX, y: p.y - drag.grabY };
      const others = items.filter((i) => i.id !== drag.id);
      // 吸附阈值固定为"屏幕上 8px"，这样不管画布多大，手感一致
      const threshold = 8 / Math.max(scale, 0.02);
      const s = snapPosition(desired, { width: dragItem?.width ?? 0, height: dragItem?.height ?? 0 },
        others, limit, threshold, gutter);
      const me = { x: s.x, y: s.y, w: dragItem?.width ?? 0, h: dragItem?.height ?? 0 };
      const colliding = others.some((o) => tooClose(me, asRect(o), gutter));
      setDrag((d) => ({ ...d, x: s.x, y: s.y, colliding }));
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
    if (e.target.closest('.stage-toolbar') || e.target.closest('.stage-batch')) return;
    onSelect(null);
    // 平移：空格 + 拖 / 中键拖 / 在画布外的灰底上左键拖
    const outsideRect = e.target.closest('.canvas-rect') === null;
    if (spaceDown || e.button === 1 || (outsideRect && e.button === 0)) {
      setPanning({ sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y });
      capture(e.currentTarget, e.pointerId);
    }
  };

  const onWheel = (e) => {
    if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
    e.preventDefault();
    setZoom((z) => clamp(z * Math.exp(-e.deltaY * 0.0016), 0.15, 8));
  };

  // ── 从访达拖文件进来 ──
  const onDragOver = (e) => { e.preventDefault(); setHot(true); };
  const onDragLeave = (e) => { if (e.currentTarget === e.target) setHot(false); };
  const onDrop = (e) => {
    e.preventDefault(); setHot(false);
    // 从左边底片条拖过来的
    const id = e.dataTransfer?.getData('text/pc-image');
    if (id && onAddToCanvas) { onAddToCanvas(id); return; }
    const files = [...(e.dataTransfer?.files ?? [])].map((f) => f.path || window.pc?.pathForFile(f)).filter(Boolean);
    if (files.length) onDropFiles(files);
  };

  const W = canvas.width, H = canvas.height;
  const overW = W > limit, overH = H > limit;
  const empty = items.length === 0;
  const remaining = { w: limit - W, h: limit - H };

  return (
    <div
      ref={stageRef}
      className={`stage${hot ? ' hot' : ''}${drag ? ' dragging' : ''}`}
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
      {empty && draft ? (
        // 手工新建的空画布：给一个明确的落点区，而不是"把照片拖进来"那个首次使用的引导
        <div className="draft-drop">
          <div className="empty-mark">
            <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
              <rect x="3.5" y="3.5" width="27" height="27" rx="3" stroke="#DDA45C" strokeWidth="1.6" strokeDasharray="4 3" />
              <path d="M17 11.5v11M11.5 17h11" stroke="#DDA45C" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </div>
          <h2>这张画布还是空的</h2>
          <p>从左边底片条把照片拖到这里，位置随你摆。想清空重来就把照片拖出去。</p>
        </div>
      ) : empty ? (
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
              const colliding = drag && drag.id === it.id && drag.colliding;
              return (
                <div
                  key={it.id}
                  className={`canvas-item${selectedId === it.id ? ' selected' : ''}${colliding ? ' colliding' : ''}${live.rotation ? ' rot90' : ''}`}
                  style={{ left: live.x, top: live.y, width: it.width, height: it.height }}
                  onPointerDown={(e) => onPointerDown(e, it)}
                  onDoubleClick={() => onRemove(it.id)}
                  title={`${it.name}\n${it.natural?.width ?? it.width}×${it.natural?.height ?? it.height} · 1:1${live.rotation ? ' · 已旋转 90°' : ''}`}
                >
                  <img
                    src={it.url}
                    alt={it.name}
                    draggable={false}
                    style={live.rotation ? {
                      position: 'absolute', top: '50%', left: '50%',
                      width: it.height, height: it.width,
                      transform: 'translate(-50%, -50%) rotate(90deg)',
                    } : undefined}
                  />
                  <div className="grip">✕</div>
                  {live.rotation ? <div className="rot-badge" title="这张在画布里转了 90°，切回原图时自动转正">↻</div> : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(!empty || draft) && (
        <div className="stage-top">
          <div className="stage-batch">
            {batch && batch.total > 1 && <span className="badge">画布 {batch.index + 1}/{batch.total}</span>}
            {draft ? (
              <>
                <span>空画布</span>
                <span className="sep" />
                <span className="muted">把左边底片拖进来</span>
              </>
            ) : (
              <>
                <span style={{ fontFamily: 'var(--mono)' }}>{W} × {H}</span>
                <span className="sep" />
                <span>{items.length} 张 · 1:1 无损</span>
                <span className="sep" />
                <span className="muted" title="画布四周还能往外拖的余量">
                  余量 {remaining.w}×{remaining.h}
                </span>
                {batch?.label && <><span className="sep" /><span className="muted">{batch.label}</span></>}
              </>
            )}
          </div>

          {/* 提示条和信息条放在同一个 flex 容器里自动换行 —— 之前是各自绝对定位，窄窗口必然叠在一起 */}
          {overW || overH ? (
            <div className="stage-warn danger">
              画布 {W}×{H} 超出像素蛋糕单边 {limit}px 上限{overW ? '（宽）' : ''}{overH ? '（高）' : ''}
            </div>
          ) : drag?.colliding ? (
            <div className="stage-warn">
              松手会自动挪到最近的空位（画布里不能有重叠 —— 被压住的像素切不回来）
            </div>
          ) : null}
        </div>
      )}

      {(!empty || draft) && (
        <div className="stage-toolbar">
          {!draft && (
            <>
              <button className="btn ghost sm" onClick={() => setZoom((z) => clamp(z / 1.25, 0.15, 8))} title="缩小">−</button>
              <button className="btn ghost sm" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} style={{ minWidth: 52, justifyContent: 'center' }}>
                {Math.round(scale * 100)}%
              </button>
              <button className="btn ghost sm" onClick={() => setZoom((z) => clamp(z * 1.25, 0.15, 8))} title="放大">+</button>
              <div style={{ width: 1, background: 'var(--line)', margin: '2px 3px' }} />
            </>
          )}
          <button className="btn ghost sm" onClick={() => onDropFiles(null)}>添加</button>
        </div>
      )}
    </div>
  );
}
