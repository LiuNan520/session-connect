import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addCard, beginStep, confirmImport, finishCardField, finishEdgeLabel, redo, renameCanvas, setEdgeActivity, typeCardField,
  typeEdgeLabel, undo, uploadIcon, useApp, type CanvasDoc
} from './store';
import { emptyHistory } from './logic/history';
import type { Card, Edge } from '#shared';

function testDoc(id: string, name: string): CanvasDoc {
  return {
    id, name, createdAt: '2026-10-21T00:00:00.000Z', revision: 0, viewport: { x: 0, y: 0, zoom: 1 },
    content: { cards: [], edges: [] }, history: emptyHistory(), readOnly: false,
    save: { status: 'idle', dirty: false, inflight: false }
  };
}

function testCard(id: string, name: string): Card {
  return { id, x: 0, y: 0, iconId: 'claude-code', name, note: '', status: 'todo' };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const noContent = (): Response => new Response(null, { status: 204 });

const reset = () => useApp.setState({
  loaded: true, loadError: false, order: [], docs: {}, currentId: null, ghostId: null, icons: [],
  prefs: { lastCanvasId: null, minimapVisible: true }, notice: null,
  selection: { cardIds: [], edgeId: null }, focus: null, editingCanvasId: null, toast: null, dialog: null, menu: null,
  connecting: false, uploading: 0, importing: false, sidebarCollapsed: false
});

beforeEach(() => {
  // addCard 会先 blurActive；Node 里没有 DOM，给最小替身。
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
  reset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('新建卡片的聚焦请求', () => {
  it('切换画布清空 focus 后，下一次新建仍然产生新的聚焦编号', () => {
    const a = testDoc('a', 'A'), b = testDoc('b', 'B');
    useApp.setState({ docs: { a, b }, order: ['a', 'b'], currentId: 'a' });
    addCard({ x: 100, y: 100 }, false);
    const first = useApp.getState().focus;
    expect(first).toMatchObject({ field: 'name' });

    // switchTo 会清空 focus；编号不能跟着回到 1，否则 Panel 会把新请求当成已处理。
    useApp.setState({ currentId: 'b', focus: null });
    addCard({ x: 100, y: 100 }, false);
    const second = useApp.getState().focus;
    expect(second).toMatchObject({ field: 'name' });
    expect(second!.nonce).toBeGreaterThan(first!.nonce);
  });
});

describe('输入框失焦与弹窗打开', () => {
  it('导入确认框打开导致名称框失焦时，恢复编辑前的名称', () => {
    const id = 'c1', cardId = 'k1';
    const doc = testDoc(id, '画布');
    doc.content.cards = [testCard(cardId, '原名称')];
    useApp.setState({ docs: { [id]: doc }, order: [id], currentId: id, selection: { cardIds: [cardId], edgeId: null } });

    beginStep('input');
    typeCardField(cardId, 'name', '');
    expect(useApp.getState().docs[id].content.cards[0].name).toBe('');

    // 导入文件读完后确认框出现；原生 dialog 抢走焦点，名称框随之失焦。
    useApp.setState({ dialog: { kind: 'import', file: new File(['{}'], 'backup.json'), fileName: 'backup.json', canvases: 0, icons: 0 } });
    finishCardField(cardId, 'name');

    expect(useApp.getState().docs[id].content.cards[0].name).toBe('原名称');
    expect(useApp.getState().docs[id].history.transient).toBeNull();
  });
});

describe('连线活跃设置', () => {
  const id = 'c1', edgeId = 'e1';
  const edge = (): Edge | undefined => useApp.getState().docs[id].content.edges.find(e => e.id === edgeId);
  const undoLength = () => useApp.getState().docs[id].history.undo.length;
  function setup(readOnly = false) {
    const doc = testDoc(id, '画布');
    doc.readOnly = readOnly;
    doc.content.cards = [testCard('A', 'A'), testCard('B', 'B')];
    doc.content.edges = [{ id: edgeId, a: 'A', b: 'B', direction: 'forward', label: '', activity: 'follow' }];
    useApp.setState({ docs: { [id]: doc }, order: [id], currentId: id, selection: { cardIds: [], edgeId } });
  }

  it('切换算一步，撤销、重做能恢复', () => {
    setup();
    setEdgeActivity(edgeId, 'off');
    expect(edge()?.activity).toBe('off');
    expect(undoLength()).toBe(1);
    undo();
    expect(edge()?.activity).toBe('follow');
    redo();
    expect(edge()?.activity).toBe('off');
  });

  it('设成当前值：内容不变，不产生撤销步骤', () => {
    setup();
    const before = useApp.getState().docs[id].content;
    setEdgeActivity(edgeId, 'follow');
    expect(useApp.getState().docs[id].content).toBe(before);
    expect(undoLength()).toBe(0);
  });

  it('只读画布上不生效', () => {
    setup(true);
    setEdgeActivity(edgeId, 'off');
    expect(edge()?.activity).toBe('follow');
    expect(undoLength()).toBe(0);
  });

  it('文字输入框有焦点时切换：先保存文字，文字和活跃设置各算一步', () => {
    setup();
    // blurActive 让输入框失焦，触发它的 onBlur（finishEdgeLabel）。
    class Input { blur() { finishEdgeLabel(edgeId); } }
    vi.stubGlobal('HTMLElement', Input);
    vi.stubGlobal('document', { activeElement: new Input(), body: null });
    beginStep('input');
    typeEdgeLabel(edgeId, '审核 ');
    setEdgeActivity(edgeId, 'off');
    expect(edge()).toMatchObject({ label: '审核', activity: 'off' });
    expect(undoLength()).toBe(2);
    vi.stubGlobal('document', { activeElement: null });
    undo();
    expect(edge()).toMatchObject({ label: '审核', activity: 'follow' });
    undo();
    expect(edge()).toMatchObject({ label: '', activity: 'follow' });
  });
});

describe('上传图标在弹窗打开时完成', () => {
  it('原画布、原卡片仍选中时，上传成功仍应用图标', async () => {
    const id = 'c1', cardId = 'k1';
    const doc = testDoc(id, '画布');
    doc.content.cards = [testCard(cardId, '卡片')];
    useApp.setState({ docs: { [id]: doc }, order: [id], currentId: id, icons: [], selection: { cardIds: [cardId], edgeId: null } });

    const reply = deferred<Response>();
    const fetchMock = vi.fn(() => reply.promise);
    vi.stubGlobal('fetch', fetchMock);
    const upload = uploadIcon(new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'icon.svg', { type: 'image/svg+xml' }), cardId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // 上传在途时打开删除画布确认框；当前画布和选择都没有变化。
    useApp.setState({ dialog: { kind: 'deleteCanvas', canvasId: id, name: '画布', cards: 1, edges: 0 } });
    const icon = { id: 'u1', builtin: false, mime: 'image/svg+xml' as const, hash: 'h1', url: '/icons/u1' };
    reply.resolve(json(icon, 201));
    await upload;

    expect(useApp.getState().icons).toEqual([icon]);
    expect(useApp.getState().docs[id].content.cards[0].iconId).toBe('u1');
  });

  it('上传完成前切走或取消选中，只加入图标库，不改卡片', async () => {
    const id = 'c1', cardId = 'k1';
    const doc = testDoc(id, '画布');
    doc.content.cards = [testCard(cardId, '卡片')];
    useApp.setState({ docs: { [id]: doc }, order: [id], currentId: id, icons: [], selection: { cardIds: [cardId], edgeId: null } });

    const reply = deferred<Response>();
    const fetchMock = vi.fn(() => reply.promise);
    vi.stubGlobal('fetch', fetchMock);
    const upload = uploadIcon(new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'icon.svg', { type: 'image/svg+xml' }), cardId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    useApp.setState({ currentId: 'other', selection: { cardIds: [], edgeId: null } });
    const icon = { id: 'u2', builtin: false, mime: 'image/svg+xml' as const, hash: 'h2', url: '/icons/u2' };
    reply.resolve(json(icon, 201));
    await upload;

    expect(useApp.getState().icons).toEqual([icon]);
    expect(useApp.getState().docs[id].content.cards[0].iconId).toBe('claude-code');
  });

  it('上传完成前改选另一张卡片，只加入图标库，不改原卡片', async () => {
    const id = 'c1', cardId = 'k1', otherId = 'k2';
    const doc = testDoc(id, '画布');
    doc.content.cards = [testCard(cardId, '原卡片'), testCard(otherId, '另一张')];
    useApp.setState({ docs: { [id]: doc }, order: [id], currentId: id, icons: [], selection: { cardIds: [cardId], edgeId: null } });

    const reply = deferred<Response>();
    const fetchMock = vi.fn(() => reply.promise);
    vi.stubGlobal('fetch', fetchMock);
    const upload = uploadIcon(new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'icon.svg', { type: 'image/svg+xml' }), cardId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    useApp.setState({ selection: { cardIds: [otherId], edgeId: null } });
    const icon = { id: 'u3', builtin: false, mime: 'image/svg+xml' as const, hash: 'h3', url: '/icons/u3' };
    reply.resolve(json(icon, 201));
    await upload;

    expect(useApp.getState().icons).toEqual([icon]);
    expect(useApp.getState().docs[id].content.cards.find(c => c.id === cardId)?.iconId).toBe('claude-code');
    expect(useApp.getState().docs[id].content.cards.find(c => c.id === otherId)?.iconId).toBe('claude-code');
  });
});

describe('画布重命名', () => {
  it('同一张画布连续改名按顺序发请求，旧响应不会覆盖新名字', async () => {
    const id = 'c1';
    useApp.setState({ docs: { [id]: testDoc(id, '旧名') }, order: [id], currentId: id });
    const replies: ReturnType<typeof deferred<Response>>[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const reply = deferred<Response>();
        replies.push(reply);
        return reply.promise;
      }
      return Promise.reject(new Error(`unexpected ${init?.method} ${String(input)}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = renameCanvas(id, '改名一');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = renameCanvas(id, '改名二');
    // 第一次还没返回：第二次必须排队，不能同时发出去。
    await new Promise(r => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    replies[0].resolve(json({ id, name: '改名一' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(useApp.getState().docs[id].name).toBe('改名一');
    replies[1].resolve(json({ id, name: '改名二' }));
    await Promise.all([first, second]);
    expect(useApp.getState().docs[id].name).toBe('改名二');
  });

  it('写入失败时提示具体原因，名称保持原样', async () => {
    vi.useFakeTimers();
    const id = 'c1';
    useApp.setState({ docs: { [id]: testDoc(id, '旧名') }, order: [id], currentId: id });
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'WRITE_FAILED', message: '写入失败', reason: 'no_permission' }, 500)));

    await renameCanvas(id, '新名');
    expect(useApp.getState().docs[id].name).toBe('旧名');
    expect(useApp.getState().toast?.text).toBe('重命名失败：没有写入权限');
  });
});

describe('导入后的状态合并', () => {
  it('备份里没有画布、只有新图标时，导入后也刷新图标库', async () => {
    const icon = { id: 'uploaded-1', builtin: false, mime: 'image/svg+xml', hash: 'hash-1', url: '/icons/uploaded-1' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.endsWith('/api/health')) return json({ app: 'session-connect', version: '1.0.0', pid: 1, port: 4319 });
      if (method === 'POST' && url.endsWith('/api/import')) return json({ canvasIds: [], iconsAdded: 1 });
      if (method === 'GET' && url.endsWith('/api/state')) {
        return json({ schemaVersion: 1, canvases: [], icons: [icon], prefs: { lastCanvasId: null, minimapVisible: true }, notice: null });
      }
      if (method === 'POST' && /\/api\/imports\/[^/]+\/ack$/.test(url)) return noContent();
      return Promise.reject(new Error(`unexpected ${method} ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    await confirmImport(new File(['{"format":"session-connect-export"}'], 'backup.json', { type: 'application/json' }));

    expect(fetchMock.mock.calls.some(([input, init]) => (init?.method ?? 'GET') === 'GET' && String(input).endsWith('/api/state'))).toBe(true);
    expect(useApp.getState().icons).toEqual([icon]);
    expect(useApp.getState().importing).toBe(false);
  });
});
