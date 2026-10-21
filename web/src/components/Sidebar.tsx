import { useEffect, useRef, useState } from 'react';
import { TEXT_LIMITS } from '#shared';
import { askDeleteCanvas, createCanvas, endRename, openMenu, renameCanvas, selectCanvas, startRename, useApp } from '../store';
import { TextField } from './common';
import { FloatingMenu } from './Menus';

export function Sidebar() {
  const order = useApp(s => s.order);
  const docs = useApp(s => s.docs);
  const currentId = useApp(s => s.currentId);
  const editingId = useApp(s => s.editingCanvasId);
  const collapsed = useApp(s => s.sidebarCollapsed);
  const menu = useApp(s => s.menu);

  if (collapsed) {
    return (
      <nav className="sidebar collapsed">
        <button className="icon-btn" title="展开画布列表" onClick={() => useApp.setState({ sidebarCollapsed: false })}>»</button>
      </nav>
    );
  }
  return (
    <nav className="sidebar">
      <div className="sidebar-head">画布</div>
      <ul className="canvas-list">
        {order.map(id => (
          <li key={id} className={`canvas-row${id === currentId ? ' current' : ''}`}>
            {editingId === id ? (
              <RenameInput id={id} initial={docs[id].name} />
            ) : (
              <>
                <button className="canvas-name" title={docs[id].name} onClick={() => selectCanvas(id)} onDoubleClick={() => startRename(id)}>
                  {docs[id].name}
                </button>
                <button
                  className="row-more"
                  title="更多"
                  onClick={e => {
                    const r = e.currentTarget.getBoundingClientRect();
                    openMenu({ kind: 'canvasRow', canvasId: id, x: r.right, y: r.bottom + 2 });
                  }}
                >
                  ⋯
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <button className="sidebar-action" onClick={() => void createCanvas()}>+ 新建画布</button>
      <button className="sidebar-action muted" onClick={() => useApp.setState({ sidebarCollapsed: true })}>« 收起</button>
      {menu?.kind === 'canvasRow' && (
        <FloatingMenu x={menu.x} y={menu.y} align="right" items={[
          { label: '重命名', run: () => startRename(menu.canvasId) },
          { label: '删除', danger: true, run: () => askDeleteCanvas(menu.canvasId) }
        ]} />
      )}
    </nav>
  );
}

/** 行内重命名：回车或点别处保存，Esc 放弃。 */
function RenameInput({ id, initial }: { id: string; initial: string }) {
  const [value, setValue] = useState(initial);
  const cancelled = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <TextField
      inputRef={ref}
      className="rename-input"
      value={value}
      max={TEXT_LIMITS.canvasName}
      ariaLabel="画布名称"
      onChange={setValue}
      onEscape={() => { cancelled.current = true; ref.current?.blur(); }}
      onBlur={() => { if (cancelled.current) endRename(); else void renameCanvas(id, value); }}
    />
  );
}
