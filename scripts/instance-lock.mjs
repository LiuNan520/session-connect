export function assertDarwin(platform = process.platform) {
  if (platform !== 'darwin') throw new Error('会话连接只支持 macOS');
}
export function tryLock(home) {
  assertDarwin();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    // Darwin sys/fcntl.h: O_EXLOCK = 0x20。锁文件的 inode 永远不替换。
    return fs.openSync(join(home, 'instance.lock'), fs.constants.O_RDWR | fs.constants.O_CREAT | 0x20 | fs.constants.O_NONBLOCK, 0o600);
  } catch (error) {
    if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') return null;
    throw error;
  }
}
export function readLock(home) {
  try {
    const record = JSON.parse(fs.readFileSync(join(home, 'instance.lock'), 'utf8'));
    if (!Number.isInteger(record.pid) || record.pid <= 0 || !['app', 'dev'].includes(record.mode)
      || !(record.port === null || Number.isInteger(record.port) && record.port >= 4319 && record.port <= 4339)
      || typeof record.startedAt !== 'string') return null;
    return record;
  } catch { return null; }
}
export function writeLock(fd, record) {
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, JSON.stringify(record), 0, 'utf8');
  fs.fsyncSync(fd);
}
import fs from 'node:fs';
import { join } from 'node:path';

