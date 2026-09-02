import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveSessionPresentation,
  groupSessionSummaries,
  sessionComposerPresentation,
  sessionCurrentTask,
  sessionMessagePresentation,
  sessionStatusTone,
  sessionTaskPresentation,
} from '../src/session.js';

test('Agent sessions group by execution and reading state without projects', () => {
  const sessions = [
    { id: 'approval', waitingForUser: true },
    { id: 'running', turnState: { active: true } },
    { id: 'unread', hasUnreadResult: true },
    { id: 'idle' },
  ];
  assert.deepEqual(
    groupSessionSummaries(sessions, 'attention').map((group) => [group.id, group.sessions.map((session) => session.id)]),
    [
      ['pending', ['approval', 'unread']],
      ['running', ['running']],
      ['ready', ['idle']],
    ],
  );
});

test('consumer-provided rich status keeps Agent grouping without exposing runtime fields', () => {
  const sessions = [
    { id: 'stopping', groupKind: 'running', status: 'stopping', statusLabel: '停止中' },
    { id: 'released', groupKind: 'released', status: 'released', statusLabel: '已暂停' },
    { id: 'attention', groupKind: 'attention', status: 'attention', statusLabel: '待确认' },
  ];
  assert.deepEqual(
    groupSessionSummaries(sessions, 'attention').map((group) => [group.id, group.sessions.map((session) => session.id)]),
    [
      ['pending', ['attention']],
      ['running', ['stopping']],
      ['ready', ['released']],
    ],
  );
  assert.equal(deriveSessionPresentation(sessions[0]).state, 'stopping');
  assert.equal(sessionStatusTone(sessions[2]), 'waiting');
});

test('Personal sessions keep project grouping while using the same presentation semantics', () => {
  const sessions = [
    { id: 'solver-running', contextId: 'solver', contextLabel: 'Solver Engine', updatedAt: 20, status: 'running' },
    { id: 'solver-unread', contextId: 'solver', contextLabel: 'Solver Engine', updatedAt: 10, status: 'unread' },
    { id: 'bible-idle', contextId: 'bible', contextLabel: 'Bible', updatedAt: 5, status: 'idle' },
  ];
  const groups = groupSessionSummaries(sessions, 'context');
  assert.deepEqual(groups.map((group) => [group.id, group.sessions.map((session) => session.id)]), [
    ['solver', ['solver-running', 'solver-unread']],
    ['bible', ['bible-idle']],
  ]);
  assert.equal(deriveSessionPresentation(sessions[0]).kind, 'running');
  assert.equal(deriveSessionPresentation(sessions[1]).kind, 'unread');
  assert.equal(sessionStatusTone(sessions[2]), 'idle');
});

test('current task is shared without leaking a project concept into Agent Web', () => {
  assert.equal(sessionCurrentTask({
    turnState: {
      requirements: [{ text: '旧任务', status: 'done' }],
      queuedTurns: [{ text: ' 继续处理 GPT Live 兼容性 ', status: 'queued' }],
    },
  }), '继续处理 GPT Live 兼容性');
});

test('Agent and Personal share one current-task status contract', () => {
  assert.deepEqual(sessionTaskPresentation({ ready: false }), {
    state: 'connecting', tone: 'running', label: '连接中',
  });
  assert.deepEqual(sessionTaskPresentation({ turnState: { active: true } }), {
    state: 'working', tone: 'running', label: '正在处理',
  });
  assert.deepEqual(sessionTaskPresentation({ turnState: { interrupted: true } }), {
    state: 'interrupted', tone: 'waiting', label: '已中断',
  });
  assert.deepEqual(sessionTaskPresentation({ previewOnly: true, sessionId: 'session-personal' }), {
    state: 'preview', tone: 'idle', label: '已暂停',
  });
});

test('Agent and Personal share message roles and running composer actions', () => {
  assert.deepEqual(sessionMessagePresentation({ type: 'user' }), {
    role: 'user', phase: 'answer', label: '你', tone: 'user',
  });
  assert.deepEqual(sessionMessagePresentation({ type: 'assistant', phase: 'commentary' }), {
    role: 'assistant', phase: 'commentary', label: '过程', tone: 'commentary',
  });
  assert.deepEqual(sessionComposerPresentation({ running: true }), {
    primaryMode: 'steer',
    primaryLabel: '追加当前',
    secondaryMode: 'queue',
    secondaryLabel: '下一轮',
    showSecondary: true,
  });
  assert.deepEqual(sessionComposerPresentation({ previewOnly: true, sessionId: 'saved-session' }).primaryLabel, '发送并恢复');
  assert.deepEqual(sessionComposerPresentation({ running: true, canSteer: false, canQueue: false }), {
    primaryMode: null,
    primaryLabel: '等待当前任务结束',
    secondaryMode: 'queue',
    secondaryLabel: '下一轮',
    showSecondary: false,
  });
});
