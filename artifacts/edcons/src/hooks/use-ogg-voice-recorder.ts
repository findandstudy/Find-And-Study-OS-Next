import { useCallback, useEffect, useRef, useState } from "react";
import { voiceRecorderStartError } from "./voice-recorder-errors";
import {
  selectVoiceRecordingFormat,
  type VoiceRecordingFormat,
} from "./voice-recorder-format";

const MAX_RECORDING_SECONDS = 5 * 60;
const MICROPHONE_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export interface OggVoiceRecorder {
  isRecording: boolean;
  seconds: number;
  isSupported: boolean;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
}

export function useOggVoiceRecorder(
  onRecorded: (file: File) => void,
  onError: (message: string) => void,
): OggVoiceRecorder {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const startedAtRef = useRef(0);
  const onRecordedRef = useRef(onRecorded);
  const onErrorRef = useRef(onError);
  const [isRecording, setIsRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    onRecordedRef.current = onRecorded;
  }, [onRecorded]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseMicrophone = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
  }, []);

  const finish = useCallback(() => {
    clearTimer();
    setIsRecording(false);
    setSeconds(0);
    recorderRef.current = null;
    chunksRef.current = [];
    releaseMicrophone();
  }, [clearTimer, releaseMicrophone]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    clearTimer();
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      finish();
      onErrorRef.current("Voice recording could not be finalized.");
    }
  }, [clearTimer, finish]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    stop();
  }, [stop]);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    if (
      typeof MediaRecorder === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      onErrorRef.current("Voice recording is not supported by this browser.");
      return;
    }

    cancelledRef.current = false;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: MICROPHONE_CONSTRAINTS,
      });
      streamRef.current = stream;
    } catch (error) {
      releaseMicrophone();
      onErrorRef.current(voiceRecorderStartError(error, "permission"));
      return;
    }

    const format = selectVoiceRecordingFormat((mimeType) =>
      MediaRecorder.isTypeSupported(mimeType)
    );
    if (!format) {
      releaseMicrophone();
      onErrorRef.current("Voice recording is not supported by this browser.");
      return;
    }

    try {
      const recorder = new MediaRecorder(stream, {
        mimeType: format.recorderMimeType,
        audioBitsPerSecond: 24_000,
      });
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        finish();
        onErrorRef.current("Voice recording could not be finalized.");
      };
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        if (!cancelledRef.current && chunks.length > 0) {
          onRecordedRef.current(buildVoiceNoteFile(chunks, format));
        }
        finish();
      };

      recorder.start(1_000);
      startedAtRef.current = Date.now();
      setSeconds(0);
      setIsRecording(true);
      timerRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
        setSeconds(elapsed);
        if (elapsed >= MAX_RECORDING_SECONDS) stop();
      }, 250);
    } catch (error) {
      finish();
      onErrorRef.current(voiceRecorderStartError(error, "encoder"));
    }
  }, [finish, releaseMicrophone, stop]);

  useEffect(
    () => () => {
      cancelledRef.current = true;
      clearTimer();
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          // Best-effort cleanup during unmount.
        }
      }
      releaseMicrophone();
    },
    [clearTimer, releaseMicrophone],
  );

  return {
    isRecording,
    seconds,
    isSupported:
      typeof window !== "undefined" &&
      typeof MediaRecorder !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia,
    start,
    stop,
    cancel,
  };
}

function buildVoiceNoteFile(
  chunks: Blob[],
  format: VoiceRecordingFormat,
): File {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new File(
    chunks,
    `voice-note-${timestamp}.${format.extension}`,
    { type: format.fileMimeType },
  );
}
