# 核心实现

使用方法和流程图见 [主 README](../../README.md)。宿主负责拆任务、选择 worker/model/effort、核对用户授权和最终验收；worker 不继续委派。

| 文件 | 职责 |
| --- | --- |
| `scripts/mcp-server.mjs` | 8 个 MCP 工具、参数校验 |
| `scripts/destination.mjs` | 本地解析实际 provider/endpoint，显式识别宿主 |
| `scripts/bridge.mjs` | 预检、参数绑定、任务锁、去重、取消、结果恢复 |
| `scripts/*-adapter.*` / `zcode-protocol.mjs` | 调用各 worker，复用其配置；凭据不写入任务记录 |
| `scripts/zcode-progress.mjs` | 汇总 Z Code 会话事件，独立保存最近活动和工具进度 |
| `skills/dispatch/SKILL.md` | 当前宿主的调度和验收规则 |
| `../../scripts/build-packages.mjs` | 从根 `plugin.json` 生成各宿主清单与 MCP 配置 |
| `../../scripts/host-config.mjs` | 打印手动接入配置，不修改宿主设置 |

`AGENT_BRIDGE_HOST` 支持 `codex / claude / zcode / hermes / generic`，未配置时为 `generic`；客户端名称不作为授权证据。可用 `AGENT_BRIDGE_NODE_PATH` 指定 Node 路径。worker 路径可用 `ZCODE_WORKER_ENTRY`、`CLAUDE_WORKER_ENTRY`、`HERMES_WORKER_PYTHON` 配置。

## 调用约定

先发现模型，再调用 `prepare_dispatch`，提供 `worker / project / task / provider / model / effort / selection_reason / read_scope / mode`。`project` 为绝对路径；`read_scope` 为已有相对文件或目录，`[]` 表示不读源码，`["."]` 表示整个项目。相关项目指令和任务元数据仍可读取。

宿主核对实际地址与用户授权后，以相同参数调用 `dispatch_task`，再提供预检返回的 `prepared_ref` 和 `destination.endpoint`（作为 `endpoint`），并分配 `request_id`。预检绑定范围、模型、模式、超时、宿主和运行时；目的地在提交和 worker 启动时重新核对。该机制不证明人类授权，也不限制操作系统文件访问。

同一 `request_id` 参数不变时返回原 job，包括失败或取消的任务。已有 job 的复用不启动 worker，无需重新读取其运行时配置；参数冲突会拒绝。新工作使用新 ID。去重保证依赖 `.ai/tasks/` 记录仍然存在。

`plan` 只开放读取/搜索；`edit` 开放文件修改，Z Code/Hermes 还可执行范围内命令。Claude 的命令和测试由宿主执行。结果必须独立验收，失败不自动重试或换模型。

## 任务进度

Z Code 在发送任务前订阅 `session/event`。`task_status` 和 `task_result` 读取本地 `progress.json`，不会触发模型调用或新的会话读取。进度每秒最多合并写入一次流式更新，工具状态和任务阶段变化立即保存。

| `progress` 字段 | 含义 |
| --- | --- |
| `monitoring` | `subscribed` 表示已订阅；`unsupported` 表示旧运行时不支持订阅 |
| `lastActivityAt` / `idleSeconds` | 最近收到有效活动的时间与距今秒数，不使用监督进程心跳更新 |
| `phase` | 最近工作阶段，如等待模型、推理、回答、执行工具、等待交互或收集结果 |
| `tools.total / active / completed / failed` | 工具调用计数，同一调用的多次进度更新不重复计数 |
| `tools.byName / current / lastCompleted` | 按工具名称汇总、当前工具（最多 20 项）与最近结束的工具，包含可用的耗时及输出字节数 |
| `reasoningCharacters / responseCharacters` | 已观察到的流式字符数，用于判断有活动；不是 Token 或费用统计 |
| `pendingInteractions / hostInteractionRequired` | 待处理交互与宿主交互阻塞，不自动批准请求 |

会话编号和已选模型在运行中即可返回。进度独立于 `state.json` 保存，避免被心跳覆盖；取消后仍保留最后观察到的进度。任务结束状态以顶层 `status` 为准。旧任务及其他 worker 返回 `progress: null`，表示没有进度数据，不能据此判断卡住。进度中不保存推理文本、源码、工具参数或输出内容。

## 开发与 CLI

```sh
node scripts/build-packages.mjs
node --test tests/*.test.mjs
node plugins/agent-bridge/scripts/bridge.mjs help
```

CLI 同样先 `prepare`，再使用返回的 `--prepared-ref` 和 `--endpoint` 执行 `submit`；选择参数必须相同。CLI 不执行人类授权交互，由调用宿主负责核对授权。

测试使用合成进程和 Mock API；适配器测试缺少运行时时跳过。`tests/live-mcp-smoke.mjs` 会调用真实模型，运行前需明确授权服务目的地与任务范围。
