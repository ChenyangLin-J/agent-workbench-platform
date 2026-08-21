import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import katex from 'katex';
import { clipboardAttachmentFiles, extractInlineVisualizations, extractRemarkDirectives, extractVisualizationReferences, groupSessionMessages, normalizeMarkdownMath, normalizeSessionBrowserViewModel, normalizeSessionViewModel, normalizeSideChatPanelViewModel, renderFileCitationsAsMarkdown, sessionTranscriptAwayFromLatest, shouldConvertPastedTextToAttachment } from '../src/ui/model.js';

const uiUrl = new URL('../src/ui/index.jsx', import.meta.url);
const stylesUrl = new URL('../src/ui/styles.css', import.meta.url);
const hooksUrl = new URL('../src/ui-hooks.js', import.meta.url);
const katexStylesUrl = new URL('../node_modules/katex/dist/katex.css', import.meta.url);

test('Session UI delegates message links and read-only document previews to its host', async () => {
  const [source, styles] = await Promise.all([
    readFile(uiUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
  ]);

  assert.match(source, /documentPreview = null/);
  assert.match(source, /onOpenLink\(href\)/);
  assert.match(source, /components=\{markdownLinkComponents\(onOpenLink\)\}/);
  assert.match(source, /onOpenExternal\(file\)/);
  assert.match(source, /file\.format === 'spreadsheet'/);
  assert.match(source, /function SpreadsheetPreview/);
  assert.match(styles, /\.cwu-document-preview/);
  assert.match(styles, /\.cwu-spreadsheet-scroll table/);
  assert.match(styles, /\.cwu-spreadsheet-scroll \{ min-width: 0/);
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
  assert.match(source, /remarkMath/);
  assert.match(source, /rehypeKatex/);
  assert.match(source, /singleDollarTextMath: false/);
  assert.match(source, /<MediaGallery items=\{message\.media\}/);
  assert.match(styles, /\.cwu-inline-visualization iframe/);
  assert.match(styles, /katex\/dist\/katex\.min\.css/);
  assert.match(styles, /\.katex-display/);
  assert.match(styles, /\.cwu-message-media img/);
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
  assert.match(source, /shouldConvertPastedTextToAttachment\(draft, text/);
  assert.match(source, /`粘贴文本-\$\{compactLocalTimestamp\(new Date\(\)\)\}\.txt`/);
  assert.match(source, /className=\{`cwu-scroll-latest/);
  assert.match(source, /target\.scrollTo\(\{ top: target\.scrollHeight, behavior: 'smooth' \}\)/);
  assert.match(source, /labels\.newMessages \|\| '有新消息'/);
  assert.match(styles, /\.cwu-scroll-latest/);
  assert.match(source, /supportedEfforts\.includes\(view\.executionProfile\.reasoningEffort\)/);
  const hooks = await readFile(hooksUrl, 'utf8');
  assert.match(source, /useSessionUserInput/);
  assert.match(hooks, /export function useSessionUserInput/);
  assert.doesNotMatch(source, /ArtifactCanvas|project-navigation/);
});

test('long pasted text becomes an attachment before the Composer hard limit', () => {
  assert.equal(shouldConvertPastedTextToAttachment('', 'a'.repeat(999)), false);
  assert.equal(shouldConvertPastedTextToAttachment('', 'a'.repeat(1000)), true);
  assert.equal(shouldConvertPastedTextToAttachment('a'.repeat(11500), 'b'.repeat(501)), true);
  assert.equal(shouldConvertPastedTextToAttachment('', ''), false);
});

test('Session transcript only offers the latest-message shortcut away from the bottom', () => {
  assert.equal(sessionTranscriptAwayFromLatest({ scrollHeight: 1000, scrollTop: 600, clientHeight: 200 }), false);
  assert.equal(sessionTranscriptAwayFromLatest({ scrollHeight: 1001, scrollTop: 600, clientHeight: 200 }), true);
  assert.equal(sessionTranscriptAwayFromLatest({ scrollHeight: 400, scrollTop: 0, clientHeight: 600 }), false);
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
  assert.match(source, /cwu-history-separator/);
  assert.match(source, /previousTop \+ \(current\.scrollHeight - previousHeight\)/);
  assert.match(source, /cwu-queued-turns/);
  assert.match(source, /const submittedDraft = draft/);
  assert.match(source, /setDraft\(submittedDraft\)/);
  assert.match(source, /useState\(view\.draft\)/);
  assert.match(source, /actions\.onDraftChange\?\.\(event\.target\.value\)/);
  assert.match(source, /handleAttachmentDrop/);
  assert.match(source, /actions\.onExecutionProfileChange/);
  assert.match(source, /actions\.onLoadTechnicalDetails/);
  assert.match(source, /serviceTier/);
  assert.match(source, /cwu-execution-fast/);
  assert.match(styles, /\.cwu-execution-controls/);
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
    messages: [{ id: 'm1', role: 'user', content: '问题', turnStatus: 'completed', canEdit: true, canFork: true }],
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
  assert.equal(session.messages[0].canEdit, true);
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

test('completed consecutive commentary is grouped behind one compact disclosure per turn', async () => {
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
  assert.match(source, /cwu-commentary-group/);
  assert.match(source, /过程 · \{messages\.length\} 条/);
  assert.match(styles, /\.cwu-commentary-group/);
  assert.doesNotMatch(source, /cwu-commentary-collapse/);
});
