import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import React from 'react';

// Evaluate the real JSX and event handlers with a small hook harness. No DOM, browser,
// Runtime, upload, or model is started; Host calls are bounded synthetic callbacks.
const require = createRequire(import.meta.url);
const bundle = await build({ entryPoints: [new URL('../src/ui/index.jsx', import.meta.url).pathname], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'], logLevel: 'silent' });
function mount(props, globals = {}) {
  let cursor = 0;
  const slots = [];
  const effects = [];
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useMemo: callback => callback(),
    useCallback: callback => callback,
    useId: () => 'test-send-mode',
    useEffect: (callback, dependencies) => { effects.push({ callback, dependencies }); },
  };
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require: name => name === 'react' ? hooks : require(name),
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, TextEncoder, TextDecoder,
    requestAnimationFrame: () => {}, ...globals,
  }, { filename: 'composer-ui.cjs' });
  return {
    render() { cursor = 0; effects.length = 0; return module.exports.SessionWorkspace(props); },
    effects,
  };
}
function all(node) {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!node || typeof node !== 'object' || !node.props) return [];
  return [node, ...all(node.props.children)];
}
const find = (tree, predicate) => all(tree).find(predicate);
const byClass = (tree, name) => find(tree, node => node.props.className?.split(' ').includes(name));
const byLabel = (tree, name) => find(tree, node => node.props['aria-label'] === name);
const flush = () => new Promise(resolve => setImmediate(resolve));
const base = { compactComposer: true, session: { sessionId: 'synthetic', status: 'running', executionProfile: { model: 'saved-model', reasoningEffort: 'high', accessMode: 'full' } }, actions: { onSubmit: async () => {}, onInterrupt: () => {} } };

test('split-send is opt in; default desktop probe and phone options retain their mode selectors', () => {
  for (const presentation of [undefined, 'split-send']) {
    const app = mount({ ...base, composerPresentation: presentation });
    let tree = app.render();
    assert.equal(Boolean(byClass(tree, 'cwu-send-action-group')), presentation === 'split-send');
    assert.equal(Boolean(byLabel(tree, '发送方式')), presentation !== 'split-send');
    byClass(tree, 'cwu-composer-options-button').props.onClick();
    tree = app.render();
    assert.equal(Boolean(byClass(tree, 'cwu-mobile-submit-mode')), presentation !== 'split-send');
    assert.ok(byClass(tree, 'cwu-composer-options-sheet'));
  }
});

test('empty drafts can change send mode; visible label, Enter and form submission use the same selected mode', async () => {
  const sent = [];
  const app = mount({ ...base, composerPresentation: 'split-send', actions: { ...base.actions, onSubmit: async payload => sent.push(payload) } });
  let tree = app.render();
  assert.equal(byClass(tree, 'cwu-send').props.disabled, true);
  assert.equal(byClass(tree, 'cwu-send-mode-trigger').props.disabled, undefined);
  byClass(tree, 'cwu-send-mode-trigger').props.onClick();
  tree = app.render();
  const modes = all(tree).filter(node => node.props.role === 'menuitemradio');
  assert.deepEqual(modes.map(node => node.props['aria-checked']), [true, false]);
  modes[1].props.onClick();
  tree = app.render();
  assert.equal(byClass(tree, 'cwu-send-mode-menu'), undefined);
  assert.equal(byClass(tree, 'cwu-send').props.children, '下一轮');
  let textarea = find(tree, node => node.type === 'textarea');
  textarea.props.onChange({ target: { value: 'after this task', selectionStart: 15 } });
  tree = app.render();
  textarea = find(tree, node => node.type === 'textarea');
  textarea.props.onKeyDown({ key: 'Enter', shiftKey: true, nativeEvent: {}, preventDefault() { assert.fail('Shift+Enter must keep its newline'); } });
  textarea.props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: {}, preventDefault() {} });
  await flush();
  assert.equal(sent[0].mode, 'queue');
  tree = app.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'next draft', selectionStart: 10 } });
  tree = app.render();
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await flush();
  assert.deepEqual(sent.map(payload => payload.mode), ['queue', 'queue']);
});

test('idle and unavailable running modes retain the existing capability and interrupt contracts', () => {
  for (const [status, features, expected] of [
    ['idle', {}, '发送'],
    ['running', { steer: false }, '下一轮'],
    ['running', { queuedTurns: false }, '追加当前'],
    ['running', { steer: false, queuedTurns: false }, '等待当前任务结束'],
  ]) {
    const app = mount({ ...base, composerPresentation: 'split-send', session: { ...base.session, status }, features });
    const tree = app.render();
    assert.equal(byClass(tree, 'cwu-send-action-group'), undefined);
    assert.equal(byClass(tree, 'cwu-send').props.children, expected);
    assert.equal(Boolean(byClass(tree, 'cwu-stop')), status === 'running');
    if (status === 'running') assert.equal(byClass(tree, 'cwu-stop').props.onClick, base.actions.onInterrupt);
  }
});

test('model metadata loads only on opt-in interaction, deduplicates concurrent calls, and retries locally', async () => {
  let reads = 0, resolve;
  const app = mount({ ...base, composerPresentation: 'split-send', actions: { ...base.actions, onLoadExecutionOptions: () => { reads++; return new Promise(done => { resolve = done; }); } } });
  let tree = app.render();
  assert.equal(reads, 0);
  byClass(tree, 'cwu-composer-options-button').props.onClick();
  tree = app.render();
  const model = byLabel(tree, '模型');
  assert.equal(model.props.value, 'saved-model');
  assert.ok(all(model).some(node => node.type === 'option' && node.props.value === 'saved-model'));
  model.props.onFocus(); model.props.onPointerDown();
  await flush();
  assert.equal(reads, 1);
  resolve(); await flush();
  model.props.onFocus(); await flush();
  assert.equal(reads, 1);
  let errors = 0;
  const failed = mount({ ...base, composerPresentation: 'split-send', actions: { ...base.actions, onError: () => { errors++; }, onLoadExecutionOptions: async () => { throw new Error('directory unavailable'); } } });
  byClass(failed.render(), 'cwu-composer-options-button').props.onClick();
  await flush();
  tree = failed.render();
  const status = byClass(tree, 'cwu-execution-options-status');
  assert.equal(status.props.role, 'alert');
  assert.ok(find(status, node => node.type === 'button' && node.props.children === '重试'));
  assert.equal(errors, 0);
  const legacy = mount({ ...base, actions: { ...base.actions, onLoadExecutionOptions: () => { assert.fail('legacy consumers must not load optional metadata'); } } });
  byClass(legacy.render(), 'cwu-composer-options-button').props.onClick();
  await flush();
});

test('send-mode menu supports arrow navigation, Escape, outside dismissal and selection focus return', () => {
  const listeners = new Map();
  const document = { activeElement: null, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  const app = mount({ ...base, composerPresentation: 'split-send' }, { document });
  let tree = app.render(), returns = 0;
  byClass(tree, 'cwu-send-mode-trigger').props.ref.current = { focus: () => { returns++; } };
  byClass(tree, 'cwu-send-mode-trigger').props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  tree = app.render();
  const menu = byClass(tree, 'cwu-send-mode-menu');
  const items = [0, 1].map(index => ({ index, focus() { document.activeElement = this; } }));
  menu.props.ref.current = { querySelector: () => items[0], querySelectorAll: () => items };
  byClass(tree, 'cwu-send-action-group').props.ref.current = { contains: target => items.includes(target) };
  const effect = app.effects.find(item => String(item.callback).includes('sendModeGroupRef'));
  const cleanup = effect.callback();
  assert.equal(document.activeElement.index, 0);
  menu.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(document.activeElement.index, 1);
  menu.props.onKeyDown({ key: 'Home', preventDefault() {} });
  assert.equal(document.activeElement.index, 0);
  listeners.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.equal(byClass(app.render(), 'cwu-send-mode-menu'), undefined);
  assert.equal(returns, 1);
  cleanup();
  tree = app.render();
  byClass(tree, 'cwu-send-mode-trigger').props.onClick();
  tree = app.render();
  const reopened = app.effects.find(item => String(item.callback).includes('sendModeGroupRef'));
  const cleanupOutside = reopened.callback();
  listeners.get('pointerdown')({ target: {} });
  assert.equal(byClass(app.render(), 'cwu-send-mode-menu'), undefined);
  assert.equal(returns, 1, 'outside click must preserve the outside focus destination');
  cleanupOutside();
});

test('adaptive probes measure the split group, ignore hidden phone context, and use the brain only when needed', () => {
  for (const [viewport, contentWidth, expectInline, expectBrain] of [
    [320, 278, false, true], [390, 326, false, true], [768, 680, false, false], [1280, 798, true, false],
  ]) {
    const rectangle = width => ({ getBoundingClientRect: () => ({ width }) });
    const app = mount({ ...base, composerPresentation: 'split-send', actions: { ...base.actions, onUploadAttachments: async () => [] } }, {
      getComputedStyle: () => ({ columnGap: '4' }),
      ResizeObserver: class { observe() {} disconnect() {} },
    });
    const tree = app.render();
    const footer = byClass(tree, 'cwu-composer-footer');
    footer.props.ref.current = { clientWidth: contentWidth, firstElementChild: {} };
    byClass(tree, 'cwu-attach-button').props.ref.current = rectangle(44);
    byClass(tree, 'cwu-composer-actions').props.ref.current = { children: [rectangle(44), rectangle(viewport <= 640 ? 0 : 100), rectangle(44), rectangle(108)] };
    const probes = all(tree).filter(node => node.props.className === 'cwu-composer-width-probe');
    probes[0].props.ref.current = rectangle(400);
    probes[1].props.ref.current = rectangle(100);
    // The width-measuring effect owns both natural-width probes.
    const measurement = app.effects.find(effect => effect.dependencies?.length === 9);
    assert.ok(measurement);
    measurement.callback()();
    const next = app.render();
    assert.equal(next.props.className.includes('has-inline-controls'), expectInline, `${viewport}px inline`);
    assert.equal(Boolean(byClass(next, 'is-icon-only')), expectBrain, `${viewport}px model entry`);
    if (expectBrain) assert.equal(byClass(next, 'is-icon-only').props['aria-label'], '输入选项 · saved-model');
  }
});

test('menu dismissal, focus, upward anchoring and 44px controls are explicit presentation contracts', async () => {
  const [source, styles, utilities] = await Promise.all([
    readFile(new URL('../src/ui/index.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/composer-utilities.jsx', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /document\.addEventListener\('pointerdown', closeOutside\)/);
  assert.match(source, /sendModeButtonRef\.current\?\.focus\(\)/);
  assert.match(source, /event\.key === 'Tab'.*setSendModeOpen\(false\)/);
  assert.match(source, /event\.key === 'Home'.*event\.key === 'End'/);
  assert.match(source, /aria-label=\{splitSendComposer \? `输入选项 · \$\{executionModelLabel\}`/);
  assert.match(styles, /\.cwu-send-mode-trigger \{[^}]*width: 44px;[^}]*height: 44px/);
  assert.match(styles, /\.cwu-send-mode-trigger svg \{ width: 22px; height: 22px/);
  assert.match(styles, /\.cwu-send-mode-menu \{[^}]*bottom: calc\(100% \+ 8px\);[^}]*width: min\(280px, calc\(100vw - 32px\)\)/);
  assert.match(styles, /\.has-split-send-composer \.cwu-composer-footer \{ flex-wrap: wrap/);
  assert.match(utilities, /<rect x="9" y="3" width="6" height="12" rx="3"\/>/);
});
