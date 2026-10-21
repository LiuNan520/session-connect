import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { openMenu } from '../store';

export interface MenuItem { label: string; run: () => void; disabled?: boolean; danger?: boolean }

/**
 * 浮动菜单（右键菜单、「⋯」菜单）：点菜单外、按 Esc 关闭。
 * 挂到 body：菜单的 z-index 不能被「⋯」所在的 topbar（z-index 6）困住，否则会被设置面板（7）盖住。
 */
export function FloatingMenu({ x, y, items, align = 'left' }: { x: number; y: number; items: MenuItem[]; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left = align === 'right' ? x - width : x;
    let top = y;
    left = Math.max(4, Math.min(left, window.innerWidth - width - 4));
    if (top + height > window.innerHeight - 4) top = Math.max(4, y - height);
    setPos({ left, top });
  }, [x, y, align]);
  return createPortal(
    <>
      <div className="menu-backdrop" onMouseDown={() => openMenu(null)} onContextMenu={e => { e.preventDefault(); openMenu(null); }} />
      <div className="menu" ref={ref} style={pos} role="menu">
        {items.map(item => (
          <button
            key={item.label}
            role="menuitem"
            className={`menu-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={() => { openMenu(null); item.run(); }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>,
    document.body
  );
}
