import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CodexAppServerApi,
  appServerAttachmentInput,
  appServerAttachmentInputs,
  appServerLaunchArgs,
  appServerRequestMethod,
  appServerRuntimeCapabilities,
} from '../src/runtime.js';

test('one launch contract enables Realtime for stdio and persistent WebSocket transports', () => {
  assert.deepEqual(appServerLaunchArgs(), ['app-server', '--enable', 'realtime_conversation']);
  assert.deepEqual(appServerLaunchArgs({ listenUrl: 'ws://127.0.0.1:47178' }), [
    'app-server', '--enable', 'realtime_conversation', '--listen', 'ws://127.0.0.1:47178',
  ]);
});

test('runtime capabilities keep product context outside the shared App Server contract', () => {
  assert.deepEqual(appServerRuntimeCapabilities({ enabled: false, browserMcp: true }), {
    startupQueue: false,
    interruptTurn: false,
    appCommands: false,
    skills: false,
    threadSearch: false,
    threadFork: false,
    subagents: false,
    audioInput: false,
    threadTree: false,
    sideChat: false,
    attachments: false,
    approvals: false,
    browserMcp: false,
    realtimeV3: false,
  });
  const personal = appServerRuntimeCapabilities({ browserMcp: true });
  assert.equal(personal.realtimeV3, true);
  assert.equal(personal.browserMcp, true);
  assert.equal('projects' in personal, false);
});

test('approval and attachment protocol inputs are shared by both hosts', () => {
  assert.equal(appServerRequestMethod('permission_approval'), 'item/permissions/requestApproval');
  assert.equal(appServerRequestMethod('future_request'), 'core/future_request');
  assert.deepEqual(appServerAttachmentInput({ mimeType: 'image/png', path: '/tmp/chart.png' }), {
    type: 'localImage', path: '/tmp/chart.png',
  });
  assert.deepEqual(appServerAttachmentInput({ mimeType: 'application/octet-stream', name: 'note.m4a', path: '/tmp/note' }), {
    type: 'localAudio', path: '/tmp/note',
  });
  assert.deepEqual(appServerAttachmentInput({ mimeType: 'application/pdf', name: 'brief.pdf', path: '/tmp/brief.pdf' }), {
    type: 'mention', name: 'brief.pdf', path: '/tmp/brief.pdf',
  });
});

test('App Server attachment inputs inline text and pair generic files with a transcript envelope', () => {
  const textInputs = appServerAttachmentInputs({
    mimeType: 'text/plain', name: 'notes.txt', path: '/tmp/notes.txt', textContent: 'hello', size: 5,
  });
  assert.equal(textInputs.length, 1);
  assert.match(textInputs[0].text, /agent-workbench-attachment/);
  assert.match(textInputs[0].text, /hello/);
  const fileInputs = appServerAttachmentInputs({
    mimeType: 'application/pdf', name: 'report.pdf', path: '/tmp/report.pdf', size: 10,
  });
  assert.equal(fileInputs.length, 2);
  assert.match(fileInputs[0].text, /report\.pdf/);
  assert.deepEqual(fileInputs[1], { type: 'mention', name: 'report.pdf', path: '/tmp/report.pdf' });
  assert.throws(() => appServerAttachmentInputs({
    mimeType: 'text/plain', name: 'large.txt', path: '/tmp/large.txt', textContent: 'too large', size: 9,
    maxInlineTextBytes: 4,
  }), { code: 'TEXT_ATTACHMENT_TOO_LARGE' });

  const markdownInputs = appServerAttachmentInputs({
    id: 'markdown-id', mimeType: 'text/markdown', name: 'rich.md', path: '/tmp/rich.md', textContent: '## 标题', size: 9,
  });
  assert.equal(markdownInputs.length, 1);
  assert.match(markdownInputs[0].text, /id="markdown-id"/);
  assert.match(markdownInputs[0].text, /mime="text%2Fmarkdown"/);

  const imageInputs = appServerAttachmentInputs({
    id: 'image-id', mimeType: 'image/png', name: 'chart.png', path: '/tmp/chart.png', size: 12,
  });
  assert.equal(imageInputs.length, 2);
  assert.match(imageInputs[0].text, /kind="image"/);
  assert.deepEqual(imageInputs[1], { type: 'localImage', path: '/tmp/chart.png' });
});

test('one stateless API serves Agent and Personal transports without sharing account state', async () => {
  const requests = [];
  const api = new CodexAppServerApi(async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/list') return { data: [{ id: 'thread-1' }] };
    if (method === 'thread/search') return { data: [{ thread: { id: 'thread-search' }, snippet: 'matched text' }] };
    if (method === 'thread/searchOccurrences') return { data: [{ itemId: 'item-search' }] };
    if (method === 'thread/read') return { thread: { id: params.threadId } };
    return { ok: true };
  });
  assert.equal((await api.listThreads()).data[0].id, 'thread-1');
  assert.equal((await api.searchThreads('  needle  ', { archived: true })).data[0].thread.id, 'thread-search');
  assert.equal((await api.searchThreadOccurrences('thread-work', 'detail')).data[0].itemId, 'item-search');
  assert.equal((await api.readThread('thread-work')).id, 'thread-work');
  await api.compactThread('thread-work');
  await api.startRealtime('thread-work', { voice: 'juniper' });
  await api.appendRealtimeAudio('thread-work', 'base64-audio');
  await api.stopRealtime('thread-work');
  assert.deepEqual(requests.slice(4), [
    { method: 'thread/compact/start', params: { threadId: 'thread-work' } },
    { method: 'thread/realtime/start', params: { voice: 'juniper', threadId: 'thread-work' } },
    { method: 'thread/realtime/appendAudio', params: { threadId: 'thread-work', audio: 'base64-audio' } },
    { method: 'thread/realtime/stop', params: { threadId: 'thread-work' } },
  ]);
  assert.deepEqual(requests.slice(1, 3), [
    { method: 'thread/search', params: { archived: true, searchTerm: 'needle' } },
    { method: 'thread/searchOccurrences', params: { threadId: 'thread-work', searchTerm: 'detail' } },
  ]);
});

test('thread search rejects empty terms before contacting App Server', async () => {
  const api = new CodexAppServerApi(() => assert.fail('request should not run'));
  assert.throws(() => api.searchThreads('   '), /search term is required/i);
  assert.throws(() => api.searchThreadOccurrences('thread-work', ''), /search term is required/i);
  assert.throws(() => api.compactThread(''), /thread id is required/i);
});
