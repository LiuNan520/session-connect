import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ProxyOptions } from 'vite';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { listenLocal } from '../src/instance.js';
import config from '../../vite.config.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; vi.unstubAllEnvs(); });
async function createOriginProxy() {
  const home = await fs.mkdtemp(join(tmpdir(), 'session-connect-proxy-'));
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
  vi.stubEnv('SESSION_CONNECT_HOME', home);
  const app = await createApp({ home }); cleanups.push(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const backend = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const proxy = config.server!.proxy!['/api'] as ProxyOptions;
  const vite = await createServer({ ...config, configFile: false, server: { ...config.server, port: 0, strictPort: false,
    hmr: false, proxy: { '/api': { ...proxy, target: backend } } } });
  cleanups.push(() => vite.close()); await vite.listen();
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
  return { backend, origin };
}
it('开发代理支持浏览器同源写请求，同时仍拒绝外站 Origin', async () => {
  const { backend, origin } = await createOriginProxy();
  const accepted = await fetch(`${origin}/api/prefs`, { method: 'PUT', headers: { 'content-type': 'application/json', origin }, body: '{"minimapVisible":false}' });
  expect(accepted.status).toBe(204);
  const forbidden = await fetch(`${origin}/api/prefs`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'http://attacker.invalid' }, body: '{"minimapVisible":true}' });
  expect(forbidden.status).toBe(403);
  const response = await fetch(`${backend}/api/state`).then(r => r.json()) as { prefs: { minimapVisible: boolean } };
  expect(response.prefs.minimapVisible).toBe(false);
});
it('开发代理写请求测试隔离外部 home 的运行实例', async () => {
  const externalHome = await fs.mkdtemp(join(tmpdir(), 'session-connect-proxy-external-'));
  cleanups.push(() => fs.rm(externalHome, { recursive: true, force: true }));
  vi.stubEnv('SESSION_CONNECT_HOME', externalHome);
  const externalApp = await createApp({ home: externalHome }); cleanups.push(() => externalApp.close());
  const externalPort = await listenLocal(externalApp);
  await fs.writeFile(join(externalHome, 'instance.lock'), JSON.stringify({ pid: process.pid, port: externalPort, mode: 'app', startedAt: new Date().toISOString() }));
  const before = await fs.readFile(join(externalHome, 'data.json'), 'utf8');

  const { backend, origin } = await createOriginProxy();
  const accepted = await fetch(`${origin}/api/prefs`, { method: 'PUT', headers: { 'content-type': 'application/json', origin }, body: '{"minimapVisible":false}' });
  expect(accepted.status).toBe(204);
  const state = await fetch(`${backend}/api/state`).then(r => r.json()) as { prefs: { minimapVisible: boolean } };
  const after = await fs.readFile(join(externalHome, 'data.json'), 'utf8');
  expect({ testHome: state.prefs.minimapVisible, externalHome: JSON.parse(after).prefs.minimapVisible })
    .toEqual({ testHome: false, externalHome: true });
  expect(after).toBe(before);
});
it('服务改用备用端口时，开发代理从锁文件跟随实际地址', async () => {
  const home = await fs.mkdtemp(join(tmpdir(), 'session-connect-proxy-port-'));
  cleanups.push(() => fs.rm(home, { recursive: true, force: true })); vi.stubEnv('SESSION_CONNECT_HOME', home);
  const app = await createApp({ home }); cleanups.push(() => app.close());
  let chosen = 0;
  for (let port = 4321; port <= 4339; port++) {
    try { await app.listen({ host: '127.0.0.1', port }); chosen = port; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
  }
  expect(chosen).toBeGreaterThan(0);
  await fs.writeFile(join(home, 'instance.lock'), JSON.stringify({ pid: process.pid, port: chosen, mode: 'dev', startedAt: new Date().toISOString() }));
  const vite = await createServer({ ...config, configFile: false, server: { ...config.server, port: 0, strictPort: false, hmr: false } });
  cleanups.push(() => vite.close()); await vite.listen();
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
  const response = await fetch(`${origin}/api/health`);
  expect(response.status).toBe(200);
  const result = await response.json() as { port: number };
  expect(result.port).toBe(chosen);
});
