import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import katex from 'katex';
import { appendComposerReferences, clipboardAttachmentFiles, composerDropPayload, documentPreviewPresentation, extractInlineVisualizations, extractRemarkDirectives, extractVisualizationReferences, groupSessionMessages, isDocumentResourceHref, isLocalFileHref, localFileBrowserHref, markdownHeadingId, normalizeCapabilityManagerViewModel, normalizeMarkdownMath, normalizeSessionBrowserViewModel, normalizeSessionViewModel, normalizeSideChatPanelViewModel, renderFileCitationsAsMarkdown, resolveDocumentResourceHref, richClipboardText, sessionTranscriptAwayFromLatest, shouldConvertPastedTextToAttachment } from '../src/ui/model.js';

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
  assert.match(source, /file\.format === 'spreadsheet'/);
  assert.match(source, /function SpreadsheetPreview/);
  assert.match(styles, /\.cwu-document-preview/);
  assert.match(styles, /\.cwu-document-tabs/);
  assert.match(styles, /\.cwu-document-html/);
  assert.match(styles, /\.cwu-document-editor/);
  assert.match(styles, /\.cwu-spreadsheet-scroll table/);
  assert.match(styles, /\.cwu-spreadsheet-scroll \{ min-width: 0/);
  assert.match(styles, /\.cwu-local-file-link:hover \.cwu-local-file-reveal/);
  assert.match(styles, /\.cwu-local-file-link \{ position: relative; display: inline-block/);
  assert.match(styles, /\.cwu-local-file-reveal \{ position: absolute;/);
  assert.match(styles, /@media \(hover: none\)/);
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
  assert.match(source, /onUploadAttachments\(\[placeholder\.file\], \{/);
  assert.match(source, /onProgress: \(progress\) =>/);
  assert.match(source, /retryAttachment\(attachment\)/);
  assert.match(source, /className="cwu-technical-artifacts"/);
  assert.match(source, /onOpenArtifact/);
  assert.match(source, /onRevealArtifact/);
  assert.match(styles, /\.cwu-attachment-progress/);
  assert.match(styles, /\.cwu-technical-artifacts/);
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
  assert.match(source, /richClipboardText\(richHtml, plainText\)/);
  assert.match(source, /shouldConvertPastedTextToAttachment\(draft, text/);
  assert.match(source, /richHtml\.trim\(\) \? 'md' : 'txt'/);
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
  assert.match(styles, /\.cwu-scroll-latest \{[^}]*align-self: center/);
  assert.match(styles, /\.cwu-scroll-latest \{[^}]*margin: 0 auto 8px/);
  assert.match(source, /supportedEfforts\.includes\(view\.executionProfile\.reasoningEffort\)/);
  const hooks = await readFile(hooksUrl, 'utf8');
  assert.match(source, /useSessionUserInput/);
  assert.match(hooks, /export function useSessionUserInput/);
  assert.doesNotMatch(source, /ArtifactCanvas|project-navigation/);
});

test('Minimal Host keeps owned portable Session Edit and Fork actions available', async () => {
  const source = await readFile(new URL('../src/environment/host-client.jsx', import.meta.url), 'utf8');
  assert.match(source, /const sessionBranchable = !sharedReadOnly;/);
  assert.match(source, /onEditMessage: messageEditEnabled && sessionBranchable/);
  assert.match(source, /onForkMessage: messageForkEnabled && sessionBranchable/);
  assert.match(source, /const branchable = session\.access\?\.kind !== 'shared';/);
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
  assert.match(source, /onWheel=\{stopSubmitFollow\}/);
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
  assert.match(source, /previousTop \+ \(current\.scrollHeight - previousHeight\)/);
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
  assert.match(source, /file\.resource \? 'Session 产物 · 只读'/);
  assert.match(source, /const submittedDraft = draft/);
  assert.match(source, /setDraft\(submittedDraft\)/);
  assert.match(source, /useState\(view\.draft\)/);
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
