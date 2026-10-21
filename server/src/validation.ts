import {
  BUILTIN_ICON_IDS, DIRECTION_VALUES, STATUS_VALUES, TEXT_LIMITS, countChars, normalizeText,
  type Canvas, type CanvasContent, type DataFile, type IconExt, type IconMime, type Viewport
} from '#shared';
import { ApiError } from './errors.js';

export const MIME_EXT: Record<IconMime, IconExt> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg'
};
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('必须是对象');
  return value as Record<string, unknown>;
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('id 不能为空');
  return value;
}
export function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export function text(value: unknown, max: number, min = 0): string {
  if (typeof value !== 'string') throw new Error('文字必须是字符串');
  const normalized = normalizeText(value);
  const length = countChars(normalized);
  if (length < min || length > max) throw new Error(`文字长度应为 ${min}–${max} 个字`);
  return normalized;
}
export function canvasName(value: unknown): string {
  try { return text(value, TEXT_LIMITS.canvasName, 1); }
  catch { throw new ApiError(400, 'INVALID_NAME', '名称不能为空且不能超过 30 个字'); }
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('坐标必须是有限数');
  return value;
}
export function viewport(value: unknown): Viewport {
  const v = object(value);
  const zoom = finite(v.zoom);
  if (zoom < 0.1 || zoom > 2) throw new Error('缩放范围为 10%–200%');
  return { x: finite(v.x), y: finite(v.y), zoom };
}
export function content(value: unknown): CanvasContent {
  const v = object(value);
  if (!Array.isArray(v.cards) || !Array.isArray(v.edges)) throw new Error('cards 和 edges 必须是数组');
  const used = new Set<string>();
  const cardIds = new Set<string>();
  const unique = (value: unknown) => {
    const key = id(value);
    if (used.has(key)) throw new Error('卡片或连线 id 重复');
    used.add(key);
    return key;
  };
  const cards = v.cards.map(value => {
    const card = object(value);
    const key = unique(card.id);
    cardIds.add(key);
    if (!STATUS_VALUES.includes(card.status as any)) throw new Error('卡片状态不合法');
    return { id: key, x: finite(card.x), y: finite(card.y), iconId: id(card.iconId),
      name: text(card.name, TEXT_LIMITS.cardName, 1), note: text(card.note, TEXT_LIMITS.note),
      status: card.status as typeof STATUS_VALUES[number] };
  });
  const pairs = new Map<string, Set<string>>();
  const edges = v.edges.map(value => {
    const edge = object(value);
    const key = unique(edge.id);
    const a = id(edge.a), b = id(edge.b);
    if (a === b || !cardIds.has(a) || !cardIds.has(b)) throw new Error('连线两端必须是不同且存在的卡片');
    const [left, right] = [a, b].sort();
    const peers = pairs.get(left) ?? new Set<string>();
    if (peers.has(right)) throw new Error('同一对卡片最多一条连线');
    peers.add(right); pairs.set(left, peers);
    if (!DIRECTION_VALUES.includes(edge.direction as any)) throw new Error('连线方向不合法');
    return { id: key, a, b, direction: edge.direction as typeof DIRECTION_VALUES[number], label: text(edge.label, TEXT_LIMITS.edgeLabel) };
  });
  return { cards, edges };
}
export function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('日期不合法');
  return value;
}
export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('必须是非负整数');
  return value;
}
export function canvas(value: unknown): Canvas {
  const v = object(value);
  return { id: id(v.id), name: text(v.name, TEXT_LIMITS.canvasName, 1), createdAt: timestamp(v.createdAt),
    revision: integer(v.revision), lastSaveId: v.lastSaveId === null ? null : id(v.lastSaveId),
    viewport: viewport(v.viewport), ...content(v) };
}
function uniqueIds<T>(values: T[], get: (value: T) => string): void {
  if (new Set(values.map(get)).size !== values.length) throw new Error('id 重复');
}
export function dataFile(value: unknown): DataFile {
  const v = object(value);
  if (v.schemaVersion !== 1) throw new Error('不支持的数据版本');
  const p = object(v.prefs);
  if (typeof p.minimapVisible !== 'boolean') throw new Error('偏好设置无效');
  if (!Array.isArray(v.canvases) || !Array.isArray(v.icons) || !Array.isArray(v.imports)) throw new Error('数据结构不完整');
  const canvases = v.canvases.map(canvas);
  const icons = v.icons.map(value => {
    const icon = object(value);
    if (!uuid(icon.id) || (BUILTIN_ICON_IDS as readonly unknown[]).includes(icon.id)) throw new Error('图标 id 不合法');
    if (typeof icon.mime !== 'string' || !Object.hasOwn(MIME_EXT, icon.mime) || MIME_EXT[icon.mime as IconMime] !== icon.ext) throw new Error('图标类型不合法');
    if (typeof icon.hash !== 'string' || !/^[a-f0-9]{64}$/.test(icon.hash)) throw new Error('hash 不合法');
    return { id: icon.id, mime: icon.mime as IconMime, ext: icon.ext as IconExt, hash: icon.hash, createdAt: timestamp(icon.createdAt) };
  });
  const imports = v.imports.map(value => {
    const record = object(value);
    if (!uuid(record.importId) || !Array.isArray(record.canvasIds) || typeof record.acked !== 'boolean') throw new Error('导入记录不合法');
    return { importId: record.importId, canvasIds: record.canvasIds.map(id), iconsAdded: integer(record.iconsAdded),
      at: timestamp(record.at), acked: record.acked };
  });
  uniqueIds(canvases, c => c.id); uniqueIds(icons, i => i.id); uniqueIds(imports, i => i.importId);
  return { schemaVersion: 1, prefs: { lastCanvasId: p.lastCanvasId === null ? null : id(p.lastCanvasId), minimapVisible: p.minimapVisible }, canvases, icons, imports };
}
