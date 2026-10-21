export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string,
    public extra: Record<string, unknown> = {}) { super(message); }
}

export class WriteError extends ApiError {
  readonly reason: 'disk_full' | 'no_permission' | 'other';
  constructor(cause: unknown) {
    const code = (cause as NodeJS.ErrnoException)?.code;
    const reason = code === 'ENOSPC' ? 'disk_full' : code === 'EACCES' || code === 'EPERM' ? 'no_permission' : 'other';
    super(500, 'WRITE_FAILED', '写入失败', { reason });
    this.reason = reason;
    this.cause = cause;
  }
}
