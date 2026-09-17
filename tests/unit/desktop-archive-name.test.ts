import { expect, it } from 'vitest';
import { archiveName } from '../../src/main/desktop/archive-name';

it('cleans Windows illegal characters, controls, bidi marks and trailing dots while keeping the work ID', () => {
  const name = archiveName({ author: 'CON', title: '../a\\b:c*?"<>|\u0000\u202e. ', workId: '123456789' });
  expect(name).toBeDefined();
  expect(name).not.toMatch(/[\\/:*?"<>|\u0000\u202e]/);
  expect(name).not.toMatch(/^CON[._ ]/i);
  expect(name).toMatch(/_123456789$/);
});
it('bounds long Unicode names without splitting surrogate pairs or dropping the work ID', () => {
  const name = archiveName({ author: '作'.repeat(300), title: '😀'.repeat(300), workId: '1234567890123456789' })!;
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
  expect(name).toMatch(/_1234567890123456789$/);
  expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});
it('falls back for absent or invalid metadata', () => {
  expect(archiveName(undefined)).toBeUndefined();
  expect(archiveName({ author: 'author', title: 'title', workId: '../bad' })).toBeUndefined();
});
