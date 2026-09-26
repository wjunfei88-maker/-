#!/usr/bin/env node
/** 生成 macOS 应用图标（build/icon.icns） */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD = path.join(ROOT, 'build');
const ICONSET = path.join(BUILD, 'icon.iconset');

// macOS 图标栅格：1024 画布上，实体占 824×824 居中，圆角约 185
const SVG = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.25" y2="1">
      <stop offset="0" stop-color="#3A3742"/>
      <stop offset="0.55" stop-color="#26242C"/>
      <stop offset="1" stop-color="#191820"/>
    </linearGradient>
    <linearGradient id="top" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#F3CB96"/>
      <stop offset="0.5" stop-color="#E0A458"/>
      <stop offset="1" stop-color="#C4833E"/>
    </linearGradient>
    <linearGradient id="bot" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#9FB6D2"/>
      <stop offset="0.5" stop-color="#6E86A6"/>
      <stop offset="1" stop-color="#4E6076"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.30"/>
      <stop offset="0.55" stop-color="#FFFFFF" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="16"/>
    </filter>
    <filter id="subject" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="34"/>
    </filter>
    <clipPath id="clipTop"><rect x="196" y="196" width="632" height="292" rx="38"/></clipPath>
    <clipPath id="clipBot"><rect x="196" y="536" width="632" height="292" rx="38"/></clipPath>
  </defs>

  <!-- 底板 -->
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
  <rect x="100.5" y="100.5" width="823" height="823" rx="185.5" fill="none"
        stroke="#FFFFFF" stroke-opacity="0.13" stroke-width="1.5"/>

  <!-- 接缝的琥珀色辉光（压在面板下面，形成发光效果） -->
  <rect x="250" y="484" width="524" height="56" rx="28" fill="#DDA45C" opacity="0.7" filter="url(#soft)"/>

  <!-- 上方面板 -->
  <rect x="196" y="196" width="632" height="292" rx="38" fill="url(#top)"/>
  <g clip-path="url(#clipTop)">
    <ellipse cx="388" cy="330" rx="132" ry="150" fill="#FFF3DC" opacity="0.42" filter="url(#subject)"/>
    <ellipse cx="712" cy="248" rx="96" ry="96" fill="#FFFFFF" opacity="0.20" filter="url(#subject)"/>
  </g>
  <rect x="196" y="196" width="632" height="292" rx="38" fill="url(#sheen)"/>
  <rect x="196.75" y="196.75" width="630.5" height="290.5" rx="37.25" fill="none"
        stroke="#FFFFFF" stroke-opacity="0.22" stroke-width="1.5"/>

  <!-- 下方面板 -->
  <rect x="196" y="536" width="632" height="292" rx="38" fill="url(#bot)"/>
  <g clip-path="url(#clipBot)">
    <ellipse cx="640" cy="676" rx="140" ry="156" fill="#E8F0FB" opacity="0.40" filter="url(#subject)"/>
    <ellipse cx="330" cy="762" rx="104" ry="104" fill="#FFFFFF" opacity="0.18" filter="url(#subject)"/>
  </g>
  <rect x="196" y="536" width="632" height="292" rx="38" fill="url(#sheen)"/>
  <rect x="196.75" y="536.75" width="630.5" height="290.5" rx="37.25" fill="none"
        stroke="#FFFFFF" stroke-opacity="0.22" stroke-width="1.5"/>

  <!-- 接缝：两段式，暗示"合起来是一张，切开是两张" -->
  <g fill="#F7E0B4">
    <rect x="286" y="501" width="126" height="22" rx="11"/>
    <rect x="449" y="501" width="126" height="22" rx="11"/>
    <rect x="612" y="501" width="126" height="22" rx="11"/>
  </g>
</svg>`;

fs.mkdirSync(BUILD, { recursive: true });
fs.rmSync(ICONSET, { recursive: true, force: true });
fs.mkdirSync(ICONSET, { recursive: true });

const master = await sharp(Buffer.from(SVG)).png().toBuffer();
await sharp(master).toFile(path.join(BUILD, 'icon-1024.png'));

const SIZES = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
];
for (const [size, name] of SIZES) {
  await sharp(master).resize(size, size, { kernel: 'lanczos3' }).png().toFile(path.join(ICONSET, name));
}

const icns = path.join(BUILD, 'icon.icns');
execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', icns]);
console.log('✔ 图标已生成：' + path.relative(ROOT, icns) + '  (' + (fs.statSync(icns).size / 1024).toFixed(0) + ' KB)');
console.log('  预览：' + path.relative(ROOT, path.join(BUILD, 'icon-1024.png')));
