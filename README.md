# 会场发言计时联屏（Stage Timer）

基于 **Node.js + React + WebSocket** 的会场发言计时系统：一个控制台操作，多块投屏实时联动。

## 功能

- **控制台**（`/console`）：设定时长（预设档位 / 自定义分秒）、开始、暂停、继续、重置
- **投屏页**（`/`）：全屏大字倒计时 + 进度条；进入最后 **60 秒**切换琥珀色告警，**归零**切换红色闪烁「时间到」
- **唯一计时状态**：服务端以单调时钟（`performance.now()`）维护唯一状态，各端均为其镜像
- **递增版本快照**：每次广播携带严格递增的 `version`，客户端丢弃过期/乱序消息，画面绝不回滚
- **断线重连恢复**：投屏断线自动重连，重连后服务端推送最新快照，恢复同一剩余时间
- **控制权互斥**：同一时刻仅一个控制台持有控制权（先到先得），其余控制台只读；持有者失联（含心跳超时）自动释放并移交给下一个控制台

## 快速开始（单条命令）

### 方式一：Docker Compose（推荐）

```bash
docker compose up --build
```

### 方式二：本地 Node.js（≥ 18）

```bash
npm start
```

该命令自动完成依赖安装、前端构建并启动服务。

## 访问地址

| 页面   | 地址                            |
| ------ | ------------------------------- |
| 投屏页 | <http://localhost:8080/>        |
| 控制台 | <http://localhost:8080/console> |

默认端口 **8080**，可通过环境变量 `PORT` 修改（如 `PORT=9000 npm start`）。

## 架构与协议

```
server/            Node.js 服务端（唯一计时状态 + WebSocket 广播 + 静态托管）
  index.js
client/            React 前端（Vite 构建）
  src/Display.jsx  投屏页
  src/Console.jsx  控制台
  src/useTimerSocket.js  WebSocket Hook（重连 / 版本防回滚 / 单调时钟对齐）
```

- **状态机**：`idle → running → paused → running → expired`，`reset` 回到 `idle`
- **服务端 → 客户端**
  - `{type:'snapshot', version, status, durationMs, remainingMs, endAt, serverNow, warningMs}`：状态快照，`version` 单调递增；运行中每 200ms 广播一次，状态变化即时广播
  - `{type:'control', granted, holderConnected}`：控制权通知
- **客户端 → 服务端**（仅控制权持有者生效）：`set_duration {ms}` / `start` / `pause` / `resume` / `reset`
- **防回滚**：客户端仅接受 `version` 严格大于本地已见的快照
- **时钟对齐**：快照携带服务端单调时钟 `serverNow/endAt`，客户端用本地单调时钟偏移插值，显示平滑且不受系统时间回拨影响
- **心跳**：服务端每 10s ping 一次，未响应的连接被终止并自动释放控制权

## 开发模式

```bash
npm run setup          # 安装依赖
npm run dev:server     # 终端 1：服务端（:8080）
npm run dev:client     # 终端 2：Vite 热更新（:5173，/ws 已代理到 8080）
```
