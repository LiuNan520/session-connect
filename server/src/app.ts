import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BUILTIN_ICON_IDS, MAX_BODY_BYTES, MAX_ICON_BYTES, type Canvas, type Icon, type IconMeta } from '#shared';
import { Store, type Log } from './store.js';
import { ApiError } from './errors.js';
import { canvasName, content, id, integer, MIME_EXT, object, uuid, viewport } from './validation.js';
import { validateImage } from './images.js';
import { registerTransfers } from './transfers.js';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const iconView = (icon: IconMeta): Icon => ({ id: icon.id, builtin: false, mime: icon.mime, hash: icon.hash, url: `/icons/${icon.id}` });
function invalid(error: unknown): never {
  if (error instanceof ApiError) throw error;
  throw new ApiError(400, 'INVALID_CONTENT', '内容不合法', { detail: error instanceof Error ? error.message : '数据结构不完整' });
}

export async function createApp(options: { home: string; port?: number; log?: Log }) {
  const store = await Store.open(options.home, { log: options.log });
  const app = Fastify({ bodyLimit: MAX_BODY_BYTES, logger: false, forceCloseConnections: true });
  const port = () => {
    const address = app.server.address();
    return address && typeof address !== 'string' ? address.port : options.port ?? 4319;
  };
  const webRoot = join(projectRoot, 'dist/web');
  const builtinRoot = existsSync(join(webRoot, 'icons/claude-code.svg')) ? join(webRoot, 'icons') : join(projectRoot, 'assets/icons');
  const builtinIcons: Icon[] = await Promise.all(BUILTIN_ICON_IDS.map(async id => ({
    id, builtin: true, mime: 'image/svg+xml', url: `/icons/${id}`,
    hash: createHash('sha256').update(await fs.readFile(join(builtinRoot, `${id}.svg`))).digest('hex')
  })));

  app.addHook('onRequest', async (request) => {
    const host = request.headers.host;
    if ((host !== `127.0.0.1:${port()}` && host !== `localhost:${port()}`)
      || (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`)) {
      throw new ApiError(403, 'FORBIDDEN', '请求来源不允许');
    }
  });
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ code: error.code, message: error.message, ...error.extra });
    const e = error as { code?: string; statusCode?: number };
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ code: 'TOO_LARGE', message: '文件太大' });
    if (e.statusCode === 400 || error instanceof SyntaxError) return reply.code(400).send({
      code: request.routeOptions.url === '/api/import' ? 'INVALID_FILE' : 'INVALID_CONTENT', message: '文件或内容格式不对', detail: '请求格式不合法'
    });
    options.log?.('request_failed', { code: e.code ?? 'UNKNOWN' });
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '本地服务发生错误' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: '内容不存在' }));

  app.get('/api/health', async () => ({ app: 'session-connect', version: '1.0.0', pid: process.pid, port: port() }));
  app.get('/api/state', async () => {
    const data = store.snapshot();
    return { schemaVersion: data.schemaVersion, canvases: data.canvases, icons: [...builtinIcons, ...data.icons.map(iconView)], prefs: data.prefs, notice: store.notice };
  });
  app.post('/api/notice/ack', async (_request, reply) => { store.notice = null; return reply.code(204).send(); });
  app.get('/api/canvases/meta', async () => store.snapshot().canvases.map(({ id, name, revision }) => ({ id, name, revision })));

  app.post('/api/canvases', async (request, reply) => {
    try {
      const body = object(request.body);
      if (!uuid(body.id)) throw new Error('画布 id 必须是 UUID');
      const canvasId = body.id;
      const result = await store.transact(data => {
        const existing = data.canvases.find(c => c.id === canvasId);
        if (existing) return { result: { existing: true, canvas: existing }, changed: false };
        const canvas: Canvas = { id: canvasId, name: canvasName(body.name), createdAt: new Date().toISOString(), revision: 0,
          lastSaveId: null, viewport: { x: 0, y: 0, zoom: 1 }, cards: [], edges: [] };
        data.canvases.push(canvas);
        return { result: { existing: false, canvas } };
      });
      return reply.code(result.existing ? 200 : 201).send(result.canvas);
    } catch (error) { invalid(error); }
  });
  app.patch<{ Params: { id: string } }>('/api/canvases/:id', async request => {
    try {
      const name = canvasName(object(request.body).name);
      return await store.transact(data => {
        const canvas = data.canvases.find(c => c.id === request.params.id);
        if (!canvas) throw new ApiError(404, 'CANVAS_NOT_FOUND', '画布已被删除');
        canvas.name = name;
        return { result: { id: canvas.id, name } };
      });
    } catch (error) { invalid(error); }
  });
  app.delete<{ Params: { id: string } }>('/api/canvases/:id', async (request, reply) => {
    await store.transact(data => {
      const before = data.canvases.length;
      data.canvases = data.canvases.filter(c => c.id !== request.params.id);
      if (data.prefs.lastCanvasId === request.params.id) data.prefs.lastCanvasId = data.canvases[0]?.id ?? null;
      return { result: null, changed: data.canvases.length !== before };
    });
    return reply.code(204).send();
  });
  app.put<{ Params: { id: string } }>('/api/canvases/:id/content', async request => {
    try {
      const body = object(request.body), baseRevision = integer(body.baseRevision), saveId = id(body.saveId);
      const value = content(body);
      return await store.transact(data => {
        const canvas = data.canvases.find(c => c.id === request.params.id);
        if (!canvas) throw new ApiError(404, 'CANVAS_NOT_FOUND', '画布已被删除');
        if (baseRevision === canvas.revision - 1 && saveId === canvas.lastSaveId) return { result: { revision: canvas.revision }, changed: false };
        if (baseRevision !== canvas.revision) throw new ApiError(409, 'REVISION_CONFLICT', '这张画布在别的标签页改过了', { revision: canvas.revision });
        Object.assign(canvas, value, { revision: canvas.revision + 1, lastSaveId: saveId });
        return { result: { revision: canvas.revision } };
      });
    } catch (error) { invalid(error); }
  });
  app.put<{ Params: { id: string } }>('/api/canvases/:id/viewport', async (request, reply) => {
    try {
      const value = viewport(request.body);
      await store.transact(data => {
        const canvas = data.canvases.find(c => c.id === request.params.id);
        if (!canvas) throw new ApiError(404, 'CANVAS_NOT_FOUND', '画布已被删除');
        canvas.viewport = value;
        return { result: null };
      });
      return reply.code(204).send();
    } catch (error) { invalid(error); }
  });
  app.put('/api/prefs', async (request, reply) => {
    try {
      const body = object(request.body);
      if (body.lastCanvasId !== undefined && body.lastCanvasId !== null) id(body.lastCanvasId);
      if (body.minimapVisible !== undefined && typeof body.minimapVisible !== 'boolean') throw new Error('小地图设置必须是布尔值');
      await store.transact(data => {
        if (body.lastCanvasId !== undefined) data.prefs.lastCanvasId = body.lastCanvasId as string | null;
        if (body.minimapVisible !== undefined) data.prefs.minimapVisible = body.minimapVisible as boolean;
        return { result: null };
      });
      return reply.code(204).send();
    } catch (error) { invalid(error); }
  });

  app.post('/api/icons', { bodyLimit: MAX_ICON_BYTES, onRequest: async request => {
    const mime = request.headers['content-type']?.split(';')[0].trim().toLowerCase() ?? '';
    if (!Object.hasOwn(MIME_EXT, mime)) throw new ApiError(415, 'UNSUPPORTED_TYPE', '只支持 PNG、JPG、WebP、SVG 图片');
  } }, async (request, reply) => {
    const bytes = request.body as Buffer;
    const image = await validateImage(bytes, request.headers['content-type']!.split(';')[0].trim().toLowerCase());
    const result = await store.transact(data => {
      const existing = data.icons.find(i => i.hash === image.hash);
      if (existing) return { result: { existing: true, icon: existing }, changed: false };
      const icon: IconMeta = { ...image, id: randomUUID(), createdAt: new Date().toISOString() };
      data.icons.push(icon);
      return { result: { existing: false, icon }, files: [{ name: `${icon.id}.${icon.ext}`, bytes }] };
    });
    return reply.code(result.existing ? 200 : 201).send(iconView(result.icon));
  });
  app.delete<{ Params: { id: string } }>('/api/icons/:id', async (request, reply) => {
    if ((BUILTIN_ICON_IDS as readonly string[]).includes(request.params.id)) throw new ApiError(400, 'BUILTIN_ICON', '内置图标不能删除');
    await store.transact(data => {
      const icon = data.icons.find(i => i.id === request.params.id);
      if (!icon) return { result: null, changed: false };
      data.icons = data.icons.filter(i => i.id !== icon.id);
      return { result: null, removeFiles: [`${icon.id}.${icon.ext}`] };
    });
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>('/icons/:id', async (request, reply) => {
    const iconId = request.params.id;
    const builtin = (BUILTIN_ICON_IDS as readonly string[]).includes(iconId);
    const icon = builtin ? builtinIcons.find(i => i.id === iconId) : store.snapshot().icons.find(i => i.id === iconId);
    if (!icon) throw new ApiError(404, 'ICON_NOT_FOUND', '图标不存在');
    const path = builtin ? join(builtinRoot, `${iconId}.svg`) : join(options.home, 'icons', `${iconId}.${(icon as IconMeta).ext}`);
    let bytes: Buffer;
    try { bytes = await fs.readFile(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'ICON_NOT_FOUND', '图标不存在'); throw error; }
    return reply.type(icon.mime).header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'").send(bytes);
  });

  registerTransfers(app, store);
  if (existsSync(webRoot)) await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
  return app;
}
