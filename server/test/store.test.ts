import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { card, svg } from './helpers.js';

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(join(tmpdir(), 'session-connect-store-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }); });

async function addIcon(store: Store, label: string) {
  const bytes = svg(`<!-- ${label} -->`);
  const icon = { id: randomUUID(), mime: 'image/svg+xml' as const, ext: 'svg' as const,
    hash: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString() };
  await store.transact(data => {
    data.icons.push(icon);
    return { result: null, files: [{ name: `${icon.id}.svg`, bytes }] };
  });
  return { ...icon, bytes };
}

describe('原子存储与启动恢复', () => {
  it('首次启动创建我的画布，写请求串行执行，重开保留结果', async () => {
    const store = await Store.open(home);
    expect(store.snapshot().canvases[0].name).toBe('我的画布');
    const id = store.snapshot().canvases[0].id;
    await Promise.all(Array.from({ length: 15 }, () => store.transact(async (data: any) => {
      await new Promise(resolve => setTimeout(resolve, 1));
      data.canvases[0].revision++;
      return { result: null };
    })));
    const reopened = await Store.open(home);
    expect(reopened.snapshot().canvases[0]).toMatchObject({ id, revision: 15 });
    expect((await fs.readdir(home)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each(['ENOSPC', 'EACCES', 'EPERM', 'EIO'])('写盘 %s 失败不改变内存、data.json 或留下图标', async code => {
    const store = await Store.open(home);
    const original = await fs.readFile(join(home, 'data.json'), 'utf8');
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === join(home, 'data.json')) throw Object.assign(new Error('模拟写盘错误'), { code });
      return rename(from, to);
    });
    const id = randomUUID();
    await expect(store.transact((data: any) => {
      data.canvases[0].name = '不应保存';
      return { result: null, files: [{ name: `${id}.svg`, bytes: Buffer.from('<svg/>') }] };
    })).rejects.toMatchObject({ code: 'WRITE_FAILED', reason: code === 'ENOSPC' ? 'disk_full' : ['EACCES', 'EPERM'].includes(code) ? 'no_permission' : 'other' });
    expect(await fs.readFile(join(home, 'data.json'), 'utf8')).toBe(original);
    expect(store.snapshot().canvases[0].name).toBe('我的画布');
    expect(await fs.readdir(join(home, 'icons'))).toEqual([]);
  });

  it('启动备份包含图标字节，只留最近十份，清理孤儿文件', async () => {
    let clock = Date.now();
    const options = { now: () => new Date(clock += 1000) };
    const store = await Store.open(home, options);
    const id = randomUUID();
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    await store.transact((data: any) => {
      data.icons.push({ id, mime: 'image/svg+xml', ext: 'svg', hash: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString() });
      return { result: null, files: [{ name: `${id}.svg`, bytes }] };
    });
    await fs.writeFile(join(home, 'icons', 'orphan.png'), 'orphan');
    for (let i = 0; i < 12; i++) await Store.open(home, options);
    const names = (await fs.readdir(join(home, 'backups'))).sort();
    expect(names).toHaveLength(10);
    expect(names.every(name => /^backup-\d{8}-\d{6}\.json$/.test(name))).toBe(true);
    const backup = JSON.parse(await fs.readFile(join(home, 'backups', names.at(-1)!), 'utf8'));
    expect(backup.data.icons[0].id).toBe(id);
    expect(backup.icons[0].dataBase64).toBe(bytes.toString('base64'));
    expect(await fs.readdir(join(home, 'icons'))).toEqual([`${id}.svg`]);
  });

  it.each([0, 437])('同一秒内连续启动超过十次，也保留最新一次备份（毫秒：%s）', async milliseconds => {
    const options = { now: () => new Date(Date.parse('2026-10-21T03:00:00.000Z') + milliseconds) };
    let store = await Store.open(home, options);
    for (let i = 1; i <= 13; i++) {
      await store.transact(data => { data.canvases[0].name = `第 ${i} 次`; return { result: null }; });
      store = await Store.open(home, options);
    }
    const names = (await fs.readdir(join(home, 'backups'))).sort();
    expect(names).toHaveLength(10);
    const latest = JSON.parse(await fs.readFile(join(home, 'backups', names.at(-1)!), 'utf8'));
    expect(latest.data.canvases[0].name).toBe('第 13 次');
  });

  it.each(['字符串上限', '备份写盘失败', '备份目录不可读'])('启动%s时保留现有数据和旧备份，仍可继续使用', async kind => {
    const store = await Store.open(home);
    const icon = await addIcon(store, '应保留');
    await store.transact(data => { data.canvases[0].name = '重要画布'; return { result: null }; });
    await Store.open(home);
    const original = await fs.readFile(join(home, 'data.json'), 'utf8');
    const directory = join(home, 'backups');
    const before = await fs.readdir(directory);
    const copies = await Promise.all(before.map(name => fs.readFile(join(directory, name), 'utf8')));
    if (kind === '字符串上限') {
      const stringify = JSON.stringify;
      vi.spyOn(JSON, 'stringify').mockImplementation((value: any, ...rest: any[]) => {
        if (value?.data?.schemaVersion === 1 && Array.isArray(value.icons)) throw new RangeError('Invalid string length');
        return (stringify as any)(value, ...rest);
      });
    } else if (kind === '备份写盘失败') {
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(to).startsWith(`${directory}/`)) throw Object.assign(new Error('模拟磁盘满'), { code: 'ENOSPC' });
        return rename(from, to);
      });
    } else {
      const readdir = fs.readdir.bind(fs);
      vi.spyOn(fs, 'readdir').mockImplementation((...args: any[]) => {
        if (args[0] === directory) return Promise.reject(Object.assign(new Error('模拟目录无权限'), { code: 'EACCES' }));
        return (readdir as any)(...args);
      });
    }
    const log = vi.fn(), reopened = await Store.open(home, { log });
    expect(reopened.notice).toBeNull();
    expect(reopened.snapshot().canvases[0].name).toBe('重要画布');
    expect(log).toHaveBeenCalledWith('backup_failed', expect.any(Object));
    vi.restoreAllMocks();
    expect(await fs.readFile(join(home, 'data.json'), 'utf8')).toBe(original);
    expect(await fs.readFile(join(home, 'icons', `${icon.id}.svg`))).toEqual(icon.bytes);
    expect(await fs.readdir(directory)).toEqual(before);
    expect(await Promise.all(before.map(name => fs.readFile(join(directory, name), 'utf8')))).toEqual(copies);
    await reopened.transact(data => { data.canvases[0].name = '仍可保存'; return { result: null }; });
    expect(JSON.parse(await fs.readFile(join(home, 'data.json'), 'utf8')).canvases[0].name).toBe('仍可保存');
  });

  it.each(['缺失', '内容被改动', '读盘失败'])('单个图标%s时仍备份画布，轮换十份后仍可恢复', async kind => {
    const log = vi.fn();
    const store = await Store.open(home, { log });
    const bad = await addIcon(store, 'bad'), good = await addIcon(store, 'good');
    await store.transact(data => {
      data.canvases[0].name = '重要画布';
      data.canvases[0].cards = [{ ...card(), iconId: bad.id }];
      return { result: null };
    });
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
    for (let i = 0; i < 11; i++) await Store.open(home, { log });
    const names = await fs.readdir(join(home, 'backups'));
    expect(names).toHaveLength(10);
    for (const name of names) {
      const backup = JSON.parse(await fs.readFile(join(home, 'backups', name), 'utf8'));
      expect(backup.data.icons.map((i: any) => i.id)).toEqual([good.id]);
      expect(backup.icons).toEqual([{ id: good.id, ext: 'svg', dataBase64: good.bytes.toString('base64') }]);
    }
    expect(await fs.readFile(join(home, 'data.json'), 'utf8')).toBe(original);
    expect(log).toHaveBeenCalledWith('icon_unavailable', expect.objectContaining({ id: bad.id, source: 'backup' }));
    await fs.writeFile(join(home, 'data.json'), '坏数据');
    const restored = await Store.open(home, { log });
    expect(restored.notice?.kind).toBe('restored');
    expect(restored.snapshot().canvases[0]).toMatchObject({ name: '重要画布', cards: [{ iconId: bad.id }] });
    expect(restored.snapshot().icons.map(i => i.id)).toEqual([good.id]);
    expect(await fs.readFile(join(home, 'icons', `${good.id}.svg`))).toEqual(good.bytes);
  });

  it.each(['缺失条目', 'hash 不符', '编码损坏', '图标数组损坏'])('备份中单个图标%s时保留最新画布和其余有效图标', async kind => {
    const store = await Store.open(home);
    const bad = await addIcon(store, 'bad'), good = await addIcon(store, 'good');
    await store.transact(data => { data.canvases[0].name = '最新的重要画布'; return { result: null }; });
    await Store.open(home);
    const [name] = await fs.readdir(join(home, 'backups'));
    const path = join(home, 'backups', name);
    const backup = JSON.parse(await fs.readFile(path, 'utf8'));
    if (kind === '缺失条目') backup.icons = [null, backup.icons[1]];
    if (kind === 'hash 不符') backup.icons[0].dataBase64 = svg('<!-- changed -->').toString('base64');
    if (kind === '编码损坏') backup.icons[0].dataBase64 += '%%%';
    if (kind === '图标数组损坏') backup.icons = null;
    await fs.writeFile(path, JSON.stringify(backup));
    await fs.writeFile(join(home, 'data.json'), '坏数据');
    const log = vi.fn(), restored = await Store.open(home, { log });
    expect(restored.notice?.kind).toBe('restored');
    expect(restored.snapshot().canvases[0].name).toBe('最新的重要画布');
    expect(restored.snapshot().icons.map(i => i.id)).toEqual(kind === '图标数组损坏' ? [] : [good.id]);
    expect(log).toHaveBeenCalledWith('backup_icon_invalid', expect.objectContaining({ name, id: bad.id }));
  });

  it('数据和图标均损坏时按原 id 恢复，跳过更坏的新备份，不新增备份', async () => {
    const store = await Store.open(home);
    const id = randomUUID();
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');
    const { createHash } = await import('node:crypto');
    await store.transact((data: any) => {
      data.canvases[0].name = '应被恢复';
      data.icons.push({ id, ext: 'svg', mime: 'image/svg+xml', hash: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString() });
      return { result: null, files: [{ name: `${id}.svg`, bytes }] };
    });
    await Store.open(home);
    await fs.writeFile(join(home, 'backups', 'backup-99999999-999999.json'), '坏备份');
    const before = await fs.readdir(join(home, 'backups'));
    await fs.writeFile(join(home, 'data.json'), '坏数据');
    await fs.writeFile(join(home, 'icons', `${id}.svg`), '坏图标');
    const restored = await Store.open(home);
    expect(restored.snapshot().canvases[0].name).toBe('应被恢复');
    expect(await fs.readFile(join(home, 'icons', `${id}.svg`))).toEqual(bytes);
    expect(restored.notice).toMatchObject({ kind: 'restored' });
    expect(await fs.readFile(restored.notice!.brokenPath, 'utf8')).toBe('坏数据');
    expect(await fs.readdir(join(home, 'backups'))).toEqual(before);
  });

  it.each(['坏数据', JSON.stringify({ schemaVersion: 1, prefs: {}, canvases: [] })])('没有可用备份就重置并保留坏数据', async broken => {
    await fs.writeFile(join(home, 'data.json'), broken);
    const store = await Store.open(home);
    expect(store.notice).toMatchObject({ kind: 'reset' });
    expect(store.snapshot().canvases[0].name).toBe('我的画布');
    expect(await fs.readFile(store.notice!.brokenPath, 'utf8')).toBe(broken);
    expect(await fs.readdir(join(home, 'backups'))).toEqual([]);
  });

  it.each([true, false])('恢复或重置时保留原图标目录，后续重启也不删除（有备份：%s）', async hasBackup => {
    const store = await Store.open(home);
    const a = await addIcon(store, 'A');
    if (hasBackup) await Store.open(home);
    const b = await addIcon(store, 'B');
    await fs.appendFile(join(home, 'data.json'), '\n坏尾巴');
    const broken = await fs.readFile(join(home, 'data.json'), 'utf8');
    expect(broken).toContain(b.id);
    const restored = await Store.open(home);
    expect(restored.notice?.kind).toBe(hasBackup ? 'restored' : 'reset');
    const brokenPath = restored.notice!.brokenPath;
    const preserved = `${brokenPath.slice(0, -5)}-图标`;
    expect(await fs.readFile(brokenPath, 'utf8')).toBe(broken);
    expect((await fs.readdir(join(home, 'icons'))).sort()).toEqual(hasBackup ? [`${a.id}.svg`] : []);
    for (const icon of [a, b]) expect(await fs.readFile(join(preserved, `${icon.id}.svg`))).toEqual(icon.bytes);
    await Store.open(home);
    for (const icon of [a, b]) expect(await fs.readFile(join(preserved, `${icon.id}.svg`))).toEqual(icon.bytes);
    expect(await fs.readFile(brokenPath, 'utf8')).toBe(broken);
  });

  it('更高 schemaVersion 拒绝启动，不覆盖或移动原文件', async () => {
    const newer = JSON.stringify({ schemaVersion: 2 });
    await fs.writeFile(join(home, 'data.json'), newer);
    await expect(Store.open(home)).rejects.toThrow('更新版本');
    expect(await fs.readFile(join(home, 'data.json'), 'utf8')).toBe(newer);
  });

  it('恢复过程写盘失败，下一次仍从备份恢复，不能误判为首次启动', async () => {
    const store = await Store.open(home);
    await addIcon(store, '备份中的图标');
    await store.transact(data => { data.canvases[0].name = '不能丢失的画布'; return { result: null }; });
    await Store.open(home);
    const newer = await addIcon(store, '备份之后的图标');
    await fs.writeFile(join(home, 'data.json'), '坏数据');
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === join(home, 'data.json')) throw Object.assign(new Error('模拟磁盘满'), { code: 'ENOSPC' });
      return rename(from, to);
    });
    await expect(Store.open(home)).rejects.toMatchObject({ code: 'WRITE_FAILED', reason: 'disk_full' });
    spy.mockRestore();
    const restored = await Store.open(home);
    expect(restored.snapshot().canvases[0].name).toBe('不能丢失的画布');
    expect(restored.notice?.kind).toBe('restored');
    const preserved = (await fs.readdir(home)).filter(name => name.endsWith('-图标'));
    const copies = await Promise.all(preserved.map(async name => {
      try { return await fs.readFile(join(home, name, `${newer.id}.svg`)); } catch { return null; }
    }));
    expect(copies.some(bytes => bytes?.equals(newer.bytes))).toBe(true);
  });
});
