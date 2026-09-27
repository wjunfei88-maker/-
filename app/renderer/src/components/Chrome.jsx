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

/** 秒表格式：<1s 显示毫秒，>=1s 显示秒（一位小数） */
function fmtMs(ms) {
  if (!ms && ms !== 0) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 进度浮层。
 * 不只转圈：把**真实阶段耗时**列出来 —— 用户抱怨过"芯片跑不满、不知道慢在哪"，
 * 所以时间必须花在哪一步就显示哪一步（这些数字是后端 onProgress 里带出来的实测值，不是估的）。
 */
export function ProgressOverlay({ progress }) {
  // 一列进度条要**自动跟着正在跑的那张滚** —— 8 张画布时框里放不下，
  // 不滚的话用户看到的是前 5 张，正在动的挤在看不见的下半截。
  const rowsEarly = progress?.rows ?? [];
  const firstRunning = rowsEarly.findIndex((r) => r.state === 'running');
  const boxRef = React.useRef(null);
  React.useEffect(() => {
    const box = boxRef.current;
    if (!box || firstRunning < 0) return;
    const el = box.children[firstRunning];
    if (!el) return;
    const top = el.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top + el.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = Math.max(0, top - 6);
    }
  }, [firstRunning]);
  if (!progress) return null;
  const pct = Math.round((progress.pct ?? 0) * 100);
  const timings = progress.timings ?? [];
  const rows = progress.rows ?? [];
  const slowest = timings.reduce((m, t) => (t.ms > (m?.ms ?? 0) ? t : m), null);

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

        {/* 每一张画布自己一条进度条 —— 并行时只有一个总进度条看不出谁卡住了 */}
        {rows.length > 1 && (
          <div className="p-rows" ref={boxRef}>
            {rows.map((r) => (
              <div key={r.index} className={`p-row ${r.state}`}>
                <span className="pr-label">{r.label}</span>
                <div className="pr-body">
                  <div className="pr-line">
                    <span className="pr-track"><i style={{ width: `${Math.round(r.pct * 100)}%` }} /></span>
                    <span className="pr-pct">{r.state === 'pending' ? '—' : `${Math.round(r.pct * 100)}%`}</span>
                  </div>
                  {r.note && <div className="pr-note">{r.note}</div>}
                </div>
              </div>
            ))}
          </div>
        )}

        {timings.length > 0 && (
          <div className="p-timings">
            {/* 标清楚这组耗时是哪一张画布的：并行时不能让人以为它是全局的 */}
            {progress.timingsTitle && <div className="p-t-title">{progress.timingsTitle}</div>}
            {timings.map((t) => (
              <div key={t.label} className={`p-t${t === slowest ? ' slow' : ''}`}>
                <span className="p-tl">{t.label}</span>
                <span className="p-tm">{fmtMs(t.ms)}</span>
              </div>
            ))}
            {/* 只看这张画布自己跑完没有 —— 不能用全局 pct，否则最后一张还在编码，
                这里却已经在说"最慢的一步"了 */}
            {progress.timingsLive && (
              <div className="p-t running">
                <span className="p-tl">进行中…</span>
                <span className="p-tm">—</span>
              </div>
            )}
            {slowest && timings.length > 1 && (
              <div className="p-note">
                {progress.timingsLive
                  ? `已完成的部分里，最慢的是「${slowest.label}」`
                  : `最慢的一步是「${slowest.label}」，占了大部分时间`}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
