import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
/** 先构建到 .new，再整体改名；失败时恢复旧应用。 */
export async function installApp(source, applications, operations = {}) {
  const copy = operations.copy ?? (async (from, to) => { await exec('/usr/bin/ditto', [from, to]); });
  const rename = operations.rename ?? fs.rename;
  const target = join(applications, '会话连接.app');
  const fresh = join(applications, '.会话连接.app.new');
  const old = join(applications, '.会话连接.app.old');
  // 不覆盖上次失败后仍可人工恢复的包。
  if (existsSync(fresh) || existsSync(old)) throw new Error('发现上次安装留下的 .new/.old 应用包，请先检查后再生成');
  try { await copy(source, fresh); }
  catch (error) { await fs.rm(fresh, { recursive: true, force: true }); throw error; }
  const hadOld = existsSync(target);
  try {
    if (hadOld) await rename(target, old);
    try { await rename(fresh, target); }
    catch (error) {
      if (hadOld) await rename(old, target);
      throw error;
    }
  } catch (error) { await fs.rm(fresh, { recursive: true, force: true }); throw error; }
  if (hadOld) await fs.rm(old, { recursive: true, force: true });
}
