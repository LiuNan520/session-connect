import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { appleScriptFor, configureAppBundle } from '../../scripts/build-app.mjs';
import { makePerfFixture } from '../../scripts/make-perf-fixture.mjs';
import { createApp } from '../src/app.js';
import { host } from './helpers.js';

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'session-connect-applet-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
it('生成的常驻 applet 具备 run/idle/reopen/quit，复杂路径也可被 osacompile 编译', async () => {
  const source = appleScriptFor('/tmp/会话 "连接"/带空格\\test');
  for (const handler of ['on run', 'on idle', 'on reopen', 'on quit']) expect(source).toContain(handler);
  expect(source).toContain('找不到 Node.js，请先安装 Node.js 再打开会话连接。');
  expect(source).toContain('ownsService');
  const file = join(directory, 'launcher.applescript'); await fs.writeFile(file, source);
  await promisify(execFile)('/usr/bin/osacompile', ['-s', '-o', join(directory, '测试.app'), file]);
  expect(await fs.stat(join(directory, '测试.app/Contents/MacOS/applet')).then(s => s.isFile())).toBe(true);
});
it('应用包的鸽子图标不会被 osacompile 的默认图标覆盖', async () => {
  const file = join(directory, 'launcher.applescript'), bundle = join(directory, '测试.app');
  await fs.writeFile(file, appleScriptFor(directory));
  await promisify(execFile)('/usr/bin/osacompile', ['-s', '-o', bundle, file]);
  await configureAppBundle(bundle, join(directory, 'app.iconset'));
  expect((await fs.stat(join(bundle, 'Contents/Resources/applet.icns'))).size).toBeGreaterThan(0);
  const { stdout } = await promisify(execFile)('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(bundle, 'Contents/Info.plist')]);
  const plist = JSON.parse(stdout);
  expect(plist).toMatchObject({ CFBundleDisplayName: '会话连接', CFBundleIconFile: 'applet.icns' });
  expect(plist).not.toHaveProperty('CFBundleIconName');
  expect(await fs.stat(join(bundle, 'Contents/Resources/Assets.car')).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })).toBe(false);
  const extracted = join(directory, 'extracted.iconset');
  await promisify(execFile)('/usr/bin/iconutil', ['-c', 'iconset', '-o', extracted, join(bundle, 'Contents/Resources/applet.icns')]);
  const source = await fs.readFile(new URL('../../assets/app-icon/app-icon.svg', import.meta.url), 'utf8');
  const expected = new Resvg(source, { fitTo: { mode: 'width', value: 256 } }).render().asPng();
  expect(await sharp(join(extracted, 'icon_128x128@2x.png')).raw().toBuffer()).toEqual(await sharp(expected).raw().toBuffer());
});
it('项目确实存在时，app 使用的目录检查命令在 macOS 上可以执行', async () => {
  const source = appleScriptFor(directory);
  const check = source.split('\n').find(line => /do shell script .* -d /.test(line))!;
  expect(check).toBeDefined();
  await promisify(execFile)('/usr/bin/osascript', ['-e', `set projectPath to ${JSON.stringify(directory)}\n${check}`]);
});
it('项目路径带末尾斜线时，也能认出自己启动的服务进程', async () => {
  const source = appleScriptFor(`${directory}/`);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)', `${directory}/dist/server/index.js`]);
  try {
    const projectProperty = source.split('\n').find(line => line.startsWith('property projectPath'))!;
    const handler = source.slice(source.indexOf('on serviceAlive()'), source.indexOf('end serviceAlive') + 'end serviceAlive'.length);
    const result = await promisify(execFile)('/usr/bin/osascript', ['-e', `${projectProperty}\nproperty servicePid : ${child.pid}\n${handler}\nreturn serviceAlive()`]);
    expect(result.stdout.trim()).toBe('true');
  } finally { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
});
it('性能夹具包含200卡片300条唯一有效连线，能通过实际导入接口', async () => {
  const fixture = makePerfFixture();
  expect(fixture).toMatchObject({ format: 'session-connect-export', formatVersion: 1, canvases: [{ cards: expect.any(Array), edges: expect.any(Array) }], icons: [] });
  expect(fixture.canvases[0].cards).toHaveLength(200); expect(fixture.canvases[0].edges).toHaveLength(300);
  const app = await createApp({ home: join(directory, 'data'), port: 4319 });
  try {
    const { randomUUID } = await import('node:crypto');
    const response = await app.inject({ method: 'POST', url: '/api/import', headers: { host, 'x-import-id': randomUUID() }, payload: fixture });
    expect(response.statusCode).toBe(200);
  } finally { await app.close(); }
});
