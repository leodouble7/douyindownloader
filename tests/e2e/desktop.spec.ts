import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DesktopDownloaderApi, DownloadSnapshot } from '../../src/shared/desktop';

// Browser-only bridge fixture. Actual capture/download/merge is covered by desktop-backend.test.ts.
async function installBridge(page: Page) {
  await page.addInitScript(() => {
    const testWindow = window as unknown as { downloader: DesktopDownloaderApi; emitFixture: (patch: Partial<DownloadSnapshot>) => void; revealed?: string; selected?: unknown; retried?: unknown };
    let state: DownloadSnapshot = { sequence: 0, phase: 'idle', directory: '/Users/demo/Movies', message: '', candidates: [], tracks: [] };
    const listeners = new Set<(value: DownloadSnapshot) => void>();
    testWindow.emitFixture = patch => { state = { ...state, ...patch, sequence: state.sequence + 1 }; listeners.forEach(fn => fn(state)); };
    testWindow.downloader = {
      getState: async () => state,
      chooseDirectory: async () => '/Users/demo/Movies/视频收藏',
      start: async () => testWindow.emitFixture({ id: 'fixture', phase: 'parsing', title: '测试作品', message: '正在解析视频' }),
      select: async input => { testWindow.selected = input; testWindow.emitFixture({ phase: 'downloading', candidates: [], message: '正在下载文件' }); },
      retry: async input => { testWindow.retried = input; },
      cancel: async () => testWindow.emitFixture({ phase: 'cancelled', message: '任务已取消' }),
      reveal: async input => { testWindow.revealed = input.taskId ? state.queue?.find(item => item.id === input.taskId)?.outputPath : state.outputPath; },
      onState: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }
    };
  });
}
async function emit(page: Page, patch: Partial<DownloadSnapshot>) {
  await page.evaluate(value => (window as unknown as { emitFixture: (p: Partial<DownloadSnapshot>) => void }).emitFixture(value), patch);
}

test('desktop workflow: native-choice result, real progress display, recovery and result', async ({ page }, testInfo) => {
  await installBridge(page); await page.goto('/');
  await expect(page.getByRole('button', { name: '开始下载' })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('empty.png'), fullPage: true });
  await page.getByRole('button', { name: '开始下载' }).click();
  await expect(page.getByRole('alert')).toContainText('有效的抖音');
  await expect(page.getByRole('textbox', { name: '视频链接' })).toBeFocused();
  await page.getByRole('textbox', { name: '视频链接' }).fill('https://www.douyin.com/video/7684438409082866998');
  await page.getByRole('button', { name: '选择文件夹' }).click();
  await expect(page.getByRole('textbox', { name: '保存位置' })).toHaveValue('/Users/demo/Movies/视频收藏');
  await page.getByRole('button', { name: '开始下载' }).click();
  await expect(page.getByRole('heading', { name: '正在准备下载' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '视频链接' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '保存位置' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('parsing.png'), fullPage: true });
  await emit(page, { phase: 'choosing', candidates: [{ index: 1, kind: 'video', groupKey: 'v', groupLabel: '待确认资源 1', audioOptions: [2], byteLength: 62409109, width: 1280, height: 720 }, { index: 2, kind: 'audio', groupKey: 'a', groupLabel: '待确认资源 2', byteLength: 9478113 }] });
  await page.getByRole('checkbox', { name: '选择 视频 01' }).focus(); await page.keyboard.press('Space');
  await page.getByRole('button', { name: '查看视频 01详情' }).click();
  await page.getByText('声音设置').click();
  await page.getByRole('radio', { name: /使用原文件/ }).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: /添加音频 02/ })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('candidates.png'), fullPage: true });
  await page.getByRole('button', { name: '下载所选 1 项' }).click();
  await emit(page, { phase: 'downloading', message: '正在下载并检查文件完整性…', title: '师徒四人身世吐槽大会', tracks: [
    { id: 'v', kind: 'video', downloadedBytes: 33554432, totalBytes: 62409109, bytesPerSecond: 3145728, status: 'running' },
    { id: 'a', kind: 'audio', downloadedBytes: 0, totalBytes: 9478113, bytesPerSecond: 0, status: 'queued' }
  ] });
  await expect(page.getByRole('progressbar', { name: '下载进度' })).toHaveAttribute('aria-valuenow', '46');
  await expect.poll(() => page.getByRole('progressbar', { name: '下载进度' }).evaluate(el => Math.round(el.firstElementChild!.getBoundingClientRect().width / el.getBoundingClientRect().width * 100))).toBe(46);
  await page.screenshot({ path: testInfo.outputPath('progress.png'), fullPage: true });
  await page.getByRole('button', { name: '取消下载' }).click();
  await expect(page.getByRole('status')).toContainText('任务已取消');
  await expect(page.getByRole('textbox', { name: '视频链接' })).not.toHaveAttribute('readonly');
  await expect(page.getByRole('button', { name: '开始下载' })).toBeEnabled();
  await page.getByRole('button', { name: '开始下载' }).click();
  await emit(page, { phase: 'failed', message: '网络连接失败，请重试', tracks: [] });
  await expect(page.getByRole('alert')).toContainText('网络连接失败');
  await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true });
  await page.getByRole('button', { name: '开始下载' }).click();
  await emit(page, { phase: 'completed', message: '音视频已无损合并，并通过完整性验证', outputPath: '/Users/demo/Movies/视频收藏/视频_20260916_120000.mp4' });
  await page.getByRole('button', { name: '打开文件夹' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { revealed: string }).revealed)).toContain('视频_20260916_120000.mp4');
  await page.screenshot({ path: testInfo.outputPath('completed.png'), fullPage: true });
});

test('batch selection keeps quality variants together and provides independent recovery', async ({ page }, testInfo) => {
  await installBridge(page); await page.goto('/');
  await emit(page, { id: 'batch', phase: 'choosing', message: '选择要保存的内容', candidates: [
    { index: 1, kind: 'pair', groupKey: 'a', groupLabel: '作品 1', grouping: 'confirmed', variantLabel: '720p', byteLength: 64000000, duplicateCount: 1 },
    { index: 2, kind: 'pair', groupKey: 'a', groupLabel: '作品 1', grouping: 'confirmed', variantLabel: '1080p', byteLength: 124750237 },
    { index: 3, kind: 'muxed', groupKey: 'b', groupLabel: '作品 2', grouping: 'confirmed', byteLength: 53000000 },
    { index: 4, kind: 'video', groupKey: 'c', groupLabel: '待确认资源 3', grouping: 'unconfirmed', byteLength: 12000000 }
  ] });
  await expect(page.getByRole('button', { name: '下载所选 0 项' })).toBeDisabled();
  await page.getByRole('checkbox', { name: '全选可用资源' }).check();
  await expect(page.getByRole('checkbox')).toHaveCount(4);
  await page.getByRole('button', { name: '查看作品 1详情' }).click();
  const quality = page.getByRole('combobox', { name: '作品 1 的版本' });
  await quality.focus(); await page.keyboard.press('Space');
  await page.screenshot({ path: testInfo.outputPath('quality-popup.png'), fullPage: true });
  await page.keyboard.press('Escape'); await quality.selectOption('2');
  await page.screenshot({ path: testInfo.outputPath('batch-selection.png'), fullPage: true });
  expect(await page.locator('.inline-selection').evaluate(el => el.getBoundingClientRect().bottom <= document.querySelector('.selection-actions')!.getBoundingClientRect().top)).toBe(true);
  await page.getByRole('button', { name: '下载所选 3 项' }).click();
  expect(await page.evaluate(() => (window as unknown as { selected: unknown }).selected)).toEqual({ jobId: 'batch', mode: 'batch', selections: [{ candidateIndex: 2 }, { candidateIndex: 3 }, { candidateIndex: 4 }] });
  const queue: NonNullable<DownloadSnapshot['queue']> = [
    { id: 'a', label: '作品 1 · 1080p', phase: 'completed', message: '完整视频已保存', attempts: 1, canRetry: false, tracks: [], outputPath: '/Users/demo/Movies/视频_20260916_120001.mp4' },
    { id: 'b', label: '作品 2', phase: 'failed', message: '网络连接失败，请重试此项', attempts: 1, canRetry: true, tracks: [] },
    { id: 'c', label: '待确认资源 3', phase: 'tracks-only', message: '纯视频已保存，未找到对应音频', attempts: 1, canRetry: false, tracks: [], outputPath: '/Users/demo/Movies/视频_20260916_120002.mp4' }
  ];
  await emit(page, { phase: 'partial', mode: 'batch', message: '1 项完成，1 项失败，1 项已保存单轨', queue });
  await expect(page.getByRole('heading', { name: '部分文件未下载成功' })).toBeVisible();
  await expect(page.getByRole('article').first()).toHaveAccessibleName('任务 2：作品 2');
  await page.getByRole('article', { name: '任务 2：作品 2' }).getByRole('button', { name: '重试此项' }).click();
  expect(await page.evaluate(() => (window as unknown as { retried: unknown }).retried)).toEqual({ jobId: 'batch', taskId: 'b' });
  await page.getByRole('article', { name: '任务 1：作品 1 · 1080p' }).getByRole('button', { name: '打开文件夹' }).click();
  expect(await page.evaluate(() => (window as unknown as { revealed: string }).revealed)).toContain('/视频_20260916_120001.mp4');
  await page.screenshot({ path: testInfo.outputPath('batch-partial.png'), fullPage: true });
  await emit(page, { phase: 'downloading', message: '正在重试所选任务…', queue: queue.map(item => item.id === 'b' ? { ...item, phase: 'downloading', message: '正在下载', attempts: 2, canRetry: false, tracks: [{ id: 'v', kind: 'video', downloadedBytes: 2, totalBytes: 10, bytesPerSecond: 1, status: 'running' }] } : item) });
  await expect(page.getByRole('heading', { name: '正在重试' })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开文件夹' }).first()).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('retry.png'), fullPage: true });
  await emit(page, { phase: 'partial', queue: queue.map(item => ({ ...item, canRetry: false })) });
  await expect(page.getByRole('button', { name: '已过期，无法重试' })).toBeDisabled();
  await expect(page.getByText(/下载信息已过期，请用上方链接重新开始/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('expired.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('batch-narrow.png'), fullPage: true });
});

test('narrow layout, long content, reduced motion and keyboard remain usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await installBridge(page); await page.goto('/');
  await page.getByRole('textbox', { name: '视频链接' }).fill('https://www.douyin.com/video/7684438409082866998');
  await page.getByRole('button', { name: '清空视频地址' }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: '视频链接' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: '视频链接' })).toHaveValue('');
  await emit(page, { id: 'fixture', phase: 'completed', title: '很长的视频标题'.repeat(12), message: '下载完成', outputPath: '/Users/demo/Movies/' + '很长的目录名称/'.repeat(6) + 'video.mp4' });
  await expect(page.getByRole('button', { name: '打开文件夹' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarColor)).not.toBe('auto');
  await page.screenshot({ path: testInfo.outputPath('narrow.png'), fullPage: true });
});

test('packaged renderer connects to real Electron IPC and remembers directory selection', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'desktop-ui-')));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'));
  const app = await electron.launch({ args: [resolve('out/main/index.js'), `--user-data-dir=${join(directory, 'prefs')}`], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '开始下载' })).toBeEnabled();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, directory);
    await page.getByRole('button', { name: '选择文件夹' }).click();
    await expect(page.getByRole('textbox', { name: '保存位置' })).toHaveValue(directory);
    await page.reload();
    await expect(page.getByRole('textbox', { name: '保存位置' })).toHaveValue(directory);
    const state = await page.evaluate(() => window.downloader.getState());
    expect(state.phase).toBe('idle'); expect(state.directory).toBe(directory);
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('single-page form and selection share document scrolling on desktop and narrow windows', async ({ page }, testInfo) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  await page.setViewportSize({ width: 1269, height: 714 });
  await installBridge(page); await page.goto('/');
  await expect(page.getByRole('button', { name: '开始下载' })).toBeEnabled();
  await emit(page, { id: 'four', phase: 'choosing', candidates: [
    { index: 1, kind: 'video', byteLength: 116287078, audioOptions: [4] },
    { index: 2, kind: 'video', byteLength: 26004684, audioOptions: [4] },
    { index: 3, kind: 'video', byteLength: 4404019, audioOptions: [4] },
    { index: 4, kind: 'audio', byteLength: 9437184 }
  ] });
  await expect(page.getByRole('button', { name: '下载所选 0 项' })).toBeDisabled();
  const layout = await page.locator('.inline-selection').evaluate(el => ({
    bottom: el.getBoundingClientRect().bottom,
    dock: document.querySelector('.selection-actions')!.getBoundingClientRect().top,
    last: [...document.querySelectorAll('.resource')].at(-1)!.getBoundingClientRect().bottom,
    overflowing: document.documentElement.scrollWidth > innerWidth
  }));
  expect(layout.last).toBeLessThanOrEqual(layout.bottom);
  expect(layout.bottom).toBeLessThanOrEqual(layout.dock);
  expect(layout.overflowing).toBe(false);
  await expect(page.getByRole('textbox', { name: '视频链接' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '视频链接' })).toHaveAttribute('readonly');
  expect(await page.locator('main').evaluate(el => getComputedStyle(el).overflowY)).toBe('visible');
  await page.screenshot({ path: testInfo.outputPath('single-page-selection.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('checkbox', { name: '选择 视频 01' }).check();
  await page.getByRole('button', { name: '查看视频 01详情' }).click();
  await page.getByText('声音设置').click();
  await page.getByRole('radio', { name: /添加音频 04/ }).check();
  await expect(page.getByRole('button', { name: '下载所选 1 项' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('narrow-selection.png'), fullPage: true });
  await page.setViewportSize({ width: 634, height: 357 });
  await page.getByRole('button', { name: '下载所选 1 项' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '下载所选 1 项' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});


test('background capture failure offers a manual page only after a user click', async ({ page }, testInfo) => {
  await installBridge(page); await page.goto('/');
  await page.getByRole('textbox', { name: '视频链接' }).fill('https://www.douyin.com/video/7684438409082866998');
  await page.getByRole('button', { name: '开始下载' }).click();
  await expect(page.getByText('正在后台读取视频，通常需要约 30 秒。')).toBeVisible();
  await emit(page, { phase: 'failed', message: '暂时无法自动获取视频。网页可能需要登录、验证或手动播放。', captureFallback: true });
  await expect(page.getByRole('button', { name: '打开抖音网页重试' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '视频链接' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('manual-fallback.png'), fullPage: true });
  await page.getByRole('button', { name: '打开抖音网页重试' }).click();
  await expect(page.getByRole('heading', { name: '正在准备下载' })).toBeVisible();
});

test('target work has a simple quality picker and one-page recovery', async ({ page }, testInfo) => {
  await installBridge(page); await page.goto('/');
  await emit(page, { id: 'target-work', phase: 'choosing', targetWorkId: '7684438409082866998', title: '师徒四人身世吐槽大会 雪莲大将？', candidates: [
    { index: 1, kind: 'muxed', width: 1920, height: 1080, byteLength: 116333475, groupKey: 'target-work', grouping: 'confirmed' },
    { index: 2, kind: 'pair', width: 1280, height: 720, byteLength: 71887222, groupKey: 'target-work', grouping: 'confirmed' }
  ] });
  await expect(page.getByRole('heading', { name: '选择清晰度' })).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  const quality = page.getByRole('combobox', { name: '清晰度' });
  await quality.focus(); await page.keyboard.press('Space');
  await page.screenshot({ path: testInfo.outputPath('target-quality-popup.png'), fullPage: true });
  await page.keyboard.press('Escape'); await quality.selectOption('2');
  await page.screenshot({ path: testInfo.outputPath('target-quality-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('target-quality-narrow.png'), fullPage: true });
  await page.getByRole('button', { name: '下载视频' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { selected: unknown }).selected)).toEqual({ jobId: 'target-work', mode: 'single', selections: [{ candidateIndex: 2 }] });
  await emit(page, { phase: 'failed', targetWorkId: undefined, captureFallback: true, message: '无法确认链接对应的视频或声音，请检查作品链接，或打开网页播放后重试。' });
  await expect(page.getByRole('alert')).toContainText('无法确认链接对应的视频');
  await expect(page.getByRole('button', { name: '打开抖音网页重试' })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始下载' })).toBeEnabled();
});
