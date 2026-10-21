import { useLayoutEffect, useRef } from 'react';
import { ackNotice, closeDialog, confirmImport, deleteCanvas, deleteIcon, hideToast, useApp, type Dialog } from '../store';

interface DialogView {
  title: string;
  body: string;
  buttons: { label: string; primary?: boolean; danger?: boolean; run: () => void }[];
  /** 回车等于点默认按钮。 */
  defaultIndex: number;
}

export function dialogView(dialog: Dialog): DialogView {
  switch (dialog.kind) {
    case 'deleteCanvas':
      return {
        title: `删除画布「${dialog.name}」？`,
        body: `画布里的 ${dialog.cards} 张卡片和 ${dialog.edges} 条连线会一起删除，删除后不能撤销。`,
        buttons: [{ label: '取消', primary: true, run: closeDialog }, { label: '删除', danger: true, run: () => void deleteCanvas(dialog.canvasId) }],
        defaultIndex: 0
      };
    case 'deleteIcon':
      return {
        title: '删除这个图标？',
        body: dialog.uses > 0 ? `有 ${dialog.uses} 张卡片在用它，删除后这些卡片会改用 Claude Code 图标。删除后不能恢复。` : '删除后不能恢复。',
        buttons: [{ label: '取消', primary: true, run: closeDialog }, { label: '删除', danger: true, run: () => void deleteIcon(dialog.iconId) }],
        defaultIndex: 0
      };
    case 'import':
      return {
        title: `导入「${dialog.fileName}」？`,
        body: `将新增 ${dialog.canvases} 张画布、${dialog.icons} 个图标，不会改动现有画布。`,
        buttons: [{ label: '取消', primary: true, run: closeDialog }, { label: '导入', run: () => void confirmImport(dialog.file) }],
        defaultIndex: 0
      };
    case 'canvasDeleted':
      return { title: '这张画布已被删除', body: '它在另一个标签页里被删除了。', buttons: [{ label: '知道了', primary: true, run: closeDialog }], defaultIndex: 0 };
  }
}

/** 可 Tab 到的元素（按 DOM 顺序）；作用在弹窗内部，保证焦点不会落到浏览器地址栏或背景。 */
function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    .filter(el => el.getClientRects().length > 0);
}

/** 弹窗：取消、Esc、点遮罩、× 都等于取消。用原生 <dialog> 的模态模式，背景自动 inert、Tab 不会跑到画布上。 */
export function DialogHost() {
  const dialog = useApp(s => s.dialog);
  const ref = useRef<HTMLDialogElement>(null);
  const view = dialog ? dialogView(dialog) : null;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!dialog || !el) return;
    // showModal 把弹窗放到顶层；不打开时（例如刚切换弹窗类型）保持原状，避免关闭再打开的闪烁。
    if (!el.open) el.showModal();
    el.querySelector<HTMLButtonElement>('[data-default]')?.focus();
  }, [dialog]);

  if (!dialog || !view) return null;
  return (
    <dialog
      ref={ref}
      className="dialog-mask"
      aria-label={view.title}
      onCancel={e => { e.preventDefault(); closeDialog(); }}
      onMouseDown={e => { if (e.target === e.currentTarget) closeDialog(); }}
      onKeyDown={e => {
        if (e.key !== 'Tab') return;
        const root = ref.current;
        if (!root) return;
        const items = tabbables(root);
        if (items.length === 0) { e.preventDefault(); return; }
        const first = items[0], last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey ? active === first || !root.contains(active) : active === last || !root.contains(active)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }}
    >
      <div className="dialog">
        <button className="icon-btn dialog-close" title="关闭" onClick={closeDialog}>×</button>
        <h2 className="dialog-title">{view.title}</h2>
        <p className="dialog-body">{view.body}</p>
        <div className="dialog-buttons">
          {view.buttons.map((b, i) => (
            <button key={b.label} className={`btn${b.primary ? ' primary' : ''}${b.danger ? ' danger-fill' : ''}`} data-default={i === view.defaultIndex ? '' : undefined} onClick={b.run}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </dialog>
  );
}

export function ToastBar() {
  const toast = useApp(s => s.toast);
  if (!toast) return null;
  return (
    <div className="toast" role="status">
      <span>{toast.text}</span>
      {toast.action && <button className="toast-action" onClick={toast.action.run}>{toast.action.label}</button>}
      <button className="toast-close" title="关闭" onClick={hideToast}>×</button>
    </div>
  );
}

function formatBackupTime(value?: string): string {
  const m = value && /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : value ?? '';
}

export function NoticeBar() {
  const notice = useApp(s => s.notice);
  if (!notice) return null;
  const text = notice.kind === 'restored'
    ? `数据文件损坏，已从 ${formatBackupTime(notice.backupTime)} 的备份恢复。损坏的文件保留在 ${notice.brokenPath}`
    : `数据文件损坏，也没有可用的备份，已从空白开始。损坏的文件保留在 ${notice.brokenPath}`;
  return (
    <div className="notice" role="alert">
      <span>{text}</span>
      <button className="btn small" onClick={ackNotice}>知道了</button>
    </div>
  );
}
