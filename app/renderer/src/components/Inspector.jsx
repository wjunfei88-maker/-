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
    allowRotate, setAllowRotate, rotCount, capacity, canvasCount, maxPerCanvas,
    exp, setExp, onCompose, onComposeAll, busy,
    rec, setRec, onRecover, onPickReturned, onPickOutDir, recoverDir, onResetOutDir,
    onScanExport, onClearLibrary, onOpenDir, lastRec, defaultRecoverDir, recoverSubdir,
    library, onForget, onReveal, onReuseBatch, sys, onSetJobs,
    ledger, price, onSetPrice,
  } = p;

  // 用户以前手选过一个自定义目录时，「默认」和「当前」就不一样了 —— 必须显眼地说出来
  const customOutDir = !!(rec.outDir && defaultRecoverDir && rec.outDir !== defaultRecoverDir);
  // 路径太长会被截断，而最要紧的恰恰是最后那一段目录名，所以保留「…/最后两段」
  const shortDir = (p) => {
    const parts = String(p || '').split('/').filter(Boolean);
    return parts.length <= 2 ? String(p || '') : `…/${parts.slice(-2).join('/')}`;
  };

  const over = canvas.width > 12000 || canvas.height > 12000;
  const blocked = over || problems.length > 0 || !items.length;
  // 大数字取"几何上限"和"这批实际排到的"里更大的那个：
  //   · 同尺寸网格算出来的上限（capacity.max）
  //   · 横竖混搭实际塞进去的张数（maxPerCanvas）—— A7M4 会比网格多 1 张
  const capMax = Math.max(maxPerCanvas || 0, capacity?.max || 0);

  return (
    <aside className="inspector">
      {/* ── 容量说明：为什么一张画布只能放 N 张 ── */}
      {capacity && capacity.max > 0 && (
        <>
          <div className="section-head"><span className="section-title">一张画布能放几张</span></div>
          <div className="insp-group">
            <div className="card">
              <div className="cap-head">
                <span className="cap-big">{capMax}</span>
                <span className="cap-txt">
                  张 / 画布<br />
                  <span className="muted">{capacity.size} 单张尺寸</span>
                </span>
              </div>
              <div className="cap-rows">
                {capacity.rows.map((r) => (
                  <div key={r.text} className={`cap-row${r.ok ? '' : ' off'}`}>
                    <span>{r.text}</span>
                    <span className="mono">{r.width}×{r.height}</span>
                    <span className={r.ok ? 'ok' : 'bad'}>
                      {r.ok ? `${r.count} 张 ✔` : `超 ${r.overBy}px`}
                    </span>
                  </div>
                ))}
              </div>
              {maxPerCanvas > capacity.max && (
                <div className="hint ok" style={{ color: 'var(--ok)' }}>
                  横竖混搭的装箱比同尺寸网格多塞了 {maxPerCanvas - capacity.max} 张 —— 这就是「智能排版」在帮你省的地方。
                </div>
              )}
              {canvasCount > 0 && maxPerCanvas > 0 && (
                <div className="hint">
                  你这批照片：一张画布实际排到 <b>{maxPerCanvas}</b> 张，共排成 <b>{canvasCount}</b> 张画布
                  （一张画布 = 像素蛋糕的一次额度）。
                </div>
              )}
              <div className="hint">
                像素蛋糕的限制是 <b>单边 12000px</b>，不是总面积。所以"能拼几张"首先是几何问题，
                不是软件没优化。想再往上塞就只有缩放照片（违背 1:1 不缩放），默认不做。
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── 画布 ── */}
      <div className="section-head">
        <span className="section-title">当前画布</span>
        {canvasCount > 1 && <span className="count-pill">{items.length} 张</span>}
      </div>
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
          {hint && (
            <div className="hint" style={{ marginTop: 8 }}>
              还能往外拖的余量：<b className="mono">{hint.remainW} × {hint.remainH}</b> px
            </div>
          )}
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
            两张图之间留的缝，缝里填的是**各自的边缘镜像**。
            实测液化会在整个画布上产生约 1px 的位移场，24px 足够把它挡在缝里。
            改大改小会立刻重排。⚠️ 缝隙很吃空间：缝为 0 时 6000×4000 能放 6 张，缝为 24 时只能放 2 张。
          </div>
        </div>

        <div className="card">
          <label className="switch-row">
            <input type="checkbox" checked={allowRotate} onChange={(e) => setAllowRotate(e.target.checked)} />
            <span>
              <b>允许旋转 90° 塞得更紧</b>
              <span className="hint" style={{ marginTop: 3, display: 'block' }}>
                旋转是整数像素重排，**完全无损**，切回原图时会自动转正。
                但画布里的脸是躺着的，像素蛋糕的人脸识别可能认不出。
                实测：40 张竖拍/横拍混合，开启后画布从 20 张降到 14 张。建议先小批量试。
              </span>
            </span>
          </label>
          {allowRotate && rotCount > 0 && (
            <div className="hint warn">当前有 {rotCount} 张被旋转了 90°。</div>
          )}
        </div>

        {over && (
          <div className="card" style={{ borderColor: 'rgba(232,119,111,0.4)' }}>
            <div className="hint danger">
              画布超出 12000px 单边上限，像素蛋糕会拒绝导入。把图片往回拖，或点「自动排版」重新分组。
            </div>
          </div>
        )}
        {problems.length > 0 && (
          <div className="card" style={{ borderColor: 'rgba(232,119,111,0.4)' }}>
            <div className="hint danger">
              {problems[0].type === 'overlap'
                ? '有两张图重叠了。重叠意味着被压住的像素在画布里根本不存在，切分时无处可取 —— 拖开它们后才能导出。'
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
        {items.length === 0 && <div className="hint" style={{ padding: '2px 0 10px' }}>这张画布还没有图片。导入后点「自动排版」。</div>}
        {items.map((it) => (
          <div className="card" key={it.id}
            style={selectedId === it.id ? { borderColor: 'var(--accent-line)', background: 'var(--accent-dim)' } : undefined}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 7 }}>
              <span style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.name}
                {it.rotation === 90 && <span className="rot-tag">↻90°</span>}
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
              {(it.natural?.width ?? it.width)}×{(it.natural?.height ?? it.height)} · {((it.width * it.height) / 1e6).toFixed(1)}MP · 1:1
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
              <span className="path-view" title={exp.outDir}>{exp.outDir || '还没选位置'}</span>
              <button className="btn sm" onClick={() => onOpenDir(exp.outDir)} disabled={!exp.outDir}
                title="在访达里打开这个文件夹">打开</button>
              <button className="btn sm" onClick={exp.onPickDir}>更改…</button>
            </div>
          </Field>
          <div className="hint" style={{ marginTop: -2 }}>
            选一个位置就行，软件会在里面自动建 <span className="mono">{exp.subdir || '像素拼图导出'}/</span> 文件夹，
            成片（<span className="mono">.tif</span> + <span className="mono">.manifest.json</span>）都放进去，
            不会和别的文件混在一起。界面回显用的预览小图再收进一层 <span className="mono">预览图/</span>。
          </div>
          <div className="row2">
            <Field label="格式">
              <select className="select" value={exp.compression} onChange={(e) => setExp({ ...exp, compression: e.target.value })}>
                <option value="lzw">TIFF · LZW（推荐）</option>
                <option value="none">TIFF · 不压缩（快很多，文件大几倍）</option>
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
          {canvasCount > 1 ? (
            <>
              <button className="btn primary" style={{ width: '100%', justifyContent: 'center', height: 32, marginTop: 4 }}
                onClick={onComposeAll} disabled={busy || blocked}>
                全部导出 · {canvasCount} 张画布
              </button>
              <button className="btn" style={{ width: '100%', justifyContent: 'center', height: 30, marginTop: 6 }}
                onClick={onCompose} disabled={busy || blocked}>
                只导出当前这张
              </button>
              <div className="hint">
                一次产出 {canvasCount} 个 TIFF + {canvasCount} 个 manifest，
                文件名会带 <span className="mono">_c01 _c02</span> 后缀，方便和画布列表对上号。
              </div>
            </>
          ) : (
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center', height: 32, marginTop: 4 }}
              onClick={onCompose} disabled={busy || blocked}>
              导出合成图
            </button>
          )}
          {sys && (
            <div className="perf-note" title="TIFF 压缩本身只用一个核，所以靠「同时导多张」把机器用满；内存不够时会自动降到 1。">
              <span className="pn-dot" />
              这台机器：导出最多能开 <b>{sys.export.max}</b> 个 · 切回最多 <b>{sys.split.max}</b> 路
              <span className="pn-sub">{sys.export.reason}</span>
            </div>
          )}
          {sys && (
            <div className="row2" style={{ marginTop: 8 }}>
              <Field label="同时导出">
                <select className="select" value={sys.export.asked}
                  onChange={(e) => onSetJobs('export', Number(e.target.value))}>
                  <option value={0}>自动（推荐 {sys.export.recommended}）</option>
                  {Array.from({ length: sys.export.max }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>{n} 个{n === 1 ? '（不并行，最省内存）' : ''}</option>
                  ))}
                </select>
              </Field>
              <Field label="切回并行">
                <select className="select" value={sys.split.asked}
                  onChange={(e) => onSetJobs('split', Number(e.target.value))}>
                  <option value={0}>自动（推荐 {sys.split.recommended}）</option>
                  {Array.from({ length: sys.split.max }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>{n} 路</option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          {sys?.export?.clampNote && <div className="hint warn-hint">{sys.export.clampNote}</div>}
          {sys?.split?.clampNote && <div className="hint warn-hint">{sys.split.clampNote}</div>}
          <div className="hint">
            导出 TIFF 后直接丢进像素蛋糕，修完**不要改文件名**导出到同一目录，再回来点「切回原图」。
          </div>
        </div>
      </div>

      {/* ── 切回原图（支持批量）── */}
      <div className="section-head">
        <span className="section-title">切回原图</span>
        {rec.plan?.okCount > 0 && <span className="count-pill">{rec.plan.okCount}/{rec.plan.total}</span>}
      </div>
      <div className="insp-group">
        <div className="card">
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }}
            onClick={onScanExport} disabled={busy}>
            一键切回原图
          </button>
          <div className="alt-row">
            <button className="btn ghost sm" onClick={onPickReturned}>像素蛋糕存到别处了？手动选</button>
          </div>

          {!rec.plan && (
            <div className="hint">
              上面那个按钮会自己去扫导出目录（<span className="mono">{shortDir(defaultRecoverDir) || '默认位置'}</span>），
              把成片和旁边的 <b>.manifest.json</b> 配好对，<b>然后直接切</b>。<br />
              只有像素蛋糕把成片存到别处、或者你分批导过的时候，才用下面的「手动选」。
            </div>
          )}

          {rec.plan && (
            <>
              <div className={`hint ${rec.plan.okCount ? '' : 'warn'}`}
                style={rec.plan.okCount ? { color: 'var(--ok)' } : undefined}>
                {rec.plan.okCount
                  ? <>找到 <b>{rec.plan.okCount}</b> 张画布 · 可以切回 <b>{rec.plan.imageCount}</b> 张原图
                    {rec.plan.total > rec.plan.okCount ? `（${rec.plan.total - rec.plan.okCount} 个跳过）` : ''}</>
                  : '这些文件旁边都没找到 .manifest.json，无法确定切分位置。'}
              </div>
              <div className="match-list">
                {rec.plan.rows.map((r) => (
                  <div key={r.file} className={`match-row${r.ok ? '' : ' bad'}`} title={r.file}>
                    <span className="mr-dot" />
                    <span className="mr-name">{r.name}</span>
                    <span className="mr-meta">{r.ok ? `${r.count} 张` : '缺记录'}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <Field label={<span>输出到{customOutDir && <em className="tag-custom">自定义位置</em>}</span>}>
            <div className="path-pick">
              <span className="path-view" title={rec.outDir}>{rec.outDir || '还没选位置'}</span>
              <button className="btn sm" onClick={() => onOpenDir(rec.outDir)} disabled={!rec.outDir}
                title="在访达里打开这个文件夹">打开</button>
              <button className="btn sm" onClick={onPickOutDir}>更改…</button>
            </div>
          </Field>
          <div className="hint">
            {customOutDir ? (
              <>
                现在切回来的原图会放进上面那个文件夹（<span className="mono">{shortDir(rec.outDir)}</span>），
                <strong>不是你导出的那个目录</strong>。默认位置是
                <span className="mono"> {defaultRecoverDir}</span>——
                想改回去点 <button className="link-btn" onClick={onResetOutDir}>恢复默认位置</button>。
              </>
            ) : (
              <>
                和导出一样自带一个 <span className="mono">{recoverSubdir || '切回原图'}/</span> 文件夹，
                就在导出目录旁边，切回来的原图有地方放，不用每次手选。
              </>
            )}
          </div>
          {lastRec?.dir && (
            <div className="last-out">
              上次切回 <b>{lastRec.count}</b> 张 →&nbsp;
              <span className="mono" title={lastRec.dir}>{shortDir(lastRec.dir)}</span>
              <button className="link-btn" onClick={() => onOpenDir(lastRec.dir)}>打开文件夹</button>
            </div>
          )}
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
            把原图的 EXIF 搬回来（摘掉旧缩略图 + 朝向归一）
          </label>
          {rec.source === 'manual' && (rec.plan?.okCount ?? 0) > 0 && (
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center', height: 32 }}
              onClick={() => onRecover()} disabled={busy}>
              {(rec.plan?.okCount ?? 0) > 1 ? `全部切回（${rec.plan.imageCount} 张原图）` : '切回原图'}
            </button>
          )}
        </div>
      </div>

      {/* ── 历史批次 + 省额度账本 ── */}
      {library.batches?.length > 0 && (
        <>
          <div className="section-head">
            <span className="section-title">历史批次</span>
            <span className="count-pill">{library.batches.length}</span>
            <button className="link-btn right" onClick={onClearLibrary}>一键清空</button>
          </div>
          {ledger && ledger.saved > 0 && (
            <div className="insp-group">
              <div className="ledger-card">
                <div className="lg-main">
                  <b>¥{ledger.money.toFixed(2)}</b>
                  <span>省了 <b>{ledger.saved}</b> 次额度</span>
                </div>
                <div className="hint">
                  {ledger.photos} 张照片拼成 <b>{ledger.canvases}</b> 张画布。
                  不拼的话像素蛋糕要扣 <b>{ledger.photos}</b> 次。
                </div>
                <div className="lg-price">
                  <span>像素蛋糕套餐</span>
                  <input className="minput" type="number" min="1" step="1" value={price.planPrice}
                    onChange={(e) => onSetPrice({ planPrice: Number(e.target.value) })} />
                  <span>元 /</span>
                  <input className="minput" type="number" min="1" step="1" value={price.planSheets}
                    onChange={(e) => onSetPrice({ planSheets: Number(e.target.value) })} />
                  <span>张</span>
                </div>
                <div className="lg-price-sub">单张 ¥{ledger.unitPrice.toFixed(3)} —— 改了上面的价，省下的钱当场重算</div>
                <div className="hint">
                  每张画布只算一次额度。<b>哪一次是白做的测试，就把那一条 ✕ 掉</b>，省下的次数会跟着扣掉。
                </div>
              </div>
            </div>
          )}
          <div className="insp-group" style={{ paddingBottom: 20 }}>
            {library.batches.slice(0, 12).map((b) => (
              <div className="batch" key={b.id}>
                {b.previewFile
                  ? <img src={pcfile(b.previewFile)} alt="" />
                  : <div style={{ width: 44, height: 32, borderRadius: 5, background: '#2a2a2e' }} />}
                <div className="batch-meta">
                  <div className="batch-name">{b.name}</div>
                  <div className="batch-sub">
                    {b.canvas.width}×{b.canvas.height} · {b.count}张
                    {b.count > 1 && <em className="lg-saved">省 {b.count - 1} 次</em>}
                  </div>
                </div>
                <button className="btn ghost sm" onClick={() => onReuseBatch(b)} title="载入这一批做切分">用</button>
                <button className="btn ghost sm icon" onClick={() => onReveal(b.canvasFile)} title="在访达中显示">↗</button>
                <button className="btn danger-ghost sm icon" onClick={() => onForget(b.id)} title="移除这条记录（这一次省下的额度也会从账上扣掉）">✕</button>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
