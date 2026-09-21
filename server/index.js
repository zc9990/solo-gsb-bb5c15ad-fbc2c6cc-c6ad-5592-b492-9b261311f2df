'use strict';

/**
 * 会场发言计时联屏 - 服务端
 *
 * 设计要点：
 * - 服务端持有唯一计时状态，所有端（控制台/投屏）都是其镜像；
 * - 使用单调时钟（performance.now()）计算剩余时间，不受系统时间回拨影响；
 * - 每次状态变化/心跳广播携带递增 version 的快照，客户端丢弃 version 不增的过期消息；
 * - 控制权同一时刻仅允许一个控制台持有，断连（含心跳超时）自动释放并移交给下一个控制台。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..', 'client', 'dist');
const TICK_MS = 200;                          // 运行中快照广播间隔
const WARNING_MS = 60_000;                    // 60 秒告警阈值
const HEARTBEAT_MS = 10_000;                  // 心跳探测间隔（识别失联控制台）
const MIN_DURATION_MS = 1_000;
const MAX_DURATION_MS = 12 * 3600 * 1000;

const monoNow = () => performance.now();

// ---------- 唯一计时状态 ----------
const state = {
  version: 0,                    // 单调递增的快照版本号
  status: 'idle',                // idle | running | paused | expired
  durationMs: 5 * 60 * 1000,     // 设定时长
  remainingMs: 5 * 60 * 1000,    // 非运行态下的剩余时间
  endAt: null,                   // 运行态下的单调时钟截止点
};

function currentRemaining() {
  if (state.status === 'running' && state.endAt != null) {
    return Math.max(0, state.endAt - monoNow());
  }
  return state.remainingMs;
}

function snapshot() {
  return {
    type: 'snapshot',
    version: state.version,
    status: state.status,
    durationMs: state.durationMs,
    remainingMs: currentRemaining(),
    endAt: state.status === 'running' ? state.endAt : null,
    serverNow: monoNow(),
    warningMs: WARNING_MS,
  };
}

// ---------- 连接与控制权 ----------
const clients = new Set(); // { ws, role, isAlive }
let controller = null;     // 当前持有控制权的控制台连接

function broadcastSnapshot() {
  state.version += 1;
  const payload = JSON.stringify(snapshot());
  for (const c of clients) {
    if (c.ws.readyState === 1) c.ws.send(payload);
  }
}

function broadcastControl() {
  for (const c of clients) {
    if (c.ws.readyState === 1) {
      c.ws.send(JSON.stringify({
        type: 'control',
        granted: c === controller,
        holderConnected: controller !== null,
      }));
    }
  }
}

// ---------- 计时心跳 ----------
let tickTimer = null;
function ensureTick() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (state.status !== 'running') { stopTick(); return; }
    if (currentRemaining() <= 0) {
      state.status = 'expired';
      state.remainingMs = 0;
      state.endAt = null;
      stopTick();
    }
    broadcastSnapshot();
  }, TICK_MS);
}
function stopTick() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

// ---------- 控制指令（仅控制权持有者可执行） ----------
const actions = {
  set_duration(ms) {
    if (state.status === 'running') return; // 运行中不可改时长
    const v = Math.round(Number(ms));
    if (!Number.isFinite(v) || v < MIN_DURATION_MS || v > MAX_DURATION_MS) return;
    state.durationMs = v;
    state.remainingMs = v;
    state.endAt = null;
    state.status = 'idle';
    broadcastSnapshot();
  },
  start() {
    state.status = 'running';
    state.remainingMs = state.durationMs;
    state.endAt = monoNow() + state.durationMs;
    ensureTick();
    broadcastSnapshot();
  },
  pause() {
    if (state.status !== 'running') return;
    state.remainingMs = currentRemaining();
    state.endAt = null;
    state.status = 'paused';
    stopTick();
    broadcastSnapshot();
  },
  resume() {
    if (state.status !== 'paused') return;
    state.status = 'running';
    state.endAt = monoNow() + state.remainingMs;
    ensureTick();
    broadcastSnapshot();
  },
  reset() {
    stopTick();
    state.status = 'idle';
    state.remainingMs = state.durationMs;
    state.endAt = null;
    broadcastSnapshot();
  },
};

function handleMessage(client, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (!msg || typeof msg.type !== 'string') return;
  if (client !== controller) return; // 非控制端指令一律忽略
  const action = actions[msg.type];
  if (action) action(msg.ms);
}

function handleConnection(ws, req) {
  const url = new URL(req.url, 'http://localhost');
  const role = url.searchParams.get('role') === 'console' ? 'console' : 'display';
  const client = { ws, role, isAlive: true };
  clients.add(client);

  // 控制权空闲时，先到先得
  if (role === 'console' && controller === null) {
    controller = client;
  }

  ws.on('pong', () => { client.isAlive = true; });
  ws.on('message', (data) => handleMessage(client, data));
  ws.on('close', () => {
    clients.delete(client);
    if (controller === client) {
      // 失联自动释放，并移交给下一个在线控制台
      controller = null;
      for (const c of clients) {
        if (c.role === 'console') { controller = c; break; }
      }
      broadcastControl();
    }
  });

  // 新连接（含断线重连）立即同步最新快照：版本递增保证不会被客户端当作过期消息丢弃
  broadcastSnapshot();
  broadcastControl();
}

// ---------- 心跳：识别并清理失联连接 ----------
setInterval(() => {
  for (const c of clients) {
    if (!c.isAlive) { c.ws.terminate(); continue; } // terminate 触发 close -> 释放控制权
    c.isAlive = false;
    try { c.ws.ping(); } catch { /* ignore */ }
  }
}, HEARTBEAT_MS);

// ---------- 静态资源（SPA） ----------
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
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.normalize(path.join(STATIC_DIR, urlPath));
  if (filePath !== STATIC_DIR && !filePath.startsWith(STATIC_DIR + path.sep)) {
    res.writeHead(403); res.end(); return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(STATIC_DIR, 'index.html'); // SPA 回退（/console 等路由）
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('客户端尚未构建：请先执行 npm run build');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});
wss.on('connection', handleConnection);

server.listen(PORT, () => {
  console.log('[stage-timer] 服务已启动');
  console.log(`  投屏页:  http://localhost:${PORT}/`);
  console.log(`  控制台:  http://localhost:${PORT}/console`);
});
