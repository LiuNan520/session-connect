import fs from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export function makePerfFixture() {
  const cards = Array.from({ length: 200 }, (_, i) => ({
    id: randomUUID(), x: (i % 20) * 240, y: Math.floor(i / 20) * 140,
    iconId: ['claude-code', 'codex', 'deepseek', 'workbuddy'][i % 4], name: `会话 ${i + 1}`,
    note: '性能验收用手工卡片', status: ['todo', 'doing', 'done', 'blocked'][i % 4]
  }));
  const edges = Array.from({ length: 300 }, (_, i) => ({
    id: randomUUID(), a: cards[i % 200].id, b: cards[(i % 200 + (i < 200 ? 1 : 2)) % 200].id,
    direction: ['forward', 'backward', 'both'][i % 3], label: i % 5 === 0 ? '审核' : ''
  }));
  return { format: 'session-connect-export', formatVersion: 1, exportedAt: new Date().toISOString(),
    canvases: [{ id: randomUUID(), name: '性能验收 200 张卡片', createdAt: new Date().toISOString(), revision: 0,
      lastSaveId: null, viewport: { x: 0, y: 0, zoom: 0.5 }, cards, edges }], icons: [] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = resolve(process.argv[2] || 'fixtures/perf-200.json');
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(makePerfFixture()));
  console.log(`已生成：${path}（200 张卡片、300 条连线）`);
}
