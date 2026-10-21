import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import {
  blurActive, cancelConnection, clearSelection, closeDialog, createCanvas, deleteSelection, openMenu, redo, selectAll, undo,
  useApp
} from '../store';
import { Board, Toolbar } from './Board';
import { Panel } from './Panel';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { DialogHost, NoticeBar, ToastBar, dialogView } from './Overlays';

function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'file', 'submit', 'reset', 'range', 'color'].includes(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * 快捷键自己处理（PRD 11.1）：
 * 弹窗或菜单打开时 Esc 只关闭它、其他键不作用于画布；拖连线途中 Esc 取消；
 * 焦点在输入框时只有 Esc（先失焦）由这里处理；否则 Cmd+Z / Cmd+Shift+Z / Delete / Backspace / Cmd+A / Esc 作用于画布。
 */
function onKeyDown(e: KeyboardEvent) {
  const s = useApp.getState();
  if (s.dialog) {
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
    else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const view = dialogView(s.dialog);
      view.buttons[view.defaultIndex].run();
    }
    return;
  }
  if (s.menu) {
    if (e.key === 'Escape') { e.preventDefault(); openMenu(null); }
    return;
  }
  if (s.connecting) {
    if (e.key === 'Escape') { e.preventDefault(); cancelConnection(); }
    return;
  }
  if (isTextInput(document.activeElement)) {
    if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); blurActive(); }
    return;
  }
  if (!s.loaded) return;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && key === 'a') { e.preventDefault(); selectAll(); return; }
  if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); deleteSelection(); return; }
  if (e.key === 'Escape') { clearSelection(); }
}

export function App() {
  const loaded = useApp(s => s.loaded);
  const loadError = useApp(s => s.loadError);
  const currentId = useApp(s => s.currentId);
  const doc = useApp(s => (s.currentId ? s.docs[s.currentId] ?? null : null));

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!loaded) {
    return <div className="loading">{loadError ? '连不上本地服务，请重新打开会话连接后再试' : '载入中…'}</div>;
  }
  return (
    <div className="app">
      <NoticeBar />
      <div className="main">
        <Sidebar />
        <div className="stage">
          {doc && currentId ? (
            <ReactFlowProvider key={currentId}>
              <Board doc={doc} />
            </ReactFlowProvider>
          ) : (
            <div className="board empty-state">
              <Toolbar disabled />
              <div className="empty-box">
                <p>还没有画布</p>
                <button className="btn primary" onClick={() => void createCanvas()}>新建画布</button>
              </div>
            </div>
          )}
          <TopBar doc={doc} />
          {doc && <Panel doc={doc} />}
        </div>
      </div>
      <ToastBar />
      <DialogHost />
    </div>
  );
}
