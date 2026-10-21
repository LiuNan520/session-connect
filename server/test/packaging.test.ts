import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installApp } from '../../scripts/app-install.mjs';

const exec = promisify(execFile);
let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'session-connect-package-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
describe('应用安装整体替换', () => {
  async function setup() {
    const source = join(directory, 'source.app'), applications = join(directory, 'Applications');
    await fs.mkdir(source); await fs.writeFile(join(source, 'new.txt'), 'new bundle');
    await fs.mkdir(join(applications, '会话连接.app'), { recursive: true });
    await fs.writeFile(join(applications, '会话连接.app', 'old.txt'), 'old bundle');
    return { source, applications };
  }
  it('成功时整体换包并清理 .old/.new，不混合旧文件', async () => {
    const { source, applications } = await setup();
    await installApp(source, applications);
    expect(await fs.readdir(applications)).toEqual(['会话连接.app']);
    expect(await fs.readdir(join(applications, '会话连接.app'))).toEqual(['new.txt']);
  });
  it('复制 .new 中途失败，旧应用原样保留并删除半成品', async () => {
    const { source, applications } = await setup();
    await expect(installApp(source, applications, { copy: async (_source: string, target: string) => {
      await fs.mkdir(target); await fs.writeFile(join(target, 'partial'), 'partial'); throw new Error('模拟复制失败');
    } })).rejects.toThrow('模拟复制失败');
    expect(await fs.readFile(join(applications, '会话连接.app/old.txt'), 'utf8')).toBe('old bundle');
    expect(await fs.readdir(applications)).toEqual(['会话连接.app']);
  });
  it('第 3 步 .new 改名失败，恢复 .old，旧应用没有变化', async () => {
    const { source, applications } = await setup();
    await expect(installApp(source, applications, { rename: async (from: string, to: string) => {
      if (from.endsWith('.app.new')) throw new Error('模拟第 3 步失败');
      return fs.rename(from, to);
    } })).rejects.toThrow('模拟第 3 步失败');
    expect(await fs.readdir(applications)).toEqual(['会话连接.app']);
    expect(await fs.readFile(join(applications, '会话连接.app/old.txt'), 'utf8')).toBe('old bundle');
  });
});

describe('应用启动脚本退出码', () => {
  async function project(node = process.execPath) {
    const root = join(directory, '带空格的 项目');
    await fs.mkdir(join(root, 'scripts'), { recursive: true });
    await fs.copyFile(resolve('scripts/app-launch.sh'), join(root, 'scripts/app-launch.sh'));
    await fs.writeFile(join(root, '.app-config'), `NODE=${node}\n`);
    return root;
  }
  async function launch(root: string) {
    try { const result = await exec('/bin/sh', [join(root, 'scripts/app-launch.sh')], { env: { ...process.env, SESSION_CONNECT_HOME: join(directory, 'data') } }); return { code: 0, ...result }; }
    catch (error) { const e = error as { code: number; stdout: string; stderr: string }; return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
  }
  async function fakeServer(root: string, line: string) {
    await fs.mkdir(join(root, 'dist/server'), { recursive: true }); await fs.mkdir(join(root, 'dist/web'), { recursive: true });
    await fs.writeFile(join(root, 'dist/web/index.html'), '占位');
    await fs.writeFile(join(root, 'dist/server/index.js'), `const fs=require('node:fs'); fs.writeFileSync(process.argv[process.argv.indexOf('--handshake')+1], ${JSON.stringify(line)}+'\\n');`);
  }
  it('找不到 Node 返回 10；未构建返回 11', async () => {
    const root = await project('/不存在的 node'); expect((await launch(root)).code).toBe(10);
    await fs.writeFile(join(root, '.app-config'), `NODE=${process.execPath}\n`); expect((await launch(root)).code).toBe(11);
  });
  it.each([
    ['READY http://127.0.0.1:4319 12345', 0, 'http://127.0.0.1:4319\t12345\n'],
    ['RUNNING http://127.0.0.1:4320', 3, 'http://127.0.0.1:4320\n'],
    ['ERROR 模拟启动失败', 12, '模拟启动失败']
  ])('正确转交握手 %s', async (line, code, stdout) => {
    const root = await project(); await fakeServer(root, line);
    const result = await launch(root); expect(result.code).toBe(code); expect(result.stdout).toContain(stdout);
    if (code === 12) expect(result.stdout).toContain('/logs');
  });
});
