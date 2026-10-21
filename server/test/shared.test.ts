import { describe, expect, it } from 'vitest';
import { countChars, normalizeText } from '#shared';

describe('共用文字规则', () => {
  it('组合 emoji 和组合音标各算一个字素', () => {
    expect(countChars('中👨‍👩‍👧‍👦e\u0301🇨🇳')).toBe(4);
  });
  it('去首尾空白，并把各种换行替换为空格', () => {
    expect(normalizeText(' \n会话\r\n连接\r测试\u2028结束\u2029好 \t')).toBe('会话 连接 测试 结束 好');
  });
});
