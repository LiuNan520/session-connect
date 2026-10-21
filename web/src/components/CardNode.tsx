import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { Card } from '#shared';
import { STATUS_LABELS } from '../store';
import { IconImg } from './common';

export type CardNodeType = Node<{ card: Card; iconUrl: string }, 'card'>;

const SIDES = [
  ['top', Position.Top], ['right', Position.Right], ['bottom', Position.Bottom], ['left', Position.Left]
] as const;

/** 卡片：状态圆点、图标、名称、备注，四边各一个连接点。 */
export const CardNode = memo(function CardNode({ data, selected, dragging }: NodeProps<CardNodeType>) {
  const { card, iconUrl } = data;
  const tooltip = card.note ? `${card.name}\n${card.note}` : card.name;
  return (
    <div className={`card${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`} title={tooltip}>
      <div className="card-row">
        <span className={`dot dot-${card.status}`} title={STATUS_LABELS[card.status]} />
        <IconImg className="card-icon" src={iconUrl} />
        <span className="card-name">{card.name}</span>
      </div>
      {card.note && <div className="card-note">{card.note}</div>}
      {SIDES.map(([id, position]) => (
        <Handle key={id} id={id} type="source" position={position} className="handle" />
      ))}
    </div>
  );
});
