import { closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { assertDarwin, writeLock } from '../../scripts/instance-lock.mjs';
import { createApp } from './app.js';
import { acquireInstance, listenLocal } from './instance.js';
import { createLog } from './log.js';
import { atomicWrite } from './files.js';
import type { Log } from './store.js';

const home = resolve(process.env.SESSION_CONNECT_HOME || join(homedir(), '.session-connect'));
const args = process.argv.slice(2);
const option = (name: string) => args.indexOf(name) < 0 ? undefined : args[args.indexOf(name) + 1];
const handshake = option('--handshake');
let log: Log = () => {};
let app: FastifyInstance | undefined;
let lockFd: number | undefined;

async function report(line: string) {
  if (handshake) await atomicWrite(handshake, `${line.replace(/[\r\n]/g, ' ')}\n`);
}
async function openBrowser(url: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/open', [url], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('无法打开默认浏览器')));
  });
}
async function main() {
  assertDarwin();
  const mode = option('--mode') ?? 'dev';
  if (mode !== 'app' && mode !== 'dev') throw new Error('启动模式必须为 app 或 dev');
  const instance = await acquireInstance(home, mode);
  if (instance.kind === 'running') {
    log = createLog(home, false); log('instance_already_running');
    if (args.includes('--open')) await openBrowser(instance.url);
    await report(`RUNNING ${instance.url}`);
    console.log(args.includes('--open') ? '会话连接已在运行，已打开浏览器' : '会话连接已在运行');
    process.exitCode = 3;
    return;
  }
  lockFd = instance.fd;
  log = createLog(home); log('instance_lock_acquired', { pid: process.pid, mode }); log('starting');
  app = await createApp({ home, log });
  const port = await listenLocal(app);
  writeLock(instance.fd, { ...instance.record, port });
  const url = `http://127.0.0.1:${port}`;
  log('listening', { host: '127.0.0.1', port });

  let quitting = false;
  const shutdown = async (signal: string) => {
    if (quitting) return;
    quitting = true; log('shutdown', { signal });
    // 超时强制退出时由内核释放锁，不提前放锁给仍未结束的写请求。
    const timeout = setTimeout(() => { log('shutdown_timeout', { signal }); process.exit(1); }, 2000).unref();
    try { await app!.close(); clearTimeout(timeout); log('exit', { signal, code: 0 }); process.exit(0); }
    catch { log('exit', { signal, code: 1 }); process.exit(1); }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { void shutdown(signal); });
  const fatal = (event: string, error: unknown) => {
    log(event, { name: error instanceof Error ? error.name : 'Unknown', code: (error as NodeJS.ErrnoException)?.code });
    process.exit(1);
  };
  process.on('uncaughtException', error => fatal('uncaught_exception', error));
  process.on('unhandledRejection', error => fatal('unhandled_rejection', error));
  await report(`READY ${url} ${process.pid}`);
  console.log(`会话连接已启动：${url}`);
  if (args.includes('--open')) await openBrowser(url);
}

main().catch(async error => {
  const reason = error instanceof Error ? error.message : '未知错误';
  try {
    if (lockFd === undefined) log = createLog(home, false);
    log('startup_failed', { reason });
  } catch { /* 日志目录也不可写时仍返回握手和终端错误。 */ }
  await report(`ERROR ${reason}`).catch(() => {});
  console.error(`会话连接启动失败：${reason}。日志在 ${join(home, 'logs')}`);
  await app?.close().catch(() => {});
  if (lockFd !== undefined) { closeSync(lockFd); lockFd = undefined; }
  process.exitCode = 12;
});
