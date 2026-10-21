import type { ApiResult } from '../api';
import type { ImportResult } from '#shared';

/**
 * 导入结果未知（连接断开）后的核对。待确认的 importId 只放在页面内存里。
 * 服务恢复后调用 verify()：
 * - 200：按成功处理，然后 ack；
 * - 202：每秒再查一次；
 * - 404：这次导入没有提交；
 * - 查询本身连不上：继续待确认，等下次服务恢复再查。
 */
export class ImportTracker {
  pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private checking = false;

  constructor(private deps: {
    query(importId: string): Promise<ApiResult<ImportResult | { code: string }>>;
    onDone(result: ImportResult, importId: string): void;
    onNotFound(importId: string): void;
    pollMs?: number;
  }) {}

  setPending(importId: string): void { this.pending = importId; }

  async verify(): Promise<void> {
    const importId = this.pending;
    if (!importId || this.checking) return;
    this.checking = true;
    let result: ApiResult<ImportResult | { code: string }>;
    try { result = await this.deps.query(importId); } finally { this.checking = false; }
    if (this.pending !== importId) return;
    if (result.ok && result.status === 202) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; void this.verify(); }, this.deps.pollMs ?? 1000);
      return;
    }
    if (result.ok) {
      this.pending = null;
      this.deps.onDone(result.data as ImportResult, importId);
      return;
    }
    if (result.kind === 'http' && result.status === 404) {
      this.pending = null;
      this.deps.onNotFound(importId);
    }
    // 连不上：保持待确认。
  }
}
