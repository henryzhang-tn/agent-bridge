# 核心实现

使用方法和流程图见 [主 README](../../README.md)。宿主负责拆任务、选择 worker/model/effort、核对用户授权和最终验收；worker 不继续委派。

| 文件 | 职责 |
| --- | --- |
| `scripts/mcp-server.mjs` | 10 个 MCP 工具、参数校验 |
| `scripts/quality.mjs` | 任务标准校验、推理建议、验收证据规则和质量状态 |
| `scripts/destination.mjs` / `codex-config.mjs` | 本地解析实际 provider/endpoint（Codex 使用其生效配置和登录类型），显式识别宿主 |
| `scripts/bridge.mjs` | 预检、参数绑定、任务锁、去重、取消、检查点、续接、结果恢复 |
| `scripts/*-adapter.*` / `zcode-protocol.mjs` | 调用各 worker，复用其配置；凭据不写入任务记录 |
| `scripts/zcode-progress.mjs` | 全 worker 共用的进度跟踪：阶段、最近活动、工具进度与仅提示性停滞评估 |
| `skills/dispatch/SKILL.md` | 当前宿主的调度和验收规则 |
| `../../scripts/build-packages.mjs` | 从根 `plugin.json` 生成各宿主清单与 MCP 配置 |
| `../../scripts/host-config.mjs` | 打印手动接入配置，不修改宿主设置 |

`AGENT_BRIDGE_HOST` 支持 `codex / claude / zcode / hermes / generic`，未配置时为 `generic`；客户端名称不作为授权证据。可用 `AGENT_BRIDGE_NODE_PATH` 指定 Node 路径。worker 路径可用 `ZCODE_WORKER_ENTRY`、`CLAUDE_WORKER_ENTRY`、`CODEX_WORKER_ENTRY`（及 `CODEX_HOME`）、`HERMES_WORKER_PYTHON` 配置。

## Worker

| worker | 运行时 | 目的地预检 | 原生续接 |
| --- | --- | --- | --- |
| `zcode` | Z Code app-server | 本地 provider 配置解析 baseUrl | 会话 `session/resume` |
| `claude` | Claude Code 无头 CLI | `settings.json` 中的第三方推理配置 | 隔离 profile 中的 `--resume` 会话 |
| `codex` | Codex CLI app-server | 生效配置的默认 provider 与登录类型 | 线程 `thread/resume` |
| `hermes` | Hermes AIAgent 隔离 profile | 既有 zai 配置 | 无（检查点续接） |

Codex 通过本地 app-server 的 `config/read` 与 `account/read` 解析项目生效配置，只派发当前默认 provider。支持自定义 `model_providers.<id>.base_url`、内置 ChatGPT 登录与 API Key 路由；无法确定目的地时预检明确失败。只读取登录类型，不读取或保存认证凭据。启动时核对 `thread/start` / `thread/resume` 返回的 provider/model 与派发一致；沙箱按模式取 `read-only` / `workspace-write`，审批策略为 `on-request`，审批请求返回适配器并拒绝、作为阻塞上报，绝不自动批准。worker 禁用子 agent、Hooks、插件、MCP 和 Apps。

## 调用约定

聊天调用支持短参数：`$agent-bridge:dispatch -w=zcode -m=GLM-5.3 -e=high <任务>`。`-w / -m / -e` 分别对应 `worker / model / effort`，可省略，支持空格、英文或中文逗号分隔。宿主把短参数映射到 MCP 完整字段；CLI 仍使用现有长参数。

`-f` 由宿主识别，表示用户预授权本次任务使用所选 worker 当前配置的模型服务及任务相关范围。仍须预检并说明实际目的地、项目、范围和模式，再直接派发；目的地或范围变化时重新核对。仅重新预检（目的地与范围不变）不需要重新询问已足够的直接授权。它不传入 MCP 或 CLI，也不改变系统审批、worker 交互阻塞或凭据保护。

先发现模型，再调用 `prepare_dispatch`，提供 `worker / project / task / provider / model / effort / selection_reason / read_scope / mode`。`project` 为绝对路径；`read_scope` 为已有相对文件或目录，`[]` 表示不读源码，`["."]` 表示整个项目。相关项目指令和任务元数据仍可读取。

宿主核对实际地址与用户授权后，以相同参数调用 `dispatch_task`，再提供预检返回的 `prepared_ref` 和 `destination.endpoint`（作为 `endpoint`），并分配 `request_id`。预检绑定范围、模型、模式、宿主和运行时；目的地在提交和 worker 启动时重新核对。该机制不证明人类授权，也不限制操作系统文件访问。预检 30 分钟有效期只约束新的提交：过期阻止新派发，但绝不终止已开始的任务，也不影响状态读取、结果或检查点。

同一 `request_id` 参数不变时返回原 job，包括失败或取消的任务。已有 job 的复用不启动 worker；参数冲突会拒绝。新工作使用新 ID。去重保证依赖 `.ai/tasks/` 记录仍然存在。

`plan` 只开放读取/搜索；`edit` 开放文件修改，Z Code/Hermes/Codex 还可执行范围内命令（Codex 受其运行时沙箱约束）。Claude 的命令和测试由宿主执行。结果必须独立验收，失败不自动重试或换模型。

## 调度质量与验收

宿主按更新后的 Skill 默认选择实际目录中的首选完整模型：普通任务用支持的 `high`，复杂开发、跨模块/平台集成和疑难修复用最高支持的推理档。`list_models` 提供各模型的 `recommended_effort`；未知的服务商专用级别不会被猜测排序，也不按名字推断模型排名。执行核心仍要求显式模型参数，保留用户选择，不暗中升级或降级。

新任务在 MCP 的 `task_contract` 或 CLI 的 `--task-contract-file` 中提供结构化交接。例如：

```json
{
  "complexity": "complex",
  "context": "相关背景、已有决定和源码入口",
  "allowed_edits": ["src/settings.mjs", "tests/settings.test.mjs"],
  "preserve": ["保留已有未提交改动"],
  "integration": "worker 实现服务和测试；宿主验证实际 Release 的完整操作流程",
  "acceptance_criteria": [
    {
      "id": "settings-restart",
      "description": "保存设置后重启仍生效",
      "verification": "在实际 Release 中使用合成设置保存、退出、重启并读取，记录版本及运行环境",
      "verification_kind": "runtime"
    }
  ]
}
```

`allowed_edits` 必须在 `read_scope` 内（可包含新文件）；plan 必须为 `[]`。`preserve` 可为空；验收标准至少一项，ID 唯一，全部为必要项。`verification_kind` 是 `source / test / runtime`：源码审查、自动测试或实际运行验证。只验证 Mock 不能满足实际运行标准。交接标准绑定预检、请求去重和续接，变更需要重新预检。它仍是行为约束，不是操作系统沙箱。

旧客户端可继续省略 contract，任务标记 `legacy/unstructured`，不把既有执行记录当作已验收。更新后的 Skill 要求每个新任务提供 contract；旧任务可在同一授权范围内带 contract 续接。

worker 返回并退出后，宿主独立检查文件和执行验证，再调用 `record_review`：

```json
{
  "job": "/absolute/project/.ai/tasks/job-id",
  "review_id": "settings-review-1",
  "checks": [
    {
      "criterion_id": "settings-restart",
      "status": "passed",
      "verification_kind": "runtime",
      "evidence": "宿主在指定 Release 版本和环境中执行了保存、退出、重启、读取；观察到合成设置保留"
    }
  ]
}
```

验收不得只转抄 worker 自述。每项标准必须恰好对应一个检查；`passed` 必须使用约定的验证类型。全部通过且 worker 无错误才得到 `quality.acceptanceStatus: accepted`；有失败项为 `changes_requested`，有未验证项为 `incomplete`。执行 `status` 保持不变，两者分开。Bridge 校验覆盖和证据类型，证据内容仍由宿主如实记录，不替代实际验证。

验收记录保存在私有 `.ai/tasks/<job>/reviews/`，最新记录在 `review.json`，权限为 0600。相同 `review_id` 和证据重试复用已有记录，不启动推理，也不撤销更新的验收；改变证据需新 ID。结果或执行状态变化时既有验收标记 `stale`。验收反映记录时的验证，后续源码变化仍须重新验证。

返修使用显式 `continue_task`，原 contract 和标准保持不变，失败/未验证项与证据自动进入交接提示；新任务记录 `reworkCount`。两次返修后提示宿主重新评估根因、拆分或模型，不自动循环或切换模型。CLI 对应 `review --job DIR --review-id ID --review-file CHECKS_JSON`（文件内容是 checks 数组）。

`effortEvidence` 分开记录 `requested`、`sentToRuntime`、`runtimeConfirmed`、`providerConfirmed`、参数位置和确认来源。没有回传确认时为 null；发送参数不等于服务端确认思考预算。Z Code 可记录模型设置回执；Codex 只使用当前回合的明确 effort 回执，不把线程原有默认值当作本回合确认。Claude/Hermes 通常没有 effort 回传，因此不声称已确认。`selectedModel` 保留为兼容的选择元数据。

## 时间预算

默认执行没有总时长上限：不提供 `timeout_seconds` 时任务不会因为运行久而终止。显式提供的正数预算会被严格执行，范围为 1 秒至 30 天；预算按墙钟计算，活动不会顺延它。启动、目录查询与控制 RPC 保持独立的短超时；适配器对运行中的回合不设内部计时器。运行时或服务商自身的上下文、轮次及额度限制仍然适用，结束后可按检查点续接。

货币类预算控制不被接受：Token/用量计数只是参考，不是费用、配额或订阅额度；不要把 `usage` 当作账单。唯一被强制执行的预算是上面的显式时间预算。

## 任务进度

每个 worker 的适配器都把紧凑进度写入任务目录的 `progress.json`：Z Code 订阅 `session/event`，Codex 使用 app-server 通知，Claude 使用 CLI 的 stream-json 事件，Hermes 使用运行时流式和工具回调。旧运行时缺少这些接口时如实标记 `monitoring: unsupported`。适配器每 30 秒上报一次，真实活动另行记录；流式更新每秒最多合并写入一次，工具状态和阶段变化立即保存。`task_status` 和 `task_result` 读取本地文件，不触发模型调用。

| `progress` 字段 | 含义 |
| --- | --- |
| `monitoring` | `subscribed` 表示已订阅运行时事件；`unsupported` 表示该运行时无流式遥测 |
| `lastActivityAt` / `idleSeconds` / `reportedAt` | 最近运行时活动、静默秒数、适配器上报时间；定期上报和监督进程心跳不刷新真实活动 |
| `phase` | 最近工作阶段，如等待模型、推理、回答、执行工具、等待交互或收集结果 |
| `tools.total / active / completed / failed` | 工具调用计数，同一调用的多次进度更新不重复计数 |
| `tools.byName / current / lastCompleted` | 按工具名称汇总、当前工具（最多 20 项）与最近结束的工具 |
| `reasoningCharacters / responseCharacters` | 已观察到的流式字符数，用于判断有活动；不是 Token 或费用统计 |
| `pendingInteractions / hostInteractionRequired` | 待处理交互与宿主交互阻塞，不自动批准请求 |
| `assessment` | 仅提示性的评估：`active / idle / unknown / blocked`、`suspectedStall` 与 `attention`；`automaticAction` 恒为 `none` |

`assessment` 区分适配器/进程心跳、真实运行时活动和任务成果：静默超过阈值只会得到 `suspectedStall: true` 的提示，绝不自动终止；进度缺失或 `unsupported` 一律按未知处理，不能据此判断卡住。权限/输入等待显示为 `blocked` 且 `attention: host_interaction_required`，永远不会被自动批准。取消的判断依据是阻塞、经过核实的停滞或任务预算，而不是单纯的时间流逝。

进度中不保存推理文本、源码、工具参数或输出内容。旧任务返回 `progress: null`，同样表示未知。

## 检查点与续接

监督进程每 60 秒及结束时写入原子 `checkpoint.json`：运行时会话 ID、续接支持类型、阶段/成果元数据（工具计数、是否观察到推理/回答）、结果文件标记，以及 Git 项目授权范围内的基线/当前文件变更路径、状态和修改时间（最多 256 项）。不含推理文本、源码内容、凭据或工具参数。非 Git 项目只记录运行时和结果引用。检查点写入不计为任务活动；最终检查点保存后才发布结束状态。

`continue_task`（CLI `continue`）是显式的宿主控制续接路径：要求全新预检（`prepared_ref`/`endpoint`）、全新 `request_id`、与原任务相同的 worker/provider/model/effort/mode/读取范围和宿主，且原监督进程与 worker 都已退出。Z Code、Codex 和 Claude 使用原生会话/线程续接并标记 `native`；Hermes 及 prompt 传输使用新的运行时会话，明确标记 `checkpoint`（提示包含检查点并指向原任务目录）。续跑要求先核对现有产物，只处理剩余工作。相同续跑 ID 和参数重试返回原任务，不重复执行；不同参数会拒绝。不会自动重放或自动推理；`recover_result` 只读取已保存结果，绝不是续接。

## 开发与 CLI

```sh
node scripts/build-packages.mjs
node --test tests/*.test.mjs
node plugins/agent-bridge/scripts/bridge.mjs help
```

CLI 同样先 `prepare`，再使用返回的 `--prepared-ref` 和 `--endpoint` 执行 `submit`；选择参数必须相同。已结束任务用 `continue` 续接（同样需要全新预检与 `--request-id`）。CLI 不执行人类授权交互，由调用宿主负责核对授权。

测试使用合成进程和 Mock API；适配器测试缺少运行时时跳过。`tests/live-mcp-smoke.mjs` 会调用真实模型，运行前需明确授权服务目的地与任务范围。
