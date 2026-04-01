import { describe, expect, test } from "bun:test";
import { difference, every, intersects, union } from "../set";

describe("difference", () => {
  test("returns items in a but not b", () => {
    expect(difference(new Set([1, 2, 3, 4]), new Set([2, 4]))).toEqual(new Set([1, 3]));
  });

  test("empty a", () => {
    expect(difference(new Set(), new Set([1, 2]))).toEqual(new Set());
  });

  test("empty b returns a", () => {
    expect(difference(new Set([1, 2]), new Set())).toEqual(new Set([1, 2]));
  });

  test("identical sets", () => {
    const s = new Set([1, 2, 3]);
    expect(difference(s, s)).toEqual(new Set());
  });
});

describe("intersects", () => {
  test("overlapping sets", () => {
    expect(intersects(new Set([1, 2]), new Set([2, 3]))).toBe(true);
  });

  test("disjoint sets", () => {
    expect(intersects(new Set([1, 2]), new Set([3, 4]))).toBe(false);
  });

  test("empty sets", () => {
    expect(intersects(new Set(), new Set())).toBe(false);
  });
});

describe("every", () => {
  test("a is subset of b", () => {
    expect(every(new Set([1, 2]), new Set([1, 2, 3]))).toBe(true);
  });

  test("a is not subset of b", () => {
    expect(every(new Set([1, 2, 4]), new Set([1, 2, 3]))).toBe(false);
  });

  test("empty a is subset of anything", () => {
    expect(every(new Set(), new Set([1, 2]))).toBe(true);
  });
});

describe("union", () => {
  test("combines both sets", () => {
    expect(union(new Set([1, 2]), new Set([3, 4]))).toEqual(new Set([1, 2, 3, 4]));
  });

  test("handles overlap", () => {
    expect(union(new Set([1, 2, 3]), new Set([2, 3, 4]))).toEqual(new Set([1, 2, 3, 4]));
  });

  test("empty sets", () => {
    expect(union(new Set(), new Set())).toEqual(new Set());
  });
});
