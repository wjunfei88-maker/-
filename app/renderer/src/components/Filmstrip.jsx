import React, { useState } from 'react';

/** 左栏底片条：已导入的照片，以及它们是否已经放上画布 */
export default function Filmstrip({ images, placedIds, selectedId, onSelect, onRemove, onAdd, onAutoLayout, onClear }) {
  const [hot, setHot] = useState(false);

  const onDrop = (e) => {
    e.preventDefault(); setHot(false);
    const files = [...(e.dataTransfer?.files ?? [])]
      .map((f) => f.path || window.pc?.pathForFile(f)).filter(Boolean);
    if (files.length) onAdd(files);
  };

  return (
    <aside className="sidebar">
      <div className="section-head">
        <span className="section-title">底片</span>
        <span className="count-pill">{images.length}</span>
      </div>

      {images.length > 0 && (
        <div style={{ display: 'flex', gap: 6, padding: '0 10px 9px' }}>
          <button className="btn sm" style={{ flex: 1, justifyContent: 'center' }} onClick={onAutoLayout}
            title="按 12000px 上限自动排版（1:1 不缩放）">
            自动排版
          </button>
          <button className="btn ghost sm icon" onClick={onClear} title="清空">✕</button>
        </div>
      )}

      <div
        className={`filmstrip${hot ? ' hot' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setHot(true); }}
        onDragLeave={() => setHot(false)}
        onDrop={onDrop}
      >
        {images.map((im) => {
          const placed = placedIds.has(im.id);
          return (
            <div
              key={im.id}
              className={`film-card${selectedId === im.id ? ' selected' : ''}${placed ? ' placed' : ''}`}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/pc-image', im.id)}
              onClick={() => onSelect(im.id)}
              onDoubleClick={() => onRemove(im.id)}
              title={`${im.name}\n${im.width}×${im.height} · ${im.megapixels.toFixed(1)}MP`}
            >
              <div className="film-thumb">
                {im.url ? <img src={im.url} alt="" draggable={false} /> : <span style={{ fontSize: 14, color: 'var(--txt-3)' }}>?</span>}
              </div>
              <div className="film-meta">
                <div className="film-name">{im.name}</div>
                <div className="film-dim">
                  {im.width}×{im.height}
                  {im.error ? ' · 读取失败' : ` · ${im.megapixels.toFixed(1)}MP`}
                  {placed ? ' · 已在画布' : ''}
                </div>
              </div>
            </div>
          );
        })}

        {images.length === 0 && (
          <div className={`dropzone${hot ? ' hot' : ''}`}>
            拖照片到这里
            <div style={{ marginTop: 8, fontSize: 11, opacity: 0.7 }}>支持 JPG / TIFF / PNG / RAW</div>
          </div>
        )}
      </div>
    </aside>
  );
}
