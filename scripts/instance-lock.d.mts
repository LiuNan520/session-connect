export interface LockRecord { pid: number; port: number | null; mode: 'app' | 'dev'; startedAt: string }
export function assertDarwin(platform?: string): void;
export function tryLock(home: string): number | null;
export function readLock(home: string): LockRecord | null;
export function writeLock(fd: number, record: LockRecord): void;
