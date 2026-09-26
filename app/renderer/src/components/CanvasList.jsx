import React from 'react';

/**
 * 画布列表
 *
 * 自动排版把照片拆成多张画布时（40 张 42MP → 20 张画布），
 * 靠顶栏的 ‹ 1/20 › 一张张点是折磨。这里直接列出每一张：
 * 第几张、装了几张、多大、有没有问题，点一下就跳过去。
 *
 * 每张画布 = 像素蛋糕的一次额度，所以列表本身就是"账单"。
 */
export default function CanvasList({ canvases, index, problems, thumbs, onSelect }) {
  if (!canvases?.length) return null;

  const total = canvases.length;
  const savedPct = Math.round((1 - total / Math.max(1, canvases.reduce((s, c) => s + c.placed.length, 0))) * 100);

  return (
    <div className="canvaslist">
      <div className="cl-summary">
        <span>共 <b>{total}</b> 张画布</span>
        <span className="sep" />
        <span>省 <b>{savedPct}%</b> 额度</span>
      </div>

      <div className="cl-rows">
        {canvases.map((c, i) => {
          const bad = (problems?.[i]?.length ?? 0) > 0;
          const over = c.width > 12000 || c.height > 12000;
          const thumb = thumbs?.[c.placed[0]?.id];
          return (
            <button
              key={i}
              className={`cl-row${i === index ? ' on' : ''}${bad || over ? ' bad' : ''}`}
              onClick={() => onSelect(i)}
              title={`画布 ${i + 1}：${c.placed.length} 张 · ${c.width}×${c.height}${bad ? ' · 有重叠需要处理' : ''}`}
            >
              <span className="cl-idx">{i + 1}</span>
              <span className="cl-thumb">
                {thumb ? <img src={thumb} alt="" draggable={false} /> : null}
              </span>
              <span className="cl-meta">
                <span className="cl-count">{c.placed.length} 张</span>
                <span className="cl-dim">{c.width}×{c.height}</span>
              </span>
              <span className="cl-flag">{bad ? '重叠' : over ? '超限' : ''}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
