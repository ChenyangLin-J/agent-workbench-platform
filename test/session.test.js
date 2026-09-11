import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveSessionPresentation,
  groupSessionSummaries,
  sessionComposerPresentation,
  sessionCurrentTask,
  sessionMessagePublishesMedia,
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

test('consumer group order keeps owned Sessions before newer shared Sessions', () => {
  const groups = groupSessionSummaries([
    { id: 'shared', contextId: 'shared', contextLabel: '与我共享', groupSortOrder: 1, updatedAt: 20 },
    { id: 'owned', contextId: 'owned', contextLabel: '我的对话', groupSortOrder: 0, updatedAt: 10 },
  ], 'context');
  assert.deepEqual(groups.map((group) => group.id), ['owned', 'shared']);
});

test('favorites stay in one leading group before time or context grouping', () => {
  const sessions = [
    { id: 'today', contextId: 'personal', contextLabel: 'Personal', updatedAt: 30 },
    { id: 'older-favorite', contextId: 'data', contextLabel: 'DataMama', updatedAt: 10, favorited: true },
    { id: 'newer-favorite', contextId: 'personal', contextLabel: 'Personal', updatedAt: 20, favorited: true },
    { id: 'older', contextId: 'data', contextLabel: 'DataMama', updatedAt: 5 },
  ];

  for (const mode of ['time', 'context']) {
    const groups = groupSessionSummaries(sessions, mode, 30);
    assert.equal(groups[0].id, 'favorites');
    assert.equal(groups[0].label, '★ 置顶');
    assert.deepEqual(groups[0].sessions.map((session) => session.id), ['newer-favorite', 'older-favorite']);
    assert.equal(groups.slice(1).flatMap((group) => group.sessions).some((session) => session.favorited), false);
  }
});

test('favorite input order is stable when the consumer supplies sort order', () => {
  const groups = groupSessionSummaries([
    { id: 'first', updatedAt: 10, sortOrder: 2, favorited: true },
    { id: 'second', updatedAt: 20, sortOrder: 1, favorited: true },
  ], 'time', 30);
  assert.deepEqual(groups[0].sessions.map((session) => session.id), ['second', 'first']);
});

test('attention grouping remains status-first even for favorites', () => {
  const groups = groupSessionSummaries([
    { id: 'favorite-running', status: 'running', favorited: true },
    { id: 'idle', status: 'idle' },
  ], 'attention');
  assert.deepEqual(groups.map((group) => group.id), ['running', 'ready']);
  assert.equal(groups.some((group) => group.id === 'favorites'), false);
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
  assert.deepEqual(sessionComposerPresentation({
    running: true,
    activityKind: 'contextCompaction',
  }), {
    primaryMode: 'queue',
    primaryLabel: '下一轮',
    secondaryMode: 'queue',
    secondaryLabel: '下一轮',
    showSecondary: false,
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

for (const fixture of [
  { label: 'project-free', context: {} },
  { label: 'project-scoped', context: { contextId: 'project-1', contextLabel: 'Project One' } },
]) {
  test(`only user input and final answers publish media in a ${fixture.label} Session`, () => {
    assert.equal(sessionMessagePublishesMedia({ ...fixture.context, role: 'user', media: [{ kind: 'image' }] }), true);
    assert.equal(sessionMessagePublishesMedia({ ...fixture.context, role: 'assistant', phase: 'final_answer', media: [{ kind: 'image' }] }), true);
    assert.equal(sessionMessagePublishesMedia({ ...fixture.context, role: 'assistant', phase: 'commentary', media: [{ kind: 'image' }] }), false);
  });
}
