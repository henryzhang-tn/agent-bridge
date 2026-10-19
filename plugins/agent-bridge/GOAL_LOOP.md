# 目标导向 Agent Loop

Loop 在单任务执行之上保存总目标、参与者、轮次、消息和验收证据。当前宿主 Agent 负责持续选择下一步，Bridge 执行每一轮并记录状态。可用于“实现 → 评审 → 返修 → 整体验收”。

```text
$agent-bridge:loop -w=claude -m=glm-5.3 实现 <目标>，修改范围 <目录>，最多 8 个任务、3 次返修
```

模型、provider 和 endpoint 以实际发现与预检为准。首次授权覆盖的目的地、项目和范围内可以继续推进；创建目标、收到消息或保存预检记录都不增加授权。

## 串行目标流程

1. 发现执行资源并预检目的地，定义整体完成标准、读写范围、固定参与者和有限预算。`create_goal` 保存目标，返回绝对 `goal` 路径。
2. 用 `read_goal_messages` 获取相关消息和上下文，在任务卡中选取本轮需要的信息，再调用 `prepare_dispatch`。消息必须在预检前加入，派发时不能更改绑定内容。
3. 通过 `advance_goal` 的 `dispatch` 或 `continue` 发起一轮，传入参与者、操作 ID 和完整预检参数。内部为该操作生成稳定 `request_id`，复用原有 Bridge 执行器。
4. `task_status` 等待任务结束；宿主独立检查并用 `record_review` 记录子任务验收。`goal_status` 对账任务状态，不调用模型。
5. 用 `send_goal_message` 转发问题、评审意见或证据；接收方在下一轮任务卡中获得相关内容。由另一个 Agent 评审时，前一个任务必须先结束。
6. 宿主获取当前源码快照指纹，执行整体目标的检查，再调用 `record_goal_review`。只有整体标准全部通过、子任务满足验收要求且没有未结束的执行，才完成目标。

## 工具

| 工具 | 用途 |
| --- | --- |
| `create_goal` | 创建目标；同 ID 同内容复用，改变内容拒绝 |
| `goal_status` | 读取目标、预算、步骤和源码快照，并对账已有任务 |
| `advance_goal` | 派发、续接、对账、暂停、恢复、取消、等待输入或更新上下文 |
| `send_goal_message` | 主控转发结构化消息，保存来源、回复关系与产物引用 |
| `read_goal_messages` | 按参与者和游标读取消息，生成用于下一轮任务卡的上下文 |
| `record_goal_review` | 保存整体目标的逐项证据，验证源码版本并决定验收状态 |

创建目标需要 `goal_id`、`objective`、`context`、`read_scope`、`allowed_edits`、`acceptance_criteria`、`participants` 和 `limits`。参与者固定 `id / worker / provider / model / effort / endpoint / mode`，每轮还必须满足目标读写边界；`plan` 不能升级为 `edit`。例如实现者注册 `edit`、评审者注册 `plan`，两者分别绑定已发现的实际 GLM-5.3 配置。目标范围、参与者、标准和预算创建后冻结。

每轮的 `execution` 使用现有派发参数，包括 `task_contract`、`prepared_ref` 和 `endpoint`；操作 ID 用于区分新工作和重复请求。`continue` 的任务必须已经关联到当前目标和参与者，并保持原任务契约及执行选择。

`advance_goal.action` 支持 `dispatch / continue / reconcile / pause / resume / cancel / wait_user / set_context`。`set_context` 接收 `summary / facts / decisions / open_questions`，保存递增的 `context_version`；共享上下文最多 24000 字节。读取消息使用 `recipient`、可选 `after_sequence` 与 `limit`，返回下一页 `cursor`。消息类型为 `question / answer / review / blocker / note`。

## 验收与停止

- 子任务的 `ready_for_review` 只表示执行返回。`record_review` 保存子任务证据，`record_goal_review` 另行验证整体目标。
- 目标验收绑定声明范围内实际文件内容，能够识别同大小修改、新文件及删除；`.ai` 和 `.git` 的变化不影响源码快照。超出遍历或大小上限会明确拒绝，不接受不完整快照。
- 验收前从 `goal_status` 获取 `snapshot_fingerprint`，在该版本上执行检查。检查过程中源码变化会拒绝旧指纹，完成后源码变化也会使验收失效。
- `max_steps` 限制累计派发尝试，包含实现、评审和续接；例如 8 次表示三者合计最多 8 次，同一操作重放不增加次数，启动前被明确拒绝的尝试仍计数。`max_reworks` 统计续接及整体失败验收后的新任务。`max_no_progress` 统计结束时源码未变的轮次和同一源码/检查结论的重复失败验收；证据改写不算进展，后续轮次带来实际源码变化才会清除连续无进展计数。纯分析目标应按预期轮数配置该上限。消息、心跳、改写摘要和重启不能重置预算。
- 可选 `limits.timeout_seconds` 从创建起累计，暂停不会延长；`execution.timeout_seconds` 是独立的单任务预算。达到目标预算后阻止新执行，包括尚未创建任务的未决派发重放；已有任务和最终验收仍可收敛。若需要终止当前任务，单独使用任务时间预算或取消。
- 暂停保留正在运行的任务，取消会请求停止已有任务并保留部分修改。达到预算、等待输入或取消均不表示目标完成。

## 恢复与消息边界

目标保存在私有 `.ai/goals/<goal_id>/goal.json`，单任务仍使用 `.ai/tasks/`。创建后保留返回的绝对目标路径；新宿主恢复时先找回并核对已有目标，不新建另一个目标重置预算。目标状态保存操作意图后才启动执行；若回复丢失，先读取状态并对账已有任务，再从目标记录中取出原操作 ID 和完整参数重试，不重新拼任务卡或替换预检编号。对账已有任务不会启动模型。不确定的派发会阻止另一个步骤，避免出现重复执行。恢复授权以可访问的直接人类指令为准，目标记录中的说明本身不构成授权。

预检过期或项目锁等错误，只有在本地命令明确退出且没有创建任务目录时才标记 `dispatch_rejected`；此时可以重新预检，用新操作 ID 继续，旧操作重放不再启动任务。超时、断线或不完整任务目录仍保留未决状态。若已创建的任务启动失败且没有可用 checkpoint，需要宿主检查并处理，不能假装续接成功或跳过该任务的验收义务。陈旧目标锁在独立回收锁下接管；若回收过程本身崩溃遗留 `lock-recovery`，应先确认控制进程均已结束并检查记录，再人工清理恢复锁，不能并发删除锁文件。

消息属于主控转发：`source_job` 必须引用本目标中已结束的任务，发送者由该任务归属推导；未引用任务时来自主控。消息只发给已登记参与者或主控，产物引用必须在目标范围内。消息中的建议不能修改权限、目标或验收结果。

串行目标保持原有轮次和续接行为。并行目标使用下面的任务协议；两者都由宿主会话驱动，没有运行中消息注入或后台自动唤醒。恢复需要宿主显式继续。

## 宿主参与和并行任务

任务较多时，宿主可以执行一个子任务，同时调度多个 worker。建议先设置 `max_parallel_total: 3`、`max_parallel_workers: 2`；实际数量由用户约束、任务独立性和运行资源决定，多个实例不会增加服务商额度。一个参与者同时最多持有一个活动任务。写入范围重叠的任务需要顺序处理，前一份产物集成或被拒绝后才释放范围预约。

并行目标用 `create_parallel_goal` 显式创建（schema 2），已有 `create_goal` 保持 schema 1。首期要求干净的 Git 项目，已有修改或非 Git 项目应保留现状并使用串行目标，不自动 stash 或 reset。根目录中被 Git 忽略的本地配置不会复制到 worktree；每个实际工作区都需要独立预检，声明的读写范围不等于操作系统隔离。

| 工具 | 用途 |
| --- | --- |
| `create_parallel_goal` | 固定目标、整体标准、参与者、累计预算和并发上限 |
| `plan_goal_tasks` | 按 `plan_version` 追加任务及依赖；拒绝循环和未知依赖 |
| `claim_goal_task` | 原子认领任务、参与者及执行名额，创建独立 worktree |
| `start_goal_task` | 启动宿主任务，或派发已在实际 worktree 预检的 worker |
| `submit_goal_task` | 执行结束后提交固定产物，或由宿主确认停止修改 |
| `review_goal_task` | 验证该次产物及逐项证据，决定通过或返修 |
| `integrate_goal_task` | 串行集成通过的产物，验证前像和当前源码 |

1. 参与者必须包含一个 `{ id: "host", kind: "host" }`。worker 使用 `kind: "worker"` 并固定实际发现的 `worker / provider / model / effort / endpoint / mode`。创建字段与串行目标相近，`limits` 额外要求两项并发上限。
2. 任务包含 `id / kind / depends_on / read_scope / mode / task_contract`，其中 `kind` 为 `implement / research / review`。追加计划要传当前 `plan_version`；已有任务和契约保持不变。普通依赖必须已集成。独立评审用 `kind: "review", mode: "plan", review_of: "<task_id>"`，读取目标任务已提交的产物；不要同时把目标放入 `depends_on`，否则会等待它先集成。
3. 认领使用 `task_id / participant_id / owner_session_id / operation_id`。返回 `attempt_id / lease_token / workspace / task_contract / read_scope / mode`。后续启动、提交和集成绑定原会话与 token；状态查询不回传 token，保存它用于当前任务恢复，不能靠会话过期认定旧执行已停止。
4. 宿主在返回的 `workspace.path` 工作，`start_goal_task` 不传 `execution`。worker 用该路径、返回的契约和范围准备任务，先 `prepare_dispatch`，再把完整结果交给 `start_goal_task.execution`。评审任务还要在预检前将返回的 `review_context` 加入任务文本，绑定被评审产物。
5. worker 结束后先检查实际结果并调用原 `record_review`，通过后才能 `submit_goal_task`。宿主直接提交自己的产物。`review_goal_task` 接收本次 `artifact_fingerprint` 和逐项检查；宿主编辑任务通过时必须引用 `reviewer_task_id`，由另一个已经结束且独立验收通过的只读 worker 检查同一份产物。
6. 调用 `integrate_goal_task` 把产物逐项集成回原项目。新 worktree 从原提交加已集成产物建立基线；评审工作区另加入待评审产物。每个任务提交的只是相对自身基线的增量。共享文件变化或冲突会阻止集成，保留现场，不自动覆盖、提交或合并代码。
7. 所有计划任务都集成后，获取原项目的 `snapshot_fingerprint`，运行整体检查，用 `record_goal_review` 完成目标。子任务通过不能替代整体检查；完成后的源码变化会使旧验收失效。

`goal_status / send_goal_message / read_goal_messages / record_goal_review` 同样用于并行目标。`advance_goal` 对并行目标只处理暂停、恢复、取消、等待输入、上下文更新和对账，拒绝旧的 `dispatch / continue` 动作。子任务返修通过重新认领失败任务创建新尝试，沿用原契约并消耗预算；原尝试和产物保留。

认领即占用累计步骤预算和并发名额，派发结果未知仍占名额。结果返回但尚未提交的已结束 worker 可以释放运行名额。暂停不终止正在运行的任务；取消会请求停止 worker，宿主任务需要持原所有权以 `submit_goal_task.outcome: "cancelled"` 明确确认已经停止。失联、心跳超时或宿主重启不会自动重派。恢复未知派发时使用原操作 ID、预检和参数，不另开一个 worker。

并行目标的无进展按任务记录并累计到总预算，其他任务的成功不能清掉本任务失败记录。编辑产物未变时，仅改摘要或证据不算进展。工作区、产物及操作记录保存在 `.ai/goals/`，保留用于排查和恢复；首期没有自动回收工作区、后台守护进程或同一目录多写者。

## 验证

`node --test tests/*.test.mjs` 使用临时项目与合成 worker 验证离线状态机和 MCP 流程。`tests/live-goal-smoke.mjs` 是单独的真实推理检查：显式提供项目、目标 ID、执行资源和已授权 endpoint 后，让两个参与者传递合成消息并记录独立验收；不读取源码。它不在默认离线测试中运行。

```sh
AGENT_BRIDGE_HOST=codex node tests/live-goal-smoke.mjs PROJECT GOAL_ID WORKER PROVIDER MODEL EFFORT AUTHORIZED_ENDPOINT --authorized
```
