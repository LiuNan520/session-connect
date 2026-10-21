/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 测试跑在 node 里没有布局引擎，这里只锁住两处容易被改回去的样式规则；真实测距靠浏览器实测。
const own = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
const flow = readFileSync(fileURLToPath(new URL('../../node_modules/@xyflow/react/dist/style.css', import.meta.url)), 'utf8');

/** 拆出所有「选择器 → 声明」规则（不含 @keyframes 内部，本文件用不到） */
function rules(css: string) {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m; (m = re.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))); ) {
    for (const selector of m[1].split(',')) out.push({ selector: selector.trim(), body: m[2] });
  }
  return out;
}
/** 只用到类选择器，按类数比较优先级即可 */
const classCount = (selector: string) => (selector.match(/\.[\w-]+/g) ?? []).length;

describe('样式回归', () => {
  it('小地图的 32px 留白规则优先级高于 React Flow 的 .react-flow__panel.right / .bottom', () => {
    const mine = rules(own).filter(r => /react-flow__minimap\b/.test(r.selector) && /right:\s*32px/.test(r.body) && /bottom:\s*32px/.test(r.body));
    expect(mine).toHaveLength(1);
    const theirs = rules(flow).filter(r => /^\.react-flow__panel\.(right|bottom)$/.test(r.selector));
    expect(theirs).toHaveLength(2);
    for (const r of theirs) expect(classCount(mine[0].selector)).toBeGreaterThan(classCount(r.selector));
  });

  it('显示小地图时，缩放控件和小地图上下至少隔 14px', () => {
    const px = (body: string | undefined, prop: string) => Number(body?.match(new RegExp(`${prop}:\\s*(\\d+)px`))?.[1]);
    const minimap = rules(own).find(r => /react-flow__minimap\b/.test(r.selector) && /bottom:/.test(r.body));
    const controls = rules(own).find(r => r.selector === '.zoom-controls.with-minimap');
    // React Flow 小地图默认高 150px，本项目给它加了上下各 1px 边框
    const minimapTop = px(minimap?.body, 'bottom') + 150 + 2;
    expect(px(controls?.body, 'bottom') - minimapTop).toBeGreaterThanOrEqual(14);
  });

  it('添加连线下拉框自动滚动时给面板底边留出间距', () => {
    const dropdown = rules(own).find(r => r.selector === '.dropdown');
    expect(dropdown?.body).toMatch(/scroll-margin-bottom:\s*(?:[1-9]\d*)px/);
  });
});
