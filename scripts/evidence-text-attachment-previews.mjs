import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSessionKernel } from '../src/runtime/core/index.js';
import {
  EnvironmentSessionStore,
  buildMinimalHostAssets,
  createMinimalHost,
} from '../src/environment/index.js';
import { FakeRuntimeProvider } from '../test/core-testkit.js';

export const metadata = {
  name: 'text-attachment-previews',
  profiles: ['desktop', 'mobile'],
};

export default async function flow({ page, evidence, profile }) {
  const root = await mkdtemp(join(tmpdir(), 'awb-text-preview-evidence-'));
  const token = 'text-preview-evidence-token';
  const store = new EnvironmentSessionStore({ stateRoot: join(root, 'state') });
  const provider = new FakeRuntimeProvider();
  const kernel = new AgentSessionKernel({ provider, bindingStore: store, validateRequest: () => {} });
  const assetsRoot = join(root, 'assets');
  await buildMinimalHostAssets({ outputDirectory: assetsRoot });
  const host = createMinimalHost({
    manifest: runManifest(root),
    kernel,
    sessionStore: store,
    assetsRoot,
    accessToken: token,
  });
  const listening = await host.start();
  const headers = { 'content-type': 'application/json', 'x-agent-workbench-token': token };

  try {
    const session = await fetch(`${listening.url}/api/sessions`, {
      method: 'POST', headers, body: JSON.stringify({ title: '附件站内预览' }),
    }).then((response) => response.json()).then((body) => body.session);
    const resources = [];
    for (const file of [
      { name: '说明.md', type: 'text/markdown', content: '# 站内预览\n\nMarkdown **安全渲染**，也可以查看 Raw。' },
      { name: '用户查询.sql', type: 'application/sql', content: "select user_id, count(*) as solves from solve_events where created_at >= date_sub(current_date(), interval 7 day) group by user_id" },
      { name: '结果.csv', type: 'text/csv', content: 'country,users,note\nUS,120,"hello, world"\nJP,88,stable' },
      { name: '备注.txt', type: 'text/plain', content: '第一行\n\t保留制表符和空格\n第三行' },
    ]) {
      const attachment = await fetch(`${listening.url}/api/sessions/${session.sessionId}/attachments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ attachment: {
          name: file.name,
          type: file.type,
          size: Buffer.byteLength(file.content),
          data: `data:${file.type};base64,${Buffer.from(file.content).toString('base64')}`,
        } }),
      }).then((response) => response.json()).then((body) => body.attachment);
      resources.push(attachment);
    }
    const turnResponse = await fetch(`${listening.url}/api/sessions/${session.sessionId}/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: '请预览这四个附件', attachments: resources }),
    });
    assert.equal(turnResponse.status, 202);

    await page.goto(`${listening.url}/?session=${encodeURIComponent(session.sessionId)}`);
    await page.getByText('请预览这四个附件', { exact: true }).waitFor();
    await evidence.chapter('文字附件站内预览', {
      description: `${profile} · Markdown / SQL / CSV / TXT`,
    });
    await evidence.checkpoint('消息内的四种附件');

    await openPreview(page, evidence, '说明.md', 'Markdown 默认安全预览');
    const markdownDialog = page.getByRole('dialog', { name: '文件预览：说明.md' });
    await evidence.action('切换 Markdown Raw', markdownDialog.getByRole('button', { name: 'Raw' }));
    await evidence.checkpoint('Markdown Raw');
    await closePreview(markdownDialog, evidence);

    await openPreview(page, evidence, '用户查询.sql', 'SQL 格式化与语法高亮');
    const sqlDialog = page.getByRole('dialog', { name: '文件预览：用户查询.sql' });
    assert.ok(await sqlDialog.locator('.cwu-sql-keyword').count());
    await evidence.action('切换 SQL 原文', sqlDialog.getByRole('button', { name: '原文' }));
    await evidence.checkpoint('SQL 原文');
    await closePreview(sqlDialog, evidence);

    await openPreview(page, evidence, '结果.csv', 'CSV 有界表格预览');
    const csvDialog = page.getByRole('dialog', { name: '文件预览：结果.csv' });
    await csvDialog.getByRole('cell', { name: 'hello, world', exact: true }).waitFor();
    await evidence.checkpoint('CSV 表格');
    await closePreview(csvDialog, evidence);

    await openPreview(page, evidence, '备注.txt', 'TXT Raw');
    const textDialog = page.getByRole('dialog', { name: '文件预览：备注.txt' });
    await textDialog.getByText(/保留制表符和空格/).waitFor();
    await evidence.checkpoint('TXT Raw');
    await closePreview(textDialog, evidence);
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function openPreview(page, evidence, name, title) {
  const attachment = page.locator('.cwu-message-attachment', { hasText: name });
  await evidence.action(`打开 ${name}`, attachment);
  await page.getByRole('dialog', { name: `文件预览：${name}` }).waitFor();
  await evidence.checkpoint(title);
}

async function closePreview(dialog, evidence) {
  await evidence.action('关闭预览', dialog.getByRole('button', { name: '关闭文件预览' }));
  await dialog.waitFor({ state: 'detached' });
}

function runManifest(runRoot) {
  return {
    schema: 'agent-workbench.environment/v1',
    kind: 'run',
    id: 'run-text-preview-evidence',
    environmentId: 'environment-text-preview-evidence',
    status: 'running',
    versions: { platform: '0.26.0', runtime: 'test' },
    profile: { id: 'text-preview-evidence', hash: 'hash', source: { type: 'inline' } },
    runtime: { provider: 'fake' },
    features: { sessionWorkspace: true, attachments: true, agentArtifacts: true },
    capabilities: { lock: { capabilities: [] }, hash: 'hash' },
    isolation: {
      requestedLevel: 'ephemeral-machine',
      effectiveLevel: 'ephemeral-machine',
      enforcement: { externalEffects: { enforced: true, mode: 'no-external-effects' } },
    },
    paths: {
      root: runRoot,
      runtime: join(runRoot, 'runtime'),
      state: join(runRoot, 'state'),
      resources: join(runRoot, 'resources'),
      workspace: join(runRoot, 'workspace'),
      temporary: join(runRoot, 'tmp'),
      credentials: join(runRoot, 'credentials'),
    },
    process: { pid: process.pid, port: 0, providerState: {} },
    extensions: {},
    lifecycle: { createdAt: new Date().toISOString(), startedAt: new Date().toISOString() },
  };
}
