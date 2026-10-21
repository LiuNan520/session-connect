import type { ApiResult } from '../api';
import type { CanvasContent, SaveContentRequest } from '#shared';

export type SaverStatus = 'idle' | 'saving' | 'offline' | 'failed' | 'conflict' | 'deleted';
export type WriteReason = 'disk_full' | 'no_permission' | 'other';

export interface SaverSnapshot {
  status: SaverStatus;
  reason?: WriteReason;
  /** 有还没成功写进数据文件的改动。 */
  dirty: boolean;
  inflight: boolean;
}

export interface SaverDeps {
  put(body: SaveContentRequest): Promise<ApiResult<{ revision: number }>>;
  getContent(): CanvasContent;
  newId(): string;
  onChange(snapshot: SaverSnapshot): void;
  onSaved?(revision: number): void;
  onConflict?(revision: number | undefined): void;
  onDeleted?(): void;
  debounceMs?: number;
  retryMs?: number;
}

interface Inflight { body: SaveContentRequest; version: number; unknown: boolean }

/**
 * 一张画布的保存队列（技术方案"前端任务 · 保存队列"）：
 * - 停手 800ms 后保存，同一时间最多一个请求在途；在途时又有改动，等它返回后再存。
 * - 结果未知（网络错误、超时）：每 5 秒原样重试同一个请求，拿到明确结果后才发之后的新内容。
 * - WRITE_FAILED（明确没写入）：每 5 秒重试，内容换成最新的，并换新的 saveId。
 * - 409：只读，停止；404：画布已删除，停止。
 */
export class CanvasSaver {
  revision: number;
  private version = 0;
  private savedVersion = 0;
  private inflight: Inflight | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private status: SaverStatus = 'idle';
  private reason: WriteReason | undefined;
  private stopped = false;
  private waiters: ((ok: boolean) => void)[] = [];
  private readonly debounceMs: number;
  private readonly retryMs: number;

  constructor(revision: number, private deps: SaverDeps) {
    this.revision = revision;
    this.debounceMs = deps.debounceMs ?? 800;
    this.retryMs = deps.retryMs ?? 5000;
  }

  get dirty(): boolean { return this.version > this.savedVersion; }
  /** 有未保存改动或请求在途。 */
  get busy(): boolean { return this.dirty || this.inflight !== null; }
  get halted(): boolean { return this.stopped; }

  snapshot(): SaverSnapshot {
    return { status: this.status, reason: this.reason, dirty: this.dirty, inflight: this.inflight !== null };
  }

  /** 内容改了一次。 */
  changed(): void {
    this.version++;
    if (this.stopped) { this.emit(); return; }
    // 重试等待中：由重试定时器统一发送，不另起请求。
    if (!this.retryTimer) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => { this.debounceTimer = null; if (!this.inflight) void this.send(); }, this.debounceMs);
    }
    this.emit();
  }

  /** 立刻把未保存改动存上（导出前用）。存上返回 true，出错返回 false。 */
  flush(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(!this.busy);
    if (!this.busy) return Promise.resolve(true);
    const promise = new Promise<boolean>(resolve => this.waiters.push(resolve));
    if (!this.inflight || this.inflight.unknown) void this.send();
    return promise;
  }

  /** 内容被服务端替换（空闲时才会发生）：以服务端 revision 为准，清掉未保存标记，恢复可保存。 */
  reset(revision: number): void {
    this.clearTimers();
    this.inflight = null;
    this.revision = revision;
    this.savedVersion = this.version;
    this.status = 'idle';
    this.reason = undefined;
    this.stopped = false;
    this.emit();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.inflight = null;
    this.resolveWaiters(false);
  }

  private clearTimers() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.debounceTimer = this.retryTimer = null;
  }

  private emit() { this.deps.onChange(this.snapshot()); }

  private resolveWaiters(ok: boolean) {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(ok);
  }

  private scheduleRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.send(); }, this.retryMs);
  }

  private async send(): Promise<void> {
    if (this.stopped) return;
    if (this.inflight && !this.inflight.unknown) return;
    this.clearTimers();
    let request: Inflight;
    if (this.inflight?.unknown) {
      request = this.inflight; // 原样重试：同 baseRevision、saveId 和内容
    } else {
      if (!this.dirty) { this.emit(); this.resolveWaiters(true); return; }
      const content = this.deps.getContent();
      request = { body: { baseRevision: this.revision, saveId: this.deps.newId(), cards: content.cards, edges: content.edges }, version: this.version, unknown: false };
    }
    request.unknown = false;
    this.inflight = request;
    this.status = 'saving';
    this.reason = undefined;
    this.emit();

    const result = await this.deps.put(request.body);
    if (this.inflight !== request || this.stopped) return;

    if (result.ok) {
      this.inflight = null;
      this.revision = result.data.revision;
      this.savedVersion = Math.max(this.savedVersion, request.version);
      this.status = 'idle';
      this.deps.onSaved?.(this.revision);
      this.emit();
      if (this.dirty) {
        if (this.waiters.length > 0) void this.send();
        else if (!this.debounceTimer) void this.send();
      } else {
        this.resolveWaiters(true);
      }
      return;
    }

    if (result.kind === 'http' && result.status === 409) {
      this.inflight = null;
      this.status = 'conflict';
      this.stopped = true;
      this.clearTimers();
      this.emit();
      this.resolveWaiters(false);
      this.deps.onConflict?.(result.error.revision);
      return;
    }
    if (result.kind === 'http' && result.status === 404) {
      this.inflight = null;
      this.status = 'deleted';
      this.stopped = true;
      this.clearTimers();
      this.emit();
      this.resolveWaiters(false);
      this.deps.onDeleted?.();
      return;
    }
    if (result.kind === 'http' && (result.error.code === 'WRITE_FAILED' || (result.status >= 400 && result.status < 500 && result.status !== 403))) {
      // 明确没写入：下次用最新内容和新 saveId。
      this.inflight = null;
      this.status = 'failed';
      this.reason = result.error.code === 'WRITE_FAILED' ? result.error.reason ?? 'other' : 'other';
    } else {
      // 结果未知：网络错误、超时、403、其他 5xx——原样重试同一个请求。
      request.unknown = true;
      this.status = 'offline';
      this.reason = undefined;
    }
    this.scheduleRetry();
    this.emit();
    this.resolveWaiters(false);
  }
}
