import assert from 'node:assert/strict';
import test from 'node:test';
import { composerContextPresentation } from '../src/ui/model.js';

test('Context updates continue replacing usage after the dialog has read an older snapshot', () => {
  const initial = { usedTokens: 100, contextWindow: 1000 };
  const status = { snapshot: { tokenUsage: { usedTokens: 200, contextWindow: 1000 } }, usageAtRead: initial };
  assert.equal(composerContextPresentation({ usage: initial }, status).label, '20%');
  assert.equal(composerContextPresentation({ usage: { usedTokens: 600, contextWindow: 1000 } }, status).label, '60%');
  assert.equal(composerContextPresentation({ usage: null }, status).label, '未知');
});

test('An authoritative null context read clears previous usage without inventing a capacity', () => {
  const initial = { usedTokens: 100, contextWindow: 1000 };
  const status = { snapshot: { tokenUsage: null }, usageAtRead: initial };
  assert.equal(composerContextPresentation({ usage: initial }, status).label, '未知');
  const draft = composerContextPresentation({ usage: null, isDraft: true });
  assert.equal(draft.label, '未开始');
  assert.equal(draft.percent, null);
  assert.equal(draft.description, '发送首条消息后显示上下文用量');
  assert.equal(composerContextPresentation({ usage: { usedTokens: null, contextWindow: 1000 } }).percent, null);
});
