import type { ApiResult } from '../api';
import type { Canvas, State } from '#shared';

export interface LocalCanvasInfo {
  id: string;
  /** 本页知道的服务端 revision。 */
  revision: number;
  /** 有未保存改动或请求在途（含被拒后的只读画布）。 */
  busy: boolean;
}

export interface MergePlan {
  /** 合并后的画布顺序（= 服务端顺序）。 */
  order: string[];
  /** 服务端新增的画布。 */
  added: Canvas[];
  /** 用服务端内容替换的画布。 */
  replaced: Canvas[];
  /** 服务端已删除的画布 id。 */
  removed: string[];
  /** 名称（不改 revision）以服务端为准。 */
  names: Record<string, string>;
}

/**
 * 刷新合并规则（技术方案"刷新与合并"）：
 * - 空闲的画布（没有未保存改动、没有请求在途）：服务端 revision 大于本地时才替换；
 * - 「重新加载」的那张（force）直接替换；
 * - 忙的画布保留本地内容，之后保存时按 409 处理；
 * - 服务端新增的加进来，已删除的移除。
 */
export function planMerge(local: readonly LocalCanvasInfo[], server: readonly Canvas[], force: ReadonlySet<string>): MergePlan {
  const localById = new Map(local.map(c => [c.id, c]));
  const serverIds = new Set(server.map(c => c.id));
  const plan: MergePlan = { order: server.map(c => c.id), added: [], replaced: [], removed: [], names: {} };
  for (const canvas of server) {
    const mine = localById.get(canvas.id);
    plan.names[canvas.id] = canvas.name;
    if (!mine) { plan.added.push(canvas); continue; }
    if (force.has(canvas.id)) { plan.replaced.push(canvas); continue; }
    if (!mine.busy && canvas.revision > mine.revision) plan.replaced.push(canvas);
  }
  for (const c of local) if (!serverIds.has(c.id)) plan.removed.push(c.id);
  return plan;
}

/** 切回标签页时，用 meta 判断要不要拉全量。 */
export function metaDiffers(local: readonly { id: string; name: string; revision: number }[], meta: readonly { id: string; name: string; revision: number }[]): boolean {
  if (local.length !== meta.length) return true;
  return meta.some((m, i) => m.id !== local[i].id || m.name !== local[i].name || m.revision !== local[i].revision);
}

/**
 * 刷新请求的过期判定：
 * - 每次刷新带递增代次号，只采用最后发出的那次；
 * - 发出之后本页有任何写请求成功，就丢弃这次响应，再拉一次。
 */
export class RefreshController {
  private generation = 0;
  private writeEpoch = 0;
  private force = new Set<string>();

  constructor(private deps: {
    fetchState(): Promise<ApiResult<State>>;
    apply(state: State, force: ReadonlySet<string>): void;
  }) {}

  /** 任何写请求成功后调用（保存、画布增删改、图标增删、导入）。 */
  noteWrite(): void { this.writeEpoch++; }

  /** 返回 true 表示这次（或接力的那次）响应被采用。 */
  async refresh(forceCanvasId?: string): Promise<boolean> {
    if (forceCanvasId) this.force.add(forceCanvasId);
    for (;;) {
      const generation = ++this.generation;
      const epoch = this.writeEpoch;
      const result = await this.deps.fetchState();
      if (generation !== this.generation) return false; // 有更新的刷新，交给它
      if (!result.ok) return false;
      if (epoch !== this.writeEpoch) continue; // 期间有写入成功，重拉
      const force = this.force;
      this.force = new Set();
      this.deps.apply(result.data, force);
      return true;
    }
  }
}
