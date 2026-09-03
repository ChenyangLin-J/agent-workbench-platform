import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SessionBranchController,
  planSessionBranch,
  sessionMessageBranchEligibility,
} from '../src/features/session-branch.js';

test('Session Branch plans replacement from the previous completed Turn', () => {
  assert.deepEqual(planSessionBranch([
    { id: 'turn-1', status: 'completed' },
    { id: 'turn-2', status: 'completed' },
  ], 'turn-2'), {
    replaceTurnId: 'turn-2',
    targetIndex: 1,
    lastTurnId: 'turn-1',
    empty: false,
  });
  assert.throws(
    () => planSessionBranch([{ id: 'turn-1', status: 'running' }], 'turn-1'),
    (error) => error.code === 'SESSION_BRANCH_TURN_ACTIVE',
  );
});

test('Session Branch Controller reserves, forks, registers, and starts an independent Turn', async () => {
  const calls = [];
  const controller = new SessionBranchController({
    history: { read: async () => ({ turns: [{ id: 'turn-1' }, { id: 'turn-2' }] }) },
    runtime: {
      create: async () => assert.fail('fork should be used'),
      fork: async (input) => { calls.push(['fork', input.lastTurnId]); return { runtimeSessionId: 'runtime-branch' }; },
      submit: async ({ input }) => { calls.push(['submit', input]); return { runtimeTurnId: 'turn-new' }; },
    },
    sessions: {
      reserve: async () => ({ sessionId: 'session-branch' }),
      register: async ({ reservation }) => ({ ...reservation, title: 'Branch' }),
      recordInput: async ({ turn }) => calls.push(['record', turn.runtimeTurnId]),
    },
  });
  const result = await controller.branch({
    sourceSessionId: 'session-source',
    replaceTurnId: 'turn-2',
    prompt: 'replacement',
  });
  assert.equal(result.session.sessionId, 'session-branch');
  assert.deepEqual(calls, [
    ['fork', 'turn-1'],
    ['submit', 'replacement'],
    ['record', 'turn-new'],
  ]);
});

test('message Branch eligibility honors the shared feature profile', () => {
  assert.deepEqual(sessionMessageBranchEligibility({
    session: { runtimeBinding: { activeTurnId: null } },
    message: { role: 'user', turnId: 'turn-1' },
    isLatestUserMessage: true,
    features: { messageEdit: false, messageFork: true },
  }), { canEdit: false, canFork: true });
  assert.deepEqual(sessionMessageBranchEligibility({
    session: { archived: true, runtimeBinding: { activeTurnId: null } },
    message: { role: 'user', turnId: 'turn-1' },
    isLatestUserMessage: true,
    features: { messageEdit: true, messageFork: true },
  }), { canEdit: false, canFork: false });
});
