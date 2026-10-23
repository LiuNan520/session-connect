import { create } from 'zustand';
import {
  MAX_ICON_BYTES, TEXT_LIMITS, normalizeText,
  type Canvas, type CanvasContent, type Card, type CardStatus, type Edge, type EdgeActivity, type EdgeDirection, type Icon,
  type IconMime, type ImportResult, type Notice, type Prefs, type State, type Viewport
} from '#shared';
import { OFFLINE_MESSAGE, isOnline, onConnectivity, request } from './api';
import { CanvasSaver, type SaverSnapshot } from './logic/saver';
import { LatestSaver } from './logic/latestSaver';
import { RefreshController, metaDiffers, planMerge } from './logic/refresh';
import { ImportTracker } from './logic/importTracker';
import { HEADER_BYTES, IMPORT_MESSAGES, analyzeImport, checkSize, isExportHeader } from './logic/importFile';
import { beginTransient, commit, emptyHistory, endTransient, redo as redoHistory, resetForReplace, undo as undoHistory, type History, type TransientKind } from './logic/history';
import { connect as connectRule } from './logic/edges';
import { nextCanvasName } from './logic/names';
import { avoidOverlap, type Point } from './logic/geometry';
import { clampChars } from './logic/text';

export const DEFAULT_ICON = 'claude-code';
export const CARD_DEFAULT_SIZE = { width: 180, height: 42 };
export const STATUS_LABELS: Record<CardStatus, string> = { todo: '未开始', doing: '进行中', done: '已完成', blocked: '卡住了' };
const REASON_LABELS = { disk_full: '磁盘已满', no_permission: '没有写入权限', other: '写入失败' } as const;
const ICON_TYPES: Record<string, IconMime> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };

export const uuid = (): string => crypto.randomUUID();

export interface CanvasDoc {
  id: string;
  name: string;
  createdAt: string;
  revision: number;
  viewport: Viewport;
  content: CanvasContent;
  history: History;
  readOnly: boolean;
  save: SaverSnapshot;
}

export interface Toast { id: number; text: string; action?: { label: string; run: () => void } }
export type Dialog =
  | { kind: 'deleteCanvas'; canvasId: string; name: string; cards: number; edges: number }
  | { kind: 'deleteIcon'; iconId: string; uses: number }
  | { kind: 'import'; file: File; fileName: string; canvases: number; icons: number }
  | { kind: 'canvasDeleted' };
export type Menu =
  | { kind: 'card'; x: number; y: number; cardId: string }
  | { kind: 'edge'; x: number; y: number; edgeId: string }
  | { kind: 'pane'; x: number; y: number; flow: Point }
  | { kind: 'more' }
  | { kind: 'canvasRow'; canvasId: string; x: number; y: number }
  | { kind: 'addEdge' };

export interface AppState {
  loaded: boolean;
  loadError: boolean;
  order: string[];
  docs: Record<string, CanvasDoc>;
  currentId: string | null;
  /** 当前画布在别的标签页被删除，等「知道了」后再切走。 */
  ghostId: string | null;
  icons: Icon[];
  prefs: Prefs;
  notice: Notice | null;
  selection: { cardIds: string[]; edgeId: string | null };
  focus: { field: 'name' | 'label'; nonce: number } | null;
  editingCanvasId: string | null;
  toast: Toast | null;
  dialog: Dialog | null;
  menu: Menu | null;
  connecting: boolean;
  uploading: number;
  importing: boolean;
  sidebarCollapsed: boolean;
}

export const useApp = create<AppState>(() => ({
  loaded: false, loadError: false, order: [], docs: {}, currentId: null, ghostId: null, icons: [],
  prefs: { lastCanvasId: null, minimapVisible: true }, notice: null,
  selection: { cardIds: [], edgeId: null }, focus: null, editingCanvasId: null, toast: null, dialog: null, menu: null,
  connecting: false, uploading: 0, importing: false, sidebarCollapsed: false
}));

const get = useApp.getState;
const set = useApp.setState;

// ---------------------------------------------------------------- 保存器
const savers = new Map<string, CanvasSaver>();
const viewportSavers = new Map<string, LatestSaver<Viewport>>();
const prefsSaver = new LatestSaver<Prefs>(prefs => request('PUT', '/api/prefs', { json: prefs }));
const pendingAcks = new Set<string>();

const refresher = new RefreshController({
  fetchState: () => request<State>('GET', '/api/state'),
  apply: (state, force) => applyState(state, force)
});

const importTracker = new ImportTracker({
  query: importId => request('GET', `/api/imports/${importId}`),
  onDone: (result, importId) => { void finishImport(result, importId, true); },
  onNotFound: () => showToast('导入没有完成，可以重新导入')
});

function patchDoc(id: string, patch: Partial<CanvasDoc> | ((doc: CanvasDoc) => Partial<CanvasDoc>)) {
  set(s => {
    const doc = s.docs[id];
    if (!doc) return {};
    const p = typeof patch === 'function' ? patch(doc) : patch;
    return { docs: { ...s.docs, [id]: { ...doc, ...p } } };
  });
}

/** 发给服务端的内容一律合法：去首尾空格、截断到上限；卡片名正在被清空时用编辑前的名称。 */
function sanitized(doc: CanvasDoc): CanvasContent {
  const before = doc.history.transient?.content;
  return {
    cards: doc.content.cards.map(card => {
      let name = clampChars(normalizeText(card.name), TEXT_LIMITS.cardName);
      if (!name) name = clampChars(normalizeText(before?.cards.find(c => c.id === card.id)?.name ?? ''), TEXT_LIMITS.cardName) || '新卡片';
      return { ...card, name, note: clampChars(normalizeText(card.note), TEXT_LIMITS.note) };
    }),
    edges: doc.content.edges.map(edge => ({ ...edge, label: clampChars(normalizeText(edge.label), TEXT_LIMITS.edgeLabel) }))
  };
}

function createSaver(id: string, revision: number): CanvasSaver {
  savers.get(id)?.stop();
  const saver = new CanvasSaver(revision, {
    put: body => request<{ revision: number }>('PUT', `/api/canvases/${id}/content`, { json: body }),
    getContent: () => sanitized(get().docs[id]),
    newId: uuid,
    onChange: snapshot => patchDoc(id, { save: snapshot }),
    onSaved: rev => { refresher.noteWrite(); patchDoc(id, { revision: rev }); },
    onConflict: () => {
      if (get().currentId === id) blurActive();
      patchDoc(id, doc => ({ readOnly: true, history: { ...doc.history, transient: null } }));
    },
    onDeleted: () => canvasGone(id)
  });
  savers.set(id, saver);
  return saver;
}

function viewportSaver(id: string): LatestSaver<Viewport> {
  let saver = viewportSavers.get(id);
  if (!saver) {
    saver = new LatestSaver<Viewport>(vp => request('PUT', `/api/canvases/${id}/viewport`, { json: vp }));
    viewportSavers.set(id, saver);
  }
  return saver;
}

function dropCanvasRuntime(id: string) {
  savers.get(id)?.stop();
  savers.delete(id);
  viewportSavers.get(id)?.stop();
  viewportSavers.delete(id);
}

function makeDoc(canvas: Canvas): CanvasDoc {
  const saver = createSaver(canvas.id, canvas.revision);
  return {
    id: canvas.id, name: canvas.name, createdAt: canvas.createdAt, revision: canvas.revision, viewport: canvas.viewport,
    content: { cards: canvas.cards, edges: canvas.edges }, history: emptyHistory(), readOnly: false, save: saver.snapshot()
  };
}

export function isBusy(id: string): boolean {
  const saver = savers.get(id);
  const doc = get().docs[id];
  return !!doc && (doc.readOnly || (saver?.busy ?? false));
}

function panelInputFocused(): boolean {
  const el = document.activeElement;
  return !!el && el instanceof HTMLInputElement && !!el.closest('.panel');
}

export function blurActive(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el !== document.body) el.blur();
}

// ---------------------------------------------------------------- 提示条与弹窗
let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function showToast(text: string, action?: Toast['action']): void {
  if (toastTimer) clearTimeout(toastTimer);
  const id = ++toastSeq;
  set({ toast: { id, text, action } });
  toastTimer = setTimeout(() => { if (get().toast?.id === id) set({ toast: null }); }, 5000);
}
export function hideToast(): void { set({ toast: null }); }
export function closeDialog(): void {
  const dialog = get().dialog;
  set({ dialog: null });
  if (dialog?.kind === 'canvasDeleted') leaveGhost();
}
export function openMenu(menu: Menu | null): void { set({ menu }); }

// ---------------------------------------------------------------- 载入、刷新与合并
let started = false;
export async function init(): Promise<void> {
  const result = await request<State>('GET', '/api/state');
  if (!result.ok) { set({ loadError: true }); setTimeout(() => { void init(); }, 5000); return; }
  const state = result.data;
  const docs: Record<string, CanvasDoc> = {};
  for (const canvas of state.canvases) docs[canvas.id] = makeDoc(canvas);
  const order = state.canvases.map(c => c.id);
  const currentId = state.prefs.lastCanvasId && docs[state.prefs.lastCanvasId] ? state.prefs.lastCanvasId : order[0] ?? null;
  set({ loaded: true, loadError: false, docs, order, currentId, icons: state.icons, prefs: state.prefs, notice: state.notice });
  if (!started) startListeners();
}

function startListeners() {
  started = true;
  const check = () => { if (document.visibilityState === 'visible') void checkRemote(); };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  window.addEventListener('beforeunload', event => {
    const unsaved = [...savers.values()].some(s => s.busy && !s.halted);
    if (unsaved) { event.preventDefault(); event.returnValue = ''; }
  });
  onConnectivity(online => {
    if (!online) return;
    // 服务恢复：重新核对（含没收到回复的新建、改名、删除），核对导入，补发 ack。
    void refresher.refresh();
    void importTracker.verify();
    for (const id of [...pendingAcks]) void ackImport(id);
  });
}

let lastCheck = 0;
/** 切回标签页：先比 meta，有变化再拉全量。 */
async function checkRemote() {
  const now = Date.now();
  if (now - lastCheck < 300) return;
  lastCheck = now;
  const result = await request<{ id: string; name: string; revision: number }[]>('GET', '/api/canvases/meta');
  if (!result.ok) return;
  const s = get();
  const local = s.order.map(id => ({ id, name: s.docs[id].name, revision: savers.get(id)?.revision ?? s.docs[id].revision }));
  if (metaDiffers(local, result.data)) await refresher.refresh();
}

function applyState(state: State, force: ReadonlySet<string>) {
  const s = get();
  const local = s.order.map(id => ({ id, revision: savers.get(id)?.revision ?? s.docs[id].revision, busy: isBusy(id) }));
  const plan = planMerge(local, state.canvases, force);
  const docs: Record<string, CanvasDoc> = {};
  const replaced = new Map(plan.replaced.map(c => [c.id, c]));
  const added = new Map(plan.added.map(c => [c.id, c]));
  const inputFocused = panelInputFocused();
  for (const id of plan.order) {
    const fresh = added.get(id);
    if (fresh) { docs[id] = makeDoc(fresh); continue; }
    const doc = s.docs[id];
    const canvas = replaced.get(id);
    if (canvas) {
      const content = { cards: canvas.cards, edges: canvas.edges };
      savers.get(id)?.reset(canvas.revision);
      docs[id] = {
        ...doc, name: canvas.name, revision: canvas.revision, content, readOnly: false,
        history: resetForReplace(doc.history, content, inputFocused && id === s.currentId),
        save: savers.get(id)!.snapshot()
      };
    } else {
      docs[id] = doc.name === plan.names[id] ? doc : { ...doc, name: plan.names[id] };
    }
  }
  let { currentId, ghostId, dialog, selection } = s;
  if (ghostId && s.docs[ghostId]) docs[ghostId] = s.docs[ghostId];
  for (const id of plan.removed) {
    dropCanvasRuntime(id);
    if (id === s.currentId) {
      // 当前画布在别处被删除：先保留只读显示，点「知道了」后切到第一张。
      blurActive();
      docs[id] = { ...s.docs[id], readOnly: true };
      ghostId = id;
      dialog = { kind: 'canvasDeleted' };
    }
  }
  if (currentId && replaced.has(currentId)) selection = pruneSelection(selection, docs[currentId].content);
  set({ docs, order: plan.order, icons: state.icons, currentId, ghostId, dialog, selection });
}

function pruneSelection(selection: AppState['selection'], content: CanvasContent): AppState['selection'] {
  const cardIds = selection.cardIds.filter(id => content.cards.some(c => c.id === id));
  const edgeId = selection.edgeId && content.edges.some(e => e.id === selection.edgeId) ? selection.edgeId : null;
  return { cardIds, edgeId };
}

/** 保存时发现画布已被删除（404）。 */
function canvasGone(id: string) {
  const s = get();
  dropCanvasRuntime(id);
  if (s.currentId === id) {
    blurActive();
    set({ order: s.order.filter(x => x !== id), ghostId: id, dialog: { kind: 'canvasDeleted' }, docs: { ...s.docs, [id]: { ...s.docs[id], readOnly: true } } });
  } else {
    const docs = { ...s.docs };
    delete docs[id];
    set({ order: s.order.filter(x => x !== id), docs });
  }
}

function leaveGhost() {
  const s = get();
  if (!s.ghostId) return;
  const docs = { ...s.docs };
  delete docs[s.ghostId];
  set({ docs, ghostId: null });
  switchTo(get().order[0] ?? null);
}

/** 「重新加载」：直接用服务端内容替换这张画布。 */
export async function reloadCanvas(id: string): Promise<void> {
  const ok = await refresher.refresh(id);
  if (!ok && !isOnline()) showToast(OFFLINE_MESSAGE);
}

export function ackNotice(): void {
  set({ notice: null });
  void request('POST', '/api/notice/ack');
}

// ---------------------------------------------------------------- 画布列表
function switchTo(id: string | null) {
  set({ currentId: id, selection: { cardIds: [], edgeId: null }, focus: null, menu: null, editingCanvasId: null });
  savePrefs({ lastCanvasId: id });
}

export function savePrefs(patch: Partial<Prefs>): void {
  const prefs = { ...get().prefs, ...patch };
  set({ prefs });
  prefsSaver.set(prefs);
}

export function selectCanvas(id: string): void {
  const s = get();
  if (s.ghostId) return;
  blurActive();
  if (id !== s.currentId) switchTo(id);
  // 被拒的画布切回来时载入最新内容（PRD 12.4）。
  if (get().docs[id]?.save.status === 'conflict') void reloadCanvas(id);
}

let creating = false;
export async function createCanvas(): Promise<void> {
  if (creating) return;
  creating = true;
  try {
    blurActive();
    const s = get();
    const id = uuid();
    const name = nextCanvasName(s.order.map(x => s.docs[x].name));
    const result = await request<Canvas>('POST', '/api/canvases', { json: { id, name } });
    if (!result.ok) { showToast(result.kind === 'network' ? OFFLINE_MESSAGE : '新建画布失败'); return; }
    refresher.noteWrite();
    if (!get().docs[id]) set(st => ({ docs: { ...st.docs, [id]: makeDoc(result.data) }, order: [...st.order, id] }));
    switchTo(id);
    set({ editingCanvasId: id });
  } finally { creating = false; }
}

export function startRename(id: string): void { set({ editingCanvasId: id, menu: null }); }
export function endRename(): void { set({ editingCanvasId: null }); }

const renameQueues = new Map<string, Promise<void>>();

/** 同一张画布的重命名串行执行：上一次有明确结果后才发下一次，避免旧响应覆盖新名字。 */
function queueRename(id: string, run: () => Promise<void>): Promise<void> {
  const previous = renameQueues.get(id) ?? Promise.resolve();
  const next = previous.then(run);
  const tail = next.catch(() => { showToast('重命名失败，请重试'); });
  renameQueues.set(id, tail);
  void tail.then(() => { if (renameQueues.get(id) === tail) renameQueues.delete(id); });
  return tail;
}

export function renameCanvas(id: string, raw: string): Promise<void> {
  set({ editingCanvasId: null });
  if (!get().docs[id]) return Promise.resolve();
  const name = normalizeText(raw);
  if (!name) { showToast('名称不能为空'); return Promise.resolve(); }
  return queueRename(id, async () => {
    const doc = get().docs[id];
    // 排队期间可能已经被上一次改名、别处刷新或删除处理掉了。
    if (!doc || name === doc.name) return;
    const result = await request<{ id: string; name: string }>('PATCH', `/api/canvases/${id}`, { json: { name } });
    if (result.ok) { refresher.noteWrite(); patchDoc(id, { name: result.data.name }); return; }
    if (result.kind === 'network') { showToast(OFFLINE_MESSAGE); return; }
    if (result.error.code === 'INVALID_NAME') { showToast('名称不能为空'); return; }
    if (result.status === 404) { void refresher.refresh(); return; }
    if (result.error.code === 'WRITE_FAILED') { showToast(`重命名失败：${REASON_LABELS[result.error.reason ?? 'other']}`); return; }
    showToast('重命名失败，请重试');
  });
}

export function askDeleteCanvas(id: string): void {
  const doc = get().docs[id];
  if (!doc) return;
  blurActive();
  set({ menu: null, dialog: { kind: 'deleteCanvas', canvasId: id, name: doc.name, cards: doc.content.cards.length, edges: doc.content.edges.length } });
}

export async function deleteCanvas(id: string): Promise<void> {
  set({ dialog: null });
  const result = await request('DELETE', `/api/canvases/${id}`);
  if (!result.ok) { showToast(result.kind === 'network' ? OFFLINE_MESSAGE : '删除画布失败'); return; }
  refresher.noteWrite();
  const s = get();
  const index = s.order.indexOf(id);
  if (index < 0) return;
  const order = s.order.filter(x => x !== id);
  const docs = { ...s.docs };
  delete docs[id];
  dropCanvasRuntime(id);
  set({ order, docs });
  if (s.currentId === id) switchTo(s.order[index - 1] ?? s.order[index + 1] ?? null);
}

// ---------------------------------------------------------------- 卡片与连线（当前画布）
export function currentDoc(): CanvasDoc | null {
  const s = get();
  return s.currentId ? s.docs[s.currentId] ?? null : null;
}

/**
 * 改当前画布内容。commitStep=true 时算一步撤销。只读时不生效。
 * 不在这里按"弹窗打开"拦截：弹窗打开会让输入框失焦，失焦收尾（恢复空名称、提交输入）
 * 和上传等已启动的异步任务必须能落地；背景交互由原生 modal dialog（inert + 焦点循环）限制。
 */
function edit(fn: (content: CanvasContent) => CanvasContent, commitStep: boolean): boolean {
  const doc = currentDoc();
  if (!doc || doc.readOnly) return false;
  const before = doc.content;
  const after = fn(before);
  if (after === before) return false;
  patchDoc(doc.id, { content: after, history: commitStep ? commit(doc.history, before) : doc.history });
  savers.get(doc.id)?.changed();
  return true;
}

export function beginStep(kind: TransientKind): void {
  const doc = currentDoc();
  if (!doc || doc.readOnly) return;
  patchDoc(doc.id, { history: beginTransient(doc.history, kind, doc.content) });
}
export function endStep(): void {
  const doc = currentDoc();
  if (!doc) return;
  patchDoc(doc.id, { history: endTransient(doc.history, doc.content) });
}

export function canUndo(doc: CanvasDoc | null): boolean {
  return !!doc && !doc.readOnly && doc.history.transient?.kind !== 'drag' && doc.history.undo.length > 0;
}
export function canRedo(doc: CanvasDoc | null): boolean {
  return !!doc && !doc.readOnly && doc.history.transient?.kind !== 'drag' && doc.history.redo.length > 0;
}

function applyHistory(result: { history: History; content: CanvasContent } | null) {
  const doc = currentDoc();
  if (!doc || !result) return;
  patchDoc(doc.id, { content: result.content, history: result.history });
  set(s => ({ selection: pruneSelection(s.selection, result.content) }));
  savers.get(doc.id)?.changed();
}
export function undo(): void {
  blurActive();
  const doc = currentDoc();
  if (canUndo(doc)) applyHistory(undoHistory(doc!.history, doc!.content));
}
export function redo(): void {
  blurActive();
  const doc = currentDoc();
  if (canRedo(doc)) applyHistory(redoHistory(doc!.history, doc!.content));
}

/** 新建卡片：point 是卡片中心在画布上的位置。 */
export function addCard(point: Point, avoid: boolean): void {
  blurActive();
  const doc = currentDoc();
  if (!doc || doc.readOnly) return;
  let position = { x: Math.round(point.x - CARD_DEFAULT_SIZE.width / 2), y: Math.round(point.y - CARD_DEFAULT_SIZE.height / 2) };
  if (avoid) position = avoidOverlap(position, doc.content.cards);
  const card: Card = { id: uuid(), ...position, iconId: DEFAULT_ICON, name: '新卡片', note: '', status: 'todo' };
  if (edit(c => ({ ...c, cards: [...c.cards, card] }), true)) {
    set({ selection: { cardIds: [card.id], edgeId: null }, menu: null });
    requestFocus('name');
  }
}

export function duplicateCards(ids: string[]): void {
  blurActive();
  const doc = currentDoc();
  if (!doc || ids.length === 0) return;
  const copies = doc.content.cards.filter(c => ids.includes(c.id)).map(c => ({ ...c, id: uuid(), x: c.x + 24, y: c.y + 24 }));
  if (copies.length && edit(c => ({ ...c, cards: [...c.cards, ...copies] }), true)) {
    set({ selection: { cardIds: copies.map(c => c.id), edgeId: null }, menu: null });
  }
}

function undoToast(text: string) {
  const doc = currentDoc();
  if (!doc) return;
  const entry = doc.history.undo[doc.history.undo.length - 1];
  const canvasId = doc.id;
  showToast(text, {
    label: '撤销',
    run: () => {
      const d = currentDoc();
      hideToast();
      if (d && d.id === canvasId && d.history.undo[d.history.undo.length - 1] === entry) undo();
    }
  });
}

export function deleteCards(ids: string[]): void {
  blurActive();
  const remove = new Set(ids);
  const doc = currentDoc();
  const count = doc?.content.cards.filter(c => remove.has(c.id)).length ?? 0;
  if (!count) return;
  const done = edit(c => ({ cards: c.cards.filter(x => !remove.has(x.id)), edges: c.edges.filter(e => !remove.has(e.a) && !remove.has(e.b)) }), true);
  if (!done) return;
  set({ selection: { cardIds: [], edgeId: null }, menu: null });
  undoToast(`已删除 ${count} 张卡片`);
}

export function deleteEdge(id: string): void {
  blurActive();
  const done = edit(c => (c.edges.some(e => e.id === id) ? { ...c, edges: c.edges.filter(e => e.id !== id) } : c), true);
  if (!done) return;
  set(s => ({ selection: s.selection.edgeId === id ? { cardIds: [], edgeId: null } : s.selection, menu: null }));
  undoToast('已删除连线');
}

export function deleteSelection(): void {
  const { selection } = get();
  if (selection.edgeId) deleteEdge(selection.edgeId);
  else if (selection.cardIds.length) deleteCards(selection.cardIds);
}

function updateCard(id: string, patch: Partial<Card>, commitStep: boolean) {
  return edit(c => {
    const index = c.cards.findIndex(x => x.id === id);
    if (index < 0) return c;
    const cards = c.cards.slice();
    cards[index] = { ...cards[index], ...patch };
    return { ...c, cards };
  }, commitStep);
}

/** 输入过程中实时改（不单独算一步，失焦时由 endStep 合并提交）。 */
export function typeCardField(id: string, field: 'name' | 'note', value: string): void { updateCard(id, { [field]: value }, false); }
export function typeEdgeLabel(id: string, value: string): void {
  edit(c => ({ ...c, edges: c.edges.map(e => (e.id === id ? { ...e, label: value } : e)) }), false);
}

/** 输入框失焦：去首尾空格；名称为空时恢复为这次编辑前的名称并提示。然后结束这一步。 */
export function finishCardField(id: string, field: 'name' | 'note'): void {
  const doc = currentDoc();
  const card = doc?.content.cards.find(c => c.id === id);
  if (doc && card && !doc.readOnly) {
    const value = normalizeText(card[field]);
    if (field === 'name' && !value) {
      const before = doc.history.transient?.content.cards.find(c => c.id === id)?.name;
      updateCard(id, { name: before && normalizeText(before) ? before : '新卡片' }, false);
      showToast('名称不能为空');
    } else if (value !== card[field]) {
      updateCard(id, { [field]: value }, false);
    }
  }
  endStep();
}
export function finishEdgeLabel(id: string): void {
  const doc = currentDoc();
  const edge = doc?.content.edges.find(e => e.id === id);
  if (doc && edge && !doc.readOnly) {
    const value = normalizeText(edge.label);
    if (value !== edge.label) typeEdgeLabel(id, value);
  }
  endStep();
}

export function setCardIcon(id: string, iconId: string): void { updateCard(id, { iconId }, true); }

export function setStatus(ids: string[], status: CardStatus): void {
  blurActive();
  const target = new Set(ids);
  edit(c => {
    if (!c.cards.some(x => target.has(x.id) && x.status !== status)) return c;
    return { ...c, cards: c.cards.map(x => (target.has(x.id) ? { ...x, status } : x)) };
  }, true);
}

/** 拖动中更新位置（拖动开始 beginStep('drag')，结束 endStep()）。 */
export function moveCards(positions: Map<string, Point>): void {
  edit(c => ({ ...c, cards: c.cards.map(x => { const p = positions.get(x.id); return p ? { ...x, x: p.x, y: p.y } : x; }) }), false);
}

/** 从连接点拖到另一张卡片。 */
export function connectCards(from: string, to: string): void {
  const doc = currentDoc();
  if (!doc || doc.readOnly || !doc.content.cards.some(c => c.id === to)) return;
  const result = connectRule(doc.content.edges, from, to, uuid);
  if (result.kind === 'exists') { showToast('这两张卡片已经连着了'); return; }
  if (result.kind === 'invalid') return;
  edit(c => ({ ...c, edges: result.edges }), true);
  if (result.kind === 'merged') showToast('已改为双向连线');
}

/** 设置面板「+ 添加连线」：创建 本卡片 → 对方。 */
export function addEdgeFromPanel(from: string, to: string): void {
  blurActive();
  const doc = currentDoc();
  if (!doc) return;
  const result = connectRule(doc.content.edges, from, to, uuid);
  if (result.kind === 'created') edit(c => ({ ...c, edges: result.edges }), true);
  set({ menu: null });
}

export function setEdgeDirection(id: string, direction: EdgeDirection): void {
  blurActive();
  edit(c => {
    const edge = c.edges.find(e => e.id === id);
    if (!edge || edge.direction === direction) return c;
    return { ...c, edges: c.edges.map(e => (e.id === id ? { ...e, direction } : e)) };
  }, true);
}

export function setEdgeActivity(id: string, activity: EdgeActivity): void {
  blurActive();
  edit(c => {
    const edge = c.edges.find(e => e.id === id);
    if (!edge || edge.activity === activity) return c;
    return { ...c, edges: c.edges.map(e => (e.id === id ? { ...e, activity } : e)) };
  }, true);
}

// ---------------------------------------------------------------- 拖连线
let connectionCanceller: (() => void) | null = null;
export function registerConnectionCanceller(fn: (() => void) | null): void { connectionCanceller = fn; }
export function setConnecting(connecting: boolean): void { set({ connecting }); }
/** 拖连线途中按 Esc：取消这次拖动。 */
export function cancelConnection(): void { connectionCanceller?.(); }

// ---------------------------------------------------------------- 选择
// 聚焦请求的编号只增不减；切换画布会清空 focus，但编号不能跟着回到 1，否则新请求会被当成已处理。
let focusSeq = 0;
function requestFocus(field: 'name' | 'label') {
  set({ focus: { field, nonce: ++focusSeq } });
}
export function selectCards(ids: string[], focusName = false): void {
  blurActive();
  set({ selection: { cardIds: ids, edgeId: null }, menu: null });
  if (focusName) requestFocus('name');
}
export function toggleCard(id: string): void {
  blurActive();
  set(s => {
    const has = s.selection.cardIds.includes(id);
    return { selection: { cardIds: has ? s.selection.cardIds.filter(x => x !== id) : [...s.selection.cardIds, id], edgeId: null } };
  });
}
export function selectEdge(id: string, focusLabel = false): void {
  blurActive();
  set({ selection: { cardIds: [], edgeId: id }, menu: null });
  if (focusLabel) requestFocus('label');
}
export function clearSelection(): void {
  blurActive();
  set({ selection: { cardIds: [], edgeId: null }, menu: null });
}
export function selectAll(): void {
  const doc = currentDoc();
  if (!doc) return;
  set({ selection: { cardIds: doc.content.cards.map(c => c.id), edgeId: null } });
}

// ---------------------------------------------------------------- 视野与偏好
export function setViewport(id: string, viewport: Viewport): void {
  const zoom = Math.min(2, Math.max(0.1, viewport.zoom));
  if (![viewport.x, viewport.y, zoom].every(Number.isFinite)) return;
  const value = { x: viewport.x, y: viewport.y, zoom };
  const doc = get().docs[id];
  if (!doc || get().ghostId === id) return;
  const old = doc.viewport;
  if (old.x === value.x && old.y === value.y && old.zoom === value.zoom) return;
  patchDoc(id, { viewport: value });
  viewportSaver(id).set(value);
}

// ---------------------------------------------------------------- 图标
function iconMime(file: File): IconMime | null {
  if (Object.values(ICON_TYPES).includes(file.type as IconMime)) return file.type as IconMime;
  if (file.type) return null;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return ICON_TYPES[ext] ?? null;
}

export async function uploadIcon(file: File, forCardId: string | null): Promise<void> {
  const mime = iconMime(file);
  if (!mime) { showToast('只支持 PNG、JPG、WebP、SVG 图片'); return; }
  if (file.size > MAX_ICON_BYTES) { showToast('图片不能超过 1 MB'); return; }
  set(s => ({ uploading: s.uploading + 1 }));
  const canvasId = get().currentId;
  try {
    const result = await request<Icon>('POST', '/api/icons', { body: file, headers: { 'Content-Type': mime } });
    if (!result.ok) {
      if (result.kind === 'network') showToast(OFFLINE_MESSAGE);
      else if (result.status === 415) showToast('只支持 PNG、JPG、WebP、SVG 图片');
      else if (result.status === 413) showToast('图片不能超过 1 MB');
      else showToast('图片读不出来，换一张试试');
      return;
    }
    refresher.noteWrite();
    const icon = result.data;
    set(s => ({ icons: s.icons.some(i => i.id === icon.id) ? s.icons : [...s.icons, icon] }));
    // 上传完成时这张卡片仍是选中状态才用到它上面（PRD 10.2）。
    const s = get();
    if (forCardId && s.currentId === canvasId && s.selection.cardIds.length === 1 && s.selection.cardIds[0] === forCardId) {
      setCardIcon(forCardId, icon.id);
    }
  } finally {
    set(s => ({ uploading: s.uploading - 1 }));
  }
}

export function iconUses(iconId: string): number {
  const s = get();
  let n = 0;
  for (const id of s.order) for (const card of s.docs[id].content.cards) if (card.iconId === iconId) n++;
  return n;
}

export function askDeleteIcon(iconId: string): void {
  blurActive();
  set({ dialog: { kind: 'deleteIcon', iconId, uses: iconUses(iconId) } });
}

export async function deleteIcon(iconId: string): Promise<void> {
  set({ dialog: null });
  const result = await request('DELETE', `/api/icons/${iconId}`);
  if (!result.ok) { showToast(result.kind === 'network' ? OFFLINE_MESSAGE : '删除图标失败'); return; }
  refresher.noteWrite();
  set(s => ({ icons: s.icons.filter(i => i.id !== iconId) }));
}

// ---------------------------------------------------------------- 导出
let exporting = false;
export async function exportAll(): Promise<void> {
  if (exporting) return;
  exporting = true;
  set({ menu: null });
  try {
    blurActive();
    const pending = [...savers.values()].filter(s => s.busy && !s.halted);
    const results = await Promise.all(pending.map(s => s.flush()));
    if (results.some(ok => !ok)) { showToast('有改动还没保存上，暂时不能导出'); return; }
    const result = await request<Blob>('GET', '/api/export', { parse: 'blob', timeoutMs: 0 });
    if (!result.ok) { showToast(result.kind === 'network' ? OFFLINE_MESSAGE : '导出失败'); return; }
    const disposition = result.headers.get('Content-Disposition') ?? '';
    const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const name = match ? decodeURIComponent(match[1]) : '会话连接-备份.json';
    const url = URL.createObjectURL(result.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } finally { exporting = false; }
}

// ---------------------------------------------------------------- 导入
export async function pickImportFile(file: File): Promise<void> {
  set({ menu: null });
  const tooLarge = checkSize(file.size);
  if (tooLarge && !tooLarge.ok) { showToast(IMPORT_MESSAGES.too_large); return; }
  let head: string;
  try { head = await file.slice(0, HEADER_BYTES).text(); } catch { showToast(IMPORT_MESSAGES.invalid); return; }
  if (!isExportHeader(head)) { showToast(IMPORT_MESSAGES.invalid); return; }
  let text: string;
  try { text = await file.text(); } catch { showToast(IMPORT_MESSAGES.invalid); return; }
  const check = analyzeImport(text, new Set(get().icons.map(i => i.hash)));
  if (!check.ok) { showToast(IMPORT_MESSAGES[check.reason]); return; }
  // 确认框会抢走焦点；先让正在编辑的输入框按"点别处"的规则收尾，再打开弹窗。
  blurActive();
  set({ dialog: { kind: 'import', file, fileName: file.name, canvases: check.canvases, icons: check.icons } });
}

export async function confirmImport(file: File): Promise<void> {
  set({ dialog: null });
  if (get().importing) return;
  const health = await request('GET', '/api/health');
  if (!health.ok) { showToast(OFFLINE_MESSAGE); return; }
  const importId = uuid();
  set({ importing: true });
  try {
    // 不设前端超时：只有连接断开才进入"结果未知"。
    const result = await request<ImportResult>('POST', '/api/import', {
      body: file, headers: { 'Content-Type': 'application/json', 'X-Import-Id': importId }, timeoutMs: 0
    });
    if (result.ok) { refresher.noteWrite(); await finishImport(result.data, importId, false); return; }
    if (result.kind === 'network') {
      importTracker.setPending(importId);
      showToast('连不上本地服务，导入结果待确认；重新打开会话连接后会自动核对');
      return;
    }
    const code = result.error.code;
    showToast(code === 'NEWER_VERSION' ? IMPORT_MESSAGES.newer : result.status === 413 ? IMPORT_MESSAGES.too_large : IMPORT_MESSAGES.invalid);
  } finally { set({ importing: false }); }
}

async function finishImport(result: ImportResult, importId: string, verified: boolean) {
  const first = result.canvasIds[0];
  // 导入可能只新增图标（备份里没有画布），所以不管有没有新画布都刷新合并一次，图标库才会更新。
  for (let i = 0; i < 3; i++) {
    if (await refresher.refresh()) break;
  }
  if (first && get().docs[first]) selectCanvas(first);
  if (verified) showToast('导入已完成');
  void ackImport(importId);
}

async function ackImport(importId: string) {
  pendingAcks.add(importId);
  const result = await request('POST', `/api/imports/${importId}/ack`);
  if (result.ok) pendingAcks.delete(importId);
}

// ---------------------------------------------------------------- 状态显示
export function saveLabel(doc: CanvasDoc | null): { text: string; error: boolean; reload: boolean } | null {
  if (!doc) return null;
  const { save } = doc;
  if (save.status === 'conflict') return { text: '这张画布在别的标签页改过了', error: true, reload: true };
  if (save.status === 'offline') return { text: '未保存：连不上本地服务，正在重试', error: true, reload: false };
  if (save.status === 'failed') return { text: `未保存：${REASON_LABELS[save.reason ?? 'other']}，正在重试`, error: true, reload: false };
  if (save.dirty || save.inflight) return { text: '保存中…', error: false, reload: false };
  return { text: '已保存', error: false, reload: false };
}

export function iconUrl(icons: Icon[], iconId: string): string {
  return icons.find(i => i.id === iconId)?.url ?? `/icons/${DEFAULT_ICON}`;
}

