import React from 'react';

/**
 * 画布列表
 *
 * 自动排版把照片拆成多张画布时（40 张 42MP → 20 张画布），
 * 靠顶栏的 ‹ 1/20 › 一张张点是折磨。这里直接列出每一张：
 * 第几张、装了几张、多大、有没有问题，点一下就跳过去。
 *
 * 每张画布 = 像素蛋糕的一次额度，所以列表本身就是"账单"。
 *
 * 「新建空画布」= 手工模式：这张画布不参与自动排版，
 * 想怎么摆就怎么摆（自动排版会把它整个跳过，手摆的成果不会被冲掉）。
 */
export default function CanvasList({
  canvases, index, problems, thumbs, onSelect, onAddCanvas, onRemoveCanvas,
}) {
  const list = canvases ?? [];
  if (!list.length && !onAddCanvas) return null;

  const total = list.length;
  const imageCount = list.reduce((s, c) => s + c.placed.length, 0);
  const savedPct = total ? Math.round((1 - total / Math.max(1, imageCount)) * 100) : 0;

  return (
    <div className="canvaslist">
      <div className="cl-summary">
        {total ? (
          <>
            <span>共 <b>{total}</b> 张画布</span>
            <span className="sep" />
            <span>省 <b>{savedPct}%</b> 额度</span>
          </>
        ) : (
          <span style={{ color: 'var(--txt-3)' }}>还没有画布</span>
        )}
      </div>

      {onAddCanvas && (
        <div className="cl-actions">
          <button className="btn ghost sm" onClick={onAddCanvas} title="新建一张空画布，照片自己往里拖 —— 它不会被自动排版打乱">
            <span className="cl-plus">＋</span> 新建空画布
          </button>
        </div>
      )}

      <div className="cl-rows">
        {list.map((c, i) => {
          const bad = (problems?.[i]?.length ?? 0) > 0;
          const over = c.width > 12000 || c.height > 12000;
          const thumb = thumbs?.[c.placed[0]?.id];
          const empty = !c.placed.length;
          const removable = empty && !!onRemoveCanvas;
          return (
            <div className="cl-item" key={i}>
              <button
                className={`cl-row${i === index ? ' on' : ''}${bad || over ? ' bad' : ''}${empty ? ' idle' : ''}`}
                onClick={() => onSelect(i)}
                title={empty
                  ? `画布 ${i + 1}：空画布（手工摆）`
                  : `画布 ${i + 1}：${c.placed.length} 张 · ${c.width}×${c.height}${c.manual ? ' · 手工摆的' : ''}${bad ? ' · 有重叠需要处理' : ''}`}
              >
                <span className="cl-idx">{i + 1}</span>
                <span className="cl-thumb">
                  {thumb ? <img src={thumb} alt="" draggable={false} /> : null}
                </span>
                <span className="cl-meta">
                  <span className="cl-count">
                    {empty ? '空画布' : `${c.placed.length} 张`}
                    {c.manual && !empty ? <em className="cl-tag">手工</em> : null}
                  </span>
                  <span className="cl-dim">{empty ? '等你放照片' : `${c.width}×${c.height}`}</span>
                </span>
                <span className="cl-flag">{bad ? '重叠' : over ? '超限' : ''}</span>
              </button>
              {removable && (
                <button
                  className="cl-del"
                  title="删掉这张空画布"
                  onClick={(e) => { e.stopPropagation(); onRemoveCanvas(i); }}
                >✕</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
