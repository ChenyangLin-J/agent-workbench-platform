import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const clientUrl = new URL('../src/environment/host-client.jsx', import.meta.url);
const stylesUrl = new URL('../src/environment/assets/host.css', import.meta.url);
const uiUrl = new URL('../src/ui/index.jsx', import.meta.url);
const modelUrl = new URL('../src/ui/model.js', import.meta.url);
const uiStylesUrl = new URL('../src/ui/styles.css', import.meta.url);

test('Minimal Host sharing preserves time groups and keeps shared interactions compact', async () => {
  const [client, styles, ui, model, uiStyles] = await Promise.all([
    readFile(clientUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
    readFile(uiUrl, 'utf8'),
    readFile(modelUrl, 'utf8'),
    readFile(uiStylesUrl, 'utf8'),
  ]);

  assert.match(client, /groupMode: 'time'/);
  assert.match(client, /groupOptions: \[\{ id: 'time', label: '最近' \}\]/);
  assert.doesNotMatch(client, /groupMode: sessionSharing/);
  assert.doesNotMatch(client, /user\.email/);
  assert.doesNotMatch(client, /<small>可查看<\/small>/);
  assert.match(client, /className="awb-share-person-button"/);
  assert.match(client, /`共享给 \$\{user\.name\}`/);
  assert.match(client, /<svg aria-hidden="true" fill="none" viewBox="0 0 24 24">/);
  assert.match(ui, /className="cwu-browser-row-shared"/);
  assert.match(ui, /aria-label="与我共享，只读"/);
  assert.match(ui, /const shared = session\.accessKind === 'shared'/);
  assert.match(ui, /extensions\.renderComposerReplacement \? null : <agent-session-composer/);
  assert.match(model, /accessKind: session\?\.access\?\.kind === 'shared'/);
  assert.match(client, /此对话只读 · 点击右上角“继续聊”后可输入/);
  assert.match(styles, /\.awb-share-results strong, \.awb-share-users strong \{[^}]*font-size: 12px;/);
  assert.match(styles, /\.awb-share-results \.awb-share-person-button \{[^}]*width: 30px;[^}]*height: 30px;/);
  assert.match(uiStyles, /\.cwu-browser-row-shared \{[^}]*width: 11px;[^}]*color: var\(--cwu-unread\);/);
});
