#!/usr/bin/env node
/**
 * 打包成 macOS .app
 *
 *   npm run package
 *
 * 产物：release/像素拼图-darwin-arm64/像素拼图.app
 *
 * 要点：
 *  · sharp 是原生模块（.node + libvips 的 .dylib），必须从 asar 里解出来，
 *    否则打包后一启动就报找不到模块
 *  · asar 里只装运行时真正需要的东西（app/ + dist/ + package.json + sharp），
 *    M0 探针、工具脚本、源码、测试全部排除
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as packagerMod from '@electron/packager';

// 这个包只有具名导出，没有 default
const packager = packagerMod.packager ?? packagerMod.default;
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'release');
const NAME = '像素拼图';

// 打包前必须已经构建过渲染层
if (!fs.existsSync(path.join(ROOT, 'dist/index.html'))) {
  console.error('✘ 还没构建渲染层。先跑 npm run build');
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'build/icon.icns'))) {
  console.error('✘ 还没有图标。先跑 npm run icon');
  process.exit(1);
}

const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

console.log(`打包 ${NAME} · darwin/${arch} …`);
const t0 = Date.now();

const paths = await packager({
  dir: ROOT,
  name: NAME,
  platform: 'darwin',
  arch,
  out: OUT,
  overwrite: true,
  appBundleId: 'com.wangjunfei.pixcaketiler',
  appCategoryType: 'public.app-category.photography',
  appVersion: '1.0.0',
  buildVersion: '1.0.0',
  icon: path.join(ROOT, 'build/icon.icns'),
  prune: true,
  asar: {
    // 原生模块必须解包
    unpack: '{**/node_modules/sharp/**,**/node_modules/@img/**}',
  },
  ignore: [
    /^\/release($|\/)/,
    /^\/probes($|\/)/,
    /^\/inbox($|\/)/,
    /^\/outbox($|\/)/,
    /^\/tools($|\/)/,
    /^\/src($|\/)/,
    /^\/scripts($|\/)/,
    /^\/build($|\/)/,
    /^\/app\/test($|\/)/,
    /^\/\.git($|\/)/,
    /^\/README\.md$/,
    /^\/M0-结果\.md$/,
    /^\/比对像素蛋糕导出结果\.command$/,
    /^\/vite\.config\.mjs$/,
    /^\/package-lock\.json$/,
  ],
  extendInfo: {
    NSHighResolutionCapable: true,
    LSMinimumSystemVersion: '11.0',
    CFBundleDisplayName: NAME,
    NSHumanReadableCopyright: '本地工具 · 仅供个人使用',
  },
  quiet: false,
});

// packager 返回的路径在不同版本里含义不一致，直接找 .app 最稳
const findApp = (p) => {
  if (p.endsWith('.app')) return p;
  const hit = fs.readdirSync(p, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.endsWith('.app'));
  return hit ? path.join(p, hit.name) : p;
};
const appPath = fs.existsSync(paths[0]) ? findApp(paths[0]) : findApp(path.join(OUT, `像素拼图-darwin-${arch}`));
if (!fs.existsSync(appPath)) { console.error('✘ 找不到生成的 .app'); process.exit(1); }

const mb = (n) => (n / 1024 / 1024).toFixed(0) + ' MB';
console.log(`\n✔ 打包完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  ${path.relative(ROOT, appPath)}`);

// 体积统计：必须用 lstat 且跳过符号链接，否则 Electron Framework 里的软链会被重复计算
const du = (p) => {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(f);
      else { try { total += fs.lstatSync(f).size; } catch { /* 跳过 */ } }
    }
  };
  walk(p);
  return total;
};
console.log(`  体积 ${mb(du(appPath))}`);

// 自检：sharp 的原生绑定和 libvips 动态库必须真的躺在 asar 外面
const unpacked = path.join(appPath, 'Contents/Resources/app.asar.unpacked');
const nativeFiles = [];
const walkFind = (d) => {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walkFind(f);
    else if (/\.(node|dylib)$/.test(e.name)) nativeFiles.push(e.name);
  }
};
walkFind(unpacked);
const hasBinding = nativeFiles.some((f) => f.endsWith('.node'));
const hasVips = nativeFiles.some((f) => f.includes('libvips'));
console.log(`  sharp 原生绑定：${hasBinding ? '✔ ' + nativeFiles.find((f) => f.endsWith('.node')) : '✘ 缺失'}`);
console.log(`  libvips 动态库：${hasVips ? '✔ ' + nativeFiles.find((f) => f.includes('libvips')) : '✘ 缺失'}`);
if (!hasBinding || !hasVips) {
  console.error('\n⚠️  原生模块没被正确解包，打包后的应用会启动失败。');
  process.exitCode = 2;
}

// 可选：顺带做一个 DMG（方便拖进「应用程序」）
//
// 给别的人用，DMG 里不能只放 .app —— 没做公证的 app 一打开就被 macOS 拦住，
// 收件人只会看到「已损坏，移到废纸篓」。所以里面要同时放一份「使用说明.txt」
// 和一个「应用程序」软链接，让「怎么装、怎么过这一关」跟 app 摆在一起。
if (process.argv.includes('--dmg')) {
  const dmg = path.join(OUT, `${NAME}-1.0.0.dmg`);
  const stage = path.join(OUT, '.dmg-stage');
  fs.rmSync(dmg, { force: true });
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  try {
    // APFS 上用 clonefile 复制：305MB 的 app 是即时、不额外占盘
    execFileSync('cp', ['-Rc', appPath, path.join(stage, `${NAME}.app`)], { stdio: 'pipe' });
    const guide = path.join(ROOT, 'build/使用说明.txt');
    if (fs.existsSync(guide)) fs.copyFileSync(guide, path.join(stage, '使用说明.txt'));
    fs.symlinkSync('/Applications', path.join(stage, '应用程序'));
    execFileSync('hdiutil', ['create', '-volname', NAME, '-srcfolder', stage,
      '-ov', '-format', 'UDZO', '-quiet', dmg], { stdio: 'pipe' });
    console.log(`\n✔ DMG：${path.relative(ROOT, dmg)}  (${mb(fs.statSync(dmg).size)})`);
    console.log('  里面：像素拼图.app + 使用说明.txt + 「应用程序」快捷方式');
  } catch (e) {
    console.error('DMG 生成失败：' + e.message);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

console.log(`\n下一步：\n  open "${appPath}"\n  或把它拖进「应用程序」文件夹`);
