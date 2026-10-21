import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { MAX_BODY_BYTES } from '#shared';
import { createApp } from '../src/app.js';
import { createLog } from '../src/log.js';
import { host } from './helpers.js';

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(join(tmpdir(), 'session-connect-lifecycle-')); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

it('日志启动时超过5 MB才轮转，正常事件写到新日志', async () => {
  const directory = join(home, 'logs'); await fs.mkdir(directory);
  const prior = 'x'.repeat(5 * 1024 * 1024 + 1); await fs.writeFile(join(directory, 'server.log'), prior);
  const log = createLog(home); log('starting', { pid: 123 });
  expect(await fs.readFile(join(directory, 'server.log.1'), 'utf8')).toBe(prior);
  expect(JSON.parse((await fs.readFile(join(directory, 'server.log'), 'utf8')).trim())).toMatchObject({ event: 'starting', pid: 123 });
});
it('恢复 notice 由 state 返回，ack 后本次运行不再显示', async () => {
  let app = await createApp({ home, port: 4319 }); await app.close();
  await fs.writeFile(join(home, 'data.json'), '损坏');
  app = await createApp({ home, port: 4319 });
  try {
    expect((await app.inject({ url: '/api/state', headers: { host } })).json().notice).toMatchObject({ kind: 'reset', brokenPath: expect.any(String) });
    expect((await app.inject({ method: 'POST', url: '/api/notice/ack', headers: { host } })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/state', headers: { host } })).json().notice).toBeNull();
  } finally { await app.close(); }
});
it('声明超过 1 GB 的导入在读体时被拒绝，进行中记录随失败清除', async () => {
  const app = await createApp({ home, port: 4319 }), id = randomUUID();
  try {
    const result = await app.inject({ method: 'POST', url: '/api/import', headers: { host, 'content-type': 'application/json', 'content-length': String(MAX_BODY_BYTES + 1), 'x-import-id': id }, payload: '{}' });
    expect(result.statusCode).toBe(413); expect(result.json().code).toBe('TOO_LARGE');
    expect((await app.inject({ url: `/api/imports/${id}`, headers: { host } })).statusCode).toBe(404);
  } finally { await app.close(); }
});
