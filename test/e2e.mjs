// 端到端冒烟测试：直接对运行中的服务端建立 WebSocket 连接。
// 用法：先启动服务端（PORT=3000），再执行 node test/e2e.mjs
import { WebSocket } from 'ws';

const PORT = process.env.PORT || 3000;
const URL = `ws://localhost:${PORT}/ws`;

let passed = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function next(inbox, type, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const i = inbox.findIndex((m) => m.type === type);
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error(`等待 ${type} 超时`);
    await sleep(20);
  }
}

// 等待满足谓词的快照；跳过（丢弃）积压中不匹配的旧快照，避免 tick 积压造成误判
async function nextSnap(inbox, pred, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (let i = 0; i < inbox.length; i++) {
      if (inbox[i].type === 'snapshot' && pred(inbox[i])) {
        return inbox.splice(i, 1)[0];
      }
    }
    if (Date.now() > deadline) throw new Error('等待匹配快照超时');
    await sleep(20);
  }
}

async function drain(inbox, timeout = 400) {
  await sleep(timeout);
  const out = inbox.splice(0);
  return out;
}

async function main() {
  console.log('1) 连接与初始快照');
  const a = await connect();
  await next(a.inbox, 'hello');
  const s0 = await next(a.inbox, 'snapshot');
  ok('初始 phase=idle', s0.phase === 'idle');
  ok('初始剩余=默认5分钟', s0.remainingMs === 300000, `got ${s0.remainingMs}`);
  ok('初始无持有者', s0.locked === false && s0.holderId === null);
  ok('版本号为正整数', Number.isInteger(s0.version) && s0.version > 0);

  console.log('2) 唯一控制权：第二个控制台被拒');
  const b = await connect();
  await next(b.inbox, 'hello');
  await next(b.inbox, 'snapshot');
  a.ws.send(JSON.stringify({ command: 'acquire' }));
  const granted = await next(a.inbox, 'control');
  ok('A 获得控制权', granted.granted === true);
  b.ws.send(JSON.stringify({ command: 'acquire' }));
  const denied = await next(b.inbox, 'control');
  ok('B 被拒绝且 reason=locked', denied.granted === false && denied.reason === 'locked');
  ok('拒绝消息单播给 B 且带持有者 id',
    denied.targetId != null && denied.holderId != null);
  const sLock = (await drain(a.inbox, 300)).filter((m) => m.type === 'snapshot').pop();
  ok('快照广播 locked=true', !!(sLock && sLock.locked));

  console.log('3) 非持有者指令被拒');
  b.ws.send(JSON.stringify({ command: 'start' }));
  const err = await next(b.inbox, 'error');
  ok('B 执行 start 返回 NOT_CONTROLLER', err.code === 'NOT_CONTROLLER');

  console.log('4) 设定短时长（2.5s）并开始');
  a.ws.send(JSON.stringify({ command: 'set_duration', durationMs: 2500 }));
  const sSet = await next(a.inbox, 'snapshot');
  ok('set_duration 生效', sSet.durationMs === 2500 && sSet.remainingMs === 2500);
  a.ws.send(JSON.stringify({ command: 'start' }));
  const sRun = await next(a.inbox, 'snapshot');
  ok('开始后 phase=running', sRun.phase === 'running');
  ok('剩余≤60s 时 warning=true', sRun.warning === true, JSON.stringify(sRun));

  console.log('5) tick 版本严格递增、剩余时间递减');
  const ticks = (await drain(a.inbox, 700)).filter((m) => m.type === 'snapshot');
  let mono = true;
  for (let i = 1; i < ticks.length; i++) {
    if (!(ticks[i].version > ticks[i - 1].version) || !(ticks[i].remainingMs <= ticks[i - 1].remainingMs + 1)) {
      mono = false;
    }
  }
  ok('tick 版本递增且剩余不增', mono && ticks.length >= 2, `ticks=${ticks.length}`);

  console.log('6) 暂停/继续保持同一剩余时间');
  a.ws.send(JSON.stringify({ command: 'pause' }));
  const sPaused = await nextSnap(a.inbox, (m) => m.phase === 'paused');
  ok('暂停后 phase=paused', sPaused.phase === 'paused');
  const frozen = sPaused.remainingMs;
  const pausedSnaps = (await drain(a.inbox, 400)).filter((m) => m.type === 'snapshot');
  ok('暂停期间无广播或全部冻结',
    pausedSnaps.every((m) => m.phase === 'paused' && m.remainingMs === frozen),
    JSON.stringify(pausedSnaps.map((m) => m.remainingMs)));
  a.ws.send(JSON.stringify({ command: 'resume' }));
  const sResume = await nextSnap(a.inbox, (m) => m.phase === 'running');
  ok('继续后 phase=running', sResume.phase === 'running');
  ok('继续起点≈冻结值', Math.abs(sResume.remainingMs - frozen) < 100, `${sResume.remainingMs} vs ${frozen}`);

  console.log('7) 归零自动 finished');
  // 当前计时约在运行，等其归零（2.5s 总长，已用约 1.5s）
  let sFin;
  for (let i = 0; i < 60; i++) {
    const m = await next(a.inbox, 'snapshot', 5000).catch(() => null);
    if (m && m.phase === 'finished') { sFin = m; break; }
  }
  ok('归零 phase=finished', !!sFin);
  ok('归零 remaining=0', sFin && sFin.remainingMs === 0);
  ok('归零 finished=true', sFin && sFin.finished === true);
  const after = (await drain(a.inbox, 600)).filter((m) => m.type === 'snapshot');
  ok('finished 后不再周期广播', after.length === 0, `got ${after.length}`);

  console.log('8) 重置恢复完整时长且 warning 解除');
  a.ws.send(JSON.stringify({ command: 'reset', durationMs: 500 }));
  const badReset = await next(a.inbox, 'error');
  ok('reset 非法时长被拒(<1s)', badReset.code === 'INVALID_DURATION');
  a.ws.send(JSON.stringify({ command: 'reset', durationMs: 120000 }));
  const sReset = await next(a.inbox, 'snapshot');
  ok('重置后 idle 且 120s', sReset.phase === 'idle' && sReset.remainingMs === 120000);
  ok('>60s warning=false', sReset.warning === false);

  console.log('9) 投屏重连恢复同一剩余时间');
  a.ws.send(JSON.stringify({ command: 'set_duration', durationMs: 30000 }));
  await next(a.inbox, 'snapshot');
  a.ws.send(JSON.stringify({ command: 'start' }));
  await next(a.inbox, 'snapshot');
  await sleep(1200);
  const c = await connect();
  await next(c.inbox, 'hello');
  const sRecv = await next(c.inbox, 'snapshot');
  ok('新连接立即收到 running 快照', sRecv.phase === 'running');
  ok('恢复剩余≈28.8s（同一计时）', Math.abs(sRecv.remainingMs - 28800) < 400, `got ${sRecv.remainingMs}`);
  c.ws.close();

  console.log('10) 断线立即释放控制权，他人可接管');
  a.ws.close();
  await sleep(300);
  b.ws.send(JSON.stringify({ command: 'acquire' }));
  const take = await next(b.inbox, 'control');
  ok('A 断线后 B 获得控制权', take.granted === true);

  console.log('11) 主动释放');
  b.ws.send(JSON.stringify({ command: 'release' }));
  await sleep(300);
  const d = await connect();
  await next(d.inbox, 'hello');
  const sAfterRel = await next(d.inbox, 'snapshot');
  ok('释放后 locked=false', sAfterRel.locked === false);
  d.ws.close();
  b.ws.close();

  console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
  if (failures.length) {
    console.log('失败项:', failures.join('; '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
