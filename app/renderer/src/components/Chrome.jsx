import React from 'react';

export function TopBar({ onOpen, onAutoLayout, onCompose, onRecover, busy, hasImages, canCompose, batch }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name">像素拼图</span>
        <span className="brand-sub">1:1 无损 · 为像素蛋糕而做</span>
      </div>

      {batch && (
        <div className="seg" style={{ width: 158, marginRight: 4 }} title="自动排版把照片分成了多张画布，每张对应一次像素蛋糕额度">
          <button onClick={batch.onPrev} disabled={batch.index === 0} style={{ flex: '0 0 26px' }}>‹</button>
          <span style={{
            flex: 1, display: 'grid', placeItems: 'center', fontSize: 11.5,
            fontFamily: 'var(--mono)', color: 'var(--txt-2)',
          }}>
            {batch.index + 1}/{batch.total} · {batch.count}张
          </span>
          <button onClick={batch.onNext} disabled={batch.index >= batch.total - 1} style={{ flex: '0 0 26px' }}>›</button>
        </div>
      )}

      <button className="btn" onClick={onOpen} disabled={busy}>导入照片</button>
      <button className="btn" onClick={onAutoLayout} disabled={busy || !hasImages}
        title="按 12000px 单边上限自动排版，装不下会自动分组">自动排版</button>
      <button className="btn" onClick={onRecover} disabled={busy}
        title="把像素蛋糕修完的图切回原图">切回原图</button>
      <button className="btn primary" onClick={onCompose} disabled={busy || !canCompose}>
        导出合成图
      </button>
    </header>
  );
}

export function StatusBar({ images, items, canvas, hint, problems, busy, message }) {
  const totalMP = items.reduce((s, i) => s + (i.width * i.height) / 1e6, 0);
  const over = canvas.width > 12000 || canvas.height > 12000;
  const dot = busy ? 'var(--accent)' : over || problems.length ? 'var(--danger)' : items.length ? 'var(--ok)' : 'var(--txt-3)';

  return (
    <footer className="statusbar">
      <span><i className="status-dot" style={{ background: dot }} />{message}</span>
      <span>底片 <b>{images.length}</b></span>
      <span>画布上 <b>{items.length}</b></span>
      <span>合计 <b>{totalMP.toFixed(1)}</b> MP</span>
      <span className="spacer" />
      {problems.length > 0 && (
        <span style={{ color: 'var(--danger)' }}>
          {problems[0].type === 'overlap' ? '有图片重叠，无法导出' : '图片之间间距过小'}
        </span>
      )}
      {hint && (
        <>
          <span>画布 <b>{hint.sizes}</b></span>
          <span>占上限 <b>{hint.areaPct.toFixed(1)}%</b></span>
          <span>填充率 <b>{hint.utilPct.toFixed(1)}%</b></span>
        </>
      )}
    </footer>
  );
}

export function Toasts({ list, onDismiss }) {
  return (
    <div className="toasts">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => onDismiss(t.id)}>
          <div className="t-title">{t.title}</div>
          {t.body && <div className="t-body">{t.body}</div>}
        </div>
      ))}
    </div>
  );
}

export function ProgressOverlay({ progress }) {
  if (!progress) return null;
  const pct = Math.round((progress.pct ?? 0) * 100);
  return (
    <div className="progress-overlay">
      <div className="progress-box">
        <div className="p-msg">{progress.message || '处理中…'}</div>
        <div className="progress-track"><i style={{ width: `${pct}%` }} /></div>
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--txt-3)', fontFamily: 'var(--mono)' }}>{pct}%</div>
      </div>
    </div>
  );
}
