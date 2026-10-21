import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, Position, getBezierPath, useInternalNode, type Edge as FlowEdge, type EdgeProps, type InternalNode } from '@xyflow/react';
import type { Edge } from '#shared';
import { floatingEnds, type Rect, type Side } from '../logic/geometry';
import { CARD_DEFAULT_SIZE, openMenu, selectEdge } from '../store';

export type FloatingEdgeType = FlowEdge<{ edge: Edge; flowing: boolean }, 'floating'>;

const POSITION: Record<Side, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

function rect(node: InternalNode): Rect {
  return {
    x: node.internals.positionAbsolute.x, y: node.internals.positionAbsolute.y,
    width: node.measured.width ?? CARD_DEFAULT_SIZE.width, height: node.measured.height ?? CARD_DEFAULT_SIZE.height
  };
}

/** 端点落在两张卡片最近两条边的中点；进行中时流动虚线（CSS stroke-dashoffset），双向只虚线不流动。 */
export const FloatingEdge = memo(function FloatingEdge({ id, source, target, markerStart, markerEnd, data, selected }: EdgeProps<FloatingEdgeType>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode || !data) return null;
  const { from, fromSide, to, toSide } = floatingEnds(rect(sourceNode), rect(targetNode));
  const [path, labelX, labelY] = getBezierPath({
    sourceX: from.x, sourceY: from.y, sourcePosition: POSITION[fromSide],
    targetX: to.x, targetY: to.y, targetPosition: POSITION[toSide]
  });
  const { edge, flowing } = data;
  const classes = ['edge-path'];
  if (flowing) classes.push('flowing', edge.direction === 'forward' ? 'flow-forward' : edge.direction === 'backward' ? 'flow-backward' : 'flow-still');
  if (selected) classes.push('is-selected');
  return (
    <>
      <BaseEdge id={id} path={path} markerStart={markerStart} markerEnd={markerEnd} className={classes.join(' ')} interactionWidth={24} />
      {edge.label && (
        <EdgeLabelRenderer>
          <div
            className={`edge-label nodrag nopan${selected ? ' is-selected' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={e => { e.stopPropagation(); selectEdge(id); }}
            onDoubleClick={e => { e.stopPropagation(); selectEdge(id, true); }}
            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); selectEdge(id); openMenu({ kind: 'edge', x: e.clientX, y: e.clientY, edgeId: id }); }}
          >
            {edge.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
