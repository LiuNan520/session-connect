import fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { MAX_ICON_BYTES, type DataFile, type IconMeta, type Notice } from '#shared';
import { dataFile, object } from './validation.js';
import { atomicWrite, fileTime } from './files.js';
import { WriteError } from './errors.js';

export type Log = (event: string, detail?: Record<string, unknown>) => void;
interface Options { now?: () => Date; log?: Log }
export interface Mutation<T> {
  result: T; changed?: boolean; files?: { name: string; bytes: Buffer }[]; removeFiles?: string[];
}
interface Backup { data: DataFile; icons: { id: string; ext: string; dataBase64: string }[] }

function blank(now: Date): DataFile {
  const id = randomUUID();
  return { schemaVersion: 1, prefs: { lastCanvasId: id, minimapVisible: true },
    canvases: [{ id, name: '我的画布', createdAt: now.toISOString(), revision: 0, lastSaveId: null,
      viewport: { x: 0, y: 0, zoom: 1 }, cards: [], edges: [] }], icons: [], imports: [] };
}

export class Store {
  notice: Notice | null = null;
  private current!: DataFile;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly log: Log;

  private constructor(readonly home: string, options: Options) {
    this.now = options.now ?? (() => new Date()); this.log = options.log ?? (() => {});
  }
  static async open(home: string, options: Options = {}): Promise<Store> {
    const store = new Store(home, options);
    await store.initialize();
    return store;
  }
  snapshot(): DataFile { return structuredClone(this.current); }

  transact<T>(edit: (draft: DataFile) => Mutation<T> | Promise<Mutation<T>>): Promise<T> {
    const task = this.queue.then(async () => {
      const draft = this.snapshot();
      const mutation = await edit(draft);
      if (mutation.changed === false) return mutation.result;
      const written: string[] = [];
      try {
        for (const file of mutation.files ?? []) {
          const path = join(this.home, 'icons', file.name);
          await atomicWrite(path, file.bytes); written.push(path);
        }
        await atomicWrite(join(this.home, 'data.json'), JSON.stringify(draft));
      } catch (error) {
        await Promise.all(written.map(path => fs.rm(path, { force: true }).catch(() => {})));
        this.log('write_failed', { reason: error instanceof WriteError ? error.reason : 'other' });
        throw error;
      }
      this.current = draft;
      // 元数据已经提交；文件删除失败只会留下下次启动清理的孤儿文件。
      for (const name of mutation.removeFiles ?? []) {
        await fs.rm(join(this.home, 'icons', name), { force: true }).catch(() => this.log('icon_cleanup_failed'));
      }
      return mutation.result;
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async readConsistent<T>(read: (data: DataFile) => Promise<T>): Promise<T> {
    // 导出和图标删除共用队列，避免读取元数据后其字节被另一个请求删除。
    const task = this.queue.then(() => read(this.snapshot()));
    this.queue = task.catch(() => {});
    return task;
  }
  async readVerifiedIcon(icon: IconMeta, source: 'backup' | 'export'): Promise<Buffer | null> {
    let bytes: Buffer;
    try { bytes = await fs.readFile(join(this.home, 'icons', `${icon.id}.${icon.ext}`)); }
    catch (error) {
      this.log('icon_unavailable', { id: icon.id, source, reason: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' });
      return null;
    }
    if (bytes.length > MAX_ICON_BYTES || createHash('sha256').update(bytes).digest('hex') !== icon.hash) {
      this.log('icon_unavailable', { id: icon.id, source, reason: 'hash_or_size_mismatch' });
      return null;
    }
    return bytes;
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(join(this.home, 'icons'), { recursive: true, mode: 0o700 });
    await fs.mkdir(join(this.home, 'backups'), { recursive: true, mode: 0o700 });
    const path = join(this.home, 'data.json');
    let raw: string;
    try { raw = await fs.readFile(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.current = blank(this.now());
      await atomicWrite(path, JSON.stringify(this.current));
      await this.cleanOrphans();
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { /* 按损坏数据处理。 */ }
    if (parsed && typeof parsed === 'object' && 'schemaVersion' in parsed && typeof parsed.schemaVersion === 'number') {
      if (parsed.schemaVersion > 1) throw new Error('数据来自更新版本的会话连接，请先升级');
      if (parsed.schemaVersion < 1) throw new Error('没有可用的旧版本数据迁移函数');
    }
    let valid = false;
    try { this.current = dataFile(parsed); valid = true; } catch { /* 保留损坏文件，尝试恢复。 */ }
    if (valid) {
      try { await this.backup(); }
      catch (error) {
        const failure = error as NodeJS.ErrnoException;
        this.log('backup_failed', { code: failure.code ?? failure.name ?? 'UNKNOWN',
          ...(error instanceof WriteError ? { reason: error.reason } : {}) });
      }
    } else await this.recover(path);
    await this.cleanOrphans();
  }
  private async backup(): Promise<void> {
    const icons: Backup['icons'] = [];
    for (const icon of this.current.icons) {
      const bytes = await this.readVerifiedIcon(icon, 'backup');
      if (bytes) icons.push({ id: icon.id, ext: icon.ext, dataBase64: bytes.toString('base64') });
    }
    const included = new Set(icons.map(icon => icon.id));
    // 只在备份副本中去掉不可恢复的图标，保留画布、卡片引用及当前工作数据。
    const data = { ...this.current, icons: this.current.icons.filter(icon => included.has(icon.id)) };
    const directory = join(this.home, 'backups');
    const existing = await fs.readdir(directory);
    const date = this.now();
    date.setMilliseconds(0);
    for (const entry of existing) {
      const match = /^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.json$/.exec(entry);
      if (!match) continue;
      const [, year, month, day, hour, minute, second] = match;
      const previous = new Date(+year, +month - 1, +day, +hour, +minute, +second);
      if (`backup-${fileTime(previous)}.json` === entry && previous.getTime() >= date.getTime()) date.setTime(previous.getTime() + 1000);
    }
    const name = `backup-${fileTime(date)}.json`;
    await atomicWrite(join(directory, name), JSON.stringify({ data, icons }));
    const backups = [...existing.filter(n => /^backup-\d{8}-\d{6}\.json$/.test(n)), name].sort().reverse();
    for (const old of backups.slice(10)) await fs.rm(join(directory, old));
    this.log('backup_created', { name });
  }
  private async recover(path: string): Promise<void> {
    const brokenPath = join(this.home, `data-损坏-${fileTime(this.now())}-${randomUUID().slice(0, 8)}.json`);
    // 先为原 inode 保留损坏文件名，再原子替换 data.json。
    // 恢复中途写盘失败时，原 data.json 仍在，下次不会误判为首次启动。
    await fs.link(path, brokenPath);
    // 原图标可能只存在于损坏文件里；先整体移到旁边保留，再重建工作目录。
    // 后续启动的孤儿清理只处理新的 icons/，不会删除手工恢复所需的原字节。
    const iconsPath = join(this.home, 'icons');
    if ((await fs.readdir(iconsPath)).length) await fs.rename(iconsPath, `${brokenPath.slice(0, -5)}-图标`);
    await fs.mkdir(iconsPath, { recursive: true, mode: 0o700 });
    const names = (await fs.readdir(join(this.home, 'backups'))).filter(n => /^backup-\d{8}-\d{6}\.json$/.test(n)).sort().reverse();
    let chosen: { data: DataFile; files: { name: string; bytes: Buffer }[]; time: string } | undefined;
    for (const name of names) {
      try {
        const backup = object(JSON.parse(await fs.readFile(join(this.home, 'backups', name), 'utf8')));
        const data = dataFile(backup.data);
        const entries = Array.isArray(backup.icons) ? backup.icons : [];
        const files: { name: string; bytes: Buffer }[] = [];
        data.icons = data.icons.filter(icon => {
          try {
            const found = entries.find(i => i && typeof i === 'object' && i.id === icon.id && i.ext === icon.ext);
            if (!found || typeof found.dataBase64 !== 'string' || found.dataBase64.length > 4 * Math.ceil(MAX_ICON_BYTES / 3)) throw new Error('缺少或损坏图标');
            const bytes = Buffer.from(found.dataBase64, 'base64');
            if (bytes.length > MAX_ICON_BYTES || bytes.toString('base64') !== found.dataBase64 || createHash('sha256').update(bytes).digest('hex') !== icon.hash) throw new Error('图标 hash 或编码不符');
            files.push({ name: `${icon.id}.${icon.ext}`, bytes });
            return true;
          } catch {
            this.log('backup_icon_invalid', { name, id: icon.id });
            return false;
          }
        });
        chosen = { data, files, time: name.slice(7, -5) };
        break;
      } catch { this.log('backup_invalid', { name }); }
    }
    this.current = chosen?.data ?? blank(this.now());
    for (const file of chosen?.files ?? []) await atomicWrite(join(this.home, 'icons', file.name), file.bytes);
    await atomicWrite(path, JSON.stringify(this.current));
    this.notice = { kind: chosen ? 'restored' : 'reset', ...(chosen ? { backupTime: chosen.time } : {}), brokenPath };
    this.log(chosen ? 'data_restored' : 'data_reset', { brokenPath });
  }
  private async cleanOrphans(): Promise<void> {
    try {
      const referenced = new Set(this.current.icons.map(i => `${i.id}.${i.ext}`));
      for (const name of await fs.readdir(join(this.home, 'icons'))) {
        if (!referenced.has(name)) await fs.rm(join(this.home, 'icons', name), { force: true });
      }
      // 写 data.json/备份时崩溃遗留的临时文件，不参与恢复和保留份数。
      for (const directory of [this.home, join(this.home, 'backups')]) {
        for (const name of await fs.readdir(directory)) {
          if (/\.json\.[0-9a-f-]{36}\.tmp$/.test(name)) await fs.rm(join(directory, name), { force: true });
        }
      }
    } catch (error) {
      this.log('orphan_cleanup_failed', { code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' });
    }
  }
}
