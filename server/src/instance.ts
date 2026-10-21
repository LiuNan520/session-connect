import { closeSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { readLock, tryLock, writeLock, type LockRecord } from '../../scripts/instance-lock.mjs';

export async function acquireInstance(home: string, mode: 'app' | 'dev') {
  const deadline = Date.now() + 5000;
  do {
    const fd = tryLock(home);
    if (fd !== null) {
      const record: LockRecord = { pid: process.pid, port: null, mode, startedAt: new Date().toISOString() };
      try { writeLock(fd, record); } catch (error) { closeSync(fd); throw error; }
      return { kind: 'owner' as const, fd, record };
    }
    const record = readLock(home);
    if (record?.port) {
      const url = `http://127.0.0.1:${record.port}`;
      try {
        const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(Math.min(300, Math.max(1, deadline - Date.now()))) });
        const health = await response.json() as { app?: string; pid?: number; port?: number };
        if (response.ok && health.app === 'session-connect' && health.pid === record.pid && health.port === record.port) return { kind: 'running' as const, url };
      } catch { /* 持锁者可能尚未启动或正退出，继续重试。 */ }
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now()))));
  } while (Date.now() < deadline);
  throw new Error('等待已有实例就绪或释放系统锁超过 5 秒');
}

export async function listenLocal(app: FastifyInstance): Promise<number> {
  for (let port = 4319; port <= 4339; port++) {
    try { await app.listen({ host: '127.0.0.1', port }); return port; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('4319–4339 端口均被占用');
}
