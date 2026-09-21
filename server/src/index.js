// 会场发言计时服务端
// 职责：
//  1. 以单调时钟（process.hrtime）维护全服务唯一的计时状态；
//  2. 每次状态变更/心跳 tick 生成单调递增版本快照并广播；
//  3. 控制台控制权为唯一租约，靠心跳续租，失联自动释放；
//  4. 提供静态文件服务（生产模式直接托管客户端构建产物）。

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../client/dist');

const PORT = Number(process.env.PORT || 3000);

const TICK_MS = Number(process.env.TICK_MS || 200);            // 运行中的快照广播周期
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 15_000); // 控制台心跳超时时间
const HEARTBEAT_REAPER_MS = Number(process.env.HEARTBEAT_REAPER_MS || 1_000);   // 失联检查周期
const LOCK_RETRY_COOLDOWN_MS = 3_000; // 控制权被占用后再次申请的最小间隔
const WARNING_MS = 60_000;     // 进入 60 秒醒目状态的阈值
const MIN_DURATION_MS = 1_000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

// 单调时钟：不受系统时钟回拨影响
const nowMono = () => Number(process.hrtime.bigint() / 1_000_000n);
const epochId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// 计时状态机
// phase: idle（未开始/重置后） | running | paused | finished
// 运行期间不存储“剩余时间”，而存储目标截止点（deadlineMono），
// 剩余时间始终由单调时钟现算，暂停则冻结。
// ---------------------------------------------------------------------------
const timer = {
  phase: 'idle',
  durationMs: 5 * 60_000,
  remainingMs: 5 * 60_000, // idle/paused/finished 下有效
  deadlineMono: null,      // running 下有效
};

let version = 0;        // 单调递增版本号，永不在运行期内归零
const epoch = epochId(); // 服务进程纪元：客户端用它识别“服务端已重启”

function remainingNow() {
  if (timer.phase === 'running') {
    return Math.max(0, timer.deadlineMono - nowMono());
  }
  return timer.remainingMs;
}

// warning（60 秒内）与 finished 是快照派生状态，进入临界值由 tick 驱动发播
function buildSnapshot() {
  const remainingMs = remainingNow();
  return {
    type: 'snapshot',
    version: ++version, // 严格递增；过期（低版本/旧纪元）消息不得回滚画面
    epoch,
    serverTimeMono: nowMono(),
    phase: timer.phase,
    durationMs: timer.durationMs,
    remainingMs,
    warning: timer.phase !== 'idle' && remainingMs <= WARNING_MS,
    finished: timer.phase === 'finished',
    locked: !!holder,
    holderId: holder ? holder.id : null,
  };
}

// ---------------------------------------------------------------------------
// 控制台租约：全服务同一时刻最多一个持有者
// ---------------------------------------------------------------------------
let holder = null;          // { id, ws, lastHeartbeatMono }

function broadcastSnapshot() {
  const snap = buildSnapshot();
  for (const client of clients) {
    send(client.ws, snap);
  }
}

function releaseHolder(reason) {
  if (!holder) return;
  const h = holder;
  holder = null;
  send(h.ws, { type: 'control', granted: false, reason, targetId: h.id });
  broadcastSnapshot(); // locked 状态变化需要立刻通知所有投屏
}

// ---------------------------------------------------------------------------
// 状态转换（全部由单调时钟定锚）
// ---------------------------------------------------------------------------
function reset(durationMs = timer.durationMs) {
  timer.phase = 'idle';
  timer.durationMs = durationMs;
  timer.remainingMs = durationMs;
  timer.deadlineMono = null;
  broadcastSnapshot();
}

function tick() {
  if (timer.phase !== 'running') return;

  if (timer.deadlineMono - nowMono() <= 0) {
    // 归零：自动切换 finished 醒目状态
    timer.phase = 'finished';
    timer.remainingMs = 0;
    timer.deadlineMono = null;
    broadcastSnapshot();
    return;
  }
  // 周期广播；warning 跨越 60 秒边界也会自然在某个 tick 中体现
  broadcastSnapshot();
}

// ---------------------------------------------------------------------------
// 指令处理（仅持有者可执行计时指令）
// ---------------------------------------------------------------------------
function fail(client, code, message) {
  send(client.ws, { type: 'error', code, message });
}

function handleCommand(client, msg) {
  const cmd = msg.command;

  if (cmd !== 'acquire' && cmd !== 'heartbeat' && cmd !== 'release') {
    if (!holder || holder.id !== client.id) {
      fail(client, 'NOT_CONTROLLER', '当前控制台未持有控制权');
      return;
    }
  }

  switch (cmd) {
    case 'acquire': {
      if (holder && holder.id !== client.id) {
        // 唯一持有者：拒绝第二个控制台（targetId 标明单播对象，便于客户端对账）
        const lastDeny = client.lastDenyAtMono ?? 0;
        const denied = {
          type: 'control',
          granted: false,
          reason: 'locked',
          targetId: client.id,
          holderId: holder.id,
        };
        if (nowMono() - lastDeny < LOCK_RETRY_COOLDOWN_MS) {
          denied.retryAfterMs = LOCK_RETRY_COOLDOWN_MS;
        } else {
          client.lastDenyAtMono = nowMono();
        }
        send(client.ws, denied);
        return;
      }
      holder = {
        id: client.id,
        ws: client.ws,
        lastHeartbeatMono: nowMono(),
      };
      send(client.ws, { type: 'control', granted: true, clientId: client.id, targetId: client.id });
      broadcastSnapshot();
      return;
    }

    case 'heartbeat': {
      if (holder && holder.id === client.id) {
        holder.lastHeartbeatMono = nowMono();
        // 心跳回包带权威快照，便于控制台续租后立即对齐
        send(client.ws, { type: 'heartbeat_ack' });
      } else {
        fail(client, 'NOT_CONTROLLER', '心跳来自非持有控制台');
      }
      return;
    }

    case 'release': {
      if (holder && holder.id === client.id) {
        releaseHolder('released');
      }
      return;
    }

    case 'set_duration': {
      const d = Number(msg.durationMs);
      if (!Number.isFinite(d) || d < MIN_DURATION_MS || d > MAX_DURATION_MS) {
        fail(client, 'INVALID_DURATION', `时长需在 ${MIN_DURATION_MS}~${MAX_DURATION_MS}ms 之间`);
        return;
      }
      if (timer.phase === 'running') {
        fail(client, 'INVALID_PHASE', '运行中不可修改时长，请先暂停或重置');
        return;
      }
      // idle / paused / finished 下设定新时长：画面回到待开始的完整时长
      timer.durationMs = d;
      timer.remainingMs = d;
      timer.phase = 'idle';
      broadcastSnapshot();
      return;
    }

    case 'start': {
      if (timer.phase === 'running') {
        fail(client, 'INVALID_PHASE', '计时已在运行中');
        return;
      }
      const d = timer.phase === 'paused' ? timer.remainingMs : timer.durationMs;
      timer.remainingMs = d;
      timer.deadlineMono = nowMono() + d;
      timer.phase = 'running';
      broadcastSnapshot();
      return;
    }

    case 'pause': {
      if (timer.phase !== 'running') {
        fail(client, 'INVALID_PHASE', '仅运行中可暂停');
        return;
      }
      timer.remainingMs = remainingNow();
      timer.deadlineMono = null;
      timer.phase = 'paused';
      broadcastSnapshot();
      return;
    }

    case 'resume': {
      if (timer.phase !== 'paused') {
        fail(client, 'INVALID_PHASE', '仅暂停后可继续');
        return;
      }
      timer.deadlineMono = nowMono() + timer.remainingMs;
      timer.phase = 'running';
      broadcastSnapshot();
      return;
    }

    case 'reset': {
      const d = Number(msg.durationMs);
      // 显式给出的时长必须合法；缺省则沿用当前时长
      if (msg.durationMs !== undefined) {
        if (!Number.isFinite(d) || d < MIN_DURATION_MS || d > MAX_DURATION_MS) {
          fail(client, 'INVALID_DURATION', `时长需在 ${MIN_DURATION_MS}~${MAX_DURATION_MS}ms 之间`);
          return;
        }
        reset(d);
      } else {
        reset();
      }
      return;
    }

    default:
      fail(client, 'UNKNOWN_COMMAND', `未知指令: ${cmd}`);
  }
}

// ---------------------------------------------------------------------------
// WebSocket 连接管理
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function makeClient(ws) {
  const client = {
    id: `c-${Math.random().toString(36).slice(2, 10)}`,
    ws,
    joinedMono: nowMono(),
    lastDenyAtMono: 0,
  };
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      fail(client, 'BAD_MESSAGE', '消息不是合法 JSON');
      return;
    }
    try {
      handleCommand(client, msg);
    } catch (err) {
      console.error('[command]', err);
      fail(client, 'INTERNAL', '服务端处理异常');
    }
  });
  ws.on('close', () => {
    clients.delete(client);
    if (holder && holder.id === client.id) {
      releaseHolder('disconnected'); // 断线即释放唯一控制权
    }
  });
  ws.on('error', (err) => console.error('[ws error]', err.message));
  return client;
}

wss.on('connection', (ws) => {
  const client = makeClient(ws);
  clients.add(client);
  // 连接/重连首包：自报身份 + 权威快照（恢复同一剩余时间）
  send(ws, { type: 'hello', clientId: client.id, epoch });
  send(ws, buildSnapshot());
});

setInterval(tick, TICK_MS).unref();

// 失联自动释放：租约心跳超时
setInterval(() => {
  if (!holder) return;
  if (nowMono() - holder.lastHeartbeatMono > HEARTBEAT_TIMEOUT_MS) {
    console.log('[holder] 控制台心跳失联，释放控制权:', holder.id);
    releaseHolder('timeout');
  }
}, HEARTBEAT_REAPER_MS).unref();

// ---------------------------------------------------------------------------
// HTTP：WebSocket 升级 + 静态文件（客户端构建产物）
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA 回退
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('客户端尚未构建，请先执行 npm run build（或使用 docker compose up）。');
          return;
        }
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.listen(PORT, () => {
  console.log(`[venue-countdown] http://0.0.0.0:${PORT}`);
  console.log(`  控制台: http://localhost:${PORT}/console`);
  console.log(`  投  屏: http://localhost:${PORT}/display`);
});
