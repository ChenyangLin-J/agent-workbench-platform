import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('default Markdown remains synchronous for SSR, preserving tables, user line breaks and math', async () => {
  const bundle = await build({ entryPoints: [new URL('../src/ui/markdown.jsx', import.meta.url).pathname], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'], logLevel: 'silent' });
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), console, TextEncoder, TextDecoder, URL });
  const render = (text, mode) => renderToStaticMarkup(React.createElement(module.exports.SessionMarkdown, { mode }, text));
  assert.match(render('**重点**\n\n| 项目 | 值 |\n| --- | --- |\n| A | 1 |'), /<strong>重点<\/strong>[\s\S]*<table>/);
  assert.match(render('第一行\n第二行', 'user'), /第一行<br\/>/);
  assert.match(render('$$x^2$$'), /class="katex"/);
  assert.doesNotMatch(render('$100'), /class="katex"/);
});
