import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import katex from 'katex';
import { appendComposerReferences, attachmentDragLeavesTarget, clipboardAttachmentFiles, composerDropPayload, dataTransferHasFiles, documentPreviewPresentation, extractInlineVisualizations, extractRemarkDirectives, extractVisualizationReferences, groupSessionMessages, groupTechnicalItems, technicalGroupsInWindow, isDocumentResourceHref, isLocalFileHref, localFileBrowserHref, markdownHeadingId, mergeTechnicalItems, normalizeCapabilityManagerViewModel, normalizeMarkdownMath, normalizeSessionBrowserViewModel, normalizeSessionViewModel, normalizeSideChatPanelViewModel, renderFileCitationsAsMarkdown, resolveDocumentResourceHref, richClipboardHasComplexStructure, richClipboardText, sessionTranscriptAwayFromLatest, shouldConvertPastedTextToAttachment, technicalGroupSummary, technicalItemsWindow, technicalStatusLabel, technicalStatusState, technicalSubagentOperationLabel, turnDurationLabel } from '../src/ui/model.js';

const uiUrl = new URL('../src/ui/index.jsx', import.meta.url);
const stylesUrl = new URL('../src/ui/styles.css', import.meta.url);
const hooksUrl = new URL('../src/ui-hooks.js', import.meta.url);
const katexStylesUrl = new URL('../node_modules/katex/dist/katex.css', import.meta.url);

test('progressive records use human summaries and do not invent unknown statuses or completed-read metadata', async () => {
  const { technicalProcessSummary } = await import('../src/ui/model.js');
  assert.deepEqual(technicalProcessSummary({ type: 'command', title: 'command', text: 'node inspect.js\nfull multiline command', status: 'completed' }), { title: 'node inspect.js', typeLabel: '运行命令', statusLabel: '已完成' });
  assert.equal(technicalProcessSummary({ type: 'assistant', title: 'assistant', text: '检查最近的执行结果\n后续说明' }).title, '检查最近的执行结果');
  assert.equal(technicalProcessSummary({ type: 'tool', title: 'tool', status: 'unknown' }).statusLabel, '');
  assert.equal(technicalProcessSummary({ type: 'tool', title: 'tool' }).title, '工具调用');
  assert.equal(technicalProcessSummary({ type: 'tool', toolName: 'read_file', title: 'tool' }).title, 'read_file');
  for (const projectId of [null, 'project-scoped']) {
    const view = normalizeSessionViewModel({ sessionId: 'session', projectId, technicalDetailsAvailable: ['turn'], technicalItemCount: 99 });
    assert.deepEqual(view.technicalDetailsLoaded, []);
    assert.deepEqual(normalizeSessionViewModel({ sessionId: 'session', projectId, technicalDetailsLoaded: ['turn', 'turn'] }).technicalDetailsLoaded, ['turn']);
  }
});

test('progressive disclosure keeps text progress and Host-designated observations inline, while commands and tool outputs remain expandable', async () => {
  const { technicalProcessNeedsDisclosure } = await import('../src/ui/model.js');
  for (const projectId of [null, 'project-scoped']) {
    const view = normalizeSessionViewModel({ sessionId: 'session', projectId, technicalItems: [
      { id: 'progress', type: 'assistant', text: '检查执行结果\n继续核对详情' },
      { id: 'image', type: 'tool', disclosure: 'inline', detail: '{"path":"image.png"}', media: [{ kind: 'image', src: '/image.png' }] },
      { id: 'file', type: 'tool', text: '查看说明文件', artifacts: [{ id: 'readme', name: 'README.md' }] },
      { id: 'command', type: 'command', text: 'node --test' },
      { id: 'tool', type: 'tool', output: 'long tool output' },
    ] });
    assert.deepEqual(view.technicalItems.map(technicalProcessNeedsDisclosure), [false, false, false, true, true]);
    assert.equal(view.technicalItems[1].disclosure, 'inline');
    assert.equal(technicalProcessNeedsDisclosure({ type: 'tool', toolName: 'webSearch', text: 'a query' }), true);
    assert.equal(technicalProcessNeedsDisclosure({ type: 'subagent', text: 'reviewer · activity' }), true);
  }
});

test('running technical records keep full loaded history while recent live records update', () => {
  for (const projectId of [null, 'project-scoped']) {
    const normalized = normalizeSessionViewModel({ projectId, technicalItems: [{ id: 'recent', text: 'preview', previewTruncated: true, detailsAvailable: true }] });
    assert.equal(normalized.technicalItems[0].previewTruncated, true);
    assert.equal(normalized.technicalItems[0].detailsAvailable, true);
    const merged = mergeTechnicalItems([
      { id: 'recent', text: 'summary', status: 'inProgress', detailsAvailable: true },
      { id: 'new', text: 'newest live progress', status: 'inProgress' },
    ], [
      { id: 'earlier', text: 'older full record' },
      { id: 'recent', text: 'complete loaded record', output: 'full output' },
    ]);
    assert.equal(merged[0].id, 'earlier');
    assert.equal(merged[1].text, 'complete loaded record');
    assert.equal(merged[1].output, 'full output');
    assert.equal(merged[1].status, 'inProgress');
    assert.equal(merged[1].previewTruncated, false);
    assert.equal(merged[1].detailsAvailable, false);
    assert.equal(merged[2].id, 'new');
    const directory = mergeTechnicalItems([{ id: 'directory', text: 'new summary', detailsAvailable: true }],
      [{ id: 'directory', text: 'old summary', detailsAvailable: true }]);
    assert.equal(directory[0].detailsAvailable, true, 'merging directories cannot mark unread details as loaded');
    assert.equal(mergeTechnicalItems([{ id: 'late-output', detailsAvailable: true }],
      [{ id: 'late-output', detailsAvailable: false }])[0].detailsAvailable, true);
    assert.deepEqual(technicalItemsWindow(Array.from({ length: 65 }, (_, index) => ({ id: String(index) }))), Array.from({ length: 30 }, (_, index) => ({ id: String(index + 35) })));
  }
});

test('technical display projection groups only adjacent named execution records and preserves boundaries', () => {
  for (const projectId of [null, 'project-scoped']) {
    const items = normalizeSessionViewModel({ projectId, technicalItems: [
      { id: 'one', type: 'command', text: 'git status', status: 'completed' },
      { id: 'two', type: 'command', text: 'git diff', status: 'failed' },
      { id: 'note', type: 'assistant', text: '检查结果' },
      { id: 'py', type: 'command', text: 'python check.py' },
      { id: 'py2', type: 'command', text: 'python test.py' },
      { id: 'tool-one', type: 'tool', toolName: 'read_file' },
      { id: 'tool-two', type: 'tool', toolName: 'read_file', status: 'inProgress' },
      { id: 'sub', type: 'subagent', agentName: 'reviewer' },
      { id: 'generic-a', type: 'tool', title: '工具调用' },
      { id: 'generic-b', type: 'tool', title: '工具调用' },
    ] }).technicalItems;
    const projection = groupTechnicalItems(items);
    assert.deepEqual(projection.map(entry => entry.kind === 'group' ? entry.items.map(item => item.id) : entry.item.id), [['one', 'two'], 'note', ['py', 'py2'], ['tool-one', 'tool-two'], 'sub', 'generic-a', 'generic-b']);
    assert.deepEqual(technicalGroupSummary(projection[0]), { label: '运行命令', status: 'failed', count: 2 });
    assert.equal(items.map(item => item.id).join(','), 'one,two,note,py,py2,tool-one,tool-two,sub,generic-a,generic-b');
    const liveGroup = groupTechnicalItems(items.slice(3, 5))[0];
    const appendedGroup = groupTechnicalItems([...items.slice(3, 5), { id: 'py3', type: 'command', text: 'python report.py' }])[0];
    assert.equal(appendedGroup.id, liveGroup.id, 'tail append retains the open group identity');
    assert.deepEqual(technicalItemsWindow(Array.from({ length: 32 }, (_, index) => ({ id: `command-${index}`, type: 'command', text: 'git status' }))).map(item => item.id), Array.from({ length: 30 }, (_, index) => `command-${index + 2}`));
    const thirtyOne = Array.from({ length: 31 }, (_, index) => ({ id: `live-${index}`, type: 'command', text: 'git status', turnKey: 'turn' }));
    const previousWindowGroup = technicalGroupsInWindow(thirtyOne.slice(0, 30), technicalItemsWindow(thirtyOne.slice(0, 30)))[0];
    const shiftedWindowGroup = technicalGroupsInWindow(thirtyOne, technicalItemsWindow(thirtyOne))[0];
    assert.equal(shiftedWindowGroup.id, previousWindowGroup.id, 'sliding the latest-30 window does not remount an open group');
  }
});

test('technical groups distinguish real Python commands, turns, and native statuses', () => {
  const projection = groupTechnicalItems([
    { id: 'python-a', type: 'command', text: 'python3 -c "print(1)"', turnKey: 'one', status: 'running' },
    { id: 'python-b', type: 'command', text: 'python test.py', turnKey: 'one', status: 'pending' },
    { id: 'shell', type: 'tool', toolName: 'exec_command', text: 'echo python', turnKey: 'one' },
    { id: 'next-turn', type: 'command', text: 'git status', turnKey: 'two', status: 'canceled' },
    { id: 'next-turn-2', type: 'command', text: 'git diff', turnKey: 'three' },
  ]);
  assert.equal(projection[0].identity, 'command:python');
  assert.deepEqual(projection[0].items.map(item => item.id), ['python-a', 'python-b']);
  assert.equal(projection[1].item.toolName, 'exec_command', 'a shell string mentioning python is not a Python tool');
  assert.deepEqual(projection.slice(2).map(entry => entry.item.id), ['next-turn', 'next-turn-2'], 'adjacent commands never cross a turn boundary');
  assert.deepEqual(technicalGroupSummary(projection[0]), { label: 'Python 命令', status: 'inProgress', count: 2 });
  assert.equal(technicalStatusState('canceled'), 'interrupted');
  assert.equal(technicalStatusLabel('running'), '进行中');
  assert.equal(technicalSubagentOperationLabel('spawnAgent', 'completed'), '已派发');
  assert.equal(technicalSubagentOperationLabel('wait_agent', 'pending'), '等待中');
  assert.equal(technicalSubagentOperationLabel('sendInput', 'failed'), '失败');
});

test('attachment drag feedback survives child transitions but clears outside the Session', () => {
  const bounds = { left: 10, right: 210, top: 20, bottom: 220 };
  const child = {};
  const currentTarget = {
    contains: (candidate) => candidate === child,
    getBoundingClientRect: () => bounds,
  };
  assert.equal(attachmentDragLeavesTarget({ currentTarget, relatedTarget: child }), false);
  assert.equal(attachmentDragLeavesTarget({ currentTarget, clientX: 100, clientY: 120 }), false);
  assert.equal(attachmentDragLeavesTarget({ currentTarget, clientX: 250, clientY: 120 }), true);
  assert.equal(attachmentDragLeavesTarget({ currentTarget, clientX: 0, clientY: 0 }), true);
});

test('attachment drag accepts browser array-like DataTransfer types', () => {
  assert.equal(dataTransferHasFiles({ types: ['Files'] }), true);
  assert.equal(dataTransferHasFiles({ types: { 0: 'Files', length: 1 } }), true);
  assert.equal(dataTransferHasFiles({ types: { 0: 'text/plain', length: 1 } }), false);
});

test('Session UI delegates message links and read-only document previews to its host', async () => {
  const [source, styles] = await Promise.all([
    readFile(uiUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
  ]);

  assert.match(source, /documentPreview = null/);
  assert.match(source, /onOpenLink\(href\)/);
  assert.match(source, /onRevealLink\(href\)/);
  assert.match(source, /className="cwu-local-file-reveal"/);
  assert.match(source, /components=\{documentMarkdownComponents\(\{ documentResourceUrl, file, onOpenLink, onRevealLink, revealLabel \}\)\}/);
  assert.match(source, /\^https\?:\\\/\\\//);
  assert.match(source, /rel="noreferrer" target="_blank"/);
  assert.match(source, /onOpenExternal\(file\)/);
  assert.match(source, /onReveal\(file\)/);
  assert.match(source, /onEdit\(file\)/);
  assert.match(source, /onSave\(\{ file, content: editorContent, version: file\.version \|\| null \}\)/);
  assert.match(source, /documentResourceUrl/);
  assert.match(source, /rehypeDocumentHeadingIds/);
  assert.match(source, /className="cwu-document-editor"/);
  assert.match(source, /srcDoc=\{sandboxedHtmlSource\(file\.content \|\| ''\)\}/);
  assert.match(source, /sandbox="allow-scripts"/);
  assert.match(source, /aria-label="文件查看方式"/);
  assert.match(source, /file\.format === 'markdown'.*file\.rawAvailable !== false/s);
  assert.match(source, /file\.format === 'sql'.*file\.rawAvailable === false/s);
  assert.match(source, /file\.format === 'spreadsheet'/);
  assert.match(source, /function SpreadsheetPreview/);
  assert.match(styles, /\.cwu-document-preview/);
  assert.match(styles, /\.cwu-document-backdrop \{[^}]*backdrop-filter: blur\(10px\)/);
  assert.match(styles, /\.cwu-document-preview \{[^}]*background: color-mix\([^}]*backdrop-filter: blur\(18px\)/);
  assert.match(styles, /@media \(prefers-reduced-transparency: reduce\)/);
  assert.match(styles, /\.cwu-document-tabs/);
  assert.match(styles, /\.cwu-document-html/);
  assert.match(styles, /\.cwu-document-editor/);
  assert.match(styles, /\.cwu-spreadsheet-scroll table/);
  assert.match(styles, /\.cwu-spreadsheet-scroll \{ min-width: 0/);
  assert.match(styles, /\.cwu-local-file-link:hover \.cwu-local-file-reveal/);
  assert.match(styles, /\.cwu-local-file-link \{ position: relative; display: inline-block/);
  assert.match(styles, /\.cwu-local-file-reveal \{ position: absolute;/);
  assert.match(styles, /@media \(hover: none\)/);
  assert.match(styles, /\.cwu-browser\.is-list-collapsed \{ grid-template-columns: 0 0 minmax\(0, 1fr\); \}/);
  assert.match(styles, /\.cwu-browser\.is-list-collapsed \.cwu-browser-list-toggle \{[^}]*position: absolute/);
  assert.match(source, /function SessionDocumentPreview\(\{ actions = \{\}, documentPreview, labels = \{\} \}\)/);
  assert.match(source, /<SessionWorkspace key=\{detail\.session\?\.sessionId \|\| 'session-detail'\} \{\.\.\.detail\} uiStateStore=\{sessionUiState\.current\} documentPreview=\{null\} \/>/);
  assert.match(source, /<SessionDocumentPreview\s+actions=\{detail\?\.actions\}\s+documentPreview=\{browserDocumentPreview\}\s+labels=\{detail\?\.labels\}/);
  assert.match(source, /inert=\{browserDocumentPreview \? true : undefined\}/);
  assert.match(styles, /\.cwu-browser > \.cwu-document-backdrop:not\(\.is-image\) \{ position: absolute; inset: -1px; overflow: hidden; border-radius: inherit; \}/);
});

test('Minimal Host browser mutations use reusable idempotency operations', async () => {
  const source = await readFile(new URL('../src/environment/host-client.jsx', import.meta.url), 'utf8');
  assert.match(source, /createSessionHostController/);
  assert.match(source, /hostController\.execute\('create'/);
  assert.match(source, /hostController\.execute\('turn'/);
  const adapter = await readFile(new URL('../src/environment/host-adapter.js', import.meta.url), 'utf8');
  assert.match(adapter, /idempotency-key/);
  assert.match(source, /bootstrap\.sessionStart === 'new'/);
  assert.match(source, /automaticSessionCreationAttempted/);
  assert.match(source, /shouldAutoCreateMinimalHostSession/);
  assert.match(source, /fallback: 'newest'/);
  assert.doesNotMatch(source, /agent-workbench\.minimal-host\.default-session/);
  assert.match(source, /documentPreview/);
  assert.match(source, /onCloseDocument: closeDocumentPreview/);
  assert.match(source, /URL\.revokeObjectURL/);
  assert.match(source, /const SESSION_LIST_PAGE_SIZE = 50/);
  assert.match(source, /const INITIAL_CONVERSATION_TURNS = 5/);
  assert.match(source, /const HISTORY_CONVERSATION_TURNS = 10/);
  assert.match(source, /paginationMode: 'incremental'/);
  assert.match(source, /onLoadEarlier: loadEarlierTurns/);
  assert.match(source, /onLoadTechnicalDetails: loadTechnicalDetails/);
  assert.match(adapter, /maintainMinimalHostEventStream/);
  assert.doesNotMatch(source, /for \(let page = 0; cursor/);
});

test('Session browser keeps header actions on one row at constrained widths', async () => {
  const styles = await readFile(stylesUrl, 'utf8');
  const responsive = styles.slice(styles.indexOf('@media (max-width: 1200px)'));
  assert.match(responsive, /\.cwu-browser-detail \.cwu-session-header \{ grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(responsive, /\.cwu-browser-detail \.cwu-session-header\.has-back \{ grid-template-columns: auto minmax\(0, 1fr\) auto;/);
  assert.match(responsive, /\.cwu-browser-detail \.cwu-session-actions \{ grid-column: auto;[^}]*white-space: nowrap;/);
});

test('Markdown document resources and heading anchors stay host-resolved and stable', () => {
  assert.equal(isDocumentResourceHref('./images/chart.png'), true);
  assert.equal(isDocumentResourceHref('../notes.md'), true);
  assert.equal(isDocumentResourceHref('images/chart.png'), true);
  assert.equal(isDocumentResourceHref('/Users/mac/chart.png'), true);
  assert.equal(isDocumentResourceHref('#overview'), false);
  assert.equal(isDocumentResourceHref('https://example.com/chart.png'), false);
  assert.equal(resolveDocumentResourceHref(
    { path: '/workspace/report.md' },
    './images/chart.png',
    ({ href }) => `/resource?href=${encodeURIComponent(href)}`,
  ), '/resource?href=.%2Fimages%2Fchart.png');
  assert.equal(resolveDocumentResourceHref({}, 'https://example.com/a.png', () => '/blocked'), 'https://example.com/a.png');
  assert.equal(markdownHeadingId('能力合并 / Next Step'), '能力合并-next-step');
  assert.equal(markdownHeadingId('***'), 'section');
});

test('Session UI keeps attachment lifecycle and technical file artifacts host-neutral', async () => {
  const [source, styles] = await Promise.all([readFile(uiUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);
  const view = normalizeSessionViewModel({
    technicalItems: [{
      id: 'change-1',
      artifacts: [{ name: 'report.html', path: '/tmp/report.html', status: 'modify' }],
    }],
  });
  assert.deepEqual(view.technicalItems[0].artifacts[0], {
    id: 'technical-0-artifact-0',
    name: 'report.html',
    kind: 'file',
    mimeType: 'application/octet-stream',
    size: 0,
    status: 'modify',
    path: '/tmp/report.html',
    href: '',
    previewUrl: '',
  });
  const pagedView = normalizeSessionViewModel({
    turnCount: 12,
    turnsCursor: 'opaque-cursor',
    turnMetadata: [{
      turnKey: 'opaque-turn', ordinal: 8, startedAt: '2026-09-11T01:02:00.000Z',
      completedAt: '2026-09-11T01:04:18.000Z', technicalItemCount: 3,
    }],
    messages: [{
      id: 'answer-with-lazy-media',
      media: [{ type: 'resourceImage', resourceId: 'resource-1', name: 'chart.png', mimeType: 'image/png' }],
    }],
  });
  assert.equal(pagedView.turnCount, 12);
  assert.equal(pagedView.turnsCursor, 'opaque-cursor');
  assert.deepEqual(pagedView.turnMetadata[0], {
    turnKey: 'opaque-turn',
    turnId: null,
    ordinal: 8,
    startedAt: Date.parse('2026-09-11T01:02:00.000Z'),
    completedAt: Date.parse('2026-09-11T01:04:18.000Z'),
    technicalItemCount: 3,
  });
  assert.deepEqual(normalizeSessionViewModel({
    turnMetadata: [{ turnKey: 'missing-optional-values', ordinal: null, startedAt: null, technicalItemCount: null }],
  }).turnMetadata[0], {
    turnKey: 'missing-optional-values',
    turnId: null,
    ordinal: null,
    startedAt: null,
    completedAt: null,
    technicalItemCount: null,
  });
  assert.equal(pagedView.messages[0].media[0].resourceId, 'resource-1');
  assert.equal(pagedView.messages[0].media[0].src, '');
  assert.match(source, /onUploadAttachments\(\[placeholder\.file\], \{/);
  assert.match(source, /onDragEnter=\{handleWorkspaceAttachmentDrag\}/);
  assert.match(source, /onDrop=\{handleWorkspaceAttachmentDrop\}/);
  assert.match(source, /opaqueFilePreview/);
  assert.match(source, /onProgress: \(progress\) =>/);
  assert.match(source, /retryAttachment\(attachment\)/);
  assert.match(source, /className="cwu-technical-artifacts"/);
  assert.match(source, /onOpenArtifact/);
  assert.match(source, /onRevealArtifact/);
  assert.match(source, /manualOpen \?\? running/);
  assert.match(source, /manualOpen \?\? \(running \|\| localOpen\)/);
  assert.match(source, /if \(!event\.target\.closest\('button'\)\) setOpen\(!open\)/);
  assert.match(source, /if \(id === selectedTab && open\) \{ setOpen\(false\); return; \}/);
  assert.match(source, /turnStatus === 'interrupted'/);
  assert.match(source, /globalThis\.setInterval\(\(\) => setDurationNow\(Date\.now\(\)\), 1000\)/);
  assert.match(source, /globalThis\.clearInterval\(timer\)/);
  assert.match(styles, /\.cwu-attachment-progress/);
  assert.match(styles, /\.cwu-technical-artifacts/);
});

test('turn duration labels use elapsed time instead of a wall-clock timestamp', () => {
  const startedAt = '2026-09-11T01:02:00.000Z';
  assert.equal(turnDurationLabel({ startedAt, completedAt: '2026-09-11T01:02:42.000Z' }), '42秒');
  assert.equal(turnDurationLabel({ startedAt, completedAt: '2026-09-11T01:04:18.000Z' }), '2分18秒');
  assert.equal(turnDurationLabel({ startedAt, completedAt: '2026-09-11T02:08:03.000Z' }), '1小时6分3秒');
  assert.equal(turnDurationLabel({ startedAt, running: true, now: '2026-09-11T01:02:18.000Z' }), '已运行 18秒');
  assert.equal(turnDurationLabel({ startedAt }), '');
  assert.equal(turnDurationLabel({ startedAt: 'invalid', completedAt: '2026-09-11T01:02:42.000Z' }), '');
  assert.equal(turnDurationLabel({ startedAt, completedAt: '2026-09-11T01:01:59.000Z' }), '');
});

test('code document previews keep line structure and resolve requested lines', async () => {
  assert.deepEqual(documentPreviewPresentation({
    name: 'server.js', format: 'text', content: 'one\ntwo\nthree', reference: '/tmp/server.js#L2',
  }), {
    code: true,
    highlightLine: 2,
    lines: ['one', 'two', 'three'],
  });
  assert.equal(documentPreviewPresentation({
    name: 'query.sql', format: 'sql', content: 'select 1', highlightLine: 9,
  }).highlightLine, null);
  assert.equal(documentPreviewPresentation({
    name: 'notes.txt', format: 'text', content: 'plain text',
  }).code, false);

  const [source, styles] = await Promise.all([readFile(uiUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);
  assert.match(source, /function DocumentCodePreview/);
  assert.match(source, /scrollIntoView\(\{ block: 'center', inline: 'nearest' \}\)/);
  assert.match(source, /className="cwu-document-line-number"/);
  assert.match(styles, /\.cwu-document-code-line \{[^}]*grid-template-columns:/);
  assert.match(styles, /\.cwu-document-line-number \{[^}]*position: sticky;[^}]*left: 0;/);
  assert.match(styles, /\.cwu-document-code-line\.is-highlighted/);
});

test('Session UI only offers host reveal actions for local file targets', () => {
  assert.equal(isLocalFileHref('/tmp/report.md'), true);
  assert.equal(isLocalFileHref('./capture.png'), true);
  assert.equal(isLocalFileHref('../capture.png'), true);
  assert.equal(isLocalFileHref('C:\\reports\\report.md'), true);
  assert.equal(isLocalFileHref('file:///tmp/report.md'), true);
  assert.equal(isLocalFileHref('//example.com/report.md'), false);
  assert.equal(isLocalFileHref('https://example.com/report.md'), false);
  assert.equal(isLocalFileHref('codex://threads/one'), false);
  assert.equal(localFileBrowserHref('./capture.png'), './capture.png');
  assert.equal(localFileBrowserHref('/Users/mac/report.md'), 'file:///Users/mac/report.md');
  assert.equal(localFileBrowserHref('C:\\reports\\report.md'), 'file:///C:/reports/report.md');
  assert.equal(localFileBrowserHref('file:///tmp/report.md'), 'file:///tmp/report.md');
  assert.equal(localFileBrowserHref('https://example.com/report.md'), 'https://example.com/report.md');
});

test('Capability UI normalizes common and custom host state without credential values', async () => {
  const [source, styles] = await Promise.all([readFile(uiUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);
  const view = normalizeCapabilityManagerViewModel({
    profileId: 'personal',
    capabilities: [{
      id: 'cli.node', title: 'Node.js', kind: 'cli-tool', scope: 'common', version: '1', enabled: true,
      available: true, status: 'healthy', dependencies: ['credentials.node'], requiredBy: [], components: ['one'],
    }],
  });
  assert.deepEqual(view.counts, { common: 1, custom: 0, enabled: 1, healthy: 1 });
  assert.equal(view.capabilities[0].kindLabel, 'CLI');
  assert.deepEqual(view.capabilities[0].components, ['one']);
  assert.match(source, /export function CapabilityPanel/);
  assert.match(source, /actions\.onInspectComponent/);
  assert.match(source, /actions\.onPlan/);
  assert.match(source, /actions\.onExecute/);
  assert.match(styles, /\.cwu-capability-panel/);
  assert.match(styles, /\.cwu-capability-preview/);
});

test('Session UI extracts safe inline visualizations and keeps message media', () => {
  const parsed = extractInlineVisualizations('上文\n\n::codex-inline-vis{file="session-layout-options.html"}\n\n下文');
  assert.deepEqual(parsed, { markdown: '上文\n\n下文', files: ['session-layout-options.html'] });
  assert.deepEqual(extractInlineVisualizations('::codex-inline-vis{file="../secret.html"}').files, []);

  const current = extractVisualizationReferences('上文\n\nvisualize{"path":"/safe/thread/session-entry.html","mode":"wide","title":"Session 对比"}\n\n下文');
  assert.deepEqual(current, {
    markdown: '上文\n\n下文',
    references: [{
      file: 'session-entry.html',
      path: '/safe/thread/session-entry.html',
      mode: 'wide',
      title: 'Session 对比',
    }],
  });

  const fenced = '```text\n::codex-inline-vis{file="missing.html"}\nvisualize{"path":"/safe/thread/hidden.html"}\n```';
  assert.deepEqual(extractVisualizationReferences(fenced), { markdown: fenced, references: [] });
  assert.deepEqual(extractVisualizationReferences('visualize{"path":"../secret.html"}').references, [{
    file: 'secret.html', path: '../secret.html', mode: null, title: null,
  }]);

  const view = normalizeSessionViewModel({ messages: [{ media: [{ kind: 'image', src: '/media/1', alt: '截图' }] }] });
  assert.equal(view.messages[0].media[0].src, '/media/1');
});

test('Session UI normalizes Codex math delimiters without changing code examples', () => {
  const markdown = [
    '公式：',
    '\\[',
    '\\frac{ARR}{上月ARR} \\times 100\\%',
    '\\]',
    '行内 \\(x + y\\) 与金额 $483,885。',
    '`\\(code\\)`',
    '```text',
    '\\[',
    '\\frac{example}{only}',
    '\\]',
    '```',
  ].join('\n');
  assert.equal(normalizeMarkdownMath(markdown), [
    '公式：',
    '$$',
    '\\frac{ARR}{上月ARR} \\times 100\\%',
    '$$',
    '行内 $$x + y$$ 与金额 $483,885。',
    '`\\(code\\)`',
    '```text',
    '\\[',
    '\\frac{example}{only}',
    '\\]',
    '```',
  ].join('\n'));
});

test('KaTeX renderer and stylesheet use compatible box layout classes', async () => {
  const html = katex.renderToString('\\boxed{\\$9,358,595.04}');
  const styles = await readFile(katexStylesUrl, 'utf8');

  assert.match(html, /class="base"/);
  assert.match(html, /class="stretchy fbox"/);
  assert.match(styles, /\.katex \.base/);
  assert.match(styles, /\.katex \.fbox/);
});

test('Session UI turns Codex file citations into local file links', () => {
  assert.equal(
    renderFileCitationsAsMarkdown('文件：:codex-file-citation{path="/tmp/report draft.xlsx" purpose="output"}'),
    '文件：[文件：report draft.xlsx](/tmp/report%20draft.xlsx)',
  );
});

test('Session UI does not collect the same pasted image from both clipboard sources', () => {
  const directImage = { name: 'clipboard.png', type: 'image/png', size: 4, lastModified: 1 };
  const duplicateItemImage = { name: 'image.png', type: 'image/png', size: 4, lastModified: 2 };
  assert.deepEqual(clipboardAttachmentFiles({
    files: [directImage],
    items: [{ kind: 'file', getAsFile: () => duplicateItemImage }],
  }), [directImage]);

  const fallbackImage = { name: 'fallback.png', type: 'image/png', size: 5, lastModified: 3 };
  assert.deepEqual(clipboardAttachmentFiles({
    files: [],
    items: [{ kind: 'string' }, { kind: 'file', getAsFile: () => fallbackImage }],
  }), [fallbackImage]);

  const secondImage = { name: 'second.png', type: 'image/png', size: 6, lastModified: 4 };
  assert.deepEqual(clipboardAttachmentFiles({ files: [directImage, secondImage] }), [directImage, secondImage]);
});

test('Session UI parses standalone remark directives without matching ordinary CSS', () => {
  assert.deepEqual(
    extractRemarkDirectives('完成\n\n::inbox-item{title="上下文同步无持久变更" summary="项目快照保持不变"}'),
    { markdown: '完成', directives: [{ name: 'inbox-item', attributes: { title: '上下文同步无持久变更', summary: '项目快照保持不变' } }] },
  );
  assert.deepEqual(extractRemarkDirectives('.button:hover { color: red; }').directives, []);
  assert.equal(extractRemarkDirectives('::future-result{title="可读兜底" detail=ready}').directives[0].name, 'future-result');
  const fenced = '```text\n::inbox-item{title="只是示例"}\n```';
  assert.deepEqual(extractRemarkDirectives(fenced), { markdown: fenced, directives: [] });
});

test('Session UI embeds visualizations in a sandbox and renders image media', async () => {
  const [source, styles] = await Promise.all([readFile(uiUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);
  assert.match(source, /sandbox="allow-scripts"/);
  assert.match(source, /visualizationUrl/);
  const mathSource = await readFile(new URL('../src/ui/markdown-math.jsx', import.meta.url), 'utf8');
  assert.match(mathSource, /remarkMath/);
  assert.match(mathSource, /rehypeKatex/);
  assert.match(mathSource, /singleDollarTextMath: false/);
  assert.match(source, /const inlineMedia = \[\.\.\.\(publishesMedia \? message\.media \|\| \[\] : \[\]\)\]/);
  assert.match(source, /attachment\.kind === 'image' && \(attachment\.previewUrl \|\| onResolveMedia\)/);
  assert.match(source, /onResolveMedia=\{onResolveMedia\}/);
  assert.match(source, /function LazyMediaItem/);
  assert.match(source, /!publishesMedia \? \{ img: \(\) => null \}/);
  assert.match(styles, /\.cwu-inline-visualization iframe/);
  assert.match(styles, /katex\/dist\/katex\.min\.css/);
  assert.match(styles, /\.katex-display/);
  assert.match(styles, /\.cwu-message-media img \{[^}]*width: auto;[^}]*height: auto;[^}]*object-fit: contain;/);
});

test('Session UI exposes product extension content without owning product navigation or canvas', async () => {
  const [source, styles] = await Promise.all([readFile(uiUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);
  assert.match(source, /extensions\.renderAfterMessage/);
  assert.match(source, /extensions\.renderAfterMessages/);
  assert.match(source, /extensions\.renderBeforeMessages/);
  assert.match(source, /extensions\.renderComposerOverlay/);
  assert.match(source, /extensions\.renderHeaderActions/);
  assert.match(source, /extensions\.renderMessageContent/);
  assert.match(source, /actions\.onEditMessage/);
  assert.match(source, /actions\.onForkMessage/);
  assert.match(source, /data-message-id=\{message\.id\}/);
  assert.match(source, /normalizeSessionFeatures\(features\)/);
  assert.match(source, /normalizeAttachmentPolicy\(attachmentPolicy\)/);
  assert.match(source, /const files = \[\.\.\.\(event\.target\.files \|\| \[\]\)\];\s*event\.target\.value = '';\s*await uploadFiles\(files\);/);
  assert.match(source, /onInput=\{uploadAttachments\}/);
  assert.match(source, /onPaste=\{handleComposerPaste\}/);
  assert.match(source, /clipboardAttachmentFiles\(event\.clipboardData\)/);
  assert.match(source, /richClipboardText\(richHtml, plainText\)/);
  assert.match(source, /const structured = richClipboardHasComplexStructure\(markdown, richHtml\)/);
  assert.match(source, /structured && uploadPolicy\.structuredTextPaste === 'attachment'/);
  assert.match(source, /const attachPaste = structuredAttachment \|\| shouldConvertPastedTextToAttachment/);
  assert.match(source, /shouldConvertPastedTextToAttachment\(draft, text/);
  assert.match(source, /structuredAttachment \? 'md' : 'txt'/);
  assert.doesNotMatch(source, /composerPreview|editFormattedComposer|格式化内容，点击编辑/);
  assert.match(source, /onOpenAttachment=\{actions\.onOpenAttachment\}/);
  assert.match(source, /className="cwu-message-attachment"/);
  assert.match(source, /className=\{`cwu-document-backdrop\$\{file\.format === 'image' \? ' is-image' : ''\}`\}/);
  assert.match(source, /className="cwu-document-image"/);
  assert.match(styles, /\.cwu-document-backdrop\.is-image \{[^}]*position: fixed/);
  assert.match(styles, /\.cwu-document-backdrop\.is-image \{[^}]*backdrop-filter: blur\(8px\)/);
  assert.match(styles, /\.cwu-document-backdrop\.is-image \.cwu-document-preview \{[^}]*width: 100%/);
  assert.match(styles, /\.cwu-document-backdrop\.is-image \.cwu-document-image \{[^}]*place-items: center/);
  assert.match(styles, /\.cwu-document-backdrop\.is-image \.cwu-document-image img \{[^}]*max-height: calc\(100dvh - 128px\)/);
  assert.match(source, /className="cwu-document-pdf"/);
  assert.match(source, /className=\{`cwu-scroll-latest/);
  assert.match(source, /target\.scrollTo\(\{ top: target\.scrollHeight, behavior: 'smooth' \}\)/);
  assert.match(source, /labels\.newMessages \|\| '有新消息'/);
  assert.match(styles, /\.cwu-scroll-latest/);
  assert.match(styles, /\.cwu-scroll-latest \{[^}]*position: absolute/);
  assert.match(styles, /\.cwu-scroll-latest \{[^}]*transform: translate\(-50%, calc\(-100% - 8px\)\)/);
  assert.match(source, /supportedEfforts\.includes\(view\.executionProfile\.reasoningEffort\)/);
  const hooks = await readFile(hooksUrl, 'utf8');
  assert.match(source, /useSessionUserInput/);
  assert.match(hooks, /export function useSessionUserInput/);
  assert.doesNotMatch(source, /ArtifactCanvas|project-navigation/);
});

test('Minimal Host keeps owned portable Session Edit and Fork actions available', async () => {
  const source = await readFile(new URL('../src/environment/host-client.jsx', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../src/ui/index.jsx', import.meta.url), 'utf8');
  assert.match(source, /const sessionBranchable = !sharedReadOnly;/);
  assert.match(source, /onEditMessage: messageEditEnabled && sessionBranchable/);
  assert.match(source, /onForkMessage: messageForkEnabled && sessionBranchable/);
  assert.match(source, /intent === 'edit' \? \{ prompt, references \} : \{\}/);
  assert.match(ui, /onForkMessage\(\{ messageId: message\.id, turnId: message\.turnId, prompt: message\.content, references: message\.references \}\)/);
  assert.match(source, /const branchable = session\.access\?\.kind !== 'shared';/);
  assert.match(source, /模型服务暂时不可用，本轮已结束。你可以编辑这条消息后重试/);
  assert.match(source, /all\\s\+\\d\+\\s\+channels/);
});

test('long pasted text becomes an attachment before the Composer hard limit', () => {
  assert.equal(shouldConvertPastedTextToAttachment('', 'a'.repeat(999)), false);
  assert.equal(shouldConvertPastedTextToAttachment('', 'a'.repeat(1000)), true);
  assert.equal(shouldConvertPastedTextToAttachment('a'.repeat(11500), 'b'.repeat(501)), true);
  assert.equal(shouldConvertPastedTextToAttachment('', ''), false);
});

test('rich clipboard HTML becomes safe Markdown while preserving structure', () => {
  const markdown = richClipboardText(
    '<h2>结论</h2><p><strong>重点</strong></p><ul><li>第一项</li></ul><table><tr><th>指标</th></tr><tr><td>42</td></tr></table>',
    '结论 重点 第一项 指标 42',
  );
  assert.match(markdown, /^## 结论/m);
  assert.match(markdown, /\*\*重点\*\*/);
  assert.match(markdown, /-\s+第一项/);
  assert.match(markdown, /\| 指标 \|/);
});

test('rich clipboard plain formulas keep literal multiplication asterisks', () => {
  const plain = '周包改成 *52，然后周转月根据用户是周就是 周费用*52，月就是月费用*12 对吧。';
  const pasted = richClipboardText(`<p>${plain}</p>`, plain);
  assert.equal(pasted, plain);
  assert.equal(pasted.includes('\\*'), false);
  assert.equal(richClipboardHasComplexStructure(pasted), false);
});

test('Composer routes only structurally complex clipboard text to an attachment', () => {
  assert.equal(richClipboardHasComplexStructure('普通的一句话'), false);
  assert.equal(richClipboardHasComplexStructure('这里有 **重点** 和 [链接](https://example.com)'), false);
  assert.equal(richClipboardHasComplexStructure('金额是 2 * 3，不是列表'), false);
  assert.equal(richClipboardHasComplexStructure('# 单独复制的短标题', '<h1>单独复制的短标题</h1>'), false);
  assert.equal(richClipboardHasComplexStructure('# **带样式的单独标题**', '<h1><strong>带样式的单独标题</strong></h1>'), false);
  assert.equal(richClipboardHasComplexStructure('-   定时通知按钮定位到真实 Superset Header', '<ul><li>定时通知按钮定位到真实 Superset Header</li></ul>'), false);
  assert.equal(richClipboardHasComplexStructure('1. 单独复制的一项', '<ol><li>单独复制的一项</li></ol>'), false);
  assert.equal(richClipboardHasComplexStructure('# 标题\n\n正文', '<h1>标题</h1><p>正文</p>'), true);
  assert.equal(richClipboardHasComplexStructure('- 第一项\n- 第二项', '<ul><li>第一项</li><li>第二项</li></ul>'), true);
  assert.equal(richClipboardHasComplexStructure('## 结论\n\n- 第一项'), true);
  assert.equal(richClipboardHasComplexStructure('第一段\n\n第二段'), true);
  assert.equal(richClipboardHasComplexStructure('| 指标 |\n| --- |\n| 42 |'), true);
  assert.equal(richClipboardHasComplexStructure('Name | value', '<table><tr><td>Name</td><td>value</td></tr></table>'), true);
});

test('rich clipboard cleanup never keeps styled body-only table elements', () => {
  const markdown = richClipboardText(
    '<table _ngcontent-demo="" class="copied-table" style="color:red"><tbody><tr><td class="title">Name</td><td style="padding:7px"><span>skills.ddit.ai</span></td></tr><tr><td>Host</td><td><span>jumpserver.ddit.ai</span><span aria-hidden="true">hidden-control</span></td></tr></tbody></table>',
    'Name skills.ddit.ai Host jumpserver.ddit.ai',
  );
  assert.doesNotMatch(markdown, /<\/?(?:table|tbody|tr|td|span)\b/i);
  assert.doesNotMatch(markdown, /(?:style|class|_ngcontent|aria-hidden)=/i);
  assert.doesNotMatch(markdown, /hidden-control/);
  assert.match(markdown, /Name\s*\|\s*skills\.ddit\.ai/);
  assert.match(markdown, /Host\s*\|\s*jumpserver\.ddit\.ai/);
  assert.equal(shouldConvertPastedTextToAttachment('', markdown), false);
});

test('Session transcript only offers the latest-message shortcut away from the bottom', () => {
  assert.equal(sessionTranscriptAwayFromLatest({ scrollHeight: 1000, scrollTop: 600, clientHeight: 200 }), false);
  assert.equal(sessionTranscriptAwayFromLatest({ scrollHeight: 1001, scrollTop: 600, clientHeight: 200 }), true);
  assert.equal(sessionTranscriptAwayFromLatest({ scrollHeight: 400, scrollTop: 0, clientHeight: 600 }), false);
});

test('Session UI keeps explicit submissions visible across mobile viewport changes', async () => {
  const [source, styles] = await Promise.all([readFile(uiUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);

  assert.match(source, /submitFollowRef\.current = true;/);
  assert.match(source, /window\.visualViewport\?\.addEventListener\('resize', followAfterViewportChange\)/);
  assert.match(source, /onPointerDown=\{stopSubmitFollow\}/);
  assert.match(source, /onWheel=\{handleTranscriptWheel\}/);
  assert.match(source, /if \(scrollingUp\) \{\s*pauseLatestFollow\(\);/);
  assert.match(source, /if \(event\.deltaY < 0\) pauseLatestFollow\(\);/);
  assert.match(source, /onTouchMove=\{handleTranscriptTouchMove\}/);
  assert.match(styles, /\.cwu-session-shell \{[^}]*height: 100vh;[^}]*height: 100dvh;/);
  assert.match(styles, /\.cwu-session-main \{[^}]*height: calc\(100vh - 64px\);[^}]*height: calc\(100dvh - 64px\);/);
  assert.match(styles, /\.cwu-transcript \{[^}]*overscroll-behavior: contain;[^}]*-webkit-overflow-scrolling: touch;/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.cwu-composer-wrap \{[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.cwu-composer textarea,[^}]*\.cwu-message-editor textarea \{[^}]*font-size: 16px;/);
  assert.match(styles, /@media \(hover: none\)[\s\S]*?\.cwu-browser-row-menu > summary \{[^}]*opacity: \.68;/);
  assert.match(styles, /@media \(hover: none\)[\s\S]*?\.cwu-message-actions \{[^}]*opacity: 1;/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.cwu-browser \{[^}]*min-height: 0;/);
});

test('Session UI wraps long transcript content on narrow touch screens', async () => {
  const styles = await readFile(stylesUrl, 'utf8');

  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.cwu-message-body pre \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.cwu-message-body table \{[^}]*width: 100%;[^}]*table-layout: fixed;/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.cwu-message-body th,[^}]*\.cwu-message-body td \{[^}]*overflow-wrap: anywhere;/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.cwu-composer-footer \{[^}]*flex-wrap: wrap;/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.cwu-composer-meta \{[^}]*width: 100%;[^}]*overflow-x: auto;/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.cwu-execution-controls \{[^}]*max-width: none;/);
});

test('Session Composer responds to its own available width inside consumer sidebars', async () => {
  const styles = await readFile(stylesUrl, 'utf8');

  assert.match(styles, /\.cwu-composer-wrap \{[^}]*container: cwu-composer \/ inline-size;/);
  assert.match(styles, /@container cwu-composer \(max-width: 559px\)[\s\S]*?\.cwu-composer-footer \{[^}]*flex-wrap: wrap;/);
  assert.match(styles, /@container cwu-composer \(max-width: 559px\)[\s\S]*?\.cwu-composer-meta \{[^}]*width: 100%;[^}]*overflow-x: auto;/);
  assert.match(styles, /@container cwu-composer \(max-width: 559px\)[\s\S]*?\.cwu-composer-actions \{[^}]*width: 100%;[^}]*justify-content: flex-end;/);
});

test('Side Chat React UI owns shared interaction while products supply actions and storage', async () => {
  const [source, styles] = await Promise.all([readFile(uiUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);
  assert.match(source, /export function SideChatPanel/);
  assert.match(source, /actions\.onCreate/);
  assert.match(source, /actions\.onDelete/);
  assert.match(source, /actions\.onSubmit/);
  assert.match(source, /actions\.onUpdate/);
  assert.match(styles, /\.cwu-side-chat-stream/);
  assert.match(styles, /\.cwu-side-chat-composer/);

  const view = normalizeSideChatPanelViewModel({
    selectedId: 'side-1',
    sideChats: [{
      id: 'side-1', title: 'Side chat', status: 'expired', resumable: false,
      transcript: [{ id: 'answer', role: 'assistant', text: '保留的答案' }],
    }],
    models: [{ model: 'gpt-test', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }],
  });
  assert.equal(view.selected.resumable, false);
  assert.equal(view.selected.transcript[0].content, '保留的答案');
  assert.deepEqual(view.models[0].reasoningEfforts, ['medium']);
  assert.equal('projectId' in view.selected, false);
});

test('browser custom elements can be imported during server rendering', async () => {
  await assert.doesNotReject(import('../src/browser/subagent-elements.js'));
});

test('Session UI owns search, row archive, history pagination, and queued-turn presentation', async () => {
  const [source, styles] = await Promise.all([readFile(uiUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);
  assert.match(source, /cwu-browser-search/);
  assert.match(source, /const \[searchOpen, setSearchOpen\]/);
  assert.match(source, /actions\.onArchive/);
  assert.match(source, /export function SessionList/);
  assert.match(source, /actions\.onFavorite/);
  assert.match(source, /actions\.onEnd/);
  assert.match(source, /actions\.onFullTextSearch/);
  assert.match(source, /extensions\.renderListFilters/);
  assert.match(source, /actions\.onLoadMore/);
  assert.match(source, /IntersectionObserver/);
  assert.match(styles, /\.cwu-browser-load-more/);
  assert.match(styles, /\.cwu-session-list-standalone > \.cwu-browser-list \{ position: static;/);
  assert.match(source, /cwu-history-separator/);
  assert.match(source, /currentAnchor\.getBoundingClientRect\(\)\.top - expectedAnchorTop/);
  assert.match(source, /cwu-queued-turns/);
  assert.match(source, /className="cwu-composer-actions"[\s\S]*?className="cwu-button cwu-stop"[\s\S]*?composer\.showSecondary/);
  const headerActionsStart = source.indexOf('<div className="cwu-session-actions">');
  const headerActionsEnd = source.indexOf("</header>", headerActionsStart);
  assert.notEqual(headerActionsStart, -1);
  assert.notEqual(headerActionsEnd, -1);
  assert.equal(
    source.slice(headerActionsStart, headerActionsEnd).includes("actions.onInterrupt"),
    false,
  );
  assert.match(styles, /\.cwu-stop \{[^}]*color: var\(--cwu-error\);/);
  assert.match(source, /'Agent 产物'/);
  assert.match(source, /file\.format === 'markdown'.*label: '预览'/);
  assert.match(source, /file\.format === 'sql'.*label: '格式化'/);
  assert.match(source, /file\.format === 'csv'.*label: '表格'/);
  assert.match(source, /cwu-sql-\$\{token\.type\}/);
  assert.match(styles, /\.cwu-sql-keyword/);
  assert.match(source, /const submittedDraft = draft/);
  assert.match(source, /setDraft\(submittedDraft\)/);
  assert.match(source, /useState\(cachedUi\?\.draft \?\? view\.draft\)/);
  assert.match(source, /target\.setSelectionRange\(view\.draft\.length, view\.draft\.length\)/);
  assert.match(source, /actions\.onDraftChange\?\.\(event\.target\.value\)/);
  assert.match(source, /handleAttachmentDrop/);
  assert.match(source, /actions\.onResolveDroppedDirectories/);
  assert.match(source, /result\?\.resources/);
  assert.match(source, /attachment\.kind === 'directory'/);
  assert.match(source, /composerDropPayload\(event\.dataTransfer\)/);
  assert.match(source, /labels\.directoryDrop \|\| '松开以引用文件夹'/);
  assert.match(source, /actions\.onExecutionProfileChange/);
  assert.match(source, /actions\.onLoadTechnicalDetails/);
  assert.match(source, /actions\.onSearchSessionReferences/);
  assert.match(source, /actions\.onResolveSessionReferences/);
  assert.match(source, /setSessionReferenceDataTransfer\(event\.dataTransfer, session\.reference\)/);
  assert.match(source, /sessionReferenceFromDataTransfer\(event\.dataTransfer\)/);
  assert.match(source, /references: resolvedReferences/);
  assert.match(source, /className="cwu-reference-picker"/);
  assert.match(source, /className="cwu-message-references"/);
  assert.match(styles, /\.cwu-reference-picker/);
  assert.match(styles, /\.cwu-references/);
  assert.match(source, /serviceTier/);
  assert.match(source, /cwu-execution-fast/);
  assert.match(styles, /\.cwu-execution-controls/);
  assert.match(source, /<span>执行设置<\/span><span aria-hidden="true" className="cwu-execution-info">ⓘ<\/span>/);
  assert.match(source, /className="cwu-execution-popover"/);
  assert.match(source, /setExecutionSettingsSaving\(true\)/);
  assert.match(source, /executionSettingsSaveRef\.current !== save/);
  assert.match(source, /setExecutionSettingsSaving\(false\)/);
  assert.match(source, /document\.addEventListener\('pointerdown', closeOutside\)/);
  assert.match(source, /event\.key !== 'Escape'/);
  assert.match(styles, /\.cwu-execution-popover \{ position: fixed;/);
  assert.match(source, /松开以上传附件/);
  assert.match(styles, /\.cwu-browser-row-action/);
  assert.match(source, /<svg aria-hidden="true" fill="none" viewBox="0 0 24 24">/);
  assert.match(styles, /\.cwu-browser-row-action svg/);
  assert.match(styles, /\.cwu-remark-card/);
  assert.match(source, /cwu-browser-group-create/);
  assert.match(styles, /\.cwu-browser-group-heading:hover \.cwu-browser-group-create/);
  assert.match(styles, /@media \(hover: hover\) and \(pointer: fine\)/);
  assert.match(styles, /@media \(max-width: 640px\)/);
  assert.match(styles, /\.cwu-session-main \{ min-width: 0;/);
  assert.match(styles, /\.cwu-transcript \{ min-width: 0; max-width: 100%;/);
  assert.match(styles, /resize: none/);
  assert.doesNotMatch(styles, /\.cwu-composer-footer \{ align-items: flex-start; flex-direction: column; \}/);
  assert.match(styles, /max-height: 240px/);

  const browser = normalizeSessionBrowserViewModel({
    archived: true,
    groupMode: 'attention',
    groupOptions: [{ id: 'attention', label: '按状态' }],
    hasMore: true,
    loadingMore: true,
    sessions: [{
      id: 'a', archived: true, canArchive: false, canEnd: true,
      canFavorite: true, favorited: true, groupKind: 'running',
      searchableText: '当前任务', secondaryLabel: '个人 · workspace', sortOrder: 2, status: 'stopping',
    }],
  });
  assert.equal(browser.archived, true);
  assert.equal(browser.hasMore, true);
  assert.equal(browser.loadingMore, true);
  assert.equal(browser.paginationMode, 'complete');
  assert.equal(browser.sessions[0].archived, true);
  assert.equal(browser.sessions[0].canArchive, false);
  assert.equal(browser.groupMode, 'attention');
  assert.deepEqual(browser.groupOptions, [{ id: 'attention', label: '按状态' }]);
  assert.equal(browser.sessions[0].status, 'stopping');
  assert.equal(browser.sessions[0].groupKind, 'running');
  assert.equal(browser.sessions[0].favorited, true);
  assert.equal(browser.sessions[0].canEnd, true);
  assert.equal(browser.sessions[0].searchableText, '当前任务');
  assert.equal(browser.sessions[0].secondaryLabel, '个人 · workspace');
  assert.equal(browser.sessions[0].sortOrder, 2);

  const ordered = normalizeSessionBrowserViewModel({
    sessions: [
      { id: 'newer', updatedAt: 30, sortOrder: 2 },
      { id: 'older-priority', updatedAt: 10, sortOrder: 1 },
    ],
  });
  assert.deepEqual(ordered.sessions.map((item) => item.id), ['older-priority', 'newer']);

  const session = normalizeSessionViewModel({
    isDraft: true,
    draft: '可恢复的输入',
    composerDisabled: true,
    activeActivityKind: 'contextCompaction',
    activityLabel: '整理上下文',
    messages: [{
      id: 'm1', role: 'user', content: '问题', turnStatus: 'completed', canEdit: true, canFork: true,
      references: [{ kind: 'session', version: 1, hostId: 'personal-local', threadId: 'target', label: '目标 Session' }],
    }],
    technicalDetailsAvailable: ['turn-1', 'turn-1'],
    technicalDetailsLoading: true,
    hasEarlierTurns: true,
    loadedTurnCount: 20,
    queuedTurns: [{ id: 'q1', prompt: '继续', attachments: [{ name: 'a.png' }] }],
    models: [{
      model: 'gpt-test', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
      serviceTiers: [{ id: 'priority', name: 'Fast', description: 'faster' }],
    }],
    executionProfile: { model: 'gpt-test', reasoningEffort: 'high', accessMode: 'full', serviceTier: 'priority' },
  });
  assert.equal(session.hasEarlierTurns, true);
  assert.equal(session.isDraft, true);
  assert.equal(session.draft, '可恢复的输入');
  assert.equal(session.composerDisabled, true);
  assert.equal(session.activityKind, 'contextCompaction');
  assert.equal(session.activityLabel, '整理上下文');
  assert.equal(session.messages[0].canEdit, true);
  assert.equal(session.messages[0].references[0].threadId, 'target');
  assert.equal(session.messages[0].turnStatus, 'completed');
  assert.deepEqual(session.technicalDetailsAvailable, ['turn-1']);
  assert.equal(session.technicalDetailsLoading, true);
  assert.equal(session.messages[0].canFork, true);
  assert.equal(session.loadedTurnCount, 20);
  assert.equal(session.queuedTurns[0].attachments[0].name, 'a.png');
  assert.equal(session.executionProfile.model, 'gpt-test');
  assert.equal(session.executionProfile.reasoningEffort, 'high');
  assert.equal(session.executionProfile.accessMode, 'full');
  assert.equal(session.executionProfile.serviceTier, 'priority');
  assert.equal(session.models[0].serviceTiers[0].label, 'Fast');
  assert.equal(session.accessModes[0].label, '完全访问');
});

test('Composer drop payload separates directories from files and preserves host path hints', () => {
  const folderFile = { name: '资料' };
  const regularFile = { name: 'report.pdf', type: 'application/pdf', size: 42 };
  const payload = composerDropPayload({
    items: [{
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: true, name: '资料' }),
      getAsFile: () => folderFile,
    }, {
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: false, name: 'report.pdf' }),
      getAsFile: () => regularFile,
    }],
    getData: (type) => type === 'text/uri-list' ? 'file:///Users/mac/My%20Project/%E8%B5%84%E6%96%99' : '',
  });
  assert.deepEqual(payload, {
    directories: [{ name: '资料', pathHint: '/Users/mac/My Project/资料', file: folderFile }],
    files: [regularFile],
  });
  assert.equal(appendComposerReferences('请检查', ['/Users/mac/My Project/资料']), '请检查\n/Users/mac/My Project/资料');
  assert.equal(appendComposerReferences('1234', [{ text: '/long' }], { textLimit: 7 }), '1234\n/l');
});

test('Composer drop payload falls back to direct files when browser items are opaque', () => {
  const file = { name: 'browser-canary.txt', type: 'text/plain', size: 7, lastModified: 1 };
  assert.deepEqual(composerDropPayload({
    items: [{ kind: 'file', getAsFile: () => null }],
    files: [file],
    getData: () => '',
  }), { directories: [], files: [file] });
});

test('completed consecutive commentary keeps the latest process visible without forcing older groups open', async () => {
  const [source, styles] = await Promise.all([
    readFile(uiUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
  ]);
  const messages = [
    { id: 'c1', turnId: 'turn-1', phase: 'commentary', turnStatus: 'completed' },
    { id: 'c2', turnId: 'turn-1', phase: 'commentary', turnStatus: 'completed' },
    { id: 'u1', turnId: 'turn-1', phase: 'answer', turnStatus: 'completed' },
    { id: 'c3', turnId: 'turn-1', phase: 'commentary', turnStatus: 'completed' },
    { id: 'c4', turnId: 'turn-2', phase: 'commentary', turnStatus: 'inProgress' },
  ];
  const groups = groupSessionMessages(messages);
  assert.deepEqual(groups.map((entry) => entry.kind), ['commentary-group', 'message', 'commentary-group', 'message']);
  assert.deepEqual(groups[0].messages.map((message) => message.id), ['c1', 'c2']);
  assert.deepEqual(groups[2].messages.map((message) => message.id), ['c3']);
  assert.equal(new Set(groups.map((entry) => entry.id)).size, groups.length);
  assert.match(source, /function CommentaryGroup/);
  assert.match(source, /initiallyOpen=\{entry\.id === latestCommentaryGroupId\}/);
  assert.match(source, /onToggle=\{\(event\) => setOpen\(event\.currentTarget\.open\)\}/);
  assert.match(source, /open=\{open\}/);
  assert.match(source, /cwu-commentary-group/);
  assert.match(source, /过程 · \{messageCount\} 条/);
  assert.match(styles, /\.cwu-commentary-group/);
  assert.match(styles, /\.cwu-message \.cwu-message-body img \{[^}]*max-width: min\(100%, 640px\);[^}]*max-height: min\(420px, 50vh\);/);
  assert.match(styles, /\.cwu-message \.cwu-message-body a:has\(> img\) \{[^}]*cursor: zoom-in;/);
  assert.doesNotMatch(source, /cwu-commentary-collapse/);
});

test('shared Session UI keeps the reviewed drawer, execution record, and one-row Composer contracts', async () => {
  const [source, styles] = await Promise.all([readFile(uiUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);
  assert.match(source, /const drawerMode = isNarrow \|\| browser\.listMode === 'drawer'/);
  assert.match(source, /className="cwu-browser-scrim"/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /touch\.clientX - start\.x < -70/);
  assert.match(source, /onOpenSessionFinder/);
  assert.match(source, /className="cwu-browser-row-action cwu-browser-row-archive"/);
  assert.match(source, /className="cwu-browser-row-action cwu-browser-row-favorite"/);
  assert.match(source, /ResizeObserver\(measure\)/);
  assert.match(source, /composerWidthProbeRef/);
  assert.match(source, /className="cwu-composer-options-sheet"/);
  assert.match(source, /function ScrollRegion/);
  assert.match(source, /remaining > 4/);
  assert.match(source, /function TechnicalProcessItem/);
  assert.match(source, /item\.output/);
  assert.match(source, /processOpenByTurn/);
  assert.match(source, /onFinalResultVisible/);
  assert.match(source, /document\.visibilityState !== 'visible'/);
  assert.match(source, /threshold: 0\.1/);
  assert.match(styles, /\.cwu-browser-scrim/);
  assert.match(styles, /\.cwu-browser\.is-drawer-mode/);
  assert.match(styles, /\.cwu-scroll-region\[data-overflow='true'\]/);
  assert.match(styles, /--cwu-scroll-max-height: min\(640px, 65dvh\)/);
  assert.match(styles, /--cwu-scroll-max-height: min\(400px, 48dvh\)/);
  assert.match(styles, /--cwu-scroll-max-height: min\(320px, 40dvh\)/);
  assert.match(styles, /\.is-compact-composer \.cwu-composer-footer \{ flex-wrap: nowrap/);
  assert.match(styles, /\.is-compact-composer \.cwu-attach-button \{ width: 56px/);
});
