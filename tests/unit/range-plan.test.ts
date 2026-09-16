import { describe, expect, it } from 'vitest';
import { createRangePlan } from '../../src/main/download/range-plan';
describe('inclusive safe range planning', () => {
  it('covers exactly ten bytes without gaps or overlaps', () => {
    expect(createRangePlan(10, 4)).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 9 }]);
    expect(createRangePlan(1, 4)).toEqual([{ start: 0, end: 0 }]);
    expect(createRangePlan(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toEqual([{ start: 0, end: Number.MAX_SAFE_INTEGER - 1 }]);
  });
  it.each([0, -1, NaN, Infinity, undefined, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unknown or unsafe totals %s', value => {
    expect(() => createRangePlan(value as number, 4)).toThrow();
  });
  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe chunk sizes %s', value => {
    expect(() => createRangePlan(10, value)).toThrow();
  });
  it('rejects an unreasonably large materialized plan', () => {
    expect(() => createRangePlan(Number.MAX_SAFE_INTEGER, 1)).toThrow();
  });
});
