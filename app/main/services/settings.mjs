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

/** 切回原图时自动建的文件夹名（和导出目录平级，别把交付的原图和画布混在一起）。 */
export const RECOVER_SUBDIR = '切回原图';

export function defaultSettings(pictures) {
  return {
    // 用户选的**父目录**；真正的导出目录 = <exportParent>/像素拼图导出
    exportParent: pictures,
    // 切回原图的输出目录（独立设置）。空串 = 跟导出目录走
    recoverDir: '',
    // 0 = 自动（按机器配置推荐）；>0 = 用户手选的并发数
    exportJobs: 0,
    splitJobs: 0,
    // 像素蛋糕的套餐价：默认 299 元 / 800 张 —— 用来把"省下的次数"折算成钱
    planPrice: 299,
    planSheets: 800,
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
  s.planPrice = clampMoney(s.planPrice, def.planPrice);
  s.planSheets = clampMoney(s.planSheets, def.planSheets);
  return s;
}

/** 套餐价/张数：只接受正数，脏值一律退回默认（除零会让「省了多少钱」变成 Infinity） */
function clampMoney(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
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
  if (Number.isFinite(p.planPrice)) clean.planPrice = clampMoney(p.planPrice, 299);
  if (Number.isFinite(p.planSheets)) clean.planSheets = clampMoney(p.planSheets, 800);
  return clean;
}

/** 真正的导出目录 = 父目录 + 固定的子文件夹名。父目录名里有没有斜杠都不影响。 */
export function exportDirOf(settings) {
  if (!settings?.exportParent) throw new Error('设置里没有 exportParent');
  return path.join(settings.exportParent, EXPORT_SUBDIR);
}

/**
 * 切回原图的输出目录。
 * 默认 = 导出目录**旁边**自动建一个「切回原图」——
 * 用户不用选任何东西，切回来的原图就有地方放；两边平级，画布和交付的原图不会混。
 */
export function recoverDirOf(settings) {
  if (settings?.recoverDir) return settings.recoverDir;
  return path.join(settings.exportParent, RECOVER_SUBDIR);
}

/** 单张均价（元）。套餐价 ÷ 张数；默认 299 / 800 = 0.37375 元/张。 */
export function unitPriceOf(settings) {
  const price = clampMoney(settings?.planPrice, 299);
  const sheets = clampMoney(settings?.planSheets, 800);
  return price / sheets;
}
