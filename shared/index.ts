export const SCHEMA_VERSION = 1 as const;
export const FORMAT_VERSION = 1 as const;
export const EXPORT_FORMAT = 'session-connect-export' as const;
export const MAX_ICON_BYTES = 1024 * 1024;
export const MAX_BODY_BYTES = 1024 * 1024 * 1024;
export const TEXT_LIMITS = { canvasName: 30, cardName: 40, note: 60, edgeLabel: 20 } as const;
export const STATUS_VALUES = ['todo', 'doing', 'done', 'blocked'] as const;
export const DIRECTION_VALUES = ['forward', 'backward', 'both'] as const;
export const BUILTIN_ICON_IDS = ['claude-code', 'codex', 'deepseek', 'workbuddy'] as const;

export type CardStatus = typeof STATUS_VALUES[number];
export type EdgeDirection = typeof DIRECTION_VALUES[number];
export type IconMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
export type IconExt = 'png' | 'jpg' | 'webp' | 'svg';
export interface Card { id: string; x: number; y: number; iconId: string; name: string; note: string; status: CardStatus }
export interface Edge { id: string; a: string; b: string; direction: EdgeDirection; label: string }
export interface Viewport { x: number; y: number; zoom: number }
export interface CanvasContent { cards: Card[]; edges: Edge[] }
export interface Canvas extends CanvasContent {
  id: string; name: string; createdAt: string; revision: number; lastSaveId: string | null; viewport: Viewport;
}
export interface IconMeta { id: string; mime: IconMime; hash: string; ext: IconExt; createdAt: string }
export interface Icon { id: string; builtin: boolean; mime: IconMime; hash: string; url: string }
export interface Prefs { lastCanvasId: string | null; minimapVisible: boolean }
export interface ImportResult { canvasIds: string[]; iconsAdded: number }
export interface ImportRecord extends ImportResult { importId: string; at: string; acked: boolean }
export interface DataFile {
  schemaVersion: 1; prefs: Prefs; canvases: Canvas[]; icons: IconMeta[]; imports: ImportRecord[];
}
export interface Notice { kind: 'restored' | 'reset'; backupTime?: string; brokenPath: string }
export interface State { schemaVersion: 1; canvases: Canvas[]; icons: Icon[]; prefs: Prefs; notice: Notice | null }
export interface SaveContentRequest extends CanvasContent { baseRevision: number; saveId: string }
export interface ExportIcon { id: string; mime: IconMime; hash: string; dataBase64: string }
export interface ExportFile {
  format: typeof EXPORT_FORMAT; formatVersion: 1; exportedAt: string; canvases: Canvas[]; icons: ExportIcon[];
}
export interface ApiError { code: string; message: string; reason?: 'disk_full' | 'no_permission' | 'other'; detail?: string; revision?: number }

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
export function countChars(text: string): number {
  let count = 0;
  for (const _ of segmenter.segment(text)) count++;
  return count;
}
export function normalizeText(text: string): string {
  return text.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ').trim();
}
