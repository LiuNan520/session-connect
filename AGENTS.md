# 会话连接（session-connect）

本地单用户网站：在无限画布上用卡片和连线整理 Claude Code / Codex 等会话之间的关系。

## 工作流

- 按 `~/.claude/workflow/流程.md`（Claude 与 Codex 共用）执行。
- 在 main 分支上工作，不新建 worktree。
- 不 commit、不 push，提交由用户做。

## 文档

| 类型   | 位置          | 文件名                 |
| ---- | ----------- | ------------------- |
| PRD  | `docs/prd/` | `<功能名>-PRD.md`      |
| 技术方案 | `docs/方案/`  | `<功能名>-技术方案.md`     |
| 修复方案 | `docs/方案/`  | `<bug 简述>-修复方案.md`  |
| 长期文档 | `docs/`     | 如 `接口.md`，归档时同步     |
| 验收清单 | `docs/`     | `<功能名>-验收清单.md`     |

- PRD 开头标注：版本、日期、状态（草稿 / 待确认 / 已确认 / 已归档）。
- 技术方案开头按工作流模板标注 PRD 路径和版本。

## 验证命令

按 `docs/方案/会话连接-技术方案.md`（已归档，2026-10-21）：

| 命令                  | 作用                        |
| ------------------- | ------------------------- |
| `npm run typecheck` | TypeScript 类型检查（server、web、shared） |
| `npm test`          | Vitest 单元和接口测试            |
| `npm run build`     | 构建 `dist/web` 和 `dist/server` |
| `npm run app`       | 生成 `/Applications/会话连接.app`（要实测应用时才跑） |
| `npm run fixture`   | 生成 `fixtures/perf-200.json`（200 张卡片、300 条连线） |

- 程序坞里的应用直接运行项目里的 `dist/`：前端改动 `npm run build` 后刷新页面即可，只有移动项目目录或换 Node 才要重跑 `npm run app`。
- Vitest 跑在 node 里，没有 DOM 组件测试环境；布局、焦点类问题要在浏览器里实测。实测用隔离数据：`SESSION_CONNECT_HOME=<临时目录> node dist/server/index.js --mode dev`，需要数据时用 `POST /api/import` 导入夹具，不碰 `~/.session-connect/`。

## 业务事实

- 单用户、本机使用，无登录；服务只监听 127.0.0.1。
- 卡片纯手动维护，不读取、不关联本机真实会话（用户 2026-10-21 明确）。
- 界面只有中文。
- 日常启动方式是 macOS 应用「会话连接.app」（放在程序坞，点击即启动服务并打开浏览器）；`npm start` 只用于开发。
- 不做任何卡片模板（用户 2026-10-21 明确）。
- 已知限制（2026-10-21 归档时遗留，用户决定暂不做）：导入、导出、备份都把整份 JSON 当一个字符串处理，受 V8 单字符串约 512 MB 上限限制，达不到约定的 1 GiB，详见 `docs/接口.md`「导出与导入」和技术方案「遗留」R1-3。要修需先写修复方案（跨前后端）。
- 内置图标在 `assets/icons/`：
  - `claude-code.svg`、`codex.svg`、`deepseek.svg` 来自 LobeHub Icons（npm `@lobehub/icons-static-svg` 1.95.1，MIT），分别是 `claude-color.svg`（Claude 橙色"菊花"标志，用户指定，不用 Claude Code 像素小人图标）、`codex-color.svg`、`deepseek-color.svg`。
  - `workbuddy.svg` 来自 WorkBuddy 官网 https://www.workbuddy.ai/ 的 `logo.svg`。
- 应用图标：`assets/app-icon/app-icon.svg`（黑白灰卡通鸽子叼信，用户 2026-10-21 选定），1024px 预览 `app-icon-preview.png`。鸽子用 Openclipart 上 wildchief 的 "Pigeon"（公有领域，https://openclipart.org/detail/71287/pigeon-by-wildchief）；信封、爱心封蜡和黑白灰配色是 Claude 加的。
