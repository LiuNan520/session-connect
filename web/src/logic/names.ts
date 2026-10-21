export const DEFAULT_CANVAS_NAME = '未命名画布';

/** 默认画布名："未命名画布"，已有同名就依次加数字："未命名画布 2""未命名画布 3"… */
export function nextCanvasName(existing: readonly string[]): string {
  const names = new Set(existing);
  if (!names.has(DEFAULT_CANVAS_NAME)) return DEFAULT_CANVAS_NAME;
  for (let n = 2; ; n++) {
    const name = `${DEFAULT_CANVAS_NAME} ${n}`;
    if (!names.has(name)) return name;
  }
}
