import React from 'react';

export function TopBar({
  onOpen, onAutoLayout, onCompose, onComposeAll, onRecover,
  busy, hasImages, canCompose, batch, canvasCount,
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name">像素拼图</span>
        <span className="brand-sub">1:1 无损 · 为像素蛋糕而做</span>
      </div>

      {batch && (
        <div className="seg" style={{ width: 166, marginRight: 4 }} title="自动排版把照片分成了多张画布，每张对应一次像素蛋糕额度。也可以点左栏的「画布」列表直接跳。">
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
        title="按 12000px 单边上限搜索最优排版，装不下会自动分成最少的画布数">自动排版</button>
      <button className="btn" onClick={onRecover} disabled={busy}
        title="把像素蛋糕修完的图切回原图">切回原图</button>
      <button className="btn primary" onClick={onCompose} disabled={busy || !canCompose}
        title="只导出当前这张画布（快捷键 ⌘E）">
        导出当前画布
      </button>
      {canvasCount > 1 && (
        <button className="btn primary" onClick={onComposeAll} disabled={busy || !canCompose}
          title={`一次把所有 ${canvasCount} 张画布都导出（快捷键 ⌘⇧E）`}>
          全部导出 ({canvasCount})
        </button>
      )}
    </header>
  );
}

/** 账上的钱要短：¥15.7 / ¥1.5K —— 状态栏没地方放小数点后两位 */
export function fmtMoney(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return (v / 1000).toFixed(1) + 'K';
  if (v >= 1000) return (v / 1000).toFixed(2) + 'K';
  return v.toFixed(2);
}

export function StatusBar({ images, items, canvas, hint, problems, busy, message, ledger }) {
  const totalMP = items.reduce((s, i) => s + (i.width * i.height) / 1e6, 0);
  const over = canvas.width > 12000 || canvas.height > 12000;
  const dot = busy ? 'var(--accent)' : over || problems.length ? 'var(--danger)' : items.length ? 'var(--ok)' : 'var(--txt-3)';

  return (
    <footer className="statusbar">
      <span><i className="status-dot" style={{ background: dot }} />{message}</span>
      <span>底片 <b>{images.length}</b></span>
      <span>画布上 <b>{items.length}</b></span>
      <span>合计 <b>{totalMP.toFixed(1)}</b> MP</span>
      {ledger?.saved > 0 && (
        <span className="ledger-chip" title={`${ledger.photos} 张照片拼成 ${ledger.canvases} 张画布；不拼的话要扣 ${ledger.photos} 次额度`}>
          已省 <b>{ledger.saved}</b> 次 · <b>¥{fmtMoney(ledger.money)}</b>
        </span>
      )}
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

/**
 * 进度浮层。
 *
 * 每一张画布一条进度条，**全部铺开、不滚动** —— 用户点名要的：一眼看到整批的进度，
 * 而不是"前 5 张 + 一个滑块"。张数多的时候自动收紧行高，让它始终铺得下。
 *
 * 这里曾经列过每一步的实测耗时（解码源图 / 保护带镜像 / 贴图 + LZW 压缩），
 * 用户反馈用不到 —— 已删掉。要看性能看 README，别占着做图时的视线。
 */
function densityOf(n) {
  if (n <= 6) return 'lg';    // 宽松：说明文字换到第二行
  if (n <= 12) return 'md';   // 适中：说明文字并到右边
  if (n <= 24) return 'sm';   // 紧凑：只留序号 + 进度条 + 百分比
  return 'xs';                // 很密：一屏铺满
}

export function ProgressOverlay({ progress }) {
  if (!progress) return null;
  const pct = Math.round((progress.pct ?? 0) * 100);
  const rows = progress.rows ?? [];
  const density = densityOf(rows.length);
  const stackNote = density === 'lg';          // 说明文字换行显示，还是并排
  const showNote = density !== 'sm' && density !== 'xs';

  return (
    <div className="progress-overlay">
      <div className="progress-box">
        <div className="p-msg">{progress.message || '处理中…'}</div>
        <div className="progress-track"><i style={{ width: `${pct}%` }} /></div>

        <div className="p-foot">
          <span className="p-pct">{pct}%</span>
          {progress.workers > 1 && (
            <span className="p-workers">{progress.workers} 个进程并行
              {progress.total > 1 ? ` · 已完成 ${progress.finished ?? 0}/${progress.total}` : ''}</span>
          )}
        </div>

        {rows.length > 1 && (
          <div className={`p-rows ${density}`}>
            {rows.map((r) => (
              <div key={r.index} className={`p-row ${r.state}`}>
                <span className="pr-label">{r.label}</span>
                <div className="pr-body">
                  <div className="pr-line">
                    <span className="pr-track"><i style={{ width: `${Math.round(r.pct * 100)}%` }} /></span>
                    <span className="pr-pct">{r.state === 'pending' ? '—' : `${Math.round(r.pct * 100)}%`}</span>
                    {!stackNote && showNote && r.note && <span className="pr-note-inline">{r.note}</span>}
                  </div>
                  {stackNote && r.note && <div className="pr-note">{r.note}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
