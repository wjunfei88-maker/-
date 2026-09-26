#!/usr/bin/env node
/** 开发启动器：先起 Vite，等端口就绪，再拉起 Electron */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5273;

const waitPort = (port, timeoutMs = 40000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(); });
    s.once('error', () => {
      s.destroy();
      if (Date.now() - t0 > timeoutMs) reject(new Error('等待 Vite 超时'));
      else setTimeout(tick, 200);
    });
  };
  tick();
});

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, stdio: 'inherit', shell: false,
});
vite.on('exit', (c) => { if (c) process.exit(c); });

let electron;
const shutdown = () => { electron?.kill(); vite.kill(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await waitPort(PORT);
  console.log('\n  Vite 就绪，启动 Electron…\n');
  electron = spawn('npx', ['electron', '.'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: `http://localhost:${PORT}`, NODE_ENV: 'development' },
  });
  electron.on('exit', () => shutdown());
} catch (e) {
  console.error(e.message);
  shutdown();
}
