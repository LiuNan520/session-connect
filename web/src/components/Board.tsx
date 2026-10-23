import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Background, BackgroundVariant, ConnectionMode, MarkerType, MiniMap, ReactFlow, useReactFlow, useViewport,
  type EdgeChange, type EdgeMarker, type NodeChange, type OnConnectEnd
} from '@xyflow/react';
import {
  addCard, beginStep, clearSelection, connectCards, deleteCards, deleteEdge, duplicateCards, endStep,
  moveCards, openMenu, registerConnectionCanceller, savePrefs, selectCards, selectEdge, setConnecting, setViewport,
  toggleCard, useApp, type CanvasDoc
} from '../store';
import { isFlowing } from '../logic/edges';
import { CardNode, type CardNodeType } from './CardNode';
import { FloatingEdge, type FloatingEdgeType } from './FloatingEdge';
import { FloatingMenu } from './Menus';

const nodeTypes = { card: CardNode };
const edgeTypes = { floating: FloatingEdge };
export const CARD_DRAG_TYPE = 'application/x-session-connect-card';
const DEFAULT_ICON_URL = '/icons/claude-code';
const COLORS = { idle: '#a3a8b0', flowing: '#ec4899', selected: '#111827' };

type Size = { width: number; height: number };

function nodeIdAt(event: MouseEvent | TouchEvent): string | null {
  const point = 'changedTouches' in event ? event.changedTouches[0] : event;
  if (!point) return null;
  const el = document.elementFromPoint(point.clientX, point.clientY)?.closest('.react-flow__node');
  return el?.getAttribute('data-id') ?? null;
}

/** 当前画布。按画布 id 作为 key 重新挂载，视野从这张画布自己记住的值开始。 */
export function Board({ doc }: { doc: CanvasDoc }) {
  const icons = useApp(s => s.icons);
  const selection = useApp(s => s.selection);
  const minimapVisible = useApp(s => s.prefs.minimapVisible);
  const menu = useApp(s => s.menu);
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const readOnly = doc.readOnly;
  const { cards, edges } = doc.content;

  // 受控节点必须带上量好的尺寸，否则 React Flow 会把节点当成未初始化。
  const [measured, setMeasured] = useState<Map<string, Size>>(() => new Map());
  const measuredRef = useRef(measured);
  measuredRef.current = measured;
  const nodeCache = useRef(new Map<string, CardNodeType>());
  const edgeCache = useRef(new Map<string, FloatingEdgeType>());
  const boxSelecting = useRef(false);
  const connectCancelled = useRef(false);

  const iconUrls = useMemo(() => new Map(icons.map(i => [i.id, i.url])), [icons]);

  const nodes = useMemo(() => {
    const selected = new Set(selection.cardIds);
    const next: CardNodeType[] = cards.map(card => {
      const iconUrl = iconUrls.get(card.iconId) ?? DEFAULT_ICON_URL;
      const isSelected = selected.has(card.id);
      const size = measured.get(card.id);
      const prev = nodeCache.current.get(card.id);
      if (prev && prev.data.card === card && prev.data.iconUrl === iconUrl && prev.selected === isSelected && prev.measured === size && prev.draggable === !readOnly) return prev;
      return {
        id: card.id, type: 'card', position: { x: card.x, y: card.y }, data: { card, iconUrl },
        selected: isSelected, measured: size, draggable: !readOnly, connectable: !readOnly
      };
    });
    nodeCache.current = new Map(next.map(n => [n.id, n]));
    return next;
  }, [cards, selection.cardIds, measured, iconUrls, readOnly]);

  const flowEdges = useMemo(() => {
    const doing = new Set(cards.filter(c => c.status === 'doing').map(c => c.id));
    const next: FloatingEdgeType[] = edges.map(edge => {
      const flowing = isFlowing(edge, doing);
      const isSelected = selection.edgeId === edge.id;
      const prev = edgeCache.current.get(edge.id);
      if (prev && prev.data?.edge === edge && prev.data.flowing === flowing && prev.selected === isSelected) return prev;
      const color = isSelected ? COLORS.selected : flowing ? COLORS.flowing : COLORS.idle;
      const marker: EdgeMarker = { type: MarkerType.ArrowClosed, color, width: 18, height: 18 };
      return {
        id: edge.id, source: edge.a, target: edge.b, type: 'floating', selected: isSelected, data: { edge, flowing },
        markerEnd: edge.direction !== 'backward' ? marker : undefined,
        markerStart: edge.direction !== 'forward' ? marker : undefined,
        zIndex: isSelected ? 1 : 0
      };
    });
    edgeCache.current = new Map(next.map(e => [e.id, e]));
    return next;
  }, [edges, cards, selection.edgeId]);

  const onNodesChange = useCallback((changes: NodeChange<CardNodeType>[]) => {
    let sizes: Map<string, Size> | null = null;
    const positions = new Map<string, { x: number; y: number }>();
    let boxed: Set<string> | null = null;
    for (const change of changes) {
      if (change.type === 'dimensions' && change.dimensions) {
        sizes ??= new Map(measuredRef.current);
        sizes.set(change.id, change.dimensions);
      } else if (change.type === 'position' && change.position) {
        positions.set(change.id, change.position);
      } else if (change.type === 'select' && boxSelecting.current) {
        boxed ??= new Set(useApp.getState().selection.cardIds);
        if (change.selected) boxed.add(change.id); else boxed.delete(change.id);
      }
    }
    if (sizes) setMeasured(sizes);
    if (positions.size) moveCards(positions);
    if (boxed) useApp.setState({ selection: { cardIds: [...boxed], edgeId: null } });
  }, []);
  // 连线的选择由点击处理；框选只选卡片。
  const onEdgesChange = useCallback((_changes: EdgeChange<FloatingEdgeType>[]) => {}, []);

  useEffect(() => {
    registerConnectionCanceller(() => {
      connectCancelled.current = true;
      document.dispatchEvent(new MouseEvent('mouseup'));
    });
    return () => registerConnectionCanceller(null);
  }, []);

  const onConnectEnd: OnConnectEnd = useCallback((event, state) => {
    setConnecting(false);
    if (connectCancelled.current) return;
    const from = state.fromNode?.id;
    const to = state.toNode?.id ?? nodeIdAt(event);
    if (from && to && to !== from) connectCards(from, to);
  }, []);

  const centerOfView = () => {
    const rect = wrapper.current!.getBoundingClientRect();
    return flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  };

  const fitAll = useCallback(() => {
    if (cards.length) void flow.fitView({ padding: 0.15, maxZoom: 2, duration: 200 });
    else void flow.zoomTo(1, { duration: 200 });
  }, [cards.length, flow]);

  const onDragOver = (e: DragEvent) => {
    if (readOnly || !e.dataTransfer.types.includes(CARD_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e: DragEvent) => {
    if (readOnly || !e.dataTransfer.types.includes(CARD_DRAG_TYPE)) return;
    e.preventDefault();
    addCard(flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), false);
  };

  const contextCard = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    if (!useApp.getState().selection.cardIds.includes(id)) selectCards([id]);
    openMenu({ kind: 'card', x: e.clientX, y: e.clientY, cardId: id });
  };

  const menuItems = (() => {
    if (!menu) return null;
    if (menu.kind === 'card') {
      const ids = useApp.getState().selection.cardIds;
      const multi = ids.length > 1;
      return { x: menu.x, y: menu.y, items: [
        { label: '编辑', disabled: multi, run: () => selectCards([menu.cardId], true) },
        { label: '复制一张', disabled: readOnly, run: () => duplicateCards(multi ? ids : [menu.cardId]) },
        { label: '删除', disabled: readOnly, danger: true, run: () => deleteCards(multi ? ids : [menu.cardId]) }
      ] };
    }
    if (menu.kind === 'edge') {
      return { x: menu.x, y: menu.y, items: [
        { label: '编辑', run: () => selectEdge(menu.edgeId, true) },
        { label: '删除', disabled: readOnly, danger: true, run: () => deleteEdge(menu.edgeId) }
      ] };
    }
    if (menu.kind === 'pane') {
      return { x: menu.x, y: menu.y, items: [
        { label: '在这里新建卡片', disabled: readOnly, run: () => addCard(menu.flow, false) },
        { label: '适应全部', run: fitAll }
      ] };
    }
    return null;
  })();

  return (
    <div className={`board${readOnly ? ' read-only' : ''}`} ref={wrapper} onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow<CardNodeType, FloatingEdgeType>
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        defaultViewport={doc.viewport}
        onMoveEnd={(_e, viewport) => setViewport(doc.id, viewport)}
        minZoom={0.1}
        maxZoom={2}
        panOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        zoomActivationKeyCode="Meta"
        selectionKeyCode="Shift"
        multiSelectionKeyCode="Shift"
        deleteKeyCode={null}
        selectNodesOnDrag={false}
        disableKeyboardA11y
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        connectionMode={ConnectionMode.Loose}
        connectionLineStyle={{ stroke: '#6b7280', strokeWidth: 1.5, strokeDasharray: '6 4' }}
        proOptions={{ hideAttribution: true }}
        onSelectionStart={() => { boxSelecting.current = true; }}
        onSelectionEnd={() => { boxSelecting.current = false; }}
        onNodeClick={(e, node) => { if (e.shiftKey) toggleCard(node.id); else selectCards([node.id]); }}
        onNodeDoubleClick={(_e, node) => selectCards([node.id], true)}
        onNodeDragStart={(_e, node) => {
          if (!useApp.getState().selection.cardIds.includes(node.id)) selectCards([node.id]);
          beginStep('drag');
        }}
        onNodeDragStop={() => endStep()}
        onSelectionDragStart={() => beginStep('drag')}
        onSelectionDragStop={() => endStep()}
        onEdgeClick={(e, edge) => { e.stopPropagation(); selectEdge(edge.id); }}
        onEdgeDoubleClick={(_e, edge) => selectEdge(edge.id, true)}
        onPaneClick={() => clearSelection()}
        onNodeContextMenu={(e, node) => contextCard(e, node.id)}
        onEdgeContextMenu={(e, edge) => { e.preventDefault(); selectEdge(edge.id); openMenu({ kind: 'edge', x: e.clientX, y: e.clientY, edgeId: edge.id }); }}
        onPaneContextMenu={e => {
          e.preventDefault();
          clearSelection();
          openMenu({ kind: 'pane', x: e.clientX, y: e.clientY, flow: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
        }}
        onConnectStart={() => { connectCancelled.current = false; setConnecting(true); }}
        onConnectEnd={onConnectEnd}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.6} color="#cfd3d9" />
        {minimapVisible && <MiniMap pannable zoomable nodeColor="#d9dce1" nodeStrokeColor="#9ca3af" maskColor="rgba(240, 242, 245, 0.6)" />}
      </ReactFlow>
      {cards.length === 0 && <div className="empty-hint">点左上角「+ 卡片」新建卡片，也可以把它拖到想放的位置</div>}
      <Toolbar disabled={readOnly} onAdd={() => addCard(centerOfView(), true)} />
      <ZoomControls minimapVisible={minimapVisible} onFit={fitAll} />
      {menuItems && <FloatingMenu {...menuItems} />}
    </div>
  );
}

export function Toolbar({ disabled, onAdd }: { disabled: boolean; onAdd?: () => void }) {
  return (
    <div className="toolbar">
      <button
        className="btn add-card"
        disabled={disabled}
        draggable={!disabled}
        onClick={() => onAdd?.()}
        onDragStart={e => { e.dataTransfer.setData(CARD_DRAG_TYPE, '1'); e.dataTransfer.effectAllowed = 'copy'; }}
        title="点击在视野中心新建，或拖到想放的位置"
      >
        + 卡片
      </button>
    </div>
  );
}

function ZoomControls({ minimapVisible, onFit }: { minimapVisible: boolean; onFit: () => void }) {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div className={`zoom-controls${minimapVisible ? ' with-minimap' : ''}`}>
      {minimapVisible
        ? <button className="minimap-toggle" title="隐藏小地图" onClick={() => savePrefs({ minimapVisible: false })}>隐藏小地图</button>
        : <button className="minimap-toggle" title="显示小地图" onClick={() => savePrefs({ minimapVisible: true })}>显示小地图</button>}
      <div className="zoom-group">
        <button title="缩小" onClick={() => void flow.zoomOut({ duration: 150 })} disabled={zoom <= 0.1001}>－</button>
        <span className="zoom-value">{Math.round(zoom * 100)}%</span>
        <button title="放大" onClick={() => void flow.zoomIn({ duration: 150 })} disabled={zoom >= 1.999}>＋</button>
        <button title="适应全部" onClick={onFit}>⤢</button>
      </div>
    </div>
  );
}

