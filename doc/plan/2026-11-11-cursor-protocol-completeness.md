# Cursor 协议解析与回传完整性修复计划

记录日期：2026-11-11。状态：实施中，尚未完成全部阶段。审计代码基线：`6288cf5`。客户端对照版本：Cursor `3.29.15`。

本计划基于当前仓库重新核验，替代聊天中将“上下文圆环仍未修复”作为待办的旧结论。当前修复保留在工作区，未提交或推送。用户最初要求暂不替换，随后明确授权编译重启；已于 2026-11-11 完成当前阶段修复的本机试用替换，旧程序已备份。

## 实施进度（2026-11-11）

已实现并进入回归验证：

- 共享模型参数解析：两种入口共用 `cursor/model_selection.rs`；解析 Fast 和 thinking，支持调用级 false 覆盖以及显式关闭思考后不被模型配置重新启用。
- 内置模型合并额外参数时保留调用级采样值；Anthropic 将 stop 映射到 stop_sequences，保留已有协议结构字段保护。
- 结构化 HTTP / SSE 上游错误保留状态和代码；RunInference 回传错误类型、超限标志及对应调用结束码。
- Anthropic 工具失败标志、内置 Responses 截断时的 usage / replay 结算、reasoning_tokens 回传。
- 内置模型握手补齐有效思考强度及 agent_token_limit，模型家族匹配改用模型 ID；插件能力来源仍未补齐，不能视为阶段 4 完成。
- 旧入口 L1～L4：按子代理类型覆盖、Resume request_context、正文 Blob 加载、选中 Git diff 投影。

验证记录：225 条服务端单元测试通过；checkpoint_recovery 4 条、error_lifecycle 7 条、provider_router 2 条、tool_round 18 条、subagent_runs 4 条通过；Clippy 通过。路由测试曾因未修改 SDK 文件的检出换行差异触发插件同步而遇到访问拒绝，恢复其原始字节格式后两条测试通过；没有将 SDK 改动同步到本机应用。后续经用户确认，以已有前端产物构建 Release 并替换重启本机应用，安装哈希与构建产物一致，启动就绪信号、健康接口、前端页面及两个入口资源检查通过；尚未用真实多轮调用验证全部修复。

尚未完成，不能据上述结果宣称整份计划完成：

以下为审计保留项，不全部属于当前必须实施的工作；是否继续实施，按第 1 节的实际必要性标准决定。“尚未完成”不等于“当前使用一定受影响”。

- 阶段 0 的正式 wire fixture / 支持矩阵，以及插件参数能力验证。
- 阶段 3 的有序助手内容、跨 Provider 原生回放和完整双向 wire 映射。
- 阶段 4 的插件上下文、可靠模型身份、摘要及新工具能力协商。
- L5 图片引用的 checkpoint / Blob 往返，以及 L3 专项 Blob 行为回归。
- 插件 SDK 的 Responses 截断结算；当前仅修复内置 Provider，SDK 修改须先在隔离的测试目录验证。
- 相关服务模块的后续职责拆分、全部阶段集成验证与本机运行版本验证。

## 1. 结论与实施范围

先修复当前已支持、正在使用的主链路中可以复现的语义错误。消息回放、模型能力和旧 AgentService 的其他缺口按实际触发场景评估，不因协议存在相应字段就自动纳入必做范围。协议字段存在但没有消费、字段被后续覆盖、出站字段没有返回，必须分别定位到具体边界；不能按 protobuf 字段数量直接判断功能完整性。

### 1.1 第一批与剩余工作的划分依据

第一批主要按“已有能力的语义纠错”选取：用户已经选择了参数，但实际出站值不同；调用级参数已经被解析，但在路由中被覆盖；工具失败或上游错误已有结构化信息，却在回传时丢失。这些问题可以通过实际记录或本地行为测试直接确认，修复目的是让现有功能按用户选择工作。

剩余清单混合了三类工作：特定端点或恢复场景的条件性正确性问题、新增能力支持，以及维护性整理。此前的阶段顺序主要按依赖关系排列，不能据此认定剩余阶段全部必要，也不能把第一批每一项都描述成用户已经遇到的故障。第一批中部分问题来自代码审计和测试复现，仍需通过实际使用判断收益。

| 判断维度 | 第一批主要依据 | 剩余工作需要补充的证据 |
|---|---|---|
| 当前是否使用 | 已支持的参数、用量、工具和错误链路 | 是否使用对应模型、插件、附件或恢复流程 |
| 问题证据 | 实际出站记录或可复现的行为偏差 | 脱敏输入、常用端点的复现结果及用户可见影响 |
| 修改目的 | 修正已承诺能力的语义 | 条件性故障修复、新能力扩展或维护整理，分别评估 |
| 验收重点 | 用户选择、实际出站和返回结果一致 | 先证明当前场景确有需求，再确定支持范围和验收 |

尤其是消息顺序与原生回放：目前已确认部分字段在代码路径中丢失，但尚未证明用户常用端点都依赖这些字段，也没有据此复现所有多轮调用故障。因此不能将它笼统称为当前最高优先级；若某个实际使用的端点明确要求回传推理状态，且缺失导致后续工具轮次失败，再升级为该场景的高优先级修复。

### 1.2 后续实施的必要性标准

| 类别 | 执行条件 | 当前处置 |
|---|---|---|
| 已确认的现有功能错误 | 有实际故障，或测试证明违反用户选择、丢失当前功能必需信息 | 修复并补充针对性回归 |
| 条件性正确性风险 | 常用模型、插件、图片或恢复场景确实触发，并能复现影响 | 先复现，成立后修复；没有证据时保留审计记录 |
| 新增能力或维护性工作 | 出现明确使用需求，或当前修改确实受结构限制 | 暂缓，不为追求协议字段齐全而实施 |

对应剩余项目的默认处置：

- 消息回放与交错顺序：先用实际常用端点验证工具调用往返；不预先启动统一消息模型的大改造。
- 图片 checkpoint 恢复：存在读图后跨轮次或恢复丢图的使用场景时复现，再决定修复范围。
- 插件上下文、插件截断结算：按实际使用的插件验证；内置 Provider 已修复不代表插件也完成，但未使用的插件不自动成为阻塞项。
- 摘要、新工具类型及更多能力协商：属于新增支持，暂缓，直到有明确需求。
- 模块拆分、完整 wire fixture 和字段矩阵：属于维护或验证手段，不单独作为产品功能推动；只补充当前修复需要的测试和样本。
- 正文 Blob 专项测试、实际版本验证：围绕已经实现且实际使用的路径补充，不扩大为全部协议覆盖。

当前可以先验证第一批修复在正常使用中的表现。若没有新的可复现故障，不要求连续实施完所有剩余阶段。

后续工作决策路径：

```text
已完成基线
  → 验证当前修复在正常使用中的表现
  → 是否存在实际故障或明确需求？
       ├─ 否 → 保留审计记录，暂缓能力扩展和维护性改造
       └─ 是 → 构造对应场景的行为复现
                 → 修复最小必要范围
                 → 回归验证，再决定是否推进下一项
```

后文阶段编号保留为工作包和依赖说明，只有通过上述筛选的工作包才进入实施，不代表必须顺序全部执行。

约束：

- 每个阶段先建立失败的行为测试，再修改对应实现，阶段完成时仍保持端到端可运行。
- 不改变 RunInference 中“Cursor 持有工具循环和会话状态”的所有权，不把本地推理接入重写成第二套服务端 Agent 循环。
- 不新增兼容降级路径、旧字段优先分支或按字符串猜测协议含义的兜底逻辑。
- 复用现有 `ModelSpec`、`ProviderReplayState`、`Usage`、Blob 和调用记录机制；只有现有表示确实无法保留必要语义时才调整统一模型。
- 不把所有客户端新增字段一次性复制进协议子集；纳入的字段必须有消费者、支持范围和验证方法。
- 当前工作区另有桌面 UI 修改，本计划的实现与提交不得混入这些改动。

## 2. 最新状态：已经完成的项目

| 项目 | 当前状态与证据 | 后续要求 |
|---|---|---|
| 调用记录读取有效思考强度 | `bf46aba` 已让内置模型记录器读取配置后的请求 | 保留三种协议的记录与出站一致性回归 |
| 首包思考强度继承 | `6a68664` 已保存本轮完整模型选择，后续调用继承 `high` / `xhigh`，允许调用级覆盖 | 不再作为未修复缺口；新参数解析必须保留这个优先级 |
| 上下文参数解析 | `6288cf5` 已解析首包和调用级 `context`；调用级覆盖不修改本轮快照 | 保留 `1m`、调用级 `128k`、恢复本轮值的测试 |
| 内置模型上下文上限 | `6288cf5` 已在请求未指定时使用已配置上限 | 不把该上限与输出 Token 上限混用 |
| 圆环用量回传 | `6288cf5` 已同时返回 `usage` 和 `extended_usage`，后者携带上下文上限 | 两种事件都必须保留；只发扩展用量不足以覆盖当前客户端读取路径 |
| 缓存输入用量口径 | `6288cf5` 已优先使用 `context_input_tokens` 返回 Cursor | 调用计费仍保留原始输入及缓存明细，不能将两种口径混写 |

本次核验没有重新运行这些修复的测试，不以“代码已合入”代替本机应用版本或实时调用验证。

仍需单独覆盖的上下文边界：插件模型没有从 `model_configs` 获得 `ModelInfo`，当前插件描述也没有上下文上限字段。当 Cursor 未显式选择 `context` 时，不能认为插件模型的圆环已经同样闭环。上限未知时不得编造固定值。

## 3. 当前结构与完整执行路径

下列行数为代码基线的物理行数，包含空行、注释以及文件内测试；明确列出的测试文件也计入。生成的 Rust protobuf、第三方依赖和客户端打包代码不计入。

```text
protocols/cursor/                                      # Cursor wire 协议定义
└── run_inference.proto                               # 当前 RunInference 子集；297 行
server/src/                                           # 服务端运行与协议接入
├── api/cursor/                                       # HTTP / Bidi 路由及协议分流
│   └── handlers/run_inference_tests.rs                # 当前握手、继承与用量行为测试；1378 行
├── cursor/                                           # Cursor 专用转换与生命周期
│   ├── inference/                                    # Cursor 持有 Agent 循环的接入路径
│   │   ├── service.rs                                # 本轮快照、并发调用、握手、事件回传；603 行
│   │   └── project.rs                                # 模型参数、内容、工具的请求投影；385 行
│   ├── compile/                                      # 旧 AgentService 请求编译
│   │   ├── model.rs                                  # 旧链路模型选择；160 行
│   │   ├── run.rs                                    # 运行与执行上下文装配；631 行
│   │   ├── context.rs                                # 规则、MCP 和选中上下文；629 行
│   │   └── break_messages.rs                         # 用户查询与运行消息编译；392 行
│   └── checkpoint/messages/                          # 旧链路的消息往返
│       ├── encode.rs                                 # 规范消息 → Cursor checkpoint；274 行
│       └── decode.rs                                 # Cursor checkpoint → 规范消息；259 行
├── model/                                            # 协议无关的请求、消息和用量
│   ├── message.rs                                    # 规范消息、工具结果及回放载体；165 行
│   └── projection.rs                                 # Provider 可见历史表示；219 行
├── provider/                                         # 上游请求序列化、响应解析及调用记录
│   ├── router.rs                                     # 内置/插件路由和有效配置装配；425 行
│   ├── anthropic.rs                                  # Anthropic 消息与事件转换；552 行
│   ├── openai_chat.rs                                # Chat 消息与事件转换；469 行
│   └── openai_responses.rs                           # Responses 消息与事件转换；584 行
└── store/                                            # SQLite 调用、会话和 Blob 持久化
server/tests/                                         # 跨模块行为验证
└── provider_router.rs                                # 有效思考强度与记录一致性；159 行
```

```text
当前 RunInference：
Cursor 首包（本轮选择） + InvokeModel（本次调用内容/覆盖）
  → handlers 分流
  → inference/service 保存本轮快照，并管理并发 invocation / cancellation
  → inference/project 生成 ModelInvocation
  → provider/router 装配内置模型或插件调用
  → Provider 序列化 → 上游
  ← Provider ModelEvent
       ├→ CallRecorder → store / SQLite 调用记录与详情
       └→ inference/service → Cursor wire 事件
                              → Cursor 更新用量、工具循环及会话状态

旧 AgentService：
Cursor AgentRunRequest
  → compile → conversation / run 的服务端循环
  ↔ checkpoint / store / Blob 的规范历史与恢复
  → Provider → 上游
  ← protocol/events → Cursor
```

本轮快照在 `RunRequest` 后固定；调用级覆盖只影响一个 invocation。新一轮 Run 创建自己的快照，即使沿用相同 conversation ID，也不能继承上一轮覆盖。取消只终止对应 invocation；结束本轮后不能继续沿用它的活动状态。

## 4. 重新核验后的缺口清单

证据表中的 `cursor/`、`provider/`、`model/`、`plugin/` 和 `error.rs` 均以 `server/src/` 为基准，`run_inference.proto` 以 `protocols/cursor/` 为基准；行号只用于定位该代码基线，实施时应按符号复查。

### 4.1 当前 RunInference 与共同 Provider 路径

| 编号 | 潜在影响级别 | 已确认现状 | 触发及影响 | 证据 |
|---|---|---|---|---|
| R1 | 高 | 新链路只消费强度和 context，尚未消费 `fast` / `thinking` | 选择 Fast 后仍可能发送普通速度请求；两条入口的模型参数规则不一致 | `cursor/inference/project.rs:42`、`cursor/compile/model.rs:100` |
| R2 | 高 | `temperature`、`top_p`、`stop_sequences` 已投影到 extra params，随后被路由整体覆盖 | 调用级参数静默失效；配置关闭时也会被空对象覆盖 | `cursor/inference/project.rs:26`、`provider/router.rs:85` |
| R3 | 条件性高影响，先复现 | RunInference 丢弃 `ProviderReplayState`，输入投影仅重建 Anthropic 回放 | Chat reasoning、Responses 加密 reasoning 无法完整往返；后续工具轮次可能缺少端点要求的状态 | `cursor/inference/service.rs` 的 `model_response`、`cursor/inference/project.rs` 的 `replay_state` |
| R4 | 条件性高影响，先复现 | 协议子集没有消息顺序、原生内容及 phase 等字段，内部助手表示也按正文/思考/工具分别收集 | 原生交错块无法按原顺序重建，历史及缓存前缀存在变化风险 | `run_inference.proto` 的 `InferenceCoreMessage`、`model/message.rs`、`model/projection.rs` |
| R5 | 高 | 上游错误转换成字符串，调用结束统一使用 code 13 | 输入超限、输出超限、取消、认证和限流无法准确回传给客户端策略 | `cursor/inference/service.rs` 的 `serve_invocation`、`error.rs` |
| R6 | 中 | Anthropic 工具结果出站没有写入已有的 `is_error` | 工具失败的结构化标志丢失 | `provider/anthropic.rs:366` |
| R7 | 中 | Responses 的 incomplete 分支没有发布终止 usage 与已收集 replay | 达到输出上限时统计和回放状态不完整 | `provider/openai_responses.rs:241` |
| R8 | 中 | 握手元数据没有完整反映有效选择；模型家族按协议类型和显示名推断 | 实际模型请求、提示词元数据和能力声明可能不一致，插件路径尤其缺少可靠来源 | `cursor/inference/service.rs` 的 `ModelInfo` / `run_ready`、`plugin/descriptor.rs` |
| R9 | 中 | 扩展用量协议没有 `reasoning_tokens`；握手未覆盖 `agent_token_limit` 等配置 | 客户端不能得到全部用量和摘要边界信息；圆环修复不等于摘要策略完整 | `run_inference.proto` 的扩展用量及模型元数据 |

R3/R4 的实际端点影响必须通过捕获并脱敏的多轮 fixture 和本地假上游验证；静态代码已能证明字段丢失，不能据此声称所有模型都会失败。

### 4.2 旧 AgentService 的独立缺口

| 编号 | 已确认现状 | 触发及影响 | 证据 |
|---|---|---|---|
| L1 | 子代理覆盖只取首项，丢弃子代理类型 | 某一类型的覆盖/禁用可能作用到全部子代理 | `cursor/compile/run.rs:605` |
| L2 | 未提取 `ResumeAction.request_context` | 恢复时可能丢失 MCP 路由、终端目录、执行限制等上下文 | `cursor/compile/context.rs:180` |
| L3 | 用户正文未从 `text_blob_id` 加载 | 仅传 Blob 正文时，模型可能收到空查询 | `cursor/compile/break_messages.rs:209` |
| L4 | 选中上下文没有消费两类 Git diff 字段 | 用户附加的变更没有进入模型上下文 | `cursor/compile/context.rs:410` |
| L5 | checkpoint 工具结果只导出文本，恢复时 image 固定为空 | 图片 Read 在 checkpoint 往返后丢失图片引用 | `cursor/checkpoint/messages/encode.rs:242`、`decode.rs:249` |

这条入口仍然存在，不能把它直接删除为“兼容代码”；其修复单独验收，不能用旧入口测试代替 RunInference 测试。

### 4.3 支持边界，不直接计为解析故障

| 字段组 | 当前边界 | 本计划处置 |
|---|---|---|
| delta / compressed invocation、配置指纹 | 未宣告接受相应请求，收到后显式拒绝 | 保留明确边界；测试声明与实际处理一致，不提前打开开关 |
| 文件内容 | 显式拒绝，尚无文件内容模型 | 独立能力工作包，先确定格式和上游支持，再宣告接受 |
| provider-defined tools、custom tool format | 协议子集没有字段及完整模型承载 | 纳入能力清单；使用这些功能前必须有实现或明确拒绝，不能静默丢弃后继续调用 |
| top_k、chat_template_kwargs、continue_final_message | 客户端存在，当前子集不包含 | 按已支持上游逐项接入或明确拒绝；不透传未知结构 |
| 摘要、子代理模型解析 | 大部分对应能力未开启 | 单独建立行为验收后启用，不把默认 false 当作解析已完成 |
| 心跳、遥测、首次输出计时、标签等 | 多项未开启或未消费 | 区分会话存活、性能指标与诊断用途；不把所有缺失都列为核心对话故障 |

协议覆盖范围只用于选取审计样本：本机客户端的 RunRequest 为 23 个字段、当前子集 3 个；ModelConfig 为 7/4；CoreMessage 为 20/7；ExtendedUsage 为 6/5。上述计数不是缺陷数量，也不代表需要照单实现所有字段。

## 5. 目标职责与模块调整

先完成必要的可运行修复；只有阶段 3 经实际复现确认需要实施，且现有结构妨碍该修改时，才随语义变化拆分文件。不为拆目录而提前做大范围重构。以下为条件性拟议结构，尚未存在的文件明确标为新增，近似行数仅是职责范围目标，不是必须达到的改造目标。

```text
server/src/cursor/                                    # Cursor wire 与统一请求之间的转换
├── model_selection.rs                               # [新增，≈180 行] 两种入口共用的参数解释与覆盖规则
├── compile/model.rs                                 # [保留] 旧 wire 类型适配，移除重复参数解释
└── inference/                                       # Cursor 持有 Agent 循环的接入层
    ├── service.rs                                   # [保留并收缩] 路由、本轮快照、并发与取消生命周期
    ├── project.rs                                   # [保留并收缩] 单次请求装配
    ├── messages.rs                                  # [新增，≈250 行] 内容/顺序/原生回放的入站投影
    └── events.rs                                    # [新增，≈250 行] 握手、用量、错误及回放的 wire 回传
server/src/model/                                    # 所有 Provider 共用的语义载体
├── message.rs                                       # [调整] 必要的有序助手内容及原生回放状态
├── projection.rs                                    # [调整] 历史投影与顺序保持
└── observability.rs                                 # [保留] 区分上下文用量和计费用量
server/src/provider/                                 # 上游协议专属转换
├── router.rs                                        # [调整] 唯一有效参数快照、记录与上游一致
├── anthropic.rs                                     # [调整] 错误工具结果和原生内容序列化
├── openai_chat.rs                                   # [调整] Chat 回放、用量和结构化失败
└── openai_responses.rs                              # [调整] Responses 回放及截断终止语义
```

模块移动、合并、拆分和删除清单：

- 合并：两种 Cursor 入口的模型参数解释进入 `cursor/model_selection.rs`，入口仅适配各自 wire 类型。
- 拆分：`inference/service.rs` 的握手与事件转换移入 `events.rs`；消息内容投影从 `project.rs` 移入 `messages.rs`。
- 调整：涉及顺序和回放的语义由统一模型表达；Provider 只负责自身协议序列化，不各自猜测历史顺序。
- 删除：两处重复参数循环、无条件覆盖调用级参数的赋值、将结构化失败提前压成字符串的路径。
- 不删除整条旧 AgentService 入口；不复制第二套调用记录、缓存、会话持久化或插件历史系统。
- 现阶段不预设新 SQL 表或迁移。若统一消息表示确实影响持久化映射，在阶段 3 明确影响后按数据库规则单独设计，不增加旧格式兼容读取分支。

## 6. 分阶段实施与验收

### 阶段 0：冻结行为基线与协议样本

- [ ] 将已修复的强度、context、两类 usage 回传测试作为固定回归集。
- [ ] 建立脱敏客户端 fixture：原始 wire 字段及编号、该字段的消费者、对应支持开关和预期行为。
- [ ] 为 R1～R9、L1～L5 分别记录已复现/静态确认/待验证，不把静态风险写成已发生的故障。
- [ ] 明确当前客户端不发送、未开启或只用于遥测的字段，避免把协议子集扩成无消费者的完整复制品。

完成标准：每个后续工作包都有具体触发输入、观测输出和负责模块；已有修复不会重新进入待办。

### 阶段 1：参数传递闭环（R1、R2，并保护现有上下文修复）

- [ ] 先以假上游复现 Fast 丢失、采样参数覆盖、调用级覆盖泄漏等行为。
- [ ] 统一 `reasoning` / `effort`、`thinking`、`fast`、`context` 的解析与校验。别名在统一入口归一化，不在每个 Provider 中重新解释。
- [ ] 优先级固定为：单次调用显式值 > 本轮首包选择 > 模型已配置值。不得用布尔 OR 代替显式 false 的覆盖语义。
- [ ] 规则区分“未提供”“显式关闭/清除”和“非法值”；非法布尔、空强度及非法上下文在调用前明确报错，不能让清除值再次被配置补齐。
- [ ] 确定额外 JSON 与有类型参数的唯一优先级：模型配置的采样默认值先合入，调用显式采样参数后覆盖；model、stream、messages、tools 等协议结构字段不得被额外 JSON 暗中改写。
- [ ] 有效配置完成后生成用于 Provider 和调用记录的同一份快照，删除当前无条件整体赋值路径；普通未知扩展字段仍走明确的上游额外参数能力。
- [ ] 内置模型与插件请求分别验证已支持的参数；插件不支持某参数时明确返回能力结果，不能静默声称执行成功。

验收矩阵：

| 场景 | 预期 |
|---|---|
| 首包 High + Fast，调用不重复选择 | 出站和记录均保留本轮选择 |
| 调用显式覆盖 Low / Fast=false | 只覆盖本次，后续恢复本轮值 |
| 首包 1M，调用 128K，后续无覆盖 | 上限依次为 1M → 128K → 1M |
| 调用指定 temperature，模型未配置额外参数 | 调用参数仍进入上游请求 |
| 模型配置与调用都指定 top_p | 按已声明优先级得到唯一值，记录与实际出站一致 |
| 输出上限和上下文上限同时存在 | `model_config.max_tokens` 控制输出；`extended_usage.max_tokens` 表示上下文容量，二者不混用 |

阶段出口：实际出站参数、记录和 Cursor 返回的有效选择一致；不引入新的 Provider 调用循环。

### 阶段 2：失败与终止事件闭环（R5、R6、R7、R9 的用量部分）

- [ ] 补齐 Anthropic `tool_result.is_error`，同时检查插件 SDK 中同类序列化，避免内置与插件行为分叉。
- [ ] 在 Provider 边界保留结构化错误：输入超限、输出超限、认证、限流、取消和普通上游失败。分类优先消费结构化上游字段，不使用宽泛关键词猜测正常内容。
- [ ] 在 Cursor 输出边界映射受支持的错误码、超限标志及详细类型；保留必要原因。上下文压缩仍由 Cursor 循环决定，服务端不得另起重试循环。
- [ ] 统一 Responses completed / incomplete 的终止结算：usage、已收集 replay、内容块关闭及最终结束原因各发布一次。
- [ ] 增加并映射 `reasoning_tokens`；输出 Token 已包含思考时不再重复累加。
- [ ] 保留普通 usage 与 extended_usage 的双事件回传；原始输入、缓存、上下文总输入的计费口径不因显示修复而改变。

完成标准：工具失败可被模型明确识别；客户端能区分超限和普通失败；截断调用有完整可用的统计，终止事件不重复。缺失 usage 时保持未知，不估算填入计费用量。

### 阶段 3：消息顺序与回放闭环（R3、R4）

进入条件：常用端点的多轮工具调用已复现回放缺失，或实际交错内容已证明发生有影响的重排。仅发现 wire 字段遗漏时，先停留在审计和复现，不自动实施本阶段全部改造。

- [ ] 按实际 wire 编号补齐必要内容字段的声明或消费：`assistant_part_order`、`assistant_text_parts`、`anthropic_native_content`、`openai_phase` / `openai_phase_null`、`model_provider_message_id`、`provider_metadata` 等；已声明但未消费的字段不重复新增，每项都建立入站和出站消费者。
- [ ] 先以交错思考/文字/工具消息证明当前顺序变化，再建立统一的有序助手内容表示；顺序只有一个权威来源，不能由多个可变的文本/工具列表分别猜测。
- [ ] 复用 `ProviderReplayState` 保存不透明原生状态；映射 Chat reasoning、Responses encrypted reasoning 和 Anthropic 签名/原生块，使用类型匹配的回放格式。
- [ ] 验证客户端已有 provider metadata / 原生内容载体能够往返实际需要的状态后，再实现映射；不把任意 JSON 塞进 thinking signature，也不新增私有 wire 字段绕过客户端。
- [ ] 将 `ProviderReplayState` 的 Cursor 出站与下一次输入打通；端点专属数据不得跨 Provider 误用，切换模型不会伪造或复用不相容签名。
- [ ] 保留工具错误、结构化结果及富内容；无法解释的受支持字段明确失败，不静默改成空文本或重排后的历史。
- [ ] 调整统一模型及其投影/持久化使用点时，在同一阶段移除旧的重复排序逻辑；历史中已经不存在的信息保持未知，不根据正文补造签名或顺序。

必须通过的结构验证：

1. 一次响应含“思考 → 文字 → 工具 → 文字”，下一次请求保持同一结构顺序。
2. Chat 工具轮次可回传 reasoning；Responses 工具轮次保留原加密项及必要 ID；Anthropic 保留原生内容与签名。
3. 未发生压缩时，第 N 次上游请求的完整历史是第 N+1 次的结构前缀；仅断言 Token 数相近不合格。
4. checkpoint 导出/恢复后仍能回放；同一输入重试不生成新的消息身份或重复块。
5. 模型切换、取消、截断和新一轮 Run 不串用上一生命周期的活动回放状态。

阶段出口：采用两轮以上的本地假上游验证完整往返，而不只验证一次文本输出或一次协议解码。

### 阶段 4：模型元数据、插件上下文与能力声明（R8、R9 的元数据部分）

进入条件：实际使用的模型或插件出现元数据错误，或用户明确需要新增能力。按单项能力评估，本阶段不作为第一批修复完成后的必做扩展。

- [ ] 握手从确定的模型能力信息生成有效 `reasoning_effort`、上下文容量及已验证家族信息；不继续以自定义显示名作为唯一身份依据，也不把 API 协议等同于实际模型厂商。
- [ ] 插件模型需要相同的能力来源；确认现有插件 ModelSnapshot / descriptor 能承载什么，再同步调整宿主、SDK 和实际使用的内置插件。上下文未知时保留未知，不统一猜成固定容量。
- [ ] 需要向 Cursor 返回的 `agent_token_limit` 与圆环上下文上限使用同一有效选择；二者属于不同 wire 消费点，不能只修一个数值字段。
- [ ] 摘要、子代理模型解析、provider-defined tools、custom tool format、额外采样字段逐项建立支持矩阵：能力来源 → 握手声明 → 请求消费 → 实际行为 → 测试。
- [ ] 仅当完整路径通过测试才打开能力开关；未纳入本期的能力保持明确拒绝或未开启。
- [ ] 对心跳、计时和遥测字段单独记录用途；会话存活逻辑与纯统计字段分别验收。

完成标准：同一模型在内置/插件入口的已支持能力有一致语义；圆环、有效参数、摘要配置不会引用彼此矛盾的上限；不伪装客户端能力支持。

### 阶段 5：旧 AgentService 的字段闭环（L1～L5）

第一批已处理的 L1～L4 保留回归；其余实现仅在实际使用旧入口并复现对应影响后推进，尤其不因 L5 尚未实现就将当前 RunInference 主链路判为不可用。

按独立小改动实施，不合成一次大重构：

- [ ] L1：按子代理类型查找覆盖设置；不同类型可分别继承、显式选择或禁用；删除首项全局覆盖逻辑。
- [ ] L2：从 ResumeAction 提取 request_context，保持同一恢复生命周期的上下文与执行参数，不人为创建新的用户回合。
- [ ] L3：在既有 Blob 加载边界恢复 text_blob_id 正文；正文缺失或 Blob 无效要报告清楚，不能发送空查询冒充成功。
- [ ] L4：将用户明确选中的两类 Git diff 投影进选中上下文；重复输入不反复追加相同上下文，变化只追加到尾部。
- [ ] L5：使图片 Read 引用及富工具结果经过 checkpoint 编码、Blob 边和解码后保持一致；不能只保存说明文本。

完成标准：同一 Run 内、checkpoint 往返后、恢复后和新 Run 四种时序分别有断言；图片和用户查询均从实际 Blob 数据恢复。

## 7. 验证与交付门槛

### 7.1 测试映射

下表测试路径均以 `server/` 为基准。

| 工作包 | 优先扩展的现有测试 |
|---|---|
| 参数、握手和双用量事件 | `src/api/cursor/handlers/run_inference_tests.rs`、`tests/provider_router.rs` |
| Provider 字段与截断事件 | 对应 Provider 的单元测试，必要时增加本地假上游集成用例 |
| 错误、取消与终止 | `tests/error_lifecycle.rs`、`tests/interrupt.rs`、RunInference 测试 |
| 消息顺序与原生回放 | `tests/prefix_stability.rs`、`tests/connect_wire.rs`、`tests/tool_round.rs` |
| 恢复、图片、正文 Blob | `tests/checkpoint_recovery.rs`、`tests/tool_round.rs` |
| 子代理类型覆盖 | `tests/subagent_runs.rs` |
| 规则、选中上下文、恢复上下文 | `tests/local_rules_context.rs`、`tests/knowledge_rules.rs`、`tests/checkpoint_recovery.rs` |

阶段先运行对应测试；全部阶段集成后运行：

```text
cargo test --locked -p cursor-server --lib
cargo test --locked -p cursor-server --test provider_router --test prefix_stability --test connect_wire --test tool_round
cargo test --locked -p cursor-server --test error_lifecycle --test interrupt --test checkpoint_recovery --test subagent_runs --test compaction --test local_rules_context --test knowledge_rules
cargo clippy --locked -p cursor-server --lib -- -D warnings
cargo fmt --all -- --check
```

既有验证限制：上轮 prefix_stability 中一条 runtime 模板断言因 CRLF/LF 差异失败；本次只读核验仍能看到模板的 CRLF，未重新运行该测试。实施时应复现并记录基线，区分检出格式与新增回归；不为通过本任务验证批量重写无关模板，也不能将有失败的结果报告成全部通过。

### 7.2 每个阶段的完成条件

- [ ] 原问题先在测试中复现，修复后相同行为测试通过。
- [ ] 同时验证 Cursor 入站、统一请求、实际上游出站、Cursor 回传和调用记录中与该字段相关的值。
- [ ] 历史顺序、生命周期边界和计费用量不出现新回归。
- [ ] fixture、失败信息和文档均不含真实凭证、私有机器路径、个人身份或内部地址。
- [ ] 只有本阶段涉及的文件进入变更；不混入同时进行的桌面 UI 工作。
- [ ] 本机应用验证需对应新编译产物，分别记录代码测试、编译成功、替换成功和实际界面/调用验证，不能互相替代。

### 7.3 Git 与发布

计划落盘不等于授权提交、推送或发布。后续每次 commit / push 前，按仓库规则检查本次拟提交文件、暂存/修改内容及 diff，报告文件清单和脱敏结果，并在检查通过且用户明确确认后执行。

本计划不要求版本号升级、创建 Release、推送标签或新增自动更新渠道。全部完成后复核支持矩阵，将已完成项归档，并保留仍未启用的能力范围。
