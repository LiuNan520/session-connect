import type { ApiResult } from '../api';

/**
 * 视野、偏好设置的保存：停手一段时间后发送最新值，同一时间只有一个请求；
 * 失败时静默每 5 秒重试，不计入保存状态。404（画布已删除）就停止。
 */
export class LatestSaver<T> {
  private value: T | undefined;
  private pending = false;
  private inflight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private send: (value: T) => Promise<ApiResult<unknown>>, private debounceMs = 1000, private retryMs = 5000) {}

  set(value: T): void {
    if (this.stopped) return;
    this.value = value;
    this.pending = true;
    this.schedule(this.debounceMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, ms);
  }

  private async flush() {
    if (this.stopped || this.inflight || !this.pending) return;
    this.inflight = true;
    this.pending = false;
    const result = await this.send(this.value as T);
    this.inflight = false;
    if (this.stopped) return;
    if (!result.ok) {
      if (result.kind === 'http' && result.status === 404) { this.stop(); return; }
      if (result.kind === 'http' && result.status === 400) return; // 值本身不合法，重试也没用
      this.pending = true;
      this.schedule(this.retryMs);
      return;
    }
    if (this.pending && !this.timer) this.schedule(0);
  }
}
