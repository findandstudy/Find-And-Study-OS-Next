import assert from "node:assert/strict";
import test from "node:test";
import { clampClientPaginationPage } from "../src/lib/tablePagination";

test("does not clamp a server-side page when no client total was provided", () => {
  assert.equal(clampClientPaginationPage(4, 100, null), 4);
});

test("keeps an in-range client-side page", () => {
  assert.equal(clampClientPaginationPage(3, 25, 100), 3);
});

test("clamps an out-of-range client-side page after the data shrinks", () => {
  assert.equal(clampClientPaginationPage(4, 25, 40), 2);
  assert.equal(clampClientPaginationPage(2, 25, 0), 1);
});
