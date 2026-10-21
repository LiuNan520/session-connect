import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { tryLock } from '../../scripts/instance-lock.mjs';

let home: string;
const children: ChildProcess[] = [];
beforeEach(async () => { home = await fs.mkdtemp(join(tmpdir(), 'session-connect-instance-')); });
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  }
  await fs.rm(home, { recursive: true, force: true });
});
function launch(name: string, mode = 'dev', preload?: string) {
  const handshake = join(home, `${name}.handshake`);
  const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), '--import', 'tsx', 'server/src/index.ts', '--mode', mode, '--handshake', handshake], {
    cwd: resolve('.'), env: { ...process.env, SESSION_CONNECT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(child);
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { output += chunk; });
  return { child, handshake, output: () => output };
}
async function waitFor<T>(get: () => Promise<T | undefined>, message: string, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await get(); if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}
async function handshake(path: string) {
  return waitFor(async () => {
    try { const line = await fs.readFile(path, 'utf8'); return line.trim() ? line.trim() : undefined; } catch { return undefined; }
  }, '没有收到启动握手');
}
async function exited(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  const [code] = await once(child, 'exit'); return code;
}

describe('macOS 单实例系统锁和真实服务进程', () => {
  it('三个进程同时启动，仅一个监听；其余返回 RUNNING 并以 3 退出；锁 inode 不变', async () => {
    const runners = [launch('one'), launch('two'), launch('three')];
    const lines = await Promise.all(runners.map(r => handshake(r.handshake)));
    expect(lines.filter(line => line.startsWith('READY '))).toHaveLength(1);
    expect(lines.filter(line => line.startsWith('RUNNING '))).toHaveLength(2);
    const ownerIndex = lines.findIndex(line => line.startsWith('READY '));
    const url = lines[ownerIndex].split(' ')[1];
    const health = await fetch(`${url}/api/health`).then(r => r.json()) as any;
    expect(health).toMatchObject({ app: 'session-connect', pid: runners[ownerIndex].child.pid });
    const record = JSON.parse(await fs.readFile(join(home, 'instance.lock'), 'utf8'));
    expect(record).toMatchObject({ pid: health.pid, port: health.port, mode: 'dev' });
    const inode = (await fs.stat(join(home, 'instance.lock'))).ino;
    for (let i = 0; i < runners.length; i++) if (i !== ownerIndex) expect(await exited(runners[i].child)).toBe(3);
    runners[ownerIndex].child.kill('SIGTERM'); await exited(runners[ownerIndex].child);
    expect((await fs.stat(join(home, 'instance.lock'))).ino).toBe(inode);
    expect(await fs.readFile(join(home, 'logs/server.log'), 'utf8')).toContain('SIGTERM');
  });
  it('kill -9 后系统立即释放锁，新进程可启动，锁文件保持同一个 inode', async () => {
    const first = launch('first'); expect(await handshake(first.handshake)).toMatch(/^READY /);
    const inode = (await fs.stat(join(home, 'instance.lock'))).ino;
    first.child.kill('SIGKILL'); await exited(first.child);
    const second = launch('second'); expect(await handshake(second.handshake)).toMatch(/^READY /);
    expect((await fs.stat(join(home, 'instance.lock'))).ino).toBe(inode);
  });
  it('持锁进程产生的子进程仍活着时，锁也能释放（CLOEXEC）', async () => {
    const moduleUrl = pathToFileURL(resolve('scripts/instance-lock.mjs')).href;
    const code = `import { tryLock } from ${JSON.stringify(moduleUrl)}; import { spawn } from 'node:child_process'; tryLock(process.argv[1]); const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { detached: true, stdio: 'ignore' }); console.log(child.pid); child.unref();`;
    const owner = spawn(process.execPath, ['--input-type=module', '-e', code, home], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(owner);
    let output = ''; owner.stdout!.on('data', chunk => { output += chunk; });
    expect(await exited(owner)).toBe(0);
    const pid = Number(output.trim());
    try {
      expect(() => process.kill(pid, 0)).not.toThrow();
      const fd = tryLock(home); expect(fd).not.toBeNull(); if (fd !== null) closeSync(fd);
    } finally { if (pid > 0) process.kill(pid, 'SIGTERM'); }
  });
  it('默认端口被其他进程占用时选下一个，并写回锁文件', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', (error: NodeJS.ErrnoException) => {
        // 用户应用可能已占用默认端口；此时测试前提已经满足。
        if (error.code === 'EADDRINUSE') resolve();
        else reject(error);
      });
      blocker.listen(4319, '127.0.0.1', () => resolve());
    });
    try {
      const server = launch('port');
      const line = await handshake(server.handshake); expect(line).toMatch(/^READY /);
      const url = new URL(line.split(' ')[1]); expect(Number(url.port)).toBeGreaterThan(4319); expect(Number(url.port)).toBeLessThanOrEqual(4339);
      const record = JSON.parse(await fs.readFile(join(home, 'instance.lock'), 'utf8'));
      expect(record.port).toBe(Number(url.port));
    } finally {
      if (blocker.listening) await new Promise<void>(resolve => blocker.close(() => resolve()));
    }
  });
  it('mock 非 macOS 平台时拒绝启动，且不创建锁文件', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    expect(() => tryLock(home)).toThrow('只支持 macOS');
    expect(await fs.readdir(home)).toEqual([]);
  });
  it('浏览器尚未发送 HTTP 头的预连接，不会把正常退出拖到超时', async () => {
    const server = launch('preconnect');
    const line = await handshake(server.handshake); expect(line).toMatch(/^READY /);
    const port = Number(new URL(line.split(' ')[1]).port);
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => {}); await once(socket, 'connect');
    try {
      server.child.kill('SIGTERM'); expect(await exited(server.child)).toBe(0);
      expect(await fs.readFile(join(home, 'logs/server.log'), 'utf8')).not.toContain('shutdown_timeout');
    } finally { socket.destroy(); }
  });
  it('未捕获异常先记录事件再退出，日志不包含卡片文字', async () => {
    const preload = join(home, 'throw-after-ready.mjs');
    await fs.writeFile(preload, `import fs from 'node:fs'; const timer=setInterval(()=>{try { const lock=JSON.parse(fs.readFileSync(process.env.SESSION_CONNECT_HOME+'/instance.lock','utf8')); if(lock.port){clearInterval(timer);setTimeout(()=>{throw new Error('不应记录的卡片文字')},100).unref();} }catch{}},20);timer.unref();`);
    const server = launch('fatal', 'dev', preload);
    expect(await handshake(server.handshake)).toMatch(/^READY /);
    expect(await exited(server.child)).toBe(1);
    const log = await fs.readFile(join(home, 'logs/server.log'), 'utf8');
    expect(log).toContain('uncaught_exception'); expect(log).not.toContain('不应记录的卡片文字');
  });
});
