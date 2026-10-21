import fs from 'node:fs/promises';
import { closeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { Resvg } from '@resvg/resvg-js';
import { assertDarwin, readLock, tryLock } from './instance-lock.mjs';
import { installApp } from './app-install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export function appleScriptFor(projectPath) {
  projectPath = resolve(projectPath);
  return `property projectPath : ${JSON.stringify(projectPath)}
property servicePid : 0
property serviceURL : ""
property ownsService : false

on showFailure(messageText)
  display dialog messageText with title "会话连接" buttons {"好"} default button "好" with icon stop
  quit
end showFailure

on serviceAlive()
  if servicePid is 0 then return false
  try
    set commandLine to do shell script "/bin/kill -0 " & servicePid & " 2>/dev/null && /bin/ps -p " & servicePid & " -o command="
    return commandLine contains (projectPath & "/dist/server/index.js")
  on error
    return false
  end try
end serviceAlive

on run
  set servicePid to 0
  set serviceURL to ""
  set ownsService to false
  try
    do shell script "/bin/test -d " & quoted form of projectPath
  on error
    my showFailure("找不到会话连接的项目目录：" & projectPath & "。如果移动过项目，请在新目录里运行 npm run app 重新生成应用。")
    return
  end try
  try
    set launchResult to do shell script "/bin/sh " & quoted form of (projectPath & "/scripts/app-launch.sh")
    set previousDelimiters to AppleScript's text item delimiters
    set AppleScript's text item delimiters to tab
    set serviceURL to text item 1 of launchResult
    set servicePid to (text item 2 of launchResult) as integer
    set AppleScript's text item delimiters to previousDelimiters
    set ownsService to true
    do shell script "/usr/bin/open " & quoted form of serviceURL
  on error errorText number errorNumber
    if errorNumber is 3 then
      set serviceURL to paragraph 1 of errorText
      do shell script "/usr/bin/open " & quoted form of serviceURL
      quit
    else if errorNumber is 10 then
      my showFailure("找不到 Node.js，请先安装 Node.js 再打开会话连接。")
    else if errorNumber is 11 then
      my showFailure("会话连接启动失败：缺少构建文件，请在项目目录运行 npm run app。日志在 ~/.session-connect/logs。")
    else
      my showFailure("会话连接启动失败：" & errorText)
    end if
  end try
end run

on idle
  if ownsService and not my serviceAlive() then quit
  return 3
end idle

on reopen
  if ownsService and my serviceAlive() then
    do shell script "/usr/bin/open " & quoted form of serviceURL
  else
    quit
  end if
end reopen

on quit
  if ownsService and my serviceAlive() then
    try
      do shell script "/bin/kill -TERM " & servicePid
    end try
  end if
  continue quit
end quit
`;
}

export function assertAppStopped(dataHome) {
  const fd = tryLock(dataHome);
  if (fd !== null) { closeSync(fd); return; }
  if (readLock(dataHome)?.mode === 'app') throw new Error('会话连接正在运行，请先在程序坞里退出它再重新生成');
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败（退出码 ${result.status}）`);
}

export async function configureAppBundle(bundle, iconset) {
  await fs.mkdir(iconset);
  const source = await fs.readFile(join(root, 'assets/app-icon/app-icon.svg'), 'utf8');
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const png = new Resvg(source, { fitTo: { mode: 'width', value: size * scale } }).render().asPng();
      await fs.writeFile(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`), png);
    }
  }
  const icon = join(bundle, 'Contents/Resources/applet.icns');
  run('/usr/bin/iconutil', ['-c', 'icns', '-o', icon, iconset]);
  const plist = join(bundle, 'Contents/Info.plist');
  // osacompile 的默认资源图标会覆盖 CFBundleIconFile 指定的鸽子图标。
  const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
  if (Object.hasOwn(info, 'CFBundleIconName')) run('/usr/libexec/PlistBuddy', ['-c', 'Delete :CFBundleIconName', plist]);
  await fs.rm(join(bundle, 'Contents/Resources/Assets.car'), { force: true });
  for (const [key, value] of [['CFBundleName', '会话连接'], ['CFBundleDisplayName', '会话连接'], ['CFBundleIdentifier', 'local.session-connect'], ['CFBundleIconFile', 'applet.icns']]) {
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'pipe' }); }
    catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist], { stdio: 'pipe' }); }
  }
}

export async function buildApp() {
  assertDarwin();
  const dataHome = resolve(process.env.SESSION_CONNECT_HOME || join(homedir(), '.session-connect'));
  assertAppStopped(dataHome);
  run('npm', ['install']);
  run('npm', ['run', 'build']);
  await fs.writeFile(join(root, '.app-config'), `NODE=${process.execPath}\n`, { mode: 0o600 });
  const temporary = await fs.mkdtemp(join(tmpdir(), 'session-connect-build-'));
  try {
    const scriptPath = join(temporary, 'launcher.applescript'), bundle = join(temporary, '会话连接.app');
    await fs.writeFile(scriptPath, appleScriptFor(root));
    run('/usr/bin/osacompile', ['-s', '-o', bundle, scriptPath]);
    await configureAppBundle(bundle, join(temporary, 'app.iconset'));
    run('/usr/bin/codesign', ['--force', '--deep', '-s', '-', bundle]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    assertAppStopped(dataHome);
    await installApp(bundle, '/Applications');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  console.log('已生成：/Applications/会话连接.app，可以把它拖到程序坞');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildApp().catch(error => { console.error(`生成失败：${error.message}`); process.exitCode = 1; });
}
