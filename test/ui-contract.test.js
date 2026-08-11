import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { extractInlineVisualizations, normalizeSessionBrowserViewModel, normalizeSessionViewModel } from '../src/ui/model.js';

const uiUrl = new URL('../src/ui/index.jsx', import.meta.url);
const stylesUrl = new URL('../src/ui/styles.css', import.meta.url);
const hooksUrl = new URL('../src/ui-hooks.js', import.meta.url);

test('Session UI delegates message links and read-only document previews to its host', async () => {
  const [source, styles] = await Promise.all([
    readFile(uiUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
  ]);

  assert.match(source, /documentPreview = null/);
  assert.match(source, /onOpenLink\(href\)/);
  assert.match(source, /components=\{markdownLinkComponents\(onOpenLink\)\}/);
  assert.match(source, /onOpenExternal\(file\)/);
  assert.match(styles, /\.cwu-document-preview/);
});

test('Session UI extracts safe inline visualizations and keeps message media', () => {
  const parsed = extractInlineVisualizations('上文\n\n::codex-inline-vis{file="session-layout-options.html"}\n\n下文');
  assert.deepEqual(parsed, { markdown: '上文\n\n下文', files: ['session-layout-options.html'] });
  assert.deepEqual(extractInlineVisualizations('::codex-inline-vis{file="../secret.html"}').files, []);

  const view = normalizeSessionViewModel({ messages: [{ media: [{ kind: 'image', src: '/media/1', alt: '截图' }] }] });
  assert.equal(view.messages[0].media[0].src, '/media/1');
});

test('Session UI embeds visualizations in a sandbox and renders image media', async () => {
  const [source, styles] = await Promise.all([readFile(uiUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);
  assert.match(source, /sandbox="allow-scripts"/);
  assert.match(source, /visualizationUrl/);
  assert.match(source, /<MediaGallery items=\{message\.media\}/);
  assert.match(styles, /\.cwu-inline-visualization iframe/);
  assert.match(styles, /\.cwu-message-media img/);
});

test('Session UI exposes product extension content without owning product navigation or canvas', async () => {
  const source = await readFile(uiUrl, 'utf8');
  assert.match(source, /extensions\.renderAfterMessage/);
  assert.match(source, /extensions\.renderAfterMessages/);
  assert.match(source, /extensions\.renderBeforeMessages/);
  assert.match(source, /extensions\.renderComposerOverlay/);
  assert.match(source, /extensions\.renderHeaderActions/);
  assert.match(source, /extensions\.renderMessageContent/);
  assert.match(source, /data-message-id=\{message\.id\}/);
  assert.match(source, /normalizeSessionFeatures\(features\)/);
  assert.match(source, /normalizeAttachmentPolicy\(attachmentPolicy\)/);
  const hooks = await readFile(hooksUrl, 'utf8');
  assert.match(source, /useSessionUserInput/);
  assert.match(hooks, /export function useSessionUserInput/);
  assert.doesNotMatch(source, /ArtifactCanvas|project-navigation/);
});

test('browser custom elements can be imported during server rendering', async () => {
  await assert.doesNotReject(import('../src/browser/subagent-elements.js'));
});

test('Session UI owns search, row archive, history pagination, and queued-turn presentation', async () => {
  const [source, styles] = await Promise.all([readFile(uiUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);
  assert.match(source, /cwu-browser-search/);
  assert.match(source, /const \[searchOpen, setSearchOpen\]/);
  assert.match(source, /actions\.onArchive/);
  assert.match(source, /cwu-history-separator/);
  assert.match(source, /previousTop \+ \(current\.scrollHeight - previousHeight\)/);
  assert.match(source, /cwu-queued-turns/);
  assert.match(styles, /\.cwu-browser-row-action/);
  assert.match(source, /<svg aria-hidden="true" fill="none" viewBox="0 0 24 24">/);
  assert.match(styles, /\.cwu-browser-row-action svg/);
  assert.match(source, /cwu-browser-group-create/);
  assert.match(styles, /\.cwu-browser-group-heading:hover \.cwu-browser-group-create/);
  assert.match(styles, /@media \(hover: hover\) and \(pointer: fine\)/);
  assert.match(styles, /@media \(max-width: 640px\)/);
  assert.match(styles, /resize: none/);
  assert.doesNotMatch(styles, /\.cwu-composer-footer \{ align-items: flex-start; flex-direction: column; \}/);
  assert.match(styles, /max-height: 240px/);

  const browser = normalizeSessionBrowserViewModel({
    archived: true,
    sessions: [{ id: 'a', archived: true, canArchive: false }],
  });
  assert.equal(browser.archived, true);
  assert.equal(browser.sessions[0].archived, true);
  assert.equal(browser.sessions[0].canArchive, false);

  const session = normalizeSessionViewModel({
    isDraft: true,
    hasEarlierTurns: true,
    loadedTurnCount: 20,
    queuedTurns: [{ id: 'q1', prompt: '继续', attachments: [{ name: 'a.png' }] }],
  });
  assert.equal(session.hasEarlierTurns, true);
  assert.equal(session.isDraft, true);
  assert.equal(session.loadedTurnCount, 20);
  assert.equal(session.queuedTurns[0].attachments[0].name, 'a.png');
});
