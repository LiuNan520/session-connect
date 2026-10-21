import { EXPORT_FORMAT, FORMAT_VERSION, MAX_BODY_BYTES } from '#shared';

/** 读文件开头多少字节来识别格式。 */
export const HEADER_BYTES = 128;

const HEADER = new RegExp(`^\\uFEFF?\\s*\\{\\s*"format"\\s*:\\s*"${EXPORT_FORMAT}"`);

/** 是否以 {"format":"session-connect-export" 开头（本程序导出的文件）。 */
export function isExportHeader(head: string): boolean {
  return HEADER.test(head);
}

export type ImportCheck =
  | { ok: true; canvases: number; icons: number }
  | { ok: false; reason: 'invalid' | 'newer' | 'too_large' };

export function checkSize(bytes: number): ImportCheck | null {
  return bytes > MAX_BODY_BYTES ? { ok: false, reason: 'too_large' } : null;
}

/** 完整解析后统计"新增 N 张画布、M 个图标"；M 按 hash 和现有图标比较（文件内重复的也只算一次）。 */
export function analyzeImport(text: string, existingHashes: ReadonlySet<string>): ImportCheck {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, reason: 'invalid' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'invalid' };
  const v = value as Record<string, unknown>;
  if (v.format !== EXPORT_FORMAT) return { ok: false, reason: 'invalid' };
  if (typeof v.formatVersion === 'number' && v.formatVersion > FORMAT_VERSION) return { ok: false, reason: 'newer' };
  if (v.formatVersion !== FORMAT_VERSION || !Array.isArray(v.canvases) || !Array.isArray(v.icons)) return { ok: false, reason: 'invalid' };
  const seen = new Set<string>();
  let icons = 0;
  for (const icon of v.icons) {
    const hash = icon && typeof icon === 'object' ? (icon as Record<string, unknown>).hash : undefined;
    if (typeof hash !== 'string') return { ok: false, reason: 'invalid' };
    if (existingHashes.has(hash) || seen.has(hash)) continue;
    seen.add(hash);
    icons++;
  }
  return { ok: true, canvases: v.canvases.length, icons };
}

export const IMPORT_MESSAGES = {
  invalid: '文件格式不对，没有导入任何内容',
  newer: '这个文件来自更新版本的会话连接，请先升级后再导入',
  too_large: '文件太大（超过 1 GB），没有导入任何内容'
} as const;
