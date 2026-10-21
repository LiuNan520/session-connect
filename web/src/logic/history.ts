import type { CanvasContent } from '#shared';

export const HISTORY_LIMIT = 100;

export type TransientKind = 'drag' | 'input';
/** 每张画布各自的撤销栈、重做栈，以及拖动或输入中的临时快照（快照式）。 */
export interface History {
  undo: CanvasContent[];
  redo: CanvasContent[];
  transient: { kind: TransientKind; content: CanvasContent } | null;
}

export const emptyHistory = (): History => ({ undo: [], redo: [], transient: null });

export function sameContent(a: CanvasContent, b: CanvasContent): boolean {
  if (a === b) return true;
  if (a.cards === b.cards && a.edges === b.edges) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 提交一步：before 是这一步之前的内容。超过 100 步丢弃最早的；新操作清空重做。 */
export function commit(history: History, before: CanvasContent): History {
  const undo = [...history.undo, before];
  if (undo.length > HISTORY_LIMIT) undo.splice(0, undo.length - HISTORY_LIMIT);
  return { ...history, undo, redo: [] };
}

export function undo(history: History, current: CanvasContent): { history: History; content: CanvasContent } | null {
  if (history.undo.length === 0) return null;
  const content = history.undo[history.undo.length - 1];
  return { content, history: { ...history, undo: history.undo.slice(0, -1), redo: [...history.redo, current] } };
}

export function redo(history: History, current: CanvasContent): { history: History; content: CanvasContent } | null {
  if (history.redo.length === 0) return null;
  const content = history.redo[history.redo.length - 1];
  const undoStack = [...history.undo, current];
  if (undoStack.length > HISTORY_LIMIT) undoStack.splice(0, undoStack.length - HISTORY_LIMIT);
  return { content, history: { ...history, undo: undoStack, redo: history.redo.slice(0, -1) } };
}

/** 拖动开始、输入框获得焦点时记快照；已有临时快照时保持原来的。 */
export function beginTransient(history: History, kind: TransientKind, current: CanvasContent): History {
  if (history.transient) return history;
  return { ...history, transient: { kind, content: current } };
}

/** 拖动结束、输入框失焦时：内容有变化就提交为一步。 */
export function endTransient(history: History, current: CanvasContent): History {
  if (!history.transient) return history;
  const before = history.transient.content;
  const cleared = { ...history, transient: null };
  return sameContent(before, current) ? cleared : commit(cleared, before);
}

/**
 * 画布内容被服务端替换（切回标签页载入、「重新加载」）：清空撤销栈、重做栈和临时快照；
 * 输入框还有焦点时，以替换后的内容作为新的临时快照（PRD 11.3）。
 */
export function resetForReplace(history: History, replaced: CanvasContent, inputFocused: boolean): History {
  return { undo: [], redo: [], transient: inputFocused ? { kind: 'input', content: replaced } : null };
}
