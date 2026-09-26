/**
 * 构造读取本地图片的 URL。
 *
 * 坑：pcfile:///Users/... 会被 URL 标准协议解析器把 "Users" 当成主机名并**小写化**，
 * 于是 /Users/... 变成了 /users/... 找不到文件。所以显式给一个主机名 local，
 * 真实路径全部落在 pathname 里（路径是大小写敏感的，不会被改）。
 */
export const pcfile = (p) => 'pcfile://local' + encodeURI(p.startsWith('/') ? p : '/' + p);
