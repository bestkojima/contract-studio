# 使用通用工作台

## Setup

已有工作台时直接使用它。首次建立工作台，从安装后的 Skill 目录调用初始化器；`<skill>` 表示包含 `SKILL.md` 的 `contract-studio` 文件夹：

```powershell
node "<skill>/scripts/init-workbench.mjs" "<目标目录>"
cd "<目标目录>"
npm install
uv sync --locked --python 3.12
node scripts/build-index.mjs
npm run dev -- --host 127.0.0.1
```

需要 Node.js 20.19+ 与 uv。初始化器只复制模板到新建或空目录，已有 Git 仓库内复用仓库，独立目录执行 `git init`；不安装依赖、不创建远端、不启动服务。安装需要下载依赖，遵循当前环境授权。

模板只有 `project` 视图和 `root` 功能组，没有业务功能。源码、需求与测试在生成的工作台内维护；它不会自动接管父目录中的现有应用。接入已有应用前，先确定源码位置、扫描配置与实际调用方式，保留用户现有技术栈。

打开终端显示的本机地址。在功能组内点“＋ 添加”或双击画布空白处添加节点，点击节点打开属性侧栏。画布修改先存浏览器草稿，保存到项目后才进入源文件；需求编辑直接保存需求源。代码和测试引用可展开源码，旁边可选 VS Code 或记事本；VS Code 跳到目标行，记事本使用 `Ctrl+G`。

## Node operations

以下路径相对于工作台本机地址；通过 HTTP 写入时发送 JSON 和同源 `Origin`。完整载荷以工作台 `server/api.mjs`、`server/traceability.mjs` 为准。

| 任务 | 入口 |
| --- | --- |
| 发现视图与能力 | `GET /api/features` |
| 节点上下文、说明与任务 | `GET /api/node-context?feature=project&nodeId=root` |
| 草稿只读预览 | `POST /api/node-context/preview`：`{featureId, graph, nodeId}` |
| 持久图、需求、关联、索引状态 | `GET /api/traceability?feature=project` |
| 保存图 | `POST /api/traceability/graph`：`{featureId, graph, expectedGraph}`，`expectedGraph` 为先前读取的项目图 |
| 创建、修改、确认需求 | `POST /api/traceability/requirement`：`action` 为 `create/save/confirm`；编辑已有需求携带读取时的 `revision` |
| 重建索引 | `node scripts/build-index.mjs` 或 `POST /api/traceability/build` |
| 查看能力和证据 | `GET /api/capabilities`、`GET /api/capabilities/evidence?capabilityId=…` |
| 运行登记测试 | `POST /api/capabilities/test`：`{capabilityId}` |

无服务时可从工作台直接导入 `server/node-context.mjs` 的 `nodeContext({featureId, nodeId}, root)`。读取层用 `openTraceability(root)` 的 `feature(id)`、`graph(descriptor)`、`source(query)` 和 `capabilities()`；复用这个 Module 的状态判断，避免在调用方重新解释原始索引。

保存与构建分别报告。源已保存但构建失败时，修复构建错误后重建；保留已保存内容，不把前次索引当作当前结果。

## Connect a user capability

在 `features/project/server.mjs` 中扩展当前功能，或建立新 feature 并在 `server/feature-registry.mjs` 导入登记。只新增原生节点时无需改 registry。

- `features`：视图 ID、别名、根节点、图/需求/RST 文件、前端入口与草稿键。
- `routes`：固定 `{method, path, handle}`，处理实际输入并调用业务 Module。
- `capabilities`：稳定 `id`、标题、根节点、`runPath`、`testPath`、`frontend` 和明确的 `testFiles`。两条 POST 路由必须已登记；`testPath` 用于节点试运行，关联测试由 `/api/capabilities/test` 执行。保持函数和测试用例关联由索引推导。
- `trials`（需要时）：能力的外部试运行输入 schema 与适配说明；不覆盖内部节点的输入。

在对应节点属性设置 `capabilityId`；为用户操作编写 `features/<功能>/client.tsx`，默认导出提供 `Panel` 的 `FeatureClient`。接口见 `src/feature-client.ts`，后端声明示例骨架见 `features/project/server.mjs`。前端消费实际后端结果，步骤和高亮来自真实 trace；仅声明入口仍会显示未实现或未运行。

测试文件用原生 `test.verifies` 关联验收，并在运行名称带 `[TEST_ID]`。通过可信执行入口取得记录后，再读取节点上下文核对逐用例结果。直接在终端运行测试可以证明该次测试结果，但不会自动成为工作台保存的证据。

## 维护入口

契约源在 `contracts/` 和手写 `traceability/*.rst`；规则在 `traceability/node-mapping.json`。保存与追踪读取在 `server/traceability.mjs`，节点说明在 `server/node-context.mjs`，自动关系在 `server/backend-relations.mjs`，证据在 `server/capabilities.mjs`。运行脚本见 `package.json`；对改动执行有针对性的测试，前端改动另做构建及关键交互检查。
