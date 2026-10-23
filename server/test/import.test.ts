import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { MAX_ICON_BYTES } from '#shared';
import { createApp } from '../src/app.js';
import type { Log } from '../src/store.js';
import { graph, host, svg } from './helpers.js';

let home: string, app: FastifyInstance;
let log = vi.fn<Log>();
const request = (options: InjectOptions) => app.inject({ ...options, headers: { host, ...options.headers } });
const submit = (payload: unknown, id = randomUUID()) => request({ method: 'POST', url: '/api/import', headers: { 'x-import-id': id }, payload: payload as any });
const exported = async () => (await request({ url: '/api/export' })).json();
const state = async () => (await request({ url: '/api/state' })).json();
async function files() {
  const names = (await fs.readdir(join(home, 'icons'))).sort();
  return { data: await fs.readFile(join(home, 'data.json'), 'utf8'), icons: await Promise.all(names.map(async name => [name, (await fs.readFile(join(home, 'icons', name))).toString('base64')])) };
}
beforeEach(async () => { home = await fs.mkdtemp(join(tmpdir(), 'session-connect-import-')); log = vi.fn<Log>(); app = await createApp({ home, port: 4319, log }); });
afterEach(async () => { vi.restoreAllMocks(); await app.close(); await fs.rm(home, { recursive: true, force: true }); });

describe('导入导出事务', () => {
  it.each(['off', 'follow'] as const)('导出再导入保留连线活跃设置 %s', async activity => {
    const canvas = (await state()).canvases[0], value = graph();
    const edges = value.edges.map(edge => ({ ...edge, activity }));
    const saved = await request({ method: 'PUT', url: `/api/canvases/${canvas.id}/content`,
      payload: { ...value, edges, baseRevision: 0, saveId: randomUUID() } });
    expect(saved.statusCode).toBe(200);
    const payload = await exported();
    expect(payload.formatVersion).toBe(1);
    expect(payload.canvases[0].edges).toEqual(edges);
    const response = await submit(payload);
    expect(response.statusCode).toBe(200);
    const imported = (await state()).canvases.find((c: any) => c.id === response.json().canvasIds[0]);
    expect(imported.id).not.toBe(canvas.id);
    expect(imported.edges[0]).toEqual({ ...edges[0], id: expect.any(String), a: imported.cards[0].id, b: imported.cards[1].id });
    expect(imported.edges[0].id).not.toBe(edges[0].id);
    const disk = JSON.parse(await fs.readFile(join(home, 'data.json'), 'utf8'));
    expect(disk.canvases.find((c: any) => c.id === imported.id).edges).toEqual(imported.edges);
  });

  it('旧性能夹具的 300 条连线导入后全部补为 follow', async () => {
    const payload = JSON.parse(await fs.readFile(new URL('../../fixtures/perf-200.json', import.meta.url), 'utf8'));
    expect(payload.canvases[0].edges).toHaveLength(300);
    expect(payload.canvases[0].edges.every((edge: any) => !Object.hasOwn(edge, 'activity'))).toBe(true);
    const response = await submit(payload);
    expect(response.statusCode).toBe(200);
    const imported = (await state()).canvases.find((c: any) => c.id === response.json().canvasIds[0]);
    expect(imported.cards).toHaveLength(200);
    expect(imported.edges).toHaveLength(300);
    expect(imported.edges.every((edge: any) => edge.activity === 'follow')).toBe(true);
    const disk = JSON.parse(await fs.readFile(join(home, 'data.json'), 'utf8'));
    expect(disk.schemaVersion).toBe(1);
    expect(disk.canvases.find((c: any) => c.id === imported.id).edges).toEqual(imported.edges);
  });

  it.each(['on', null, '', false, 0, {}, []].map(activity => ({ activity })))('连线活跃设置 $activity 非法时整个文件拒绝，画布和文件不变', async ({ activity }) => {
    const payload = await exported();
    Object.assign(payload.canvases[0], graph());
    payload.canvases.push({ ...payload.canvases[0], id: randomUUID(), ...graph() });
    payload.canvases[1].edges[0].activity = activity;
    const beforeFiles = await files(), beforeState = await state(), importId = randomUUID();
    const response = await submit(payload, importId);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'INVALID_FILE', message: '文件格式不对，没有导入任何内容' });
    expect(await files()).toEqual(beforeFiles);
    expect(await state()).toEqual(beforeState);
    expect((await request({ url: `/api/imports/${importId}` })).statusCode).toBe(404);
  });

  it.each(['缺失', '内容被改动', '读盘失败'])('单个图标%s时导出其余数据，文件仍可导入', async kind => {
    const bad = (await request({ method: 'POST', url: '/api/icons', headers: { 'content-type': 'image/svg+xml' }, payload: svg('<!-- bad -->') })).json();
    const goodBytes = svg('<!-- good -->');
    const good = (await request({ method: 'POST', url: '/api/icons', headers: { 'content-type': 'image/svg+xml' }, payload: goodBytes })).json();
    const canvas = (await state()).canvases[0], value = graph();
    value.cards[0].iconId = bad.id; value.cards[1].iconId = good.id;
    await request({ method: 'PUT', url: `/api/canvases/${canvas.id}/content`, payload: { baseRevision: 0, saveId: randomUUID(), ...value } });
    const original = await fs.readFile(join(home, 'data.json'), 'utf8');
    const badPath = join(home, 'icons', `${bad.id}.svg`);
    if (kind === '缺失') await fs.rm(badPath);
    if (kind === '内容被改动') await fs.appendFile(badPath, 'x');
    if (kind === '读盘失败') {
      const readFile = fs.readFile.bind(fs);
      vi.spyOn(fs, 'readFile').mockImplementation((...args: any[]) => {
        if (args[0] === badPath) return Promise.reject(Object.assign(new Error('模拟权限错误'), { code: 'EACCES' }));
        return (readFile as any)(...args);
      });
    }
    const download = await request({ url: '/api/export' });
    expect(download.statusCode).toBe(200);
    expect(download.body.startsWith('{"format":"session-connect-export"')).toBe(true);
    const payload = download.json();
    expect(payload.canvases[0].cards).toEqual(value.cards);
    expect(payload.icons).toEqual([{ id: good.id, mime: good.mime, hash: good.hash, dataBase64: goodBytes.toString('base64') }]);
    expect(await fs.readFile(join(home, 'data.json'), 'utf8')).toBe(original);
    expect(log).toHaveBeenCalledWith('icon_unavailable', expect.objectContaining({ id: bad.id, source: 'export' }));
    const otherHome = await fs.mkdtemp(join(tmpdir(), 'session-connect-partial-export-'));
    const other = await createApp({ home: otherHome, port: 4319 });
    try {
      const imported = await other.inject({ method: 'POST', url: '/api/import', headers: { host, 'x-import-id': randomUUID() }, payload });
      expect(imported.statusCode).toBe(200);
      expect(imported.json().iconsAdded).toBe(1);
      const data = (await other.inject({ url: '/api/state', headers: { host } })).json();
      expect(data.canvases.at(-1).cards[0].iconId).toBe(bad.id);
      expect(data.icons.some((i: any) => i.id === bad.id)).toBe(false);
      const uploaded = data.icons.filter((i: any) => !i.builtin);
      expect(uploaded).toHaveLength(1);
      expect((await other.inject({ url: uploaded[0].url, headers: { host } })).rawPayload).toEqual(goodBytes);
    } finally { await other.close(); await fs.rm(otherHome, { recursive: true, force: true }); }
  });

  it('导出的 format 是第一个字段，附件文件名为 UTF-8，导回后内容完整且 id 全新', async () => {
    const icon = (await request({ method: 'POST', url: '/api/icons', headers: { 'content-type': 'image/svg+xml' }, payload: svg() })).json();
    const canvas = (await state()).canvases[0];
    const value = graph(); value.cards[0].iconId = icon.id;
    await request({ method: 'PUT', url: `/api/canvases/${canvas.id}/content`, payload: { baseRevision: 0, saveId: randomUUID(), ...value } });
    const download = await request({ url: '/api/export' });
    expect(download.body.startsWith('{"format":"session-connect-export"')).toBe(true);
    expect(download.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(String(download.headers['content-disposition']))).toMatch(/会话连接-备份-\d{8}-\d{4}\.json/);
    const payload = download.json();
    expect(payload.icons[0].dataBase64).toBe(svg().toString('base64'));
    const response = await submit(payload);
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ iconsAdded: 0, canvasIds: [expect.any(String)] });
    const duplicate = (await state()).canvases.at(-1);
    expect(duplicate.id).not.toBe(canvas.id);
    expect(duplicate.cards.map((c: any) => c.id)).not.toEqual(value.cards.map(c => c.id));
    expect(duplicate.cards.map(({ id: _, ...c }: any) => c)).toEqual(value.cards.map(({ id: _, ...c }) => c));
    expect(duplicate.edges[0]).toMatchObject({ a: duplicate.cards[0].id, b: duplicate.cards[1].id, label: '审核', direction: 'forward' });
    expect(duplicate.edges[0].id).not.toBe(value.edges[0].id);
    // 新目录导入也还原字节，并映射为新的上传图标 id。
    const otherHome = await fs.mkdtemp(join(tmpdir(), 'session-connect-restore-'));
    const other = await createApp({ home: otherHome, port: 4319 });
    try {
      const r = await other.inject({ method: 'POST', url: '/api/import', headers: { host, 'x-import-id': randomUUID() }, payload });
      expect(r.json().iconsAdded).toBe(1);
      const s = (await other.inject({ url: '/api/state', headers: { host } })).json();
      const imported = s.canvases.at(-1), newIcon = s.icons.find((i: any) => !i.builtin);
      expect(imported.cards[0].iconId).toBe(newIcon.id); expect(newIcon.id).not.toBe(icon.id);
      expect((await other.inject({ url: newIcon.url, headers: { host } })).rawPayload).toEqual(svg());
    } finally { await other.close(); await fs.rm(otherHome, { recursive: true, force: true }); }
  });
  it('16 个恰好 1 MB 图标能导出再导入，不受旧 20 MB 上限影响', async () => {
    for (let i = 0; i < 16; i++) {
      const seed = svg(`<!-- ${i} -->`);
      const prefix = seed.subarray(0, seed.length - 6);
      const bytes = Buffer.concat([prefix, Buffer.from('<!--'), Buffer.alloc(MAX_ICON_BYTES - seed.length - 7, 32), Buffer.from('--></svg>')]);
      expect(bytes.length).toBe(MAX_ICON_BYTES);
      expect((await request({ method: 'POST', url: '/api/icons', headers: { 'content-type': 'image/svg+xml' }, payload: bytes })).statusCode).toBe(201);
    }
    const download = await request({ url: '/api/export' });
    expect(Buffer.byteLength(download.body)).toBeGreaterThan(20 * 1024 * 1024);
    expect((await submit(download.json())).statusCode).toBe(200);
    expect((await state()).icons.filter((i: any) => !i.builtin)).toHaveLength(16);
  });
  it('同文件再次导入画布 id 全新，但 hash 相同的图标不重复', async () => {
    await request({ method: 'POST', url: '/api/icons', headers: { 'content-type': 'image/svg+xml' }, payload: svg() });
    const payload = await exported();
    const a = (await submit(payload)).json(), b = (await submit(payload)).json();
    expect(a.canvasIds).not.toEqual(b.canvasIds); expect(b.iconsAdded).toBe(0);
    expect((await state()).icons).toHaveLength(6);
  });
  it.each(['普通 JSON', '更高版本', '损坏图标', '错误 hash', '非法连线', '图标晚失败'])('%s 导入失败且数据和图标目录均不变', async kind => {
    await request({ method: 'POST', url: '/api/icons', headers: { 'content-type': 'image/svg+xml' }, payload: svg() });
    const payload = await exported();
    if (kind === '普通 JSON') payload.format = 'other';
    if (kind === '更高版本') payload.formatVersion = 2;
    if (kind === '损坏图标') payload.icons[0].dataBase64 = Buffer.from('坏图标').toString('base64');
    if (kind === '错误 hash') payload.icons[0].hash = '0'.repeat(64);
    if (kind === '非法连线') payload.canvases[0].edges.push({ id: randomUUID(), a: 'a', b: 'b', direction: 'both', label: '' });
    if (kind === '图标晚失败') payload.icons.push({ ...payload.icons[0], id: randomUUID(), dataBase64: '%%%坏编码' });
    const before = await files(), importId = randomUUID();
    const response = await submit(payload, importId);
    expect(response.statusCode).toBe(400); expect(response.json().code).toBe(kind === '更高版本' ? 'NEWER_VERSION' : 'INVALID_FILE');
    expect(await files()).toEqual(before);
    expect((await request({ url: `/api/imports/${importId}` })).statusCode).toBe(404);
  });
  it('损坏 JSON 和缺少 importId 返回约定错误', async () => {
    const malformed = await request({ method: 'POST', url: '/api/import', headers: { 'x-import-id': randomUUID(), 'content-type': 'application/json' }, payload: '{"format":' });
    expect(malformed.statusCode).toBe(400); expect(malformed.json().code).toBe('INVALID_FILE');
    const missing = await request({ method: 'POST', url: '/api/import', payload: { format: 'session-connect-export' } });
    expect(missing.json().code).toBe('MISSING_IMPORT_ID');
  });
  it('同 importId 幂等，重启仍能查询并返回相同结果', async () => {
    const payload = await exported(), id = randomUUID();
    const a = await submit(payload, id), b = await submit(payload, id);
    expect(a.statusCode).toBe(200); expect(a.json()).toEqual(b.json());
    await app.close(); app = await createApp({ home, port: 4319 });
    expect((await request({ url: `/api/imports/${id}` })).json()).toEqual(a.json());
    expect((await submit(payload, id)).json()).toEqual(a.json());
    expect((await state()).canvases).toHaveLength(2);
    expect((await request({ url: `/api/imports/${randomUUID()}` })).json().code).toBe('IMPORT_NOT_FOUND');
  });
  it('未确认记录不清理；已确认只留最新 20 条；ack 幂等', async () => {
    const payload = await exported(), unacked = randomUUID(), acked: string[] = [];
    await submit(payload, unacked);
    for (let i = 0; i < 25; i++) {
      const id = randomUUID(); acked.push(id);
      expect((await submit(payload, id)).statusCode).toBe(200);
      expect((await request({ method: 'POST', url: `/api/imports/${id}/ack` })).statusCode).toBe(204);
    }
    expect((await request({ url: `/api/imports/${unacked}` })).statusCode).toBe(200);
    expect((await request({ url: `/api/imports/${acked[0]}` })).statusCode).toBe(404);
    expect((await request({ url: `/api/imports/${acked.at(-1)}` })).statusCode).toBe(200);
    const saved = JSON.parse(await fs.readFile(join(home, 'data.json'), 'utf8'));
    expect(saved.imports.filter((i: any) => i.acked)).toHaveLength(20);
    for (let i = 0; i < 2; i++) expect((await request({ method: 'POST', url: `/api/imports/${acked[0]}/ack` })).statusCode).toBe(204);
  });
  it('写 data.json 失败则撤销已写图标，不留下成功记录或画布', async () => {
    const freshHome = await fs.mkdtemp(join(tmpdir(), 'session-connect-export-'));
    const source = await createApp({ home: freshHome, port: 4319 });
    let payload;
    try {
      await source.inject({ method: 'POST', url: '/api/icons', headers: { host, 'content-type': 'image/svg+xml' }, payload: svg() });
      payload = (await source.inject({ url: '/api/export', headers: { host } })).json();
    } finally { await source.close(); await fs.rm(freshHome, { recursive: true, force: true }); }
    const before = await files(), id = randomUUID(), rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === join(home, 'data.json')) throw Object.assign(new Error('磁盘满'), { code: 'ENOSPC' });
      return rename(from, to);
    });
    const result = await submit(payload, id);
    expect(result.statusCode).toBe(500); expect(result.json()).toMatchObject({ code: 'WRITE_FAILED', reason: 'disk_full' });
    expect(await files()).toEqual(before);
    expect((await request({ url: `/api/imports/${id}` })).statusCode).toBe(404);
  });
  it('在读取请求体之前登记进行中；断开的未完成请求可以确定没有提交', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as import('node:net').AddressInfo;
    const url = `http://127.0.0.1:${address.port}`, id = randomUUID();
    const slow = http.request(`${url}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-import-id': id } });
    slow.on('error', () => {}); slow.write('{"format":');
    let response: Response | undefined;
    for (let i = 0; i < 100; i++) {
      response = await fetch(`${url}/api/imports/${id}`);
      if (response.status === 202) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(response?.status).toBe(202); expect(await response!.json()).toMatchObject({ code: 'IMPORT_IN_PROGRESS' });
    slow.destroy();
    for (let i = 0; i < 100; i++) {
      response = await fetch(`${url}/api/imports/${id}`);
      if (response.status === 404) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(response?.status).toBe(404);
    const latest = await fetch(`${url}/api/state`).then(r => r.json()) as { canvases: unknown[] };
    expect(latest.canvases).toHaveLength(1);
  });
});
