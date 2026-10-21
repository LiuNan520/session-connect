import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { EXPORT_FORMAT, FORMAT_VERSION, MAX_ICON_BYTES, type Canvas, type ExportFile, type IconMeta, type ImportRecord, type ImportResult } from '#shared';
import { ApiError } from './errors.js';
import { canvas, object, timestamp, uuid } from './validation.js';
import { validateImage } from './images.js';
import { fileTime } from './files.js';
import type { Store } from './store.js';

interface Pending {
  id: string; phase: 'reading' | 'processing'; promise: Promise<ImportResult | null>;
  resolve: (result: ImportResult | null) => void;
}
const resultOf = (record: ImportRecord): ImportResult => ({ canvasIds: record.canvasIds, iconsAdded: record.iconsAdded });

export function registerTransfers(app: FastifyInstance, store: Store): void {
  const pending = new Map<string, Pending>();
  const owners = new WeakMap<FastifyRequest, Pending>();
  function finish(request: FastifyRequest, result: ImportResult | null) {
    const token = owners.get(request);
    if (!token) return;
    owners.delete(request);
    if (pending.get(token.id) === token) pending.delete(token.id);
    token.resolve(result);
  }
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'POST' || request.routeOptions.url !== '/api/import') return;
    const importId = request.headers['x-import-id'];
    if (!uuid(importId)) throw new ApiError(400, 'MISSING_IMPORT_ID', '缺少有效的导入标识');
    const recorded = store.snapshot().imports.find(i => i.importId === importId);
    if (recorded) return reply.send(resultOf(recorded));
    const active = pending.get(importId);
    if (active) {
      const result = await active.promise;
      if (result) return reply.send(result);
      throw new ApiError(400, 'INVALID_FILE', '前一个同标识导入未成功，请重新导入');
    }
    let resolve!: Pending['resolve'];
    const promise = new Promise<ImportResult | null>(r => { resolve = r; });
    const token: Pending = { id: importId, phase: 'reading', promise, resolve };
    pending.set(importId, token); owners.set(request, token);
  });
  app.addHook('onRequestAbort', async request => {
    // handler 开始后仍有可能提交，连接断开也必须保留进行中状态，直至事务结束。
    if (owners.get(request)?.phase === 'reading') finish(request, null);
  });
  app.addHook('onError', async request => {
    if (owners.get(request)?.phase === 'reading') finish(request, null);
  });
  app.addHook('onResponse', async request => {
    if (owners.get(request)?.phase === 'reading') finish(request, null);
  });

  app.get('/api/export', async (_request, reply) => {
    const payload = await store.readConsistent(async data => {
      const icons: ExportFile['icons'] = [];
      for (const icon of data.icons) {
        const bytes = await store.readVerifiedIcon(icon, 'export');
        if (bytes) icons.push({ id: icon.id, mime: icon.mime, hash: icon.hash, dataBase64: bytes.toString('base64') });
      }
      // 字段顺序是协议的一部分，前端用文件开头识别自己的备份。
      return { format: EXPORT_FORMAT, formatVersion: FORMAT_VERSION, exportedAt: new Date().toISOString(), canvases: data.canvases, icons } satisfies ExportFile;
    });
    const name = `会话连接-备份-${fileTime(new Date()).slice(0, -2)}.json`;
    return reply.type('application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`).send(JSON.stringify(payload));
  });

  app.post('/api/import', async request => {
    const token = owners.get(request)!;
    token.phase = 'processing';
    let result: ImportResult | null = null;
    try {
      const value = await validateExport(request.body);
      result = await store.transact(data => {
        const existing = data.imports.find(i => i.importId === token.id);
        if (existing) return { result: resultOf(existing), changed: false };
        const files: { name: string; bytes: Buffer }[] = [];
        const iconMap = new Map<string, string>();
        for (const source of value.icons) {
          const same = data.icons.find(i => i.hash === source.image.hash);
          if (same) { iconMap.set(source.id, same.id); continue; }
          const icon: IconMeta = { ...source.image, id: randomUUID(), createdAt: new Date().toISOString() };
          data.icons.push(icon); iconMap.set(source.id, icon.id);
          files.push({ name: `${icon.id}.${icon.ext}`, bytes: source.bytes });
        }
        const canvases = value.canvases.map(source => {
          const ids = new Map(source.cards.map(c => [c.id, randomUUID()]));
          return { ...source, id: randomUUID(), revision: 0, lastSaveId: null,
            cards: source.cards.map(c => ({ ...c, id: ids.get(c.id)!, iconId: iconMap.get(c.iconId) ?? c.iconId })),
            edges: source.edges.map(e => ({ ...e, id: randomUUID(), a: ids.get(e.a)!, b: ids.get(e.b)! })) };
        });
        data.canvases.push(...canvases);
        const imported = { canvasIds: canvases.map(c => c.id), iconsAdded: files.length };
        data.imports.push({ ...imported, importId: token.id, at: new Date().toISOString(), acked: false });
        return { result: imported, files };
      });
      return result;
    } finally { finish(request, result); }
  });

  app.get<{ Params: { importId: string } }>('/api/imports/:importId', async (request, reply) => {
    const record = store.snapshot().imports.find(i => i.importId === request.params.importId);
    if (record) return resultOf(record);
    if (pending.has(request.params.importId)) return reply.code(202).send({ code: 'IMPORT_IN_PROGRESS', message: '导入进行中' });
    throw new ApiError(404, 'IMPORT_NOT_FOUND', '这次导入没有提交');
  });
  app.post<{ Params: { importId: string } }>('/api/imports/:importId/ack', async (request, reply) => {
    await store.transact(data => {
      const record = data.imports.find(i => i.importId === request.params.importId);
      if (!record || record.acked) return { result: null, changed: false };
      record.acked = true;
      const keep = new Set(data.imports.filter(i => i.acked).slice(-20).map(i => i.importId));
      data.imports = data.imports.filter(i => !i.acked || keep.has(i.importId));
      return { result: null };
    });
    return reply.code(204).send();
  });
}

async function validateExport(value: unknown) {
  try {
    const v = object(value);
    if (v.format !== EXPORT_FORMAT) throw new Error('不是本程序导出文件');
    if (typeof v.formatVersion === 'number' && v.formatVersion > FORMAT_VERSION) throw new ApiError(400, 'NEWER_VERSION', '这个文件来自更新版本的会话连接，请先升级后再导入');
    if (v.formatVersion !== FORMAT_VERSION || !Array.isArray(v.canvases) || !Array.isArray(v.icons)) throw new Error('导出结构不完整');
    timestamp(v.exportedAt);
    const canvases: Canvas[] = v.canvases.map(canvas);
    if (new Set(canvases.map(c => c.id)).size !== canvases.length) throw new Error('画布 id 重复');
    const used = new Set<string>();
    const icons: { id: string; bytes: Buffer; image: Awaited<ReturnType<typeof validateImage>> }[] = [];
    for (const item of v.icons) {
      const icon = object(item);
      if (!uuid(icon.id) || used.has(icon.id)) throw new Error('图标 id 不合法或重复');
      used.add(icon.id);
      if (typeof icon.dataBase64 !== 'string' || typeof icon.mime !== 'string') throw new Error('图标内容缺失');
      if (icon.dataBase64.length > 4 * Math.ceil(MAX_ICON_BYTES / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(icon.dataBase64)) throw new Error('base64 不合法');
      const bytes = Buffer.from(icon.dataBase64, 'base64');
      if (bytes.toString('base64') !== icon.dataBase64) throw new Error('base64 不合法');
      const image = await validateImage(bytes, icon.mime);
      if (image.hash !== icon.hash) throw new Error('hash 不一致');
      icons.push({ id: icon.id, bytes, image });
    }
    return { canvases, icons };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NEWER_VERSION') throw error;
    throw new ApiError(400, 'INVALID_FILE', '文件格式不对，没有导入任何内容');
  }
}
