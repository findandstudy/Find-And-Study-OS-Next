import test from "node:test";
import assert from "node:assert/strict";
import {
  isImportantNotification,
  notificationPriority,
} from "../src/lib/notificationPriority";
import {
  cacheNotificationCounts,
  clearNotificationCountCacheForTests,
  getCachedNotificationCounts,
  invalidateNotificationCounts,
} from "../src/lib/notificationCountCache";

test("attention policy keeps routine activity out of the default bell view", () => {
  assert.equal(notificationPriority("inbox.send_failed"), "critical");
  assert.equal(notificationPriority("application.offer_letter_expiring"), "high");
  assert.equal(isImportantNotification("task.assigned"), true);
  assert.equal(isImportantNotification("student.document_uploaded"), false);
  assert.equal(isImportantNotification("inbox.new_message"), false);
  assert.equal(isImportantNotification("application.stage_changed"), false);
});

test("notification count cache is isolated, immutable, and invalidatable", () => {
  clearNotificationCountCacheForTests();
  cacheNotificationCounts(10, {
    total: 9,
    importantTotal: 2,
    leads: 1,
    students: 2,
    applications: 3,
    tasks: 1,
  });
  const first = getCachedNotificationCounts(10);
  assert.equal(first?.importantTotal, 2);
  if (first) first.total = 999;
  assert.equal(getCachedNotificationCounts(10)?.total, 9);
  assert.equal(getCachedNotificationCounts(11), null);
  invalidateNotificationCounts(10);
  assert.equal(getCachedNotificationCounts(10), null);
});
