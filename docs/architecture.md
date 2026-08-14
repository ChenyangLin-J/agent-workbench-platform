# Agent Workbench 共享架构

文档类型：重构 spec  
状态：当前完整版；定义公共 Agent 能力与各产品外壳的边界，以及从现有实现迁移到四个宿主的顺序。

## 当前问题

`@agent-workbench/platform` 已经共享 Codex App Server、Session Kernel、附件、Subagent 摘要和 React Session UI，但共享单位仍然偏横向：消费者拿到若干 runtime helper 和 UI 组件，再分别拼装完整功能。

这会让一个用户能力在不同宿主中形成多套实现。当前最明显的例子是 Side Chat：Personal 自己维护 fork、记录、事件订阅和原生 DOM 面板；Agent Terminal Web 也有独立实现；Solvely 尚未接入。修复其中一套不会自动修复其他宿主。

共享的目标不是让四个产品长得一样，而是让同一项 Agent 能力只实现一次，并允许每个产品保留自己的导航、数据、权限、视觉与业务内容。

## 已确认的现状

| 宿主 | 当前技术形态 | Platform 使用情况 | 产品边界 |
| --- | --- | --- | --- |
| Personal Workbench | 原生页面外壳 + React `SessionWorkspace` | 固定 `v0.3.14`；使用 Core、Session UI、附件和 Browser Provider | 项目、事项、个人状态、记忆和资产 |
| Solvely Workbench | Next.js + React | 固定 `v0.3.9`；使用 Session UI 和部分附件合约；Subagent 关闭 | 业务导航、报告、SQL、证据及业务 Tools/Skills |
| Agent Terminal Web | Express + WebSocket + 原生页面，同时支持 PTY Terminal 与 App Server | 尚未使用 Platform；独立实现 App Server、Session 与 Side Chat | 手机优先入口、Terminal、记忆和多执行主机 |
| Superset Side Agent | 待接入的轻量侧边面板 | 尚未接入 | Dashboard、Chart、筛选条件和 Superset 权限上下文 |

代码证据：

- Platform 的 `SessionWorkspace` 已经拥有 transcript、Composer、审批、附件和 Subagent 摘要，但没有 Side Chat Feature。
- Personal 的 Side Chat API 位于 `src/server.mjs`，对应页面状态与渲染位于 `public/app.js`；Subagent 详情链路也由 Personal 自己实现。
- Solvely 在 `web/lib/core-session-config.js` 中将 `subagents` 配置为 `hidden`，其 `SessionWorkspace` 只传入通用 Session 与业务扩展内容。
- Agent Terminal Web 的公开仓库没有 `@agent-workbench/platform` 依赖，并在自己的 `server.js` 与 `public/app.js` 中维护 Side Chat。

## 目标边界

先保留一个 npm 包和一个 Git 仓库，不为了架构整洁立即拆成多个发布包。包内形成三个清楚的层次：

```text
@agent-workbench/platform/runtime
  App Server connection、Session/Turn、事件、审批、附件输入

@agent-workbench/platform/features
  Side Chat、Subagent 等完整 Feature 的 controller、状态与 action contract

@agent-workbench/platform/ui
  React SessionWorkspace 与 Feature 面板
```

Runtime 与 Feature contract 不依赖 DOM。React 是四个 Web 宿主的统一 renderer，不是 Agent Runtime 本身。以后只有出现真实的非 React 消费者时，才评估拆分 npm 包。

### Platform 拥有

- Codex thread、turn、request 和事件的产品中立语义，以及 Composer 中模型、思考强度和访问模式的统一交互合约。
- Side Chat、Subagent、附件和审批等 Feature 的状态模型、动作合约、错误语义和 React UI。
- Feature 能力配置，例如 `sideChats: hidden | summary | full` 与 `subagents: hidden | summary | full`。
- project-free 与 project-scoped 两类 fixture 和合约测试。

### 产品拥有

- 页面导航、项目/业务对象、用户和权限、凭据、部署及数据目录。
- 产品专属状态与存储位置，以及把这些状态和访问模式映射到 Runtime / Feature contract 的 adapter。
- Personal 的项目与事项、Solvely 的报告与 SQL、Agent Terminal 的 PTY 与多主机、Superset 的 Dashboard 上下文。
- 主题、入口位置、产品文案，以及通过 slot 插入的业务内容。

## 第一个共享 Feature：Side Chat

Side Chat 用来验证这条边界是否成立。Platform 统一以下语义：

- 从父 Session 创建独立 fork，并保存 `parentSessionId` 与 `sideThreadId` 关系。
- 统一 `creating | idle | running | interrupted | expired | error` 状态。
- 独立 transcript、连续追问、停止、模型/推理配置和显式删除。
- 收起面板、切换 Session、页面刷新与删除是不同动作；只有显式删除移除记录。
- Runtime 不可恢复时保留只读记录，并明确显示 `expired`，不伪装成可继续会话。

Platform 提供 controller、View Model、React `SideChatPanel` 和以下 product adapter 合约：

```text
SideChatStore
  list(parentSessionId)
  load(sideChatId)
  save(record)
  remove(sideChatId)

SideChatRuntime
  fork(parentRuntimeSessionId, options)
  submit(sideRuntimeSessionId, input, options)
  interrupt(sideRuntimeSessionId, turnId)
  readSnapshot(sideRuntimeSessionId)
```

产品可以选择自己的持久化实现，但不能重定义关闭、删除、失效和运行状态的语义。

## Subagent 边界

Subagent 与 Side Chat 保持不同数据模型。Platform 继续从 Codex 父子 Agent 关系发现 Subagent，并补齐：

- 读取单个 Subagent 的完整 Turn/Item 链路。
- 从列表进入详情、返回列表、打开独立 Session和停止运行中 Agent。
- 统一摘要与完整模式的 View Model 和 React 面板。

产品只决定是否显示、入口位置和当前 Session 的业务归属，不复制 Subagent 解析与链路渲染。

## 四个宿主的装配

| Feature | Personal | Solvely | Agent Terminal | Superset |
| --- | --- | --- | --- | --- |
| Session/Turn | full | full | full | lightweight |
| Side Chat | full | configurable | full | hidden 或 lightweight |
| Subagent | full | configurable | full | hidden |
| 审批/用户输入 | full | full | full | 按权限配置 |
| 附件 | full | full | configurable | Dashboard 上下文优先 |
| Browser/Realtime | Personal 配置 | 产品配置 | 产品配置 | hidden |
| 产品扩展 | 项目/事项 | 报告/SQL/证据 | Terminal/记忆/多主机 | Chart/筛选条件 |

这里的 `full`、`lightweight` 和 `hidden` 是宿主 profile，不产生不同 Feature 实现。

## 不改什么

- 不把 Personal 与 Solvely 的页面外壳、导航和业务内容合并。
- 不让浏览器直接连接或启动 Codex App Server；各产品后端仍拥有执行连接与鉴权。
- 不把产品数据库或权限模型迁入 Platform。
- 不在本轮同时迁移四个宿主，也不先建设通用插件系统。
- 不复制 DeepSeek Harness 的完整插件框架；只采用 base feature 加宿主 profile 的组合原则。

## 迁移顺序

1. **公共合约**：在 Platform 增加 Side Chat Feature、Subagent 详情合约、能力配置与 project-free/project-scoped fixture；作为新的 minor compatibility boundary 发布。
2. **Personal 验证**：保持现有 API 和数据不变，先用 adapter 接入共享 controller/View Model/React 面板，再删除被替代的前端状态和渲染代码。
3. **Solvely 验证**：升级到同一 minor，保持业务 Canvas 与扩展 slot，不默认打开新能力；通过配置逐项启用 Side Chat/Subagent。
4. **Agent Terminal 迁移**：前端迁到 React 后接入相同 Feature；PTY、移动布局、记忆和多主机继续归产品所有。
5. **Superset 接入**：使用 lightweight profile 和独立后端 adapter，只暴露当前 Dashboard 所需能力。

每一步都必须在当前宿主通过后才能删除其旧实现；不得先做一次跨仓库批量替换。

## 验证方式

- Platform 单测同时覆盖 project-free 与 project-scoped Session。
- 同一组 Side Chat 合约测试必须能运行在内存 store 与至少一个真实产品 adapter 上。
- 刷新、切换 Session、服务重启、Runtime 丢失和显式删除分别验证，不能只测正常问答。
- Personal 与 Solvely 的浏览器验收确认共享 Feature 行为一致，同时确认产品导航与扩展内容没有变化。
- 每个消费者固定明确的 Platform 版本；升级证据记录测试命令、关键输出和浏览器截图。

## 风险

- 如果 Platform 直接读取产品数据库，会重新形成产品耦合；必须经过 store adapter。
- 如果只共享 React 面板而不共享状态和动作语义，重复实现仍然存在。
- 如果为了统一视觉删除现有 slot，Solvely 的报告/SQL体验和 Personal 的项目上下文会被压平。
- Personal 已在使用中，迁移期间必须保留旧链路作为短期回退，但验收后应删除被替代代码，不能长期双轨。
