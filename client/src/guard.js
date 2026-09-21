// 快照版本守卫（纯函数，便于单测）：
// 基线（epoch）只由连接首包 hello 显式建立/重置；
// 之后只接受同 epoch 且 version 严格更高的快照，
// 过期/重复消息以及旧纪元残留消息一律丢弃，画面不得回滚。
export const INITIAL_BASELINE = Object.freeze({ currentEpoch: null, currentVersion: 0 });

export function judgeSnapshot(baseline, msg) {
  if (baseline.currentEpoch === null) {
    return { accept: true, baseline: true, epoch: msg.epoch, version: msg.version };
  }
  if (msg.epoch !== baseline.currentEpoch) {
    return { accept: false }; // 旧纪元（重启前）残留消息
  }
  if (msg.version <= baseline.currentVersion) {
    return { accept: false }; // 过期或重复
  }
  return { accept: true, baseline: false, epoch: msg.epoch, version: msg.version };
}
