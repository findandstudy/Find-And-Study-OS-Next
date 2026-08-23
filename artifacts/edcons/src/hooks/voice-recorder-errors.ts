export type VoiceRecorderStartStage = "permission" | "encoder";

function errorText(error: unknown): { name: string; message: string } {
  if (!error || typeof error !== "object") {
    return { name: "", message: String(error ?? "") };
  }

  const candidate = error as { name?: unknown; message?: unknown };
  return {
    name: typeof candidate.name === "string" ? candidate.name : "",
    message: typeof candidate.message === "string" ? candidate.message : "",
  };
}

export function voiceRecorderStartError(
  error: unknown,
  stage: VoiceRecorderStartStage,
): string {
  const details = errorText(error);
  const signature = `${details.name} ${details.message}`.toLowerCase();

  if (
    signature.includes("notallowederror") ||
    signature.includes("permissiondeniederror") ||
    signature.includes("permission denied") ||
    signature.includes("permission dismissed")
  ) {
    return "Microphone access is blocked. Allow microphone access for this browser/Codex and apply.findandstudy.com, then try again.";
  }

  if (
    signature.includes("notfounderror") ||
    signature.includes("devicesnotfounderror") ||
    signature.includes("requested device not found")
  ) {
    return "No microphone was found. Connect or enable a microphone, then try again.";
  }

  if (
    signature.includes("notreadableerror") ||
    signature.includes("trackstarterror") ||
    signature.includes("could not start audio source")
  ) {
    return "The microphone is unavailable or in use by another app. Close other recording apps, then try again.";
  }

  if (signature.includes("securityerror") || signature.includes("insecure")) {
    return "Microphone access is blocked by browser security. Open the secure apply.findandstudy.com page and allow microphone access.";
  }

  if (signature.includes("aborterror")) {
    return "Microphone startup was interrupted. Please try again.";
  }

  if (stage === "encoder") {
    return "The microphone is available, but the voice-message encoder could not start. Refresh the page or try again in Chrome.";
  }

  return "Microphone could not be started. Check browser and macOS microphone permissions, then try again.";
}
