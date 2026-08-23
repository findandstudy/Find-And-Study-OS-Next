export interface VoiceRecordingFormat {
  recorderMimeType: string;
  fileMimeType: string;
  extension: string;
}

const VOICE_RECORDING_FORMATS: readonly VoiceRecordingFormat[] = [
  {
    recorderMimeType: "audio/webm;codecs=opus",
    fileMimeType: "audio/webm",
    extension: "webm",
  },
  {
    recorderMimeType: "audio/ogg;codecs=opus",
    fileMimeType: "audio/ogg",
    extension: "ogg",
  },
  {
    recorderMimeType: "audio/webm",
    fileMimeType: "audio/webm",
    extension: "webm",
  },
  {
    recorderMimeType: "audio/mp4",
    fileMimeType: "audio/mp4",
    extension: "m4a",
  },
];

export function selectVoiceRecordingFormat(
  isTypeSupported: (mimeType: string) => boolean,
): VoiceRecordingFormat | null {
  return VOICE_RECORDING_FORMATS.find((format) =>
    isTypeSupported(format.recorderMimeType)
  ) ?? null;
}
