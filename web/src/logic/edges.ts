import type { Edge } from '#shared';

export type ConnectResult =
  | { kind: 'created'; edges: Edge[]; edge: Edge }
  | { kind: 'merged'; edges: Edge[]; edge: Edge }
  | { kind: 'exists'; edges: Edge[] }
  | { kind: 'invalid'; edges: Edge[] };

export function findEdgeBetween(edges: readonly Edge[], x: string, y: string): Edge | undefined {
  return edges.find(e => (e.a === x && e.b === y) || (e.a === y && e.b === x));
}

/** 这条连线是否已经有 from → to 的箭头。 */
export function pointsFrom(edge: Edge, from: string): boolean {
  if (edge.direction === 'both') return true;
  return edge.direction === 'forward' ? edge.a === from : edge.b === from;
}

/**
 * 从 from 拖到 to 的规则（PRD 9.2）：
 * 没有连线就新建 from → to；已有 to → from 就改为双向；已有 from → to 或双向则不变。
 */
export function connect(edges: Edge[], from: string, to: string, newId: () => string): ConnectResult {
  if (from === to) return { kind: 'invalid', edges };
  const existing = findEdgeBetween(edges, from, to);
  if (!existing) {
    const edge: Edge = { id: newId(), a: from, b: to, direction: 'forward', label: '', activity: 'follow' };
    return { kind: 'created', edges: [...edges, edge], edge };
  }
  if (pointsFrom(existing, from)) return { kind: 'exists', edges };
  const edge: Edge = { ...existing, direction: 'both' };
  return { kind: 'merged', edges: edges.map(e => (e.id === existing.id ? edge : e)), edge };
}

/** 连线是否显示为活跃（PRD 4.1）：不活跃的线恒为普通灰线，跟随卡片的线任一端进行中时活跃。 */
export function isFlowing(edge: Edge, doingIds: ReadonlySet<string>): boolean {
  return edge.activity !== 'off' && (doingIds.has(edge.a) || doingIds.has(edge.b));
}

/** 卡片面板里连线列表的方向符号：从 self 的角度看。 */
export function arrowFor(edge: Edge, self: string): '→' | '←' | '⇄' {
  if (edge.direction === 'both') return '⇄';
  return pointsFrom(edge, self) ? '→' : '←';
}
