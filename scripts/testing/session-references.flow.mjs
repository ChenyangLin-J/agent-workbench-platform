import assert from 'node:assert/strict';
export const metadata = { name: 'session-references', profiles: ['desktop', 'mobile'], timeoutMs: 60000 };
export default async function ({ page, evidence, baseUrl, profile }) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseUrl);
  const toggle = page.locator('.cwu-browser-list-toggle');
  const composer = page.locator('.cwu-composer textarea');
  await composer.waitFor();
  const showList = async () => { if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click(); };
  const create = async () => {
    await showList();
    const count = await page.locator('.cwu-browser-row').count();
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    await page.waitForFunction(count => document.querySelectorAll('.cwu-browser-row').length > count, count);
    await page.locator('.cwu-session-header h1').getByText('新对话', { exact: true }).waitFor();
    await composer.waitFor();
  };
  await create();
  const marker = `引用目标 ${profile} ${Date.now()}`;
  await composer.fill(marker);
  await page.locator('.cwu-composer button[type=submit]').click();
  await page.getByText('已检查布局。', { exact: false }).first().waitFor({ timeout: 15000 });
  await create();
  await composer.fill('对照这个会话处理本轮需求');
  await evidence.chapter('会话引用', { description: `${profile} · 拖入 / @ 选择、草稿恢复、发送及引用回看` });
  if (profile === 'desktop') {
    await page.locator('.cwu-browser-row').filter({ hasText: marker }).dragTo(page.locator('.cwu-composer'));
  } else {
    await composer.fill(`对照这个会话处理本轮需求\n@${marker}`);
    await page.getByRole('listbox', { name: '选择 Session' }).getByRole('option').filter({ hasText: marker }).click();
  }
  const chips = page.getByLabel('已引用 Sessions');
  await chips.getByText(marker, { exact: true }).waitFor();
  await evidence.checkpoint('引用已加入 Composer');
  if (profile === 'desktop') {
    await page.locator('.cwu-browser-row').filter({ hasText: marker }).dragTo(page.locator('.cwu-composer'));
    assert.equal(await chips.locator('button').count(), 1);
  }
  await page.getByRole('button', { name: `移除 Session 引用：${marker}`, exact: true }).click();
  await composer.fill(`对照这个会话处理本轮需求\n@${marker}`);
  await page.getByRole('listbox', { name: '选择 Session' }).getByRole('option').filter({ hasText: marker }).click();
  await evidence.checkpoint('可移除并通过 @ 重新选择');
  const sourceTitle = await page.locator('.cwu-session-header h1').textContent();
  await showList();
  await page.locator('.cwu-browser-row-main').filter({ hasText: marker }).click();
  await page.locator('.cwu-session-header h1').filter({ hasText: marker }).waitFor();
  await showList();
  await page.locator('.cwu-browser-row-main').filter({ hasText: sourceTitle.trim() }).first().click();
  await chips.getByText(marker, { exact: true }).waitFor();
  assert.match(await composer.inputValue(), /对照这个会话/);
  await evidence.checkpoint('切换会话后草稿与引用保留');
  await page.locator('.cwu-composer button[type=submit]').click();
  const messageReference = page.getByLabel('引用的 Sessions').last();
  await messageReference.getByText(marker, { exact: true }).waitFor();
  await evidence.checkpoint('发送后消息保留会话引用');
  assert.equal(await page.locator('.cwu-message.is-user').last().textContent().then(text => text.includes('agent-workbench-session-references')), false);
  await messageReference.getByRole('button').click();
  await page.locator('.cwu-session-header h1').filter({ hasText: marker }).waitFor();
  await evidence.checkpoint('点击消息引用打开目标会话');
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}
