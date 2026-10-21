import { defineConfig, type ProxyOptions } from 'vite';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readLock } from './scripts/instance-lock.mjs';

const localProxy: ProxyOptions = {
  target: 'http://127.0.0.1:4319',
  changeOrigin: true,
  configure(proxy) {
    proxy.on('start', (_request, _response, target) => {
      const home = resolve(process.env.SESSION_CONNECT_HOME || join(homedir(), '.session-connect'));
      const record = readLock(home);
      if (record?.port && target instanceof URL) target.port = String(record.port);
    });
    proxy.on('proxyReq', (outgoing, incoming) => {
      // 只转换开发页面本身的同源 Origin；外站 Origin 原样交给后端拒绝。
      const origin = incoming.headers.origin, host = incoming.headers.host;
      if (origin && /^127\.0\.0\.1:\d+$|^localhost:\d+$/.test(host ?? '') && origin === `http://${host}`) {
        outgoing.setHeader('origin', `http://${outgoing.getHeader('host')}`);
      }
    });
  }
};

export default defineConfig({
  root: 'web',
  publicDir: '../assets',
  resolve: { alias: { '#shared': fileURLToPath(new URL('./shared/index.ts', import.meta.url)) } },
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': localProxy, '/icons': localProxy }
  }
});
