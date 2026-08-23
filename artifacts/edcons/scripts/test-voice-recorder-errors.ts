import assert from "node:assert/strict";
import test from "node:test";
import { voiceRecorderStartError } from "../src/hooks/voice-recorder-errors";
import { selectVoiceRecordingFormat } from "../src/hooks/voice-recorder-format";

test("recognizes permission denial without relying on DOMException identity", () => {
  assert.match(
    voiceRecorderStartError(
      { name: "NotAllowedError", message: "Permission denied" },
      "permission",
    ),
    /access is blocked/i,
  );
});

test("distinguishes missing and busy microphones", () => {
  assert.match(
    voiceRecorderStartError({ name: "NotFoundError" }, "permission"),
    /No microphone was found/i,
  );
  assert.match(
    voiceRecorderStartError({ name: "NotReadableError" }, "permission"),
    /in use by another app/i,
  );
});

test("reports encoder startup separately from microphone permission", () => {
  assert.match(
    voiceRecorderStartError(new Error("AudioWorklet failed"), "encoder"),
    /encoder could not start/i,
  );
  assert.doesNotMatch(
    voiceRecorderStartError(new Error("AudioWorklet failed"), "encoder"),
    /permission is required/i,
  );
});

test("uses a safe generic message for unknown permission failures", () => {
  assert.equal(
    voiceRecorderStartError("unexpected failure", "permission"),
    "Microphone could not be started. Check browser and macOS microphone permissions, then try again.",
  );
});

test("prefers native WebM Opus for Chromium voice recordings", () => {
  const supported = new Set(["audio/webm;codecs=opus", "audio/webm"]);
  assert.deepEqual(
    selectVoiceRecordingFormat((mimeType) => supported.has(mimeType)),
    {
      recorderMimeType: "audio/webm;codecs=opus",
      fileMimeType: "audio/webm",
      extension: "webm",
    },
  );
});

test("falls back to browser-supported OGG or MP4 formats", () => {
  assert.equal(
    selectVoiceRecordingFormat((mimeType) => mimeType === "audio/ogg;codecs=opus")?.extension,
    "ogg",
  );
  assert.equal(
    selectVoiceRecordingFormat((mimeType) => mimeType === "audio/mp4")?.extension,
    "m4a",
  );
  assert.equal(selectVoiceRecordingFormat(() => false), null);
});
