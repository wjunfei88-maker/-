import path from 'node:path';

/**
 * 导出位置与并发数的设置（存在 userData/settings.json）。
 *
 * 为什么单独一个文件：这些规则有几个**会悄悄出错**的地方 ——
 *   · 用户选的是"父目录"，真实导出位置是 <父目录>/像素拼图导出，两者不能混
 *   · 父目录被删掉/改名的机器上，导出不能直接崩，要退回「图片」目录
 *   · 并发数是用户手选的数字，必须夹在内存/核数允许的范围内
 * 放在这里就能被 npm test 直接覆盖，不用起 Electron。
 */

/** 导出时自动建的项目文件夹名。成片、manifest、预览图都收在里面。 */
export const EXPORT_SUBDIR = '像素拼图导出';

export function defaultSettings(pictures) {
  return {
    // 用户选的**父目录**；真正的导出目录 = <exportParent>/像素拼图导出
    exportParent: pictures,
    // 切回原图的输出目录（独立设置）。空串 = 跟导出目录走
    recoverDir: '',
    // 0 = 自动（按机器配置推荐）；>0 = 用户手选的并发数
    exportJobs: 0,
    splitJobs: 0,
  };
}

/**
 * 把磁盘上的原始设置收敛成一份可用的设置。
 * `exists` 注入进来是为了能测 —— 默认用 fs.existsSync。
 */
export function normalizeSettings(raw, { pictures, exists }) {
  const def = defaultSettings(pictures);
  const s = { ...def, ...(raw && typeof raw === 'object' ? raw : {}) };

  if (typeof s.exportParent !== 'string' || !s.exportParent) s.exportParent = def.exportParent;
  // 父目录没了就退回「图片」目录 —— 否则用户点导出会直接报错，还不知道为什么
  if (!exists(s.exportParent)) s.exportParent = def.exportParent;

  if (typeof s.recoverDir !== 'string') s.recoverDir = '';
  if (s.recoverDir && !exists(s.recoverDir)) s.recoverDir = '';

  s.exportJobs = clampJobs(s.exportJobs);
  s.splitJobs = clampJobs(s.splitJobs);
  return s;
}

/** 并发数只接受非负整数（0 = 自动）。乱七八糟的值一律当自动。 */
function clampJobs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/** 从渲染层传来的更新里挑出能用的字段，别的一律丢掉 */
export function cleanPatch(patch = {}) {
  const clean = {};
  const p = patch && typeof patch === 'object' ? patch : {};
  if (typeof p.exportParent === 'string' && p.exportParent) clean.exportParent = p.exportParent;
  if (typeof p.recoverDir === 'string' && p.recoverDir) clean.recoverDir = p.recoverDir;
  if (Number.isFinite(p.exportJobs)) clean.exportJobs = clampJobs(p.exportJobs);
  if (Number.isFinite(p.splitJobs)) clean.splitJobs = clampJobs(p.splitJobs);
  return clean;
}

/** 真正的导出目录 = 父目录 + 固定的子文件夹名。父目录名里有没有斜杠都不影响。 */
export function exportDirOf(settings) {
  if (!settings?.exportParent) throw new Error('设置里没有 exportParent');
  return path.join(settings.exportParent, EXPORT_SUBDIR);
}

/** 切回原图的输出目录：用户没单独设过就跟导出目录走 */
export function recoverDirOf(settings) {
  return settings?.recoverDir || exportDirOf(settings);
}
