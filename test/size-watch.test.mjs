/** Попередження про наближення YML до ліміту чинної системи (50 000 000 Б). */
import test from "node:test";
import assert from "node:assert/strict";
import { liveLimitStatus, LIVE_LIMIT_BYTES } from "../src/verify/size-watch.mjs";

test("рівні: OK < 95% ≤ WARNING < 99% ≤ CRITICAL ≤ ліміт < OVER", () => {
  assert.equal(liveLimitStatus(40_000_000).level, "OK");
  assert.equal(liveLimitStatus(47_499_999).level, "OK");
  assert.equal(liveLimitStatus(47_500_000).level, "WARNING");
  assert.equal(liveLimitStatus(49_061_976).level, "WARNING", "поточний реальний main (≈98,1%) — попередження");
  assert.equal(liveLimitStatus(49_500_000).level, "CRITICAL");
  assert.equal(liveLimitStatus(LIVE_LIMIT_BYTES).level, "CRITICAL");
  assert.equal(liveLimitStatus(LIVE_LIMIT_BYTES + 1).level, "OVER");
});

test("запас і частка рахуються від 50 000 000 Б; невалідний розмір — помилка", () => {
  const s = liveLimitStatus(49_061_976);
  assert.equal(s.headroomBytes, 938_024);
  assert.equal(s.share, 0.9812);
  assert.match(s.message, /98\.1%/);
  assert.throws(() => liveLimitStatus(NaN));
  assert.throws(() => liveLimitStatus(-1));
});
