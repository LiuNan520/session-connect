import type { ApiError } from '#shared';

// 所有请求的统一结果：network 表示没拿到回复（连不上、断开、超时），结果未知。
export type ApiResult<T> =
  | { ok: true; status: number; data: T; headers: Headers }
  | { ok: false; kind: 'network' }
  | { ok: false; kind: 'http'; status: number; error: ApiError };

export interface RequestOptions {
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  /** 毫秒；0 表示不设超时（导入用）。 */
  timeoutMs?: number;
  parse?: 'json' | 'blob' | 'none';
}

const DEFAULT_TIMEOUT = 30_000;
const HEALTH_POLL_MS = 5_000;

// ---- 连通性：任何请求连不上就进入离线，离线期间每 5 秒探测一次；恢复时通知订阅者。
type Listener = (online: boolean) => void;
let online = true;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<Listener>();

export function onConnectivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function isOnline(): boolean { return online; }

function setOnline(value: boolean) {
  if (value === online) return;
  online = value;
  if (!value && !pollTimer) pollTimer = setInterval(() => { void request('GET', '/api/health'); }, HEALTH_POLL_MS);
  if (value && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  for (const listener of listeners) listener(value);
}

export async function request<T = unknown>(method: string, url: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...options.headers };
  let body = options.body;
  if (options.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(options.json); }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response: Response;
  try {
    response = await fetch(url, { method, headers, body, signal: controller.signal, cache: 'no-store' });
  } catch {
    if (timer) clearTimeout(timer);
    setOnline(false);
    return { ok: false, kind: 'network' };
  }
  try {
    if (!response.ok) {
      let error: ApiError = { code: `HTTP_${response.status}`, message: response.statusText };
      try { error = await response.json() as ApiError; } catch { /* 非 JSON 错误体 */ }
      setOnline(true);
      return { ok: false, kind: 'http', status: response.status, error };
    }
    const parse = options.parse ?? 'json';
    let data: unknown = null;
    if (response.status !== 204 && parse === 'json') data = await response.json();
    else if (parse === 'blob') data = await response.blob();
    setOnline(true);
    return { ok: true, status: response.status, data: data as T, headers: response.headers };
  } catch {
    // 读响应体中途断开：结果同样未知。
    setOnline(false);
    return { ok: false, kind: 'network' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const OFFLINE_MESSAGE = '连不上本地服务，请重新打开会话连接后再试';
