import { describe, expect, test } from "bun:test";
import { count, intersperse, uniq } from "../array";

describe("intersperse", () => {
  test("empty array", () => {
    expect(intersperse([], () => 0)).toEqual([]);
  });

  test("single element", () => {
    expect(intersperse([1], () => 0)).toEqual([1]);
  });

  test("multiple elements", () => {
    expect(intersperse([1, 2, 3], () => 0)).toEqual([1, 0, 2, 0, 3]);
  });

  test("separator receives index", () => {
    const result = intersperse(["a", "b", "c"], (i) => `sep-${i}`);
    expect(result).toEqual(["a", "sep-1", "b", "sep-2", "c"]);
  });
});

describe("count", () => {
  test("empty array", () => {
    expect(count([], () => true)).toBe(0);
  });

  test("counts matching elements", () => {
    expect(count([1, 2, 3, 4, 5], (x) => x > 3)).toBe(2);
  });

  test("no matches", () => {
    expect(count([1, 2, 3], (x) => x > 10)).toBe(0);
  });

  test("all match", () => {
    expect(count([1, 2, 3], () => true)).toBe(3);
  });
});

describe("uniq", () => {
  test("empty array", () => {
    expect(uniq([])).toEqual([]);
  });

  test("removes duplicates", () => {
    expect(uniq([1, 2, 2, 3, 1])).toEqual([1, 2, 3]);
  });

  test("works with strings", () => {
    expect(uniq(["a", "b", "a"])).toEqual(["a", "b"]);
  });
});
