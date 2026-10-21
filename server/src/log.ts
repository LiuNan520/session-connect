import fs from 'node:fs';
import { join } from 'node:path';
import type { Log } from './store.js';

export function createLog(home: string, rotate = true): Log {
  const directory = join(home, 'logs'), path = join(directory, 'server.log');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (rotate && fs.existsSync(path) && fs.statSync(path).size > 5 * 1024 * 1024) fs.renameSync(path, `${path}.1`);
  return (event, detail = {}) => {
    // 调用方仅传事件、错误码和路径，禁止记录请求体、卡片或导入文件内容。
    try {
      fs.appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`, { mode: 0o600 });
    } catch {
      // 磁盘满或权限丢失时，日志失败不能遮住业务写盘错误，或把已提交的事务报成失败。
    }
  };
}
