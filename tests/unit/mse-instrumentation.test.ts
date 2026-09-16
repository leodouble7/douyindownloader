import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { MSE_INSTRUMENTATION } from '../../src/main/browser/mse-instrumentation';

it('wraps native methods once, preserves descriptors/returns/errors and emits only metadata', () => {
  const records: Record<string, unknown>[] = [];
  class SourceBuffer {
    buffered = { length: 1, start: () => 0, end: () => 2 };
    appendBuffer(value: Uint8Array) { if (value.byteLength === 0) throw new Error('empty'); return 17; }
  }
  class MediaSource { addSourceBuffer(_mime: string) { return new SourceBuffer(); } }
  const url = { createObjectURL: () => 'blob:https://site.test/object' };
  const before = Object.getOwnPropertyDescriptor(SourceBuffer.prototype, 'appendBuffer');
  const context = { MediaSource, SourceBuffer, URL: url, performance: { now: () => 50 }, __mslEmit: (value: string) => records.push(JSON.parse(value)) };
  runInNewContext(MSE_INSTRUMENTATION, context);
  runInNewContext(MSE_INSTRUMENTATION, context);
  const source = new MediaSource();
  expect(url.createObjectURL()).toBe('blob:https://site.test/object');
  const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
  expect(buffer.appendBuffer(new Uint8Array([73, 74]))).toBe(17);
  expect(() => buffer.appendBuffer(new Uint8Array())).toThrow('empty');
  expect(records.filter((item) => item.type === 'append')).toHaveLength(1);
  expect(records.find((item) => item.type === 'append')).toMatchObject({ byteLength: 2, timestamp: 50, buffered: [[0, 2]] });
  expect(records.find((item) => item.type === 'source-buffer')).toMatchObject({ mimeType: 'video/mp4; codecs="avc1.42E01E"' });
  expect(JSON.stringify(records)).not.toMatch(/73|74/);
  expect(Object.getOwnPropertyDescriptor(SourceBuffer.prototype, 'appendBuffer')).toMatchObject({ writable: before?.writable, configurable: before?.configurable, enumerable: before?.enumerable });
});
