// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { RunTimeline } from '../../src/renderer/components/RunTimeline';
import type { RunEvent } from '../../src/shared/contracts';
afterEach(cleanup);
it('explains navigation, worker, MSE, probes, download, remux and verification with expandable safe diffs', () => {
  const actions = ['navigation:after', 'target-attached:after', 'capture-mse:after', 'without-query:after', 'range-tail:after', 'download:progress', 'remux:result', 'probe:result'];
  const events: RunEvent[] = actions.map((action, i) => ({ id: `e-${i}`, runId: 'run', sequence: i + 1, timestamp: '2026-09-15T10:00:00Z', phase: i < 3 ? 'capture' : i < 5 ? 'probe' : i === 5 ? 'download' : i === 6 ? 'ffmpeg' : 'verify', action, purpose: '验证服务端访问控制', status: 'succeeded', evidence: { status: 206, requestDiff: { query: '删除全部查询参数', beforeHeaders: { cookie: '[已脱敏]' }, afterHeaders: { range: 'bytes=-65536' } } }, conclusion: '已返回媒体字节；不代表完整播放', relatedIds: [] }));
  render(<RunTimeline events={events} />);
  expect(screen.getByRole('heading', { name: '页面导航' })).toBeInTheDocument(); expect(screen.getByRole('heading', { name: '附加页面 / Worker' })).toBeInTheDocument(); expect(screen.getByRole('heading', { name: 'MSE 追加与缓冲' })).toBeInTheDocument(); expect(screen.getByRole('heading', { name: '尾部 Range' })).toBeInTheDocument(); expect(screen.getAllByText(/206/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getAllByText('展开证据')[3]);
  for (const label of ['准备做什么', '为什么', '修改了什么', '服务端返回', '如何判定']) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/已脱敏/).length).toBeGreaterThan(0); expect(document.querySelectorAll('time')).toHaveLength(8);
});
