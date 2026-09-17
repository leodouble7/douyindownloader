import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import type { DesktopDownloaderApi, DownloadSnapshot } from '../../src/shared/desktop';

afterEach(cleanup);
const archived = { id: 'saved-1', workId: '7684438409082866998', author: '测试作者', title: '已存作品', outputPath: '/tmp/videos/作者_作品_7684438409082866998.mp4', directory: '/tmp/videos', completedAt: '2026-09-17T02:00:00Z', available: true };
const idle: DownloadSnapshot = { sequence: 0, phase: 'idle', directory: '/tmp/videos', message: '', candidates: [], tracks: [] };
const url = 'https://www.douyin.com/jingxuan?modal_id=7684438409082866998';
function setup(initial = idle) {
  let listener: ((state: DownloadSnapshot) => void) | undefined;
  const api: DesktopDownloaderApi = {
    getState: vi.fn().mockResolvedValue(initial), chooseDirectory: vi.fn().mockResolvedValue('/tmp/selected'),
    start: vi.fn().mockResolvedValue(undefined), select: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined), reveal: vi.fn().mockResolvedValue(undefined), retry: vi.fn().mockResolvedValue(undefined),
    continueDownload: vi.fn().mockResolvedValue(undefined), revealHistory: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 20 }),
    onState: callback => { listener = callback; return () => { listener = undefined; }; }
};
  render(<App api={api} />);
  return { api, emit: (state: DownloadSnapshot) => act(() => listener?.(state)) };
}

it('keeps a duplicate paused, reveals the saved file by ID and continues only after explicit choice', async () => {
  const { api } = setup({ ...idle, id: 'duplicate-job', phase: 'duplicate', duplicate: archived });
  await screen.findByRole('heading', { name: '这个作品已下载过' });
  expect(api.start).not.toHaveBeenCalled(); expect(api.continueDownload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '打开已有文件位置' }));
  await waitFor(() => expect(api.revealHistory).toHaveBeenCalledWith({ id: 'saved-1' }));
  fireEvent.click(screen.getByRole('button', { name: '仍然下载' }));
  await waitFor(() => expect(api.continueDownload).toHaveBeenCalledWith({ jobId: 'duplicate-job' }));
});

it('loads persistent history, marks missing files, and paginates instead of an unbounded list', async () => {
  const { api } = setup();
  vi.mocked(api.getHistory).mockResolvedValue({ items: [archived, { ...archived, id: 'missing', title: '已移走作品', available: false }], total: 22, offset: 0, limit: 20 });
  await screen.findByDisplayValue('/tmp/videos');
  fireEvent.click(screen.getByRole('button', { name: '下载历史' }));
  await screen.findByText('已存作品');
  expect(screen.getByText(/文件已移动或删除/)).toBeVisible();
  const missing = screen.getByText('已移走作品').closest('li')!;
  expect(within(missing).getByRole('button', { name: '打开文件夹' })).toBeDisabled();
  vi.mocked(api.getHistory).mockResolvedValue({ items: [{ ...archived, id: 'page2', title: '第二页作品' }], total: 22, offset: 20, limit: 20 });
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText('第二页作品');
  expect(api.getHistory).toHaveBeenLastCalledWith({ offset: 20 });
  expect(screen.queryByText('已存作品')).not.toBeInTheDocument();
});

it('shows a retry action when history cannot be read', async () => {
  const { api } = setup();
  vi.mocked(api.getHistory).mockRejectedValueOnce(new Error('无法读取下载历史'));
  await screen.findByDisplayValue('/tmp/videos');
  fireEvent.click(screen.getByRole('button', { name: '下载历史' }));
  await screen.findByText('无法读取下载历史，请重试。');
  fireEvent.click(screen.getByRole('button', { name: '重试加载历史' }));
  await screen.findByText('还没有下载记录。成功保存的作品会显示在这里。');
});

it('validates a link, chooses the native directory and starts one job', async () => {
  const { api, emit } = setup();
  await screen.findByDisplayValue('/tmp/videos');
  fireEvent.click(screen.getByRole('button', { name: '开始下载' }));
  expect(screen.getByRole('textbox', { name: '视频链接' })).toHaveFocus();
  expect(screen.getByRole('alert')).toHaveTextContent('抖音');
  expect(api.start).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: '视频链接' }), { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
  await screen.findByDisplayValue('/tmp/selected');
  fireEvent.click(screen.getByRole('button', { name: '开始下载' }));
  await waitFor(() => expect(api.start).toHaveBeenCalledWith({ url, directory: '/tmp/selected' }));
  emit({ ...idle, id: 'job-1', sequence: 1, phase: 'parsing', message: '正在解析视频' });
  expect(screen.getByRole('textbox', { name: '视频链接' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: '视频链接' })).toHaveAttribute('readonly');
  expect(screen.getByRole('heading', { name: '正在准备下载' })).toBeVisible();
  expect(screen.getByRole('button', { name: '取消下载' })).toBeEnabled();
});

it('shows actual bytes and speed, and keeps merge indeterminate until completion', async () => {
  const { emit, api } = setup();
  await screen.findByDisplayValue('/tmp/videos');
  emit({ ...idle, sequence: 2, id: 'j', phase: 'downloading', title: '测试视频', tracks: [
    { id: 'v', kind: 'video', downloadedBytes: 5 * 1024 ** 2, totalBytes: 10 * 1024 ** 2, bytesPerSecond: 1024 ** 2, status: 'running' }
  ] });
  expect(screen.getByRole('progressbar', { name: '下载进度' })).toHaveAttribute('aria-valuenow', '50');
  fireEvent.click(screen.getByText('下载详情'));
  expect(await screen.findByText('1.0 MB/s')).toBeVisible();
  emit({ ...idle, sequence: 3, id: 'j', phase: 'merging', message: '正在合并音视频' });
  expect(screen.getByText('正在保存，请稍候…')).toBeVisible();
  emit({ ...idle, sequence: 4, id: 'j', phase: 'completed', outputPath: '/tmp/videos/job/video.mp4', message: '下载完成' });
  expect(screen.getByText('/tmp/videos/job/video.mp4')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '打开文件夹' }));
  await waitFor(() => expect(api.reveal).toHaveBeenCalledWith({ jobId: 'j' }));
});

it('selects one video and explicitly assigns its audio while ignoring older snapshots', async () => {
  const { emit, api } = setup();
  await screen.findByDisplayValue('/tmp/videos');
  emit({ ...idle, id: 'j', sequence: 3, phase: 'choosing', message: '发现多个媒体', candidates: [
    { index: 1, kind: 'video', byteLength: 5000, groupKey: 'v', groupLabel: '待确认资源 1', audioOptions: [2] }, { index: 2, kind: 'audio', byteLength: 600, groupKey: 'a', groupLabel: '待确认资源 2' }
  ] });
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 视频 01' }));
  fireEvent.click(screen.getByRole('button', { name: '查看视频 01详情' }));
  fireEvent.click(screen.getByText('声音设置'));
  fireEvent.click(screen.getByRole('radio', { name: /添加音频 02/ }));
  fireEvent.click(screen.getByRole('button', { name: '下载所选 1 项' }));
  await waitFor(() => expect(api.select).toHaveBeenCalledWith({ jobId: 'j', mode: 'single', selections: [{ candidateIndex: 1, audioIndex: 2 }] }));
  emit({ ...idle, sequence: 2 });
  expect(screen.getByRole('checkbox', { name: '选择 视频 01' })).toBeChecked();
});

it('groups quality variants and allows more than two independent batch jobs', async () => {
  const { emit, api } = setup(); await screen.findByDisplayValue('/tmp/videos');
  emit({ ...idle, id: 'batch', sequence: 1, phase: 'choosing', candidates: [
    { index: 1, kind: 'pair', groupKey: 'work-a', groupLabel: '作品 1', grouping: 'confirmed', variantLabel: '720p', duplicateCount: 2 },
    { index: 2, kind: 'pair', groupKey: 'work-a', groupLabel: '作品 1', grouping: 'confirmed', variantLabel: '1080p' },
    { index: 3, kind: 'muxed', groupKey: 'work-b', groupLabel: '作品 2', grouping: 'confirmed' },
    { index: 4, kind: 'muxed', groupKey: 'work-c', groupLabel: '作品 3', grouping: 'confirmed' }
  ] });
  expect(screen.getAllByRole('checkbox')).toHaveLength(4);
  expect(screen.getByRole('button', { name: '下载所选 0 项' })).toBeDisabled();
  expect(screen.queryByText(/重复来源/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: '全选可用资源' }));
  fireEvent.click(screen.getByRole('button', { name: '查看作品 1详情' }));
  fireEvent.change(screen.getByRole('combobox', { name: '作品 1 的版本' }), { target: { value: '2' } });
  expect(screen.getAllByRole('checkbox').every(el => (el as HTMLInputElement).checked)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '下载所选 3 项' }));
  await waitFor(() => expect(api.select).toHaveBeenCalledWith({ jobId: 'batch', mode: 'batch', selections: [{ candidateIndex: 2 }, { candidateIndex: 3 }, { candidateIndex: 4 }] }));
});

it('shows partial batch results and retries or reveals only the chosen item', async () => {
  const { api, emit } = setup(); await screen.findByDisplayValue('/tmp/videos');
  emit({ ...idle, id: 'batch', sequence: 1, phase: 'partial', mode: 'batch', message: '1 项完成，1 项失败', queue: [
    { id: 'a', label: '作品 1', phase: 'completed', tracks: [], message: '已保存', attempts: 1, canRetry: false, outputPath: '/tmp/videos/a/video.mp4' },
    { id: 'b', label: '作品 2', phase: 'failed', tracks: [], message: '网络连接失败', attempts: 1, canRetry: true, reportPath: '/tmp/videos/b/result.json' }
  ] });
  const first = within(screen.getByRole('article', { name: '任务 1：作品 1' }));
  const second = within(screen.getByRole('article', { name: '任务 2：作品 2' }));
  fireEvent.click(second.getByRole('button', { name: '重试此项' }));
  await waitFor(() => expect(api.retry).toHaveBeenCalledWith({ jobId: 'batch', taskId: 'b' }));
  fireEvent.click(first.getByRole('button', { name: '打开文件夹' }));
  await waitFor(() => expect(api.reveal).toHaveBeenCalledWith({ jobId: 'batch', taskId: 'a' }));
  expect(first.queryByRole('button', { name: '重试此项' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '部分文件未下载成功' })).toBeVisible();
  expect(screen.getAllByRole('article')[0]).toHaveAccessibleName('任务 2：作品 2');
  expect(screen.getByText(/开始新下载后，无法重试这次的失败项/)).toBeVisible();
});

it('does not add a manually assigned audio as a duplicate batch task', async () => {
  const { api, emit } = setup(); await screen.findByDisplayValue('/tmp/videos');
  emit({ ...idle, id: 'j', sequence: 1, phase: 'choosing', candidates: [
    { index: 1, kind: 'video', groupKey: 'v1', groupLabel: '资源 1', audioOptions: [2] },
    { index: 2, kind: 'audio', groupKey: 'a', groupLabel: '资源 2' },
    { index: 3, kind: 'video', groupKey: 'v2', groupLabel: '资源 3', audioOptions: [2] }
  ] });
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 视频 01' }));
  fireEvent.click(screen.getByRole('button', { name: '查看视频 01详情' }));
  fireEvent.click(screen.getByText('声音设置'));
  fireEvent.click(screen.getByRole('radio', { name: /添加音频 02/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: '全选可用资源' }));
  expect(screen.getByRole('checkbox', { name: '选择 音频 02' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: '选择 音频 02' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '查看视频 03详情' }));
  fireEvent.click(screen.getByText('声音设置'));
  expect(screen.getByRole('radio', { name: /添加音频 02/ })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '下载所选 2 项' }));
  await waitFor(() => expect(api.select).toHaveBeenCalledWith({ jobId: 'j', mode: 'batch', selections: [{ candidateIndex: 1, audioIndex: 2 }, { candidateIndex: 3 }] }));
});

it('preserves the form after failure so retry uses the same link, and supports cancellation', async () => {
  const { emit, api } = setup();
  await screen.findByDisplayValue('/tmp/videos');
  fireEvent.change(screen.getByRole('textbox', { name: '视频链接' }), { target: { value: url } });
  emit({ ...idle, id: 'j', sequence: 1, phase: 'failed', message: '网络连接失败，请重试' });
  expect(screen.getByRole('alert')).toHaveTextContent('网络连接失败');
  expect(screen.getByRole('textbox', { name: '视频链接' })).toHaveValue(url);
  fireEvent.click(screen.getByRole('button', { name: '开始下载' }));
  await waitFor(() => expect(api.start).toHaveBeenCalledWith({ url, directory: '/tmp/videos' }));
  emit({ ...idle, id: 'j2', sequence: 2, phase: 'downloading', message: '正在下载' });
  fireEvent.click(screen.getByRole('button', { name: '取消下载' }));
  await waitFor(() => expect(api.cancel).toHaveBeenCalledWith({ jobId: 'j2' }));
});

it('keeps the selected directory when the native chooser is dismissed and exposes start errors', async () => {
  const { api } = setup();
  await screen.findByDisplayValue('/tmp/videos');
  vi.mocked(api.chooseDirectory).mockResolvedValue(null);
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
  await waitFor(() => expect(api.chooseDirectory).toHaveBeenCalled());
  expect(screen.getByRole('textbox', { name: '保存位置' })).toHaveValue('/tmp/videos');
  vi.mocked(api.start).mockRejectedValue(new Error("Error invoking remote method 'downloader:start': Error: 目录不可写，请重新选择"));
  fireEvent.change(screen.getByRole('textbox', { name: '视频链接' }), { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: '开始下载' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('目录不可写');
  expect(screen.getByRole('alert')).not.toHaveTextContent('downloader:start');
  expect(screen.getByRole('button', { name: '开始下载' })).toBeEnabled();
});


it('requires a directory with an associated field error before starting', async () => {
  const { api } = setup({ ...idle, directory: '' });
  await waitFor(() => expect(screen.getByRole('button', { name: '开始下载' })).toBeEnabled());
  fireEvent.change(screen.getByRole('textbox', { name: '视频链接' }), { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: '开始下载' }));
  expect(screen.getByRole('textbox', { name: '保存位置' })).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('button', { name: '选择文件夹' })).toHaveFocus();
  expect(api.start).not.toHaveBeenCalled();
});

it('keeps a new-task draft open when retained retry information expires', async () => {
  const queue: NonNullable<DownloadSnapshot['queue']> = [{ id: 'a', label: '视频 01', phase: 'failed', tracks: [], attempts: 1, canRetry: true, message: '网络中断' }];
  const { emit } = setup({ ...idle, id: 'batch', phase: 'partial', queue });
  await screen.findByRole('button', { name: '开始下载' });
  fireEvent.change(screen.getByRole('textbox', { name: '视频链接' }), { target: { value: url } });
  emit({ ...idle, sequence: 1, id: 'batch', phase: 'partial', queue: queue.map(item => ({ ...item, canRetry: false })) });
  expect(screen.getByRole('textbox', { name: '视频链接' })).toHaveValue(url);
  expect(screen.getByRole('button', { name: '开始下载' })).toBeEnabled();
});

it('replaces expired retry with an explanation and preserves completed file access', async () => {
  setup({ ...idle, id: 'batch', phase: 'partial', queue: [
    { id: 'a', label: '完成项', phase: 'completed', tracks: [], attempts: 1, canRetry: false, message: '已保存', outputPath: '/tmp/videos/a.mp4' },
    { id: 'b', label: '失败项', phase: 'failed', tracks: [], attempts: 1, canRetry: false, message: '网络中断' }
  ] });
  expect(await screen.findByRole('button', { name: '已过期，无法重试' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '打开文件夹' })).toBeEnabled();
  expect(screen.getByText(/下载信息已过期，请用上方链接重新开始/)).toBeVisible();
});

it('displays retry as an active task with only its current progress and locks result actions', async () => {
  setup({ ...idle, id: 'batch', phase: 'downloading', message: '正在重试所选任务…', queue: [
    { id: 'a', label: '完成项', phase: 'completed', tracks: [], attempts: 1, canRetry: false, message: '已保存', outputPath: '/tmp/videos/a.mp4' },
    { id: 'b', label: '失败项', phase: 'downloading', tracks: [{ id: 'v', kind: 'video', downloadedBytes: 2, totalBytes: 10, bytesPerSecond: 1, status: 'running' }], attempts: 2, canRetry: false, message: '正在下载' }
  ] });
  expect(await screen.findByRole('heading', { name: '正在重试' })).toBeVisible();
  expect(screen.getByRole('progressbar', { name: '下载进度' })).toHaveAttribute('aria-valuenow', '20');
  expect(screen.getByRole('button', { name: '打开文件夹' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: '新建任务' })).not.toBeInTheDocument();
});

it('reserves every variant of a manually assigned audio group', async () => {
  setup({ ...idle, id: 'batch', phase: 'choosing', candidates: [
    { index: 1, kind: 'video', groupKey: 'v1', audioOptions: [3, 4] },
    { index: 2, kind: 'video', groupKey: 'v2', audioOptions: [3, 4] },
    { index: 3, kind: 'audio', groupKey: 'audio', grouping: 'confirmed', groupLabel: '共享音频', variantLabel: '低码率' },
    { index: 4, kind: 'audio', groupKey: 'audio', grouping: 'confirmed', groupLabel: '共享音频', variantLabel: '高码率' }
  ] });
  await screen.findByRole('checkbox', { name: '选择 视频 01' });
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 视频 01' }));
  fireEvent.click(screen.getByRole('button', { name: '查看视频 01详情' }));
  fireEvent.click(screen.getByText('声音设置'));
  fireEvent.click(screen.getAllByRole('radio', { name: /添加共享音频/ })[0]);
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 视频 02' }));
  fireEvent.click(screen.getByRole('button', { name: '查看视频 02详情' }));
  fireEvent.click(screen.getByText('声音设置'));
  for (const option of screen.getAllByRole('radio', { name: /添加共享音频/ })) expect(option).toBeDisabled();
});

it('preserves keyboard focus and reading position while download stages change', async () => {
  const { emit } = setup({ ...idle, id: 'job', phase: 'downloading', message: '正在下载' });
  const cancel = await screen.findByRole('button', { name: '取消下载' });
  cancel.focus();
  const content = screen.getByLabelText('下载工作区'); content.scrollTop = 120;
  emit({ ...idle, id: 'job', sequence: 1, phase: 'merging', message: '正在合并' });
  expect(cancel).toHaveFocus(); expect(content.scrollTop).toBe(120);
  emit({ ...idle, id: 'job', sequence: 2, phase: 'verifying', message: '正在校验' });
  expect(cancel).toHaveFocus(); expect(content.scrollTop).toBe(120);
});


it('shows only the essential form and a clear direct-save hint on the home screen', async () => {
  setup(); await screen.findByRole('button', { name: '开始下载' });
  expect(screen.getByText('文件直接保存在此文件夹')).toBeVisible();
  expect(screen.queryByText(/候选|01 \/|资源和进度|本地存储/)).not.toBeInTheDocument();
});

it.each([['failed', '下载未成功'], ['cancelled', '下载已取消']] as const)('describes an entirely %s queue without calling it partial', async (phase, title) => {
  setup({ ...idle, id: 'j', phase, queue: [{ id: 'one', label: '视频 01', phase, tracks: [], attempts: 1, canRetry: true, message: '未完成' }] });
  expect(await screen.findByRole('heading', { name: title })).toBeVisible();
  expect(screen.queryByText('部分文件未下载成功')).not.toBeInTheDocument();
});

it('keeps technical download details collapsed and shows one overall progress bar', async () => {
  setup({ ...idle, id: 'j', phase: 'downloading', tracks: [
    { id: 'v', kind: 'video', downloadedBytes: 40, totalBytes: 80, bytesPerSecond: 10, status: 'running' },
    { id: 'a', kind: 'audio', downloadedBytes: 0, totalBytes: 20, bytesPerSecond: 0, status: 'queued' }
  ] });
  expect(await screen.findByRole('progressbar', { name: '下载进度' })).toHaveAttribute('aria-valuenow', '40');
  expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  fireEvent.click(screen.getByText('下载详情'));
  expect(await screen.findByRole('progressbar', { name: '音频下载进度' })).toBeVisible();
});


it('keeps link, directory and results together and immediately allows another download after cancel', async () => {
  const { emit, api } = setup(); await screen.findByDisplayValue('/tmp/videos');
  fireEvent.change(screen.getByRole('textbox', { name: '视频链接' }), { target: { value: url } });
  for (const phase of ['parsing', 'choosing', 'downloading', 'merging'] as const) {
    emit({ ...idle, id: 'j', phase, sequence: ['parsing', 'choosing', 'downloading', 'merging'].indexOf(phase) + 1 });
    expect(screen.getByRole('textbox', { name: '视频链接' })).toHaveValue(url);
    expect(screen.getByRole('textbox', { name: '保存位置' })).toBeVisible();
    expect(screen.getByRole('button', { name: '选择文件夹' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消下载' })).toBeEnabled();
  }
  emit({ ...idle, id: 'j', phase: 'cancelled', sequence: 5, message: '下载已取消' });
  expect(screen.getByRole('textbox', { name: '视频链接' })).not.toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: '选择文件夹' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '开始下载' }));
  await waitFor(() => expect(api.start).toHaveBeenCalledWith({ url, directory: '/tmp/videos' }));
});

it('opens the manual web retry only from an explicit fallback action', async () => {
  const { emit, api } = setup(); await screen.findByDisplayValue('/tmp/videos');
  fireEvent.change(screen.getByRole('textbox', { name: '视频链接' }), { target: { value: url } });
  emit({ ...idle, id: 'j', phase: 'parsing', sequence: 1, captureMode: 'background' });
  expect(screen.getByText('正在后台读取视频，资源齐全后会自动开始下载。')).toBeVisible();
  expect(screen.queryByRole('button', { name: '打开抖音网页重试' })).not.toBeInTheDocument();
  emit({ ...idle, id: 'j', phase: 'failed', sequence: 2, captureFallback: true, message: '暂时无法自动获取视频' });
  fireEvent.click(screen.getByRole('button', { name: '打开抖音网页重试' }));
  await waitFor(() => expect(api.start).toHaveBeenCalledWith({ url, directory: '/tmp/videos', interactive: true }));
});

it('keeps the saved file directory separate from a newly selected destination', async () => {
  const { api } = setup({ ...idle, id: 'j', phase: 'completed', resultDirectory: '/tmp/videos', outputPath: '/tmp/videos/视频.mp4' });
  await screen.findByRole('button', { name: '打开文件夹' });
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
  await screen.findByDisplayValue('/tmp/selected');
  expect(screen.getByText('/tmp/videos')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '打开文件夹' }));
  await waitFor(() => expect(api.reveal).toHaveBeenCalledWith({ jobId: 'j' }));
});

it('shows the original request while retrying and restores the next-download draft afterwards', async () => {
  const { emit, api } = setup(); await screen.findByDisplayValue('/tmp/videos');
  fireEvent.change(screen.getByRole('textbox', { name: '视频链接' }), { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: '开始下载' }));
  await waitFor(() => expect(api.start).toHaveBeenCalled());
  const item = { id: 'one', label: '视频 01', phase: 'failed' as const, tracks: [], attempts: 1, canRetry: true, message: '网络中断' };
  emit({ ...idle, id: 'j', phase: 'failed', sequence: 1, resultDirectory: '/tmp/videos', queue: [item] });
  const nextUrl = 'https://www.douyin.com/video/888';
  fireEvent.change(screen.getByRole('textbox', { name: '视频链接' }), { target: { value: nextUrl } });
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' })); await screen.findByDisplayValue('/tmp/selected');
  fireEvent.click(screen.getByRole('button', { name: '重试此项' })); await waitFor(() => expect(api.retry).toHaveBeenCalled());
  emit({ ...idle, id: 'j', phase: 'downloading', sequence: 2, directory: '/tmp/selected', resultDirectory: '/tmp/videos', queue: [{ ...item, phase: 'downloading', attempts: 2, canRetry: false }] });
  expect(screen.getByRole('textbox', { name: '视频链接' })).toHaveValue(url);
  expect(screen.getByRole('textbox', { name: '保存位置' })).toHaveValue('/tmp/videos');
  emit({ ...idle, id: 'j', phase: 'completed', sequence: 3, directory: '/tmp/selected', resultDirectory: '/tmp/videos', queue: [{ ...item, phase: 'completed', canRetry: false, outputPath: '/tmp/videos/视频.mp4' }] });
  expect(screen.getByRole('textbox', { name: '视频链接' })).toHaveValue(nextUrl);
  expect(screen.getByRole('textbox', { name: '保存位置' })).toHaveValue('/tmp/selected');
});

it('shows the identified work with only quality selection and automatically associated audio', async () => {
  const { api } = setup({ ...idle, sequence: 2, id: 'target', phase: 'choosing', targetWorkId: '7684438409082866998', title: '师徒四人身世吐槽大会', candidates: [
    { index: 1, kind: 'muxed', height: 1080, byteLength: 116333475, groupKey: 'target', grouping: 'confirmed' },
    { index: 2, kind: 'pair', height: 720, byteLength: 71887222, groupKey: 'target', grouping: 'confirmed' }
  ] });
  await screen.findByRole('heading', { name: '选择清晰度' });
  expect(screen.getByText('师徒四人身世吐槽大会')).toBeVisible();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.queryByText('声音设置')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: '清晰度' }), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: '下载视频' }));
  await waitFor(() => expect(api.select).toHaveBeenCalledWith({ jobId: 'target', mode: 'single', selections: [{ candidateIndex: 2 }] }));
});
