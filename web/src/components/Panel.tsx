import { useEffect, useMemo, useRef, useState } from 'react';
import { STATUS_VALUES, TEXT_LIMITS, type Card, type CardStatus, type Edge, type EdgeDirection, type Icon } from '#shared';
import {
  DEFAULT_ICON, STATUS_LABELS, addEdgeFromPanel, askDeleteIcon, beginStep, clearSelection, deleteCards, deleteEdge,
  duplicateCards, finishCardField, finishEdgeLabel, openMenu, selectEdge, setCardIcon, setEdgeDirection, setStatus,
  typeCardField, typeEdgeLabel, uploadIcon, useApp, type CanvasDoc
} from '../store';
import { arrowFor, findEdgeBetween } from '../logic/edges';
import { IconImg, TextField } from './common';

const BUILTIN_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', deepseek: 'DeepSeek', workbuddy: 'WorkBuddy' };
const UPLOAD_ACCEPT = '.png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml';

// 面板挂载后才响应的聚焦请求；记住已处理的编号，避免切换时重复聚焦。
let consumedFocus = 0;
function useFocusRequest(field: 'name' | 'label', ref: React.RefObject<HTMLInputElement | null>) {
  const focus = useApp(s => s.focus);
  useEffect(() => {
    if (!focus || focus.field !== field || focus.nonce === consumedFocus) return;
    consumedFocus = focus.nonce;
    const el = ref.current;
    if (el && !el.disabled) { el.focus(); el.select(); }
  }, [focus, field, ref]);
}

export function Panel({ doc }: { doc: CanvasDoc }) {
  const selection = useApp(s => s.selection);
  const { cards, edges } = doc.content;
  if (selection.edgeId) {
    const edge = edges.find(e => e.id === selection.edgeId);
    if (edge) return <EdgePanel key={edge.id} edge={edge} cards={cards} readOnly={doc.readOnly} />;
  }
  const selected = cards.filter(c => selection.cardIds.includes(c.id));
  if (selected.length === 1) return <CardPanel key={selected[0].id} card={selected[0]} doc={doc} />;
  if (selected.length > 1) return <MultiPanel cards={selected} readOnly={doc.readOnly} />;
  return null;
}

function PanelShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <aside className="panel" onContextMenu={e => e.stopPropagation()}>
      <header className="panel-head">
        <span>{title}</span>
        <button className="icon-btn" title="关闭" onClick={() => clearSelection()}>×</button>
      </header>
      <div className="panel-body">{children}</div>
    </aside>
  );
}

function StatusButtons({ value, onPick, disabled }: { value: CardStatus | null; onPick: (s: CardStatus) => void; disabled: boolean }) {
  return (
    <div className="status-buttons">
      {STATUS_VALUES.map(status => (
        <button key={status} className={`status-btn${value === status ? ' active' : ''}`} disabled={disabled} onClick={() => onPick(status)}>
          <span className={`dot dot-${status}`} />{STATUS_LABELS[status]}
        </button>
      ))}
    </div>
  );
}

function CardPanel({ card, doc }: { card: Card; doc: CanvasDoc }) {
  const icons = useApp(s => s.icons);
  const uploading = useApp(s => s.uploading);
  const menu = useApp(s => s.menu);
  const readOnly = doc.readOnly;
  const nameRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useFocusRequest('name', nameRef);
  const cardsById = useMemo(() => new Map(doc.content.cards.map(c => [c.id, c])), [doc.content.cards]);
  const myEdges = doc.content.edges.filter(e => e.a === card.id || e.b === card.id);
  const currentIcon = icons.some(i => i.id === card.iconId) ? card.iconId : DEFAULT_ICON;

  return (
    <PanelShell title="卡片">
      <section>
        <label className="field-label">图标</label>
        <div className="icon-grid">
          {icons.map(icon => (
            <IconCell key={icon.id} icon={icon} current={icon.id === currentIcon} readOnly={readOnly} onPick={() => setCardIcon(card.id, icon.id)} />
          ))}
          <button className="icon-cell upload" disabled={readOnly} onClick={() => fileRef.current?.click()} title="上传 PNG、JPG、WebP、SVG，不超过 1 MB">
            {uploading > 0 ? '上传中…' : '上传'}
          </button>
          <input
            ref={fileRef} type="file" hidden accept={UPLOAD_ACCEPT}
            onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void uploadIcon(file, card.id); }}
          />
        </div>
      </section>
      <section>
        <label className="field-label">名称</label>
        <TextField
          inputRef={nameRef} value={card.name} max={TEXT_LIMITS.cardName} disabled={readOnly} ariaLabel="名称"
          onFocus={() => beginStep('input')}
          onChange={v => typeCardField(card.id, 'name', v)}
          onBlur={() => finishCardField(card.id, 'name')}
        />
      </section>
      <section>
        <label className="field-label">备注</label>
        <TextField
          value={card.note} max={TEXT_LIMITS.note} disabled={readOnly} ariaLabel="备注" placeholder="可选"
          onFocus={() => beginStep('input')}
          onChange={v => typeCardField(card.id, 'note', v)}
          onBlur={() => finishCardField(card.id, 'note')}
        />
      </section>
      <section>
        <label className="field-label">状态</label>
        <StatusButtons value={card.status} disabled={readOnly} onPick={s => setStatus([card.id], s)} />
      </section>
      <section>
        <label className="field-label">连线</label>
        <div className="edge-list">
          {myEdges.map(edge => {
            const other = cardsById.get(edge.a === card.id ? edge.b : edge.a);
            return (
              <div key={edge.id} className="edge-row">
                <button className="edge-row-main" onClick={() => selectEdge(edge.id)} title="选中这条连线">
                  <span className="edge-arrow">{arrowFor(edge, card.id)}</span>
                  <span className="edge-other">{other?.name ?? ''}</span>
                  {edge.label && <span className="edge-row-label">{edge.label}</span>}
                </button>
                <button className="icon-btn" title="删除这条连线" disabled={readOnly} onClick={() => deleteEdge(edge.id)}>×</button>
              </div>
            );
          })}
        </div>
        <div className="add-edge">
          <button className="btn small" disabled={readOnly} onClick={() => openMenu(menu?.kind === 'addEdge' ? null : { kind: 'addEdge' })}>+ 添加连线</button>
          {menu?.kind === 'addEdge' && <AddEdgeDropdown card={card} cards={doc.content.cards} edges={doc.content.edges} />}
        </div>
      </section>
      <footer className="panel-foot">
        <button className="btn" disabled={readOnly} onClick={() => duplicateCards([card.id])}>复制一张</button>
        <button className="btn danger" disabled={readOnly} onClick={() => deleteCards([card.id])}>删除卡片</button>
      </footer>
    </PanelShell>
  );
}

function IconCell({ icon, current, readOnly, onPick }: { icon: Icon; current: boolean; readOnly: boolean; onPick: () => void }) {
  return (
    <div className={`icon-cell${current ? ' current' : ''}${readOnly ? ' disabled' : ''}`} title={BUILTIN_NAMES[icon.id] ?? '上传的图标'}>
      <button className="icon-pick" disabled={readOnly} onClick={onPick}><IconImg src={icon.url} /></button>
      {!icon.builtin && !readOnly && (
        <button className="icon-del" title="删除这个图标" onClick={e => { e.stopPropagation(); askDeleteIcon(icon.id); }}>×</button>
      )}
    </div>
  );
}

/**
 * 「+ 添加连线」下拉：放在面板文档流里，随面板一起滚动。
 * 不用全屏遮罩关闭：遮罩会盖住面板，滚轮落在遮罩上时面板滚不动；改为监听点到 .add-edge 之外就关闭。
 */
function AddEdgeDropdown({ card, cards, edges }: { card: Card; cards: Card[]; edges: Edge[] }) {
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    const onDown = (e: MouseEvent) => {
      if (!el.closest('.add-edge')?.contains(e.target as Node)) openMenu(null);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, []);
  const others = cards.filter(c => c.id !== card.id);
  const keyword = filter.trim().toLowerCase();
  const shown = keyword ? others.filter(c => c.name.toLowerCase().includes(keyword)) : others;
  return (
    <div className="dropdown" ref={ref}>
      {others.length === 0 ? (
        <div className="dropdown-empty">没有其他卡片</div>
      ) : (
        <>
          <input className="dropdown-filter" autoFocus placeholder="输入名称筛选" value={filter} onChange={e => setFilter(e.target.value)} />
          <div className="dropdown-list">
            {shown.map(other => {
              const connected = !!findEdgeBetween(edges, card.id, other.id);
              return (
                <button key={other.id} className="dropdown-item" disabled={connected} onClick={() => addEdgeFromPanel(card.id, other.id)}>
                  <span className="dropdown-name">{other.name}</span>
                  {connected && <span className="tag">已连接</span>}
                </button>
              );
            })}
            {shown.length === 0 && <div className="dropdown-empty">没有匹配的卡片</div>}
          </div>
        </>
      )}
    </div>
  );
}

function MultiPanel({ cards, readOnly }: { cards: Card[]; readOnly: boolean }) {
  const ids = cards.map(c => c.id);
  const same = cards.every(c => c.status === cards[0].status) ? cards[0].status : null;
  return (
    <PanelShell title={`已选中 ${cards.length} 张卡片`}>
      <section>
        <label className="field-label">状态</label>
        <StatusButtons value={same} disabled={readOnly} onPick={s => setStatus(ids, s)} />
      </section>
      <footer className="panel-foot">
        <button className="btn" disabled={readOnly} onClick={() => duplicateCards(ids)}>复制一张</button>
        <button className="btn danger" disabled={readOnly} onClick={() => deleteCards(ids)}>删除</button>
      </footer>
    </PanelShell>
  );
}

const DIRECTIONS: [EdgeDirection, string][] = [['forward', 'A → B'], ['backward', 'A ← B'], ['both', 'A ⇄ B']];

function EdgePanel({ edge, cards, readOnly }: { edge: Edge; cards: Card[]; readOnly: boolean }) {
  const labelRef = useRef<HTMLInputElement>(null);
  useFocusRequest('label', labelRef);
  const a = cards.find(c => c.id === edge.a);
  const b = cards.find(c => c.id === edge.b);
  return (
    <PanelShell title="连线">
      <section className="edge-ends">
        <div><span className="end-tag">A</span>{a?.name}</div>
        <div><span className="end-tag">B</span>{b?.name}</div>
      </section>
      <section>
        <label className="field-label">方向</label>
        <div className="direction-buttons">
          {DIRECTIONS.map(([direction, label]) => (
            <button key={direction} className={`status-btn${edge.direction === direction ? ' active' : ''}`} disabled={readOnly} onClick={() => setEdgeDirection(edge.id, direction)}>
              {label}
            </button>
          ))}
        </div>
      </section>
      <section>
        <label className="field-label">文字</label>
        <TextField
          inputRef={labelRef} value={edge.label} max={TEXT_LIMITS.edgeLabel} disabled={readOnly} ariaLabel="连线文字" placeholder="可选"
          onFocus={() => beginStep('input')}
          onChange={v => typeEdgeLabel(edge.id, v)}
          onBlur={() => finishEdgeLabel(edge.id)}
        />
      </section>
      <footer className="panel-foot">
        <button className="btn danger" disabled={readOnly} onClick={() => deleteEdge(edge.id)}>删除连线</button>
      </footer>
    </PanelShell>
  );
}
