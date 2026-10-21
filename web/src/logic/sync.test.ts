import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Canvas, ImportResult, SaveContentRequest, State } from '#shared';
import type { ApiResult } from '../api';
import { CanvasSaver, type SaverSnapshot } from './saver';
import { RefreshController, metaDiffers, planMerge } from './refresh';
import { ImportTracker } from './importTracker';
import { LatestSaver } from './latestSaver';

const ok = <T>(data: T, status = 200): ApiResult<T> => ({ ok: true, status, data, headers: new Headers() });
const net = (): ApiResult<never> => ({ ok: false, kind: 'network' });
const http = (status: number, code: string, extra: Record<string, unknown> = {}): ApiResult<never> =>
  ({ ok: false, kind: 'http', status, error: { code, message: code, ...extra } });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('保存队列', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(revision = 0) {
    const calls: { body: SaveContentRequest; reply: ReturnType<typeof deferred<ApiResult<{ revision: number }>>> }[] = [];
    let content = { cards: [] as never[], edges: [] as never[], tag: 0 };
    let ids = 0;
    const states: SaverSnapshot[] = [];
    const events: string[] = [];
    const saver = new CanvasSaver(revision, {
      put: body => { const reply = deferred<ApiResult<{ revision: number }>>(); calls.push({ body, reply }); return reply.promise; },
      getContent: () => content as never,
      newId: () => `save-${++ids}`,
      onChange: s => states.push(s),
      onConflict: rev => events.push(`conflict:${rev}`),
      onDeleted: () => events.push('deleted')
    });
    const edit = () => { content = { ...content, tag: content.tag + 1 }; saver.changed(); };
    const last = () => states[states.length - 1];
    return { saver, calls, edit, last, events };
  }

  it('停手 800ms 后保存；成功后 revision 更新、状态回到已保存', async () => {
    const { saver, calls, edit, last } = setup(3);
    edit(); edit();
    await vi.advanceTimersByTimeAsync(799);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.baseRevision).toBe(3);
    expect(last()).toMatchObject({ status: 'saving', inflight: true });
    calls[0].reply.resolve(ok({ revision: 4 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.revision).toBe(4);
    expect(last()).toMatchObject({ status: 'idle', dirty: false, inflight: false });
  });

  it('同一时间最多一个请求；在途时又有改动，返回后再存一次', async () => {
    const { calls, edit } = setup();
    edit();
    await vi.advanceTimersByTimeAsync(800);
    edit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(1);
    calls[0].reply.resolve(ok({ revision: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.baseRevision).toBe(1);
  });

  it('结果未知时每 5 秒原样重试同一个请求，期间的新改动等明确结果后再发', async () => {
    const { calls, edit, last } = setup(7);
    edit();
    await vi.advanceTimersByTimeAsync(800);
    calls[0].reply.resolve(net());
    await vi.advanceTimersByTimeAsync(0);
    expect(last().status).toBe('offline');
    edit(); // 离线期间继续编辑
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toBe(calls[0].body); // 同 baseRevision、saveId、内容
    calls[1].reply.resolve(ok({ revision: 8 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(3); // 拿到明确结果后，发送之后的新内容
    expect(calls[2].body.baseRevision).toBe(8);
    expect(calls[2].body.saveId).not.toBe(calls[0].body.saveId);
  });

  it('WRITE_FAILED 时每 5 秒重试，内容换成最新的并换新 saveId', async () => {
    const { calls, edit, last } = setup();
    edit();
    await vi.advanceTimersByTimeAsync(800);
    calls[0].reply.resolve(http(500, 'WRITE_FAILED', { reason: 'disk_full' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ status: 'failed', reason: 'disk_full', dirty: true });
    edit();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.saveId).not.toBe(calls[0].body.saveId);
    expect((calls[1].body as unknown as { tag: number }).tag).toBeUndefined(); // body 只取 cards/edges
    expect(calls[1].body.baseRevision).toBe(0);
  });

  it('409 变只读并停止；404 通知画布已删除', async () => {
    const a = setup();
    a.edit();
    await vi.advanceTimersByTimeAsync(800);
    a.calls[0].reply.resolve(http(409, 'REVISION_CONFLICT', { revision: 5 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.last().status).toBe('conflict');
    expect(a.events).toEqual(['conflict:5']);
    a.edit();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a.calls).toHaveLength(1);

    const b = setup();
    b.edit();
    await vi.advanceTimersByTimeAsync(800);
    b.calls[0].reply.resolve(http(404, 'CANVAS_NOT_FOUND'));
    await vi.advanceTimersByTimeAsync(0);
    expect(b.last().status).toBe('deleted');
    expect(b.events).toEqual(['deleted']);
  });

  it('flush 立刻保存；存不上返回 false', async () => {
    const { saver, calls, edit } = setup();
    edit();
    const p = saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    calls[0].reply.resolve(net());
    expect(await p).toBe(false);
    const p2 = saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    calls[1].reply.resolve(ok({ revision: 1 }));
    expect(await p2).toBe(true);
    expect(await saver.flush()).toBe(true);
  });

  it('reset 以服务端 revision 为准并清掉未保存标记（「重新加载」后恢复编辑）', async () => {
    const { saver, calls, edit, last } = setup();
    edit();
    await vi.advanceTimersByTimeAsync(800);
    calls[0].reply.resolve(http(409, 'REVISION_CONFLICT', { revision: 2 }));
    await vi.advanceTimersByTimeAsync(0);
    saver.reset(2);
    expect(last()).toMatchObject({ status: 'idle', dirty: false });
    edit();
    await vi.advanceTimersByTimeAsync(800);
    expect(calls[1].body.baseRevision).toBe(2);
  });
});

describe('刷新合并', () => {
  const canvas = (id: string, revision: number, name = id): Canvas =>
    ({ id, name, revision, createdAt: '', lastSaveId: null, viewport: { x: 0, y: 0, zoom: 1 }, cards: [], edges: [] });

  it('revision 不大于本地时不替换；更大时替换', () => {
    const plan = planMerge([{ id: 'a', revision: 3, busy: false }, { id: 'b', revision: 3, busy: false }],
      [canvas('a', 3), canvas('b', 4)], new Set());
    expect(plan.replaced.map(c => c.id)).toEqual(['b']);
  });
  it('有未保存改动的画布不被覆盖；「重新加载」的那张直接替换', () => {
    const local = [{ id: 'a', revision: 1, busy: true }, { id: 'b', revision: 5, busy: true }];
    const plan = planMerge(local, [canvas('a', 9), canvas('b', 5)], new Set(['b']));
    expect(plan.replaced.map(c => c.id)).toEqual(['b']);
  });
  it('服务端新增的加进来，已删除的移除，名称以服务端为准', () => {
    const plan = planMerge([{ id: 'a', revision: 1, busy: false }, { id: 'x', revision: 1, busy: true }],
      [canvas('a', 1, '新名字'), canvas('n', 0)], new Set());
    expect(plan.added.map(c => c.id)).toEqual(['n']);
    expect(plan.removed).toEqual(['x']);
    expect(plan.names.a).toBe('新名字');
    expect(plan.order).toEqual(['a', 'n']);
  });
  it('meta 比较', () => {
    const local = [{ id: 'a', name: 'A', revision: 1 }];
    expect(metaDiffers(local, [{ id: 'a', name: 'A', revision: 1 }])).toBe(false);
    expect(metaDiffers(local, [{ id: 'a', name: 'A', revision: 2 }])).toBe(true);
    expect(metaDiffers(local, [])).toBe(true);
  });

  it('过期响应被丢弃：只采用最后发出的那次', async () => {
    const replies: ReturnType<typeof deferred<ApiResult<State>>>[] = [];
    const applied: string[] = [];
    const ctl = new RefreshController({
      fetchState: () => { const d = deferred<ApiResult<State>>(); replies.push(d); return d.promise; },
      apply: s => applied.push(s.canvases[0].id)
    });
    const first = ctl.refresh();
    const second = ctl.refresh();
    replies[1].resolve(ok({ schemaVersion: 1, canvases: [canvas('new', 2)], icons: [], prefs: { lastCanvasId: null, minimapVisible: true }, notice: null }));
    replies[0].resolve(ok({ schemaVersion: 1, canvases: [canvas('old', 1)], icons: [], prefs: { lastCanvasId: null, minimapVisible: true }, notice: null }));
    expect(await second).toBe(true);
    expect(await first).toBe(false);
    expect(applied).toEqual(['new']);
  });

  it('刷新发出之后本页有写入成功：丢弃这次响应，再拉一次；force 保留到被采用', async () => {
    const replies: ReturnType<typeof deferred<ApiResult<State>>>[] = [];
    const applied: { id: string; force: string[] }[] = [];
    const ctl = new RefreshController({
      fetchState: () => { const d = deferred<ApiResult<State>>(); replies.push(d); return d.promise; },
      apply: (s, force) => applied.push({ id: s.canvases[0].id, force: [...force] })
    });
    const done = ctl.refresh('c1');
    ctl.noteWrite();
    replies[0].resolve(ok({ schemaVersion: 1, canvases: [canvas('stale', 1)], icons: [], prefs: { lastCanvasId: null, minimapVisible: true }, notice: null }));
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[1].resolve(ok({ schemaVersion: 1, canvases: [canvas('fresh', 2)], icons: [], prefs: { lastCanvasId: null, minimapVisible: true }, notice: null }));
    expect(await done).toBe(true);
    expect(applied).toEqual([{ id: 'fresh', force: ['c1'] }]);
  });
});

describe('导入结果未知后的核对', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(replies: ApiResult<ImportResult | { code: string }>[]) {
    const log: string[] = [];
    const tracker = new ImportTracker({
      query: async id => { log.push(`query:${id}`); return replies.shift()!; },
      onDone: r => log.push(`done:${r.canvasIds.join(',')}`),
      onNotFound: () => log.push('notfound')
    });
    tracker.setPending('imp');
    return { tracker, log };
  }

  it('200 按成功处理', async () => {
    const { tracker, log } = setup([ok({ canvasIds: ['c1'], iconsAdded: 0 })]);
    await tracker.verify();
    expect(log).toEqual(['query:imp', 'done:c1']);
    expect(tracker.pending).toBeNull();
  });
  it('202 每秒再查一次，直到有结果', async () => {
    const { tracker, log } = setup([ok({ code: 'IMPORT_IN_PROGRESS' }, 202), ok({ code: 'IMPORT_IN_PROGRESS' }, 202), ok({ canvasIds: ['c2'], iconsAdded: 1 })]);
    await tracker.verify();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(log).toEqual(['query:imp', 'query:imp', 'query:imp', 'done:c2']);
  });
  it('404 提示没有完成', async () => {
    const { tracker, log } = setup([http(404, 'IMPORT_NOT_FOUND')]);
    await tracker.verify();
    expect(log).toEqual(['query:imp', 'notfound']);
    expect(tracker.pending).toBeNull();
  });
  it('查询连不上时保持待确认，下次恢复再查', async () => {
    const { tracker, log } = setup([net(), ok({ canvasIds: ['c3'], iconsAdded: 0 })]);
    await tracker.verify();
    expect(tracker.pending).toBe('imp');
    await vi.advanceTimersByTimeAsync(5000);
    expect(log).toEqual(['query:imp']);
    await tracker.verify();
    expect(log).toEqual(['query:imp', 'query:imp', 'done:c3']);
  });
});

describe('视野和偏好设置的保存', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('停手 1 秒后发最新值，失败静默重试，404 停止', async () => {
    const sent: number[] = [];
    const replies: ApiResult<unknown>[] = [net(), ok(null, 204), http(404, 'CANVAS_NOT_FOUND')];
    const saver = new LatestSaver<number>(async v => { sent.push(v); return replies.shift()!; });
    saver.set(1); saver.set(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual([2]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([2, 2]);
    saver.set(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual([2, 2, 3]);
    saver.set(4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([2, 2, 3]);
  });
});
