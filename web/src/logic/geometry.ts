export type Side = 'top' | 'right' | 'bottom' | 'left';
export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

export function sideMidpoint(rect: Rect, side: Side): Point {
  switch (side) {
    case 'top': return { x: rect.x + rect.width / 2, y: rect.y };
    case 'bottom': return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    case 'left': return { x: rect.x, y: rect.y + rect.height / 2 };
    case 'right': return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
  }
}

const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

/** 两张卡片相互最靠近的那两条边的中点（PRD 9.1）。 */
export function floatingEnds(a: Rect, b: Rect): { from: Point; fromSide: Side; to: Point; toSide: Side } {
  let best = { from: sideMidpoint(a, 'right'), fromSide: 'right' as Side, to: sideMidpoint(b, 'left'), toSide: 'left' as Side };
  let bestDistance = Infinity;
  for (const fromSide of SIDES) {
    const from = sideMidpoint(a, fromSide);
    for (const toSide of SIDES) {
      const to = sideMidpoint(b, toSide);
      const distance = (from.x - to.x) ** 2 + (from.y - to.y) ** 2;
      if (distance < bestDistance) { bestDistance = distance; best = { from, fromSide, to, toSide }; }
    }
  }
  return best;
}

/** 新卡片位置：与已有卡片完全重叠时往右下错开 24px，直到不重叠。 */
export function avoidOverlap(position: Point, cards: readonly Point[], step = 24): Point {
  let { x, y } = position;
  const taken = new Set(cards.map(c => `${c.x},${c.y}`));
  while (taken.has(`${x},${y}`)) { x += step; y += step; }
  return { x, y };
}
