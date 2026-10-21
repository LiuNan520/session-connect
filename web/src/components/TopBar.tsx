import { useRef } from 'react';
import { canRedo, canUndo, exportAll, openMenu, pickImportFile, redo, reloadCanvas, saveLabel, undo, useApp, type CanvasDoc } from '../store';
import { FloatingMenu } from './Menus';

/** 右上角：保存状态、撤销、重做、「⋯」菜单（导出全部数据、导入）。 */
export function TopBar({ doc }: { doc: CanvasDoc | null }) {
  const menu = useApp(s => s.menu);
  const importing = useApp(s => s.importing);
  const fileRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const label = saveLabel(doc);
  const rect = moreRef.current?.getBoundingClientRect();
  return (
    <div className="topbar">
      {label && (
        <span className={`save-status${label.error ? ' error' : ''}`}>
          {label.text}
          {label.reload && doc && <button className="btn small reload" onClick={() => void reloadCanvas(doc.id)}>重新加载</button>}
        </span>
      )}
      {importing && <span className="save-status">导入中…</span>}
      <button className="icon-btn" title="撤销（Cmd+Z）" disabled={!canUndo(doc)} onMouseDown={e => e.preventDefault()} onClick={undo}>↶</button>
      <button className="icon-btn" title="重做（Cmd+Shift+Z）" disabled={!canRedo(doc)} onMouseDown={e => e.preventDefault()} onClick={redo}>↷</button>
      <button ref={moreRef} className="icon-btn" title="更多" onClick={() => openMenu(menu?.kind === 'more' ? null : { kind: 'more' })}>⋯</button>
      <input
        ref={fileRef} type="file" hidden accept=".json,application/json"
        onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void pickImportFile(file); }}
      />
      {menu?.kind === 'more' && rect && (
        <FloatingMenu x={rect.right} y={rect.bottom + 4} align="right" items={[
          { label: '导出全部数据', disabled: !!doc?.readOnly, run: () => void exportAll() },
          { label: '导入', disabled: importing, run: () => fileRef.current?.click() }
        ]} />
      )}
    </div>
  );
}
