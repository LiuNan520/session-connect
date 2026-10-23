import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { MAX_ICON_BYTES } from '#shared';
import { createApp } from '../src/app.js';
import { createLog } from '../src/log.js';
import { card, graph, host, svg } from './helpers.js';

let home: string, app: FastifyInstance;
async function request(options: InjectOptions) {
  return app.inject({ ...options, headers: { host, ...options.headers } });
}
async function firstCanvas(): Promise<any> { return (await request({ url: '/api/state' })).json().canvases[0]; }
async function save(body: unknown, id: string) { return request({ method: 'PUT', url: `/api/canvases/${id}/content`, payload: body as any }); }
beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'session-connect-api-'));
  app = await createApp({ home, port: 4319 });
});
afterEach(async () => { vi.restoreAllMocks(); await app.close(); await fs.rm(home, { recursive: true, force: true }); });

describe('画布和偏好接口', () => {
  it('health/state 返回完整启动数据和五个内置图标，notice 可确认', async () => {
    expect((await request({ url: '/api/health' })).json()).toMatchObject({ app: 'session-connect', pid: process.pid, port: 4319, version: '1.0.0' });
    const state = (await request({ url: '/api/state' })).json();
    expect(state).toMatchObject({ schemaVersion: 1, prefs: { minimapVisible: true }, notice: null });
    expect(state.icons.map((i: any) => i.id)).toEqual(['claude-code', 'codex', 'antigravity', 'deepseek', 'workbuddy']);
    expect(state.icons.every((i: any) => i.builtin && i.url === `/icons/${i.id}`)).toBe(true);
    expect((await request({ method: 'POST', url: '/api/notice/ack' })).statusCode).toBe(204);
  });
  it('按 id 创建幂等，文字规范化，改名和视野不改变 revision，删除幂等', async () => {
    const id = randomUUID();
    const created = await request({ method: 'POST', url: '/api/canvases', payload: { id, name: '  新\n画布 ' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id, name: '新 画布', revision: 0, lastSaveId: null });
    const again = await request({ method: 'POST', url: '/api/canvases', payload: { id, name: '不应覆盖' } });
    expect(again.statusCode).toBe(200); expect(again.json()).toEqual(created.json());
    expect((await request({ method: 'PATCH', url: `/api/canvases/${id}`, payload: { name: '修改后' } })).json()).toEqual({ id, name: '修改后' });
    expect((await request({ method: 'PUT', url: `/api/canvases/${id}/viewport`, payload: { x: 50, y: -30, zoom: 0.5 } })).statusCode).toBe(204);
    expect((await request({ method: 'PUT', url: '/api/prefs', payload: { lastCanvasId: id, minimapVisible: false } })).statusCode).toBe(204);
    expect((await request({ url: '/api/canvases/meta' })).json().at(-1)).toEqual({ id, name: '修改后', revision: 0 });
    const state = (await request({ url: '/api/state' })).json();
    expect(state.canvases.at(-1).viewport).toEqual({ x: 50, y: -30, zoom: 0.5 });
    expect(state.prefs).toEqual({ lastCanvasId: id, minimapVisible: false });
    for (let i = 0; i < 2; i++) expect((await request({ method: 'DELETE', url: `/api/canvases/${id}` })).statusCode).toBe(204);
  });
  it.each(['', '  \n ', '字'.repeat(31)])('拒绝无效画布名', async name => {
    const response = await request({ method: 'POST', url: '/api/canvases', payload: { id: randomUUID(), name } });
    expect(response.statusCode).toBe(400); expect(response.json().code).toBe('INVALID_NAME');
  });
  it('30 个组合 emoji 是合法画布名', async () => {
    expect((await request({ method: 'POST', url: '/api/canvases', payload: { id: randomUUID(), name: '👨‍👩‍👧‍👦'.repeat(30) } })).statusCode).toBe(201);
  });
  it('删除最后的画布后不会自动补建，重开仍然为空', async () => {
    const canvas = await firstCanvas();
    await request({ method: 'DELETE', url: `/api/canvases/${canvas.id}` });
    await app.close(); app = await createApp({ home, port: 4319 });
    expect((await request({ url: '/api/state' })).json().canvases).toEqual([]);
  });
});

describe('内容保存、校验和幂等', () => {
  it.each([
    ['off', 'off'], ['follow', 'follow'], [undefined, 'follow']
  ] as const)('连线活跃设置 %s 保存并重启后读回 %s', async (activity, expected) => {
    const { id } = await firstCanvas();
    const value = graph();
    const edges = value.edges.map(edge => ({ ...edge, activity }));
    const response = await save({ ...value, edges, baseRevision: 0, saveId: randomUUID() }, id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revision: 1 });
    const expectedEdges = value.edges.map(edge => ({ ...edge, activity: expected }));
    expect((await firstCanvas()).edges).toEqual(expectedEdges);
    const saved = JSON.parse(await fs.readFile(join(home, 'data.json'), 'utf8'));
    expect(saved.schemaVersion).toBe(1);
    expect(saved.canvases[0].edges).toEqual(expectedEdges);
    await app.close(); app = await createApp({ home, port: 4319 });
    expect((await firstCanvas()).edges).toEqual(expectedEdges);
    const backups = await fs.readdir(join(home, 'backups'));
    expect(backups).toHaveLength(1);
    const backup = JSON.parse(await fs.readFile(join(home, 'backups', backups[0]), 'utf8'));
    expect(backup.data.canvases[0].edges).toEqual(expectedEdges);
  });

  it('旧 data.json 的连线补为 follow，启动和读取不重写原文件', async () => {
    await app.close();
    const path = join(home, 'data.json');
    const legacy = JSON.parse(await fs.readFile(path, 'utf8'));
    const value = graph();
    Object.assign(legacy.canvases[0], value, { edges: value.edges.map(({ activity: _, ...edge }) => edge) });
    const original = `${JSON.stringify(legacy, null, 2)}\n`;
    await fs.writeFile(path, original);
    app = await createApp({ home, port: 4319 });
    const state = (await request({ url: '/api/state' })).json();
    expect(state.schemaVersion).toBe(1);
    expect(state.notice).toBeNull();
    expect(state.canvases[0]).toMatchObject({ id: legacy.canvases[0].id, revision: 0,
      edges: value.edges.map(edge => ({ ...edge, activity: 'follow' })) });
    const download = await request({ url: '/api/export' });
    expect(download.statusCode).toBe(200);
    expect(download.json()).toMatchObject({ formatVersion: 1, canvases: [{ edges: state.canvases[0].edges }] });
    expect(await fs.readFile(path, 'utf8')).toBe(original);
  });

  it.each([undefined, 'off'] as const)('从备份恢复连线活跃设置 %s，缺字段按 follow', async activity => {
    await app.close();
    const path = join(home, 'data.json');
    const data = JSON.parse(await fs.readFile(path, 'utf8'));
    const value = graph();
    const edges = value.edges.map(edge => ({ ...edge, activity }));
    Object.assign(data.canvases[0], value, { edges });
    await fs.writeFile(join(home, 'backups', 'backup-20261023-080000.json'), JSON.stringify({ data, icons: [] }));
    await fs.writeFile(path, '损坏的工作数据');
    app = await createApp({ home, port: 4319 });
    const state = (await request({ url: '/api/state' })).json();
    expect(state.schemaVersion).toBe(1);
    expect(state.notice).toMatchObject({ kind: 'restored', backupTime: '20261023-080000' });
    const expectedEdges = value.edges.map(edge => ({ ...edge, activity: activity ?? 'follow' }));
    expect(state.canvases[0]).toMatchObject({ id: data.canvases[0].id, edges: expectedEdges });
    expect(JSON.parse(await fs.readFile(path, 'utf8')).canvases[0].edges).toEqual(expectedEdges);
    expect(await fs.readFile(state.notice.brokenPath, 'utf8')).toBe('损坏的工作数据');
  });

  it('revision 递增；重复请求包括重启后都不重复写，旧 revision 返回 409，删除后返回 404', async () => {
    const { id } = await firstCanvas();
    const body = { baseRevision: 0, saveId: randomUUID(), ...graph() };
    expect((await save(body, id)).json()).toEqual({ revision: 1 });
    const written = await fs.readFile(join(home, 'data.json'), 'utf8');
    expect((await save(body, id)).json()).toEqual({ revision: 1 });
    expect(await fs.readFile(join(home, 'data.json'), 'utf8')).toBe(written);
    await app.close(); app = await createApp({ home, port: 4319 });
    expect((await save(body, id)).json()).toEqual({ revision: 1 });
    const conflict = await save({ ...body, saveId: randomUUID() }, id);
    expect(conflict.statusCode).toBe(409); expect(conflict.json()).toMatchObject({ code: 'REVISION_CONFLICT', revision: 1 });
    expect((await save({ ...body, baseRevision: 1, saveId: randomUUID() }, id)).json()).toEqual({ revision: 2 });
    expect((await save(body, id)).statusCode).toBe(409);
    await request({ method: 'DELETE', url: `/api/canvases/${id}` });
    expect((await save(body, id)).json().code).toBe('CANVAS_NOT_FOUND');
  });
  it('两个并发保存只有一个成功', async () => {
    const { id } = await firstCanvas();
    const results = await Promise.all([1, 2].map(() => save({ baseRevision: 0, saveId: randomUUID(), ...graph() }, id)));
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
  });
  it.each([
    ['重复卡片 id', (v: any) => { v.cards[1].id = v.cards[0].id; }],
    ['重复连线 id', (v: any) => { v.edges.push({ ...v.edges[0] }); }],
    ['跨类型 id 重复', (v: any) => { v.edges[0].id = v.cards[0].id; }],
    ['缺失端点', (v: any) => { v.edges[0].b = '不存在'; }],
    ['自连', (v: any) => { v.edges[0].b = v.edges[0].a; }],
    ['反向重复连线', (v: any) => { const e = v.edges[0]; v.edges.push({ ...e, id: randomUUID(), a: e.b, b: e.a }); }],
    ['错误状态', (v: any) => { v.cards[0].status = 'bad'; }],
    ['错误方向', (v: any) => { v.edges[0].direction = 'bad'; }],
    ['活跃设置 on', (v: any) => { v.edges[0].activity = 'on'; }],
    ['活跃设置 null', (v: any) => { v.edges[0].activity = null; }],
    ['活跃设置空字符串', (v: any) => { v.edges[0].activity = ''; }],
    ['活跃设置布尔值', (v: any) => { v.edges[0].activity = false; }],
    ['活跃设置数字', (v: any) => { v.edges[0].activity = 0; }],
    ['活跃设置对象', (v: any) => { v.edges[0].activity = {}; }],
    ['活跃设置数组', (v: any) => { v.edges[0].activity = []; }],
    ['非有限坐标', (v: any) => { v.cards[0].x = null; }],
    ['错误坐标类型', (v: any) => { v.cards[0].y = '1'; }],
    ['空卡片名', (v: any) => { v.cards[0].name = '  '; }],
    ['长卡片名', (v: any) => { v.cards[0].name = '字'.repeat(41); }],
    ['长备注', (v: any) => { v.cards[0].note = '字'.repeat(61); }],
    ['长连线文字', (v: any) => { v.edges[0].label = '字'.repeat(21); }],
    ['错误 revision', (v: any) => { v.baseRevision = -1; }],
    ['空 saveId', (v: any) => { v.saveId = ''; }],
    ['缺少数组', (v: any) => { delete v.cards; }]
  ])('INVALID_CONTENT：%s 且不写盘', async (name, change) => {
    const before = await firstCanvas(), { id } = before;
    const original = await fs.readFile(join(home, 'data.json'), 'utf8');
    const value = { ...graph(), baseRevision: 0, saveId: randomUUID() }; change(value);
    const result = await save(value, id);
    expect(result.statusCode).toBe(400); expect(result.json()).toMatchObject({ code: 'INVALID_CONTENT', detail: expect.any(String) });
    if (name.startsWith('活跃设置')) expect(result.json().detail).toBe('连线活跃设置不合法');
    expect(await fs.readFile(join(home, 'data.json'), 'utf8')).toBe(original);
    expect(await firstCanvas()).toEqual(before);
  });
  it('一万张卡片可以保存，没有人为的卡片数量或 5 MB 上限', async () => {
    const { id } = await firstCanvas();
    const cards = Array.from({ length: 10000 }, () => ({ ...card(), name: '字'.repeat(40), note: '字'.repeat(60) }));
    const response = await save({ baseRevision: 0, saveId: randomUUID(), cards, edges: [] }, id);
    expect(response.statusCode).toBe(200);
    expect((await firstCanvas()).cards).toHaveLength(10000);
  });
  it.each([['ENOSPC', 'disk_full'], ['EACCES', 'no_permission'], ['EPERM', 'no_permission'], ['EIO', 'other']])('写盘 %s 返回明确原因且可重试', async (code, reason) => {
    const { id } = await firstCanvas();
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === join(home, 'data.json')) throw Object.assign(new Error('写盘错误'), { code });
      return rename(from, to);
    });
    const body = { baseRevision: 0, saveId: randomUUID(), ...graph() };
    const response = await save(body, id);
    expect(response.statusCode).toBe(500); expect(response.json()).toMatchObject({ code: 'WRITE_FAILED', reason });
    expect((await firstCanvas()).revision).toBe(0);
    spy.mockRestore(); expect((await save(body, id)).json()).toEqual({ revision: 1 });
  });
  it('磁盘满时日志写入也失败，仍返回原来的 WRITE_FAILED', async () => {
    await app.close(); app = await createApp({ home, port: 4319, log: createLog(home) });
    const { id } = await firstCanvas();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === join(home, 'data.json')) throw Object.assign(new Error('磁盘满'), { code: 'ENOSPC' });
      return rename(from, to);
    });
    vi.spyOn(fsSync, 'appendFileSync').mockImplementation(() => { throw Object.assign(new Error('日志也写不进'), { code: 'ENOSPC' }); });
    const response = await save({ baseRevision: 0, saveId: randomUUID(), ...graph() }, id);
    expect(response.statusCode).toBe(500); expect(response.json()).toMatchObject({ code: 'WRITE_FAILED', reason: 'disk_full' });
    expect((await firstCanvas()).revision).toBe(0);
  });
});

describe('上传图片', () => {
  async function upload(bytes: Buffer, mime: string) { return request({ method: 'POST', url: '/api/icons', headers: { 'content-type': mime }, payload: bytes }); }
  it('PNG、JPG、WebP、SVG 完整解码，读取带安全头', async () => {
    const image = sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } });
    for (const [mime, bytes] of [
      ['image/png', await image.clone().png().toBuffer()], ['image/jpeg', await image.clone().jpeg().toBuffer()],
      ['image/webp', await image.clone().webp().toBuffer()], ['image/svg+xml', svg('<script>alert(1)</script>')]
    ] as const) {
      const response = await upload(bytes, mime);
      expect(response.statusCode).toBe(201);
      const icon = response.json();
      expect(icon).toMatchObject({ builtin: false, mime, hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
      const get = await request({ url: icon.url });
      expect(get.rawPayload).toEqual(bytes);
      expect(get.headers['x-content-type-options']).toBe('nosniff');
      expect(get.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'");
    }
  });
  it('GIF/不支持的 MIME 返回 415，超过 1 MB 返回 413', async () => {
    expect((await upload(Buffer.from('GIF89a'), 'image/gif')).json().code).toBe('UNSUPPORTED_TYPE');
    const large = await upload(Buffer.alloc(MAX_ICON_BYTES + 1), 'image/png');
    expect(large.statusCode).toBe(413); expect(large.json().code).toBe('TOO_LARGE');
  });
  it('截断 PNG/JPG、类型错配、非 SVG 根、残缺 SVG 返回 422', async () => {
    const image = sharp({ create: { width: 60, height: 60, channels: 3, background: '#5500aa' } });
    const png = await image.clone().png().toBuffer(), jpg = await image.clone().jpeg().toBuffer();
    for (const [mime, bytes] of [
      ['image/png', png.subarray(0, Math.floor(png.length / 2))], ['image/jpeg', jpg.subarray(0, jpg.length - 30)],
      ['image/png', jpg], ['image/svg+xml', Buffer.from('<html><svg/></html>')], ['image/svg+xml', Buffer.from('<svg><path')]
    ] as const) {
      const response = await upload(bytes, mime);
      expect(response.statusCode).toBe(422); expect(response.json().code).toBe('UNREADABLE');
    }
  });
  it('按 hash 去重；删除不改卡片；重传得到新 id；禁止删除内置图标', async () => {
    const a = await upload(svg(), 'image/svg+xml');
    const again = await upload(svg(), 'image/svg+xml');
    expect(again.statusCode).toBe(200); expect(again.json()).toEqual(a.json());
    const canvas = await firstCanvas();
    await save({ baseRevision: 0, saveId: randomUUID(), cards: [{ ...card(), iconId: a.json().id }], edges: [] }, canvas.id);
    for (let i = 0; i < 2; i++) expect((await request({ method: 'DELETE', url: a.json().url.replace('/icons/', '/api/icons/') })).statusCode).toBe(204);
    expect((await firstCanvas()).cards[0].iconId).toBe(a.json().id);
    expect((await request({ url: a.json().url })).statusCode).toBe(404);
    expect((await upload(svg(), 'image/svg+xml')).json().id).not.toBe(a.json().id);
    expect((await request({ method: 'DELETE', url: '/api/icons/claude-code' })).json().code).toBe('BUILTIN_ICON');
    expect((await request({ url: '/icons/claude-code' })).statusCode).toBe(200);
  });
});

describe('Host 和 Origin', () => {
  it.each([
    { host: 'attacker.invalid:4319' }, { host: '127.0.0.1:4320' }, { host: '127.0.0.1:4319', origin: 'https://attacker.invalid' },
    { host: '127.0.0.1:4319', origin: 'http://localhost:4319' }, { host: 'localhost:4319', origin: 'null' }
  ])('拒绝非法来源 %o', async headers => {
    const response = await request({ url: '/api/health', headers });
    expect(response.statusCode).toBe(403); expect(response.json().code).toBe('FORBIDDEN');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('接受 localhost/127.0.0.1 自身来源以及没有 Origin 的本地请求', async () => {
    for (const h of [host, 'localhost:4319']) expect((await request({ url: '/api/health', headers: { host: h, origin: `http://${h}` } })).statusCode).toBe(200);
  });
});
