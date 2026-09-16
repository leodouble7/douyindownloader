// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProbeMatrix } from '../../src/renderer/components/ProbeMatrix';
afterEach(cleanup);
it('labels transport failures inconclusive and links each outcome to evidence', () => {
  const select = vi.fn(); render(<ProbeMatrix probes={[{ id: 'p1', trackId: 't1', name: 'range-tail', outcome: 'inconclusive', eventIds: ['e1'], status: undefined }, { id: 'p2', trackId: 't1', name: 'without-query', outcome: 'denied', eventIds: ['e2'], status: 403 }]} onEvidence={select} />);
  expect(screen.getByText('无法判定')).toBeInTheDocument(); expect(screen.getByText('服务端拒绝')).toBeInTheDocument(); fireEvent.click(screen.getAllByRole('button', { name: /查看证据/ })[0]); expect(select).toHaveBeenCalledWith('e1');
});
