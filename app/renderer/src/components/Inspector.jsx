import React from 'react';
import { pcfile } from '../lib/pcfile.js';

const Meter = ({ value, max = 1, tone }) => {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  const color = tone || (pct > 96 ? 'var(--danger)' : pct > 80 ? 'var(--warn)' : 'var(--accent)');
  return (
    <div className="meter"><i style={{ width: `${pct}%`, background: color }} /></div>
  );
};

const KV = ({ k, v, tone }) => (
  <div className="kv"><span className="k">{k}</span><span className={`v ${tone || ''}`}>{v}</span></div>
);

const Field = ({ label, children }) => (
  <div className="field"><label>{label}</label>{children}</div>
);

export default function Inspector(p) {
  const {
    items, canvas, hint, gutter, setGutter, problems, selectedId, onMove, onRemove,
    exp, setExp, onCompose, busy,
    rec, setRec, onRecover, onPickReturned, onPickOutDir,
    library, onForget, onReveal, onReuseBatch,
  } = p;

  const over = canvas.width > 12000 || canvas.height > 12000;

  return (
    <aside className="inspector">
      {/* ── 画布 ── */}
      <div className="section-head"><span className="section-title">画布</span></div>
      <div className="insp-group">
        <div className="card">
          <KV k="尺寸" v={canvas.width && canvas.height ? `${canvas.width} × ${canvas.height}` : '—'} tone={over ? 'danger' : ''} />
          <KV k="总像素" v={canvas.width ? `${((canvas.width * canvas.height) / 1e6).toFixed(1)} MP` : '—'} />
          <KV k="像素蛋糕上限" v="12000 × 12000" />
          <KV k="占上限" v={hint ? `${hint.areaPct.toFixed(1)}%` : '—'} />
          <Meter value={hint ? hint.areaPct / 100 : 0} />
          <div className="meter-label">
            <span>画布填充率</span>
            <b>{hint ? `${hint.utilPct.toFixed(1)}%` : '—'}</b>
          </div>
        </div>

        <div className="card">
          <Field label="保护带宽度">
            <div className="nudge" style={{ width: 96 }}>
              <input
                type="number" min="0" max="200" value={gutter}
                onChange={(e) => setGutter(Math.max(0, Math.min(200, Number(e.target.value) || 0)))}
              />
              <span className="unit">px</span>
            </div>
          </Field>
          <div className="hint">
            两张图之间留的缝，缝里填的是各自的边缘镜像。
            实测液化会在整个画布上产生约 1px 的位移场，24px 足够把它挡在缝里。
          </div>
        </div>

        {over && (
          <div className="card" style={{ borderColor: 'rgba(232,119,111,0.4)' }}>
            <div className="hint danger">
              画布超出 12000px 单边上限，像素蛋糕会拒绝导入。用「自动排版」重新分组，或把图片拖近一点。
            </div>
          </div>
        )}
        {problems.length > 0 && (
          <div className="card" style={{ borderColor: 'rgba(232,119,111,0.4)' }}>
            <div className="hint danger">
              {problems[0].type === 'overlap'
                ? '有两张图重叠了。重叠意味着被压住的像素在画布里根本不存在，切分时无处可取 —— 必须分开。'
                : '两张图之间没有留出保护带的间距。'}
            </div>
          </div>
        )}
      </div>

      {/* ── 画布上的图片 ── */}
      <div className="section-head">
        <span className="section-title">画布上的图片</span>
        <span className="count-pill">{items.length}</span>
      </div>
      <div className="insp-group">
        {items.length === 0 && <div className="hint" style={{ padding: '2px 0 10px' }}>还没有图片。导入后点「自动排版」。</div>}
        {items.map((it) => (
          <div className="card" key={it.id}
            style={selectedId === it.id ? { borderColor: 'var(--accent-line)', background: 'var(--accent-dim)' } : undefined}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 7 }}>
              <span style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.name}
              </span>
              <button className="btn ghost sm icon" onClick={() => onRemove(it.id)} title="从画布移除">✕</button>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {['x', 'y'].map((ax) => (
                <div className="nudge" key={ax} style={{ flex: 1 }}>
                  <span style={{ padding: '0 0 0 8px', fontSize: 10.5, color: 'var(--txt-3)' }}>{ax.toUpperCase()}</span>
                  <input
                    type="number" value={it[ax]}
                    onChange={(e) => onMove(it.id, { [ax]: Number(e.target.value) || 0 })}
                  />
                  <span className="unit">px</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 6, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--txt-3)' }}>
              {it.width}×{it.height} · {((it.width * it.height) / 1e6).toFixed(1)}MP · 1:1
            </div>
          </div>
        ))}
      </div>

      {/* ── 导出 ── */}
      <div className="section-head"><span className="section-title">导出合成图</span></div>
      <div className="insp-group">
        <div className="card">
          <Field label="文件名前缀">
            <input className="input" value={exp.name} onChange={(e) => setExp({ ...exp, name: e.target.value })} />
          </Field>
          <Field label="保存到">
            <div className="path-pick">
              <input className="input" value={exp.outDir} readOnly placeholder="选择文件夹…" />
              <button className="btn sm" onClick={exp.onPickDir}>选择</button>
            </div>
          </Field>
          <div className="row2">
            <Field label="格式">
              <select className="select" value={exp.compression} onChange={(e) => setExp({ ...exp, compression: e.target.value })}>
                <option value="lzw">TIFF · LZW（推荐）</option>
                <option value="none">TIFF · 不压缩</option>
                <option value="deflate">TIFF · Deflate</option>
              </select>
            </Field>
            <Field label="色彩空间">
              <select className="select" value={exp.icc} onChange={(e) => setExp({ ...exp, icc: e.target.value })}>
                <option value="srgb">sRGB</option>
                <option value="p3">Display P3</option>
                <option value="adobergb1998">Adobe RGB</option>
              </select>
            </Field>
          </div>
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', height: 32, marginTop: 4 }}
            onClick={onCompose} disabled={busy || !items.length || over || problems.length > 0}>
            导出合成图
          </button>
          <div className="hint">
            导出 TIFF 后直接丢进像素蛋糕，修完**不要改文件名**导出到同一目录，再回来点「切回原图」。
          </div>
        </div>
      </div>

      {/* ── 切回原图 ── */}
      <div className="section-head"><span className="section-title">切回原图</span></div>
      <div className="insp-group">
        <div className="card">
          <Field label="像素蛋糕修完的文件">
            <div className="path-pick">
              <input className="input" value={rec.returnedFile || ''} readOnly placeholder="选择文件…" />
              <button className="btn sm" onClick={onPickReturned}>选择</button>
            </div>
          </Field>
          {rec.matched && (
            <div className="hint ok" style={{ color: 'var(--ok)' }}>
              已匹配到合成记录：{rec.matched.name} · {rec.matched.canvas.width}×{rec.matched.canvas.height} · {rec.matched.items.length} 张
            </div>
          )}
          {rec.returnedFile && !rec.matched && (
            <div className="hint warn">在同目录下没找到对应的 .manifest.json，无法确定切分位置。</div>
          )}
          <Field label="输出到">
            <div className="path-pick">
              <input className="input" value={rec.outDir} readOnly placeholder="选择文件夹…" />
              <button className="btn sm" onClick={onPickOutDir}>选择</button>
            </div>
          </Field>
          <div className="row2">
            <Field label="输出格式">
              <select className="select" value={rec.format} onChange={(e) => setRec({ ...rec, format: e.target.value })}>
                <option value="jpeg">JPG</option>
                <option value="tiff">TIFF</option>
                <option value="png">PNG</option>
                <option value="original">跟原图一致</option>
              </select>
            </Field>
            <Field label="画质">
              <select className="select" value={rec.quality} onChange={(e) => setRec({ ...rec, quality: Number(e.target.value) })}>
                {[14, 13, 12, 11, 10].map((q) => (
                  <option key={q} value={q}>{q === 14 ? '14 · 最高' : q}</option>
                ))}
              </select>
            </Field>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--txt-2)', margin: '2px 0 9px' }}>
            <input type="checkbox" checked={rec.keepExif} onChange={(e) => setRec({ ...rec, keepExif: e.target.checked })} />
            把原图的 EXIF 搬回来（并摘掉内嵌的旧缩略图）
          </label>
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', height: 32 }}
            onClick={onRecover} disabled={busy || !rec.returnedFile || !rec.matched}>
            切回原图
          </button>
        </div>
      </div>

      {/* ── 历史批次 ── */}
      {library.batches?.length > 0 && (
        <>
          <div className="section-head">
            <span className="section-title">历史批次</span>
            <span className="count-pill">{library.batches.length}</span>
          </div>
          <div className="insp-group" style={{ paddingBottom: 20 }}>
            {library.batches.slice(0, 12).map((b) => (
              <div className="batch" key={b.id}>
                {b.previewFile
                  ? <img src={pcfile(b.previewFile)} alt="" />
                  : <div style={{ width: 40, height: 30, borderRadius: 5, background: '#2a2a2e' }} />}
                <div className="batch-meta">
                  <div className="batch-name">{b.name}</div>
                  <div className="batch-sub">{b.canvas.width}×{b.canvas.height} · {b.count}张</div>
                </div>
                <button className="btn ghost sm" onClick={() => onReuseBatch(b)} title="载入这一批做切分">用</button>
                <button className="btn ghost sm icon" onClick={() => onReveal(b.canvasFile)} title="在访达中显示">↗</button>
                <button className="btn danger-ghost sm icon" onClick={() => onForget(b.id)} title="移除记录">✕</button>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
