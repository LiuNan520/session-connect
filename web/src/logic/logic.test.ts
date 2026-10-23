import { describe, expect, it } from 'vitest';
import type { CanvasContent, Card, Edge } from '#shared';
import { connect, arrowFor, isFlowing } from './edges';
import { HISTORY_LIMIT, beginTransient, commit, emptyHistory, endTransient, redo, resetForReplace, undo } from './history';
import { nextCanvasName } from './names';
import { clampChars, inputValue } from './text';
import { analyzeImport, checkSize, isExportHeader } from './importFile';
import { avoidOverlap, floatingEnds } from './geometry';

const card = (id: string, x = 0, y = 0): Card => ({ id, x, y, iconId: 'claude-code', name: id, note: '', status: 'todo' });
let seq = 0;
const newId = () => `e${++seq}`;

describe('连线创建规则', () => {
  it('没有连线时新建 from → to', () => {
    const r = connect([], 'A', 'B', newId);
    expect(r.kind).toBe('created');
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]).toMatchObject({ a: 'A', b: 'B', direction: 'forward', label: '', activity: 'follow' });
  });
  it('拖回自己不创建', () => {
    expect(connect([], 'A', 'A', newId).kind).toBe('invalid');
  });
  it('已有 B → A，再从 A 拖到 B：改成双向', () => {
    const edges: Edge[] = [{ id: 'x', a: 'B', b: 'A', direction: 'forward', label: 'L', activity: 'follow' }];
    const r = connect(edges, 'A', 'B', newId);
    expect(r.kind).toBe('merged');
    expect(r.edges).toEqual([{ id: 'x', a: 'B', b: 'A', direction: 'both', label: 'L', activity: 'follow' }]);
  });
  it('已有 A ← B（backward 存法）再从 A 拖到 B：也改成双向', () => {
    const edges: Edge[] = [{ id: 'x', a: 'A', b: 'B', direction: 'backward', label: '', activity: 'follow' }];
    expect(connect(edges, 'A', 'B', newId).kind).toBe('merged');
  });
  it('已有 A → B 或双向：不变', () => {
    const forward: Edge[] = [{ id: 'x', a: 'A', b: 'B', direction: 'forward', label: '', activity: 'follow' }];
    const r1 = connect(forward, 'A', 'B', newId);
    expect(r1.kind).toBe('exists');
    expect(r1.edges).toBe(forward);
    const reversedStore: Edge[] = [{ id: 'x', a: 'B', b: 'A', direction: 'backward', label: '', activity: 'follow' }];
    expect(connect(reversedStore, 'A', 'B', newId).kind).toBe('exists');
    const both: Edge[] = [{ id: 'x', a: 'B', b: 'A', direction: 'both', label: '', activity: 'follow' }];
    expect(connect(both, 'A', 'B', newId).kind).toBe('exists');
  });
  it('已有不活跃的 B → A，再从 A 拖到 B：改成双向，仍是不活跃', () => {
    const edges: Edge[] = [{ id: 'x', a: 'B', b: 'A', direction: 'forward', label: 'L', activity: 'off' }];
    const r = connect(edges, 'A', 'B', newId);
    expect(r.kind).toBe('merged');
    expect(r.edges).toEqual([{ id: 'x', a: 'B', b: 'A', direction: 'both', label: 'L', activity: 'off' }]);
  });
  it('面板列表的方向符号从本卡片角度看', () => {
    const e: Edge = { id: 'x', a: 'A', b: 'B', direction: 'forward', label: '', activity: 'follow' };
    expect(arrowFor(e, 'A')).toBe('→');
    expect(arrowFor(e, 'B')).toBe('←');
    expect(arrowFor({ ...e, direction: 'both' }, 'B')).toBe('⇄');
  });
});

describe('连线活跃显示规则（PRD 4.1）', () => {
  const edge = (activity: Edge['activity'], direction: Edge['direction'] = 'forward'): Edge => ({ id: 'x', a: 'A', b: 'B', direction, label: '', activity });
  it.each(['forward', 'backward', 'both'] as const)('跟随卡片：%s 连线有一端进行中时活跃', direction => {
    expect(isFlowing(edge('follow', direction), new Set(['A']))).toBe(true);
    expect(isFlowing(edge('follow', direction), new Set(['B']))).toBe(true);
  });
  it('跟随卡片：两端都不在进行中时不活跃', () => {
    expect(isFlowing(edge('follow'), new Set())).toBe(false);
    expect(isFlowing(edge('follow'), new Set(['C']))).toBe(false);
  });
  it.each(['forward', 'backward', 'both'] as const)('不活跃：%s 连线两端都进行中也不活跃', direction => {
    expect(isFlowing(edge('off', direction), new Set(['A', 'B']))).toBe(false);
  });
});

describe('撤销重做', () => {
  const content = (n: number): CanvasContent => ({ cards: Array.from({ length: n }, (_, i) => card(`c${i}`)), edges: [] });

  it('每步撤销回退一步，重做逐步恢复，新操作清空重做', () => {
    let h = emptyHistory();
    let current = content(0);
    for (let i = 1; i <= 3; i++) { h = commit(h, current); current = content(i); }
    const u1 = undo(h, current)!;
    expect(u1.content.cards).toHaveLength(2);
    const u2 = undo(u1.history, u1.content)!;
    expect(u2.content.cards).toHaveLength(1);
    const r1 = redo(u2.history, u2.content)!;
    expect(r1.content.cards).toHaveLength(2);
    const after = commit(r1.history, r1.content);
    expect(after.redo).toHaveLength(0);
  });

  it('最多保留 100 步，超出丢弃最早的', () => {
    let h = emptyHistory();
    for (let i = 0; i < 130; i++) h = commit(h, content(i));
    expect(h.undo).toHaveLength(HISTORY_LIMIT);
    expect(h.undo[0].cards).toHaveLength(30);
  });

  it('拖动或输入：开始记快照，结束时有变化才提交一步', () => {
    const before = content(1);
    let h = beginTransient(emptyHistory(), 'input', before);
    // 连续输入多次只算一步
    const typed1 = { ...before, cards: [{ ...before.cards[0], name: 'a' }] };
    const typed2 = { ...before, cards: [{ ...before.cards[0], name: 'ab' }] };
    h = beginTransient(h, 'input', typed1); // 已有快照时保持原来的
    h = endTransient(h, typed2);
    expect(h.undo).toEqual([before]);
    expect(h.transient).toBeNull();
    // 内容没变：不提交
    let h2 = beginTransient(emptyHistory(), 'drag', before);
    h2 = endTransient(h2, { cards: [...before.cards], edges: [] });
    expect(h2.undo).toHaveLength(0);
  });

  it('被服务端内容替换后清空撤销栈、重做栈和临时快照；输入框有焦点时以新内容作为临时快照', () => {
    let h = commit(emptyHistory(), content(1));
    h = { ...h, redo: [content(2)] };
    h = beginTransient(h, 'drag', content(3));
    const replaced = content(5);
    const cleared = resetForReplace(h, replaced, false);
    expect(cleared).toEqual({ undo: [], redo: [], transient: null });
    const focused = resetForReplace(h, replaced, true);
    expect(focused.undo).toHaveLength(0);
    expect(focused.transient).toEqual({ kind: 'input', content: replaced });
  });
});

describe('默认画布名', () => {
  it('依次为 未命名画布、未命名画布 2、未命名画布 3', () => {
    const names: string[] = ['我的画布'];
    for (let i = 0; i < 3; i++) names.push(nextCanvasName(names));
    expect(names.slice(1)).toEqual(['未命名画布', '未命名画布 2', '未命名画布 3']);
  });
  it('补上空缺的编号', () => {
    expect(nextCanvasName(['未命名画布', '未命名画布 3'])).toBe('未命名画布 2');
  });
});

describe('文字长度', () => {
  it('按字素截断，emoji 算 1 个字', () => {
    expect(clampChars('一二三四五', 3)).toBe('一二三');
    expect(clampChars('👨‍👩‍👧ab', 2)).toBe('👨‍👩‍👧a');
    expect(clampChars('短', 30)).toBe('短');
  });
  it('换行变成空格，再截断', () => {
    expect(inputValue('a\nb\r\nc', 40)).toBe('a b c');
    expect(inputValue('x'.repeat(50), 40)).toHaveLength(40);
  });
});

describe('导入文件识别', () => {
  it('只认本程序导出的开头', () => {
    expect(isExportHeader('{"format":"session-connect-export","formatVersion":1')).toBe(true);
    expect(isExportHeader('\uFEFF{ "format" : "session-connect-export"')).toBe(true);
    expect(isExportHeader('{"a":1}')).toBe(false);
    expect(isExportHeader('\u0000\u0000\u0000 ftypisom')).toBe(false);
    expect(isExportHeader('{"formatVersion":1,"format":"session-connect-export"}')).toBe(false);
  });
  it('统计新增画布和图标（按 hash 去重）', () => {
    const file = JSON.stringify({ format: 'session-connect-export', formatVersion: 1, exportedAt: '2026-10-21T00:00:00Z',
      canvases: [{}, {}], icons: [{ hash: 'h1' }, { hash: 'h2' }, { hash: 'h2' }] });
    expect(analyzeImport(file, new Set(['h1']))).toEqual({ ok: true, canvases: 2, icons: 1 });
  });
  it('截断、更新版本、结构不对', () => {
    const full = JSON.stringify({ format: 'session-connect-export', formatVersion: 1, canvases: [], icons: [] });
    expect(analyzeImport(full.slice(0, -5), new Set())).toEqual({ ok: false, reason: 'invalid' });
    expect(analyzeImport(full.replace('"formatVersion":1', '"formatVersion":2'), new Set())).toEqual({ ok: false, reason: 'newer' });
    expect(analyzeImport('{"format":"session-connect-export","formatVersion":1}', new Set())).toEqual({ ok: false, reason: 'invalid' });
    expect(checkSize(1024 ** 3 + 1)).toEqual({ ok: false, reason: 'too_large' });
    expect(checkSize(1024)).toBeNull();
  });
});

describe('几何', () => {
  it('端点落在相互最近的两条边中点', () => {
    const a = { x: 0, y: 0, width: 100, height: 40 };
    const right = floatingEnds(a, { x: 300, y: 0, width: 100, height: 40 });
    expect(right).toMatchObject({ fromSide: 'right', toSide: 'left', from: { x: 100, y: 20 }, to: { x: 300, y: 20 } });
    const below = floatingEnds(a, { x: 0, y: 300, width: 100, height: 40 });
    expect(below).toMatchObject({ fromSide: 'bottom', toSide: 'top' });
  });
  it('完全重叠时往右下错开 24px', () => {
    expect(avoidOverlap({ x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 24, y: 24 }])).toEqual({ x: 48, y: 48 });
    expect(avoidOverlap({ x: 5, y: 0 }, [{ x: 0, y: 0 }])).toEqual({ x: 5, y: 0 });
  });
});
