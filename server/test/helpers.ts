import { randomUUID } from 'node:crypto';
import type { CanvasContent } from '#shared';

export const host = '127.0.0.1:4319';
export const card = (id = randomUUID()) => ({ id, x: 1, y: 2, iconId: 'claude-code', name: '方案会话', note: '', status: 'todo' as const });
export function graph(): CanvasContent {
  const a = card(), b = card();
  return { cards: [a, b], edges: [{ id: randomUUID(), a: a.id, b: b.id, direction: 'forward', label: '审核', activity: 'follow' }] };
}
export const svg = (extra = '') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/>${extra}</svg>`);
