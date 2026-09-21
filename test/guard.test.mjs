// 版本守卫纯函数单测：node test/guard.test.mjs
import assert from 'node:assert/strict';
import { judgeSnapshot, INITIAL_BASELINE } from '../client/src/guard.js';

let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log(`  ✓ ${name}`); };

// 模拟连接首包 hello 建立基线
let st = { currentEpoch: 'E1', currentVersion: 0 };

check('更高版本被接受', () => {
  const v = judgeSnapshot(st, { epoch: 'E1', version: 5 });
  assert.equal(v.accept, true);
  assert.equal(v.baseline, false);
  st = { currentEpoch: v.epoch, currentVersion: v.version };
});

check('过期低版本被丢弃（不得回滚画面）', () => {
  const v = judgeSnapshot(st, { epoch: 'E1', version: 2, phase: 'idle' });
  assert.equal(v.accept, false);
});

check('相同版本被丢弃（重复消息）', () => {
  const v = judgeSnapshot(st, { epoch: 'E1', version: 5 });
  assert.equal(v.accept, false);
});

check('旧纪元残留快照（重启前消息）被丢弃', () => {
  const v = judgeSnapshot(st, { epoch: 'E0', version: 999 });
  assert.equal(v.accept, false);
});

check('未来纪元快照也不会在 hello 之前被冒认为基线', () => {
  const v = judgeSnapshot(st, { epoch: 'E2', version: 1 });
  assert.equal(v.accept, false);
});

check('INITIAL_BASELINE 下首条快照兜底接受（hello 丢失场景）', () => {
  const v = judgeSnapshot(INITIAL_BASELINE, { epoch: 'E9', version: 3 });
  assert.equal(v.accept, true);
  assert.equal(v.baseline, true);
  assert.equal(v.version, 3);
});

console.log(`\n守卫单测：${n} 通过，0 失败`);
