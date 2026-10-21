import { countChars } from '#shared';

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });

/** 按"字"（字素）截断到上限；一个 emoji 算 1 个字。 */
export function clampChars(text: string, max: number): string {
  if (countChars(text) <= max) return text;
  let out = '';
  let n = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (n === max) break;
    out += segment;
    n++;
  }
  return out;
}

/** 单行：换行替换为空格（不去首尾空格，输入过程中要能打空格）。 */
export function singleLine(text: string): string {
  return text.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
}

/** 输入框里的值：换行变空格，再截断到上限。 */
export function inputValue(raw: string, max: number): string {
  return clampChars(singleLine(raw), max);
}
