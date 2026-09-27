# 像素拼图 · AI 协作者须知

这份文件是给替我改这个项目的 AI 看的。**每一条都是真踩过的坑**，不是想象中的风险。
用户是摄影师，不是程序员 —— 跟他说人话。

---

## 一、这个项目是什么

Electron + React 桌面应用。把一堆照片 1:1 无损拼成几张画布，送进像素蛋糕（PixCake）
只扣一次额度，修完再切回原图。

**硬约束（绝不能破）**
- **纯 JavaScript，永远不要转 TypeScript**
- 唯一运行时依赖 `sharp`，不要加别的
- `npm test` 必须全绿才算改完
- **永远不能改成"缩放"** —— 全程 1:1
- 保护带必须填**各自边缘的镜像像素**，不许填灰底、不许填邻图
- 不用 `sharp` 的 `withExif` 搬 EXIF（它会重新编码，破坏无损）
- 设计系统：深暖灰底 + 单一香槟金 `#dda45c` + 暖白文字 `#f0ede7`，
  动效 `cubic-bezier(0.32,0.72,0,1)` / `170ms`

---

## 二、改代码：五个会**静默**毁掉文件的坑

1. **用脚本批量改 JSX 时，anchor 必须唯一。**
   `s.index("export function Toasts(")` 命中的是文件里**第一个**，可能在目标位置**之前** →
   `start > end` → `s[:start] + new + s[end:]` 把中间那段**复制了一遍**，
   文件里出现两份同名函数，而 `npm run build` **居然还通过**。
   → 改完必须 `grep -n "^export function\|^function\|^class" <file>` 数一遍有没有重名。

2. **别用 `"\n  return ("` 这种通用 anchor。**
   它会命中文里**第一个** `return (`。曾经因此把 helper 插进了 `Meter` 组件而不是
   `Inspector` → 整窗口黑屏。
   → 用足够独特的一行做 anchor。

3. **多步 `python3` 脚本里，`assert` 失败后续的 `write` 不会执行。**
   整批改动全没生效，但脚本的报错很容易被后面的日志淹没。
   → 每步 `print()` 出声，或分成多次独立调用。

4. **主进程代码没有构建步骤兜底。**
   一次改 `main.mjs` 少写一个括号：`npm test` 全绿、`build` 全绿，**App 一双击就死**，
   而且表现是「进程 0% CPU、毫无输出」，极难查。
   → 改完主进程必须 `node --check app/main/*.mjs`（测试第 ⑯ 节已经自动查了）。

5. **`grep` 管道会块缓冲。**
   把关键日志塞在 `... | grep -E "^\[eval\]"` 后面，进程被 kill 时输出全丢，
   看起来像"什么都没打印"。
   → 调试时直接 `tail`，别用 grep 过滤。

---

## 三、React：一个已经栽过两次的错

**`useCallback` / `useMemo` 的依赖数组是在渲染期求值的** —— 里面引用的 `const`
必须先声明。写反了就是 `ReferenceError: Cannot access 'Qe' before initialization` →
整窗口黑屏。

> 这个项目已经因此栽过两次（`loadReturned`、`recover`）。**把函数定义放在依赖它的
> `useCallback` 之后**，别嫌别扭。

**渲染层的错误边界必须一直留着**（`app/renderer/src/main.jsx` 的 `class Boundary`）。
没有它，任何渲染期错误都只是"黑屏"；有了它，黑屏变成页面上可读的堆栈。
上面那个 TDZ 就是靠它才查出来的。

---

## 四、界面验收（PC_EVAL）的坑

开发开关：`PC_DEMO` / `PC_SHOT` / `PC_SHOT_DELAY` / `PC_EVAL='<js>'` / `PC_EVAL_WAIT` /
`PC_JOBS=n` / `PC_SMOKE` / `PC_DEBUG`。启动必须带
`--no-sandbox --disable-gpu --user-data-dir=/tmp/<dir>` + `ELECTRON_DISABLE_SANDBOX=1`。

1. **`PC_SHOT_DELAY` 必须大于 `PC_EVAL` 的耗时**，否则 App 在 eval 跑完前就退出了，
   你会以为"什么都没发生"。
2. **截图抓不住瞬间状态。** 进度浮层几秒就跑完，截图经常落在它消失之后。
   → **PC_EVAL 里读 DOM 才是可靠证据**，截图只做事后确认。
   → 想看清过程就 `PC_JOBS=1` 把耗时拉长，或把点击时机和 `PC_SHOT_DELAY` 对齐到同一秒内。
3. **`.inspector` 是滚动容器**：`scrollIntoView` 对里面的元素**无效**，
   必须 `document.querySelector('.inspector').scrollTop = scrollHeight`。
4. **React 受控输入框必须用原生 setter**：
   ```js
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
   el.dispatchEvent(new Event('input', { bubbles: true }));
   ```
   直接 `el.value = v` 无效；receiver 用错会抛 `Illegal invocation`。
5. 合成 `DragEvent` **可用**（配 `DataTransfer`）；合成 `PointerEvent` **不可用**。
6. **`npm test` 覆盖不到 `main.mjs`**（它要 Electron）。主进程/界面联动的 bug
   只能靠 PC_EVAL 冒烟测试抓 —— 真抓到过好几次。
7. 临时脚本要**放在项目内**（`/tmp` 下 `import sharp` 会 `ERR_MODULE_NOT_FOUND`），用完删。
8. 测试文件里的助手函数**别重名**（`mk` 已存在 → `SyntaxError`，整个测试跑不起来）。
9. **纯色测试图测不出性能**：LZW 一压就没。要造高熵图（噪声放大 + 彩色块）。

---

## 五、产品原则（每一条都对应一个用户报过的真 bug）

1. **"文件写到哪了"不能只靠一条会消失的 toast。**
   用户报过「显示切回完成，一看文件夹啥也没有」—— 文件其实全在，只是在他早前手选的
   自定义目录里，而那个路径在界面上是只读 input，**从右边截断**，被截掉的正好是最要紧的
   目录名。→ 路径要能换行完整显示 + 打「自定义位置」标记 + 给「打开」按钮。

2. **一个叫「切回」的按钮必须真的切回。**
   曾经的「扫码切回」只配对不切分，切分还要再点一个按钮 —— 用户直接问「这按钮有啥用」。
   → 一个按钮干完一件事；两步合并成一步。

3. **进度条不许先说"完事了"。**
   只要还有一张没落盘，总进度永远 < 100%；每张画布的内部进度最多贡献 0.99。

4. **数字必须是真话。**
   - 标题里的「正在并行 N 张」必须真的在跑 N 张 —— 曾经把 32 张全标成 running，
     实际只有 10 张在动；也曾经把"在跑但 pct=0"的行降级成"等待中"，
     10 路并看起来像一路排队。
   - **真正跑着的工作不许因为进度是 0 就看起来像没开始**（给个 5px 的最小可见宽度）。

5. **不要让用户面对"这两条我该点哪个"。**
   同一屏出现两个长得一样的按钮，就是设计错了。

6. **别让一次误操作毁掉用户的手工劳动。**
   手工摆的画布不能被「自动排版」冲掉；空的自动画布可以丢，空的手工画布要留着。

7. **不确定的事如实说。**
   比如 `min(4, 核数-1)` 这个上限是拍的、不是算出来的，就要在 README 里写明「这是我拍的」。

---

## 六、每次改完的固定动作

```bash
npm test                      # 必须 N 项全绿
npm run build                 # 渲染层
node --check app/main/main.mjs   # 主进程（测试第 ⑯ 节也会查）
```

然后：提交 → `git push origin main` → `git push backup main` →
**核对三处 SHA 一致**（本地 / GitHub / 备份裸仓库）→ 重新打包
（`ELECTRON_MIRROR=... node scripts/package.mjs --dmg`）→ 清理 `/tmp` 夹具。

改完之后要主动告诉用户：**`/Applications/像素拼图.app` 还是老版本，要手动覆盖。**
