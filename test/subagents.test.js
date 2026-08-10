import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CodexSubagentService,
  normalizeCodexThreadTree,
  rememberCodexSubagentMetadata,
} from '../src/subagents.js';
import { normalizeSessionViewModel } from '../src/ui/model.js';

test('Codex-native sub-agent discovery and interruption stay scoped to one parent Session', async () => {
  const requests = [];
  const metadata = new Map();
  rememberCodexSubagentMetadata(metadata, {
    type: 'collabAgentToolCall',
    receiverThreadIds: ['child-running'],
    prompt: 'Inspect the runtime contract',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    agentsStates: { 'child-running': { status: 'working', message: 'Reading tests' } },
  });
  const service = new CodexSubagentService(async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/list') return { data: [
      { id: 'child-running', parentThreadId: 'root', status: { type: 'active' }, preview: 'Runtime audit', updatedAt: 10 },
      { id: 'child-done', parentThreadId: 'root', status: { type: 'idle' }, name: 'UI review', updatedAt: 9 },
    ] };
    if (method === 'thread/read') return { thread: { id: params.threadId, turns: [{ id: 'turn-active', status: 'inProgress' }] } };
    return { ok: true };
  }, { metadata });

  const agents = await service.list('root');
  assert.deepEqual(agents.map((agent) => [agent.id, agent.statusType, agent.canStop]), [
    ['child-running', 'active', true],
    ['child-done', 'idle', false],
  ]);
  assert.equal(agents[0].prompt, 'Inspect the runtime contract');
  assert.equal(agents[0].state, 'working');
  assert.deepEqual(await service.stop('root', 'child-running'), {
    threadId: 'child-running', turnId: 'turn-active',
  });
  assert.deepEqual(requests.at(-1), {
    method: 'turn/interrupt', params: { threadId: 'child-running', turnId: 'turn-active' },
  });
  await assert.rejects(() => service.stop('root', 'outside'), /not a descendant/);
});

test('thread tree normalization distinguishes native sub-agents from forks', () => {
  const nodes = normalizeCodexThreadTree([
    { id: 'root', status: 'idle', name: 'Root' },
    { id: 'agent', parentThreadId: 'root', status: 'active', agentRole: 'reviewer' },
    { id: 'branch', forkedFromId: 'root', status: 'idle' },
    { id: 'other', status: 'idle' },
  ], { currentThreadId: 'root' });
  assert.deepEqual(nodes.map((node) => [node.id, node.relation]).sort(), [
    ['agent', 'agent'], ['branch', 'branch'], ['root', 'root'],
  ]);
});

test('shared Session UI view model exposes native sub-agent state without product fields', () => {
  const view = normalizeSessionViewModel({
    subagents: [{ id: 'child', agentRole: 'ignored', role: 'reviewer', statusType: 'active', canStop: true }],
  });
  assert.deepEqual(view.subagents[0], {
    id: 'child', name: '子 Agent', nickname: '', role: 'reviewer', status: '未知', statusType: 'active',
    state: '', stateMessage: '', prompt: '', model: '', reasoningEffort: '', canStop: true, updatedAt: 0,
  });
  assert.equal('projectId' in view.subagents[0], false);
});
