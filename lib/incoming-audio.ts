type IncomingAudioMessage = {
  type?: unknown;
  audio?: unknown;
  voice?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function getMediaLink(media: unknown): string | null {
  if (typeof media !== "object" || media === null || !("link" in media)) {
    return null;
  }

  return isNonEmptyString(media.link) ? media.link.trim() : null;
}

export function isIncomingAudioMessage(
  message: IncomingAudioMessage | null | undefined,
): boolean {
  if (!message) return false;

  return (
    message.type === "audio" ||
    message.type === "voice" ||
    Boolean(message.audio) ||
    Boolean(message.voice)
  );
}

export function getIncomingAudioMediaUrl(
  message: IncomingAudioMessage | null | undefined,
): string | null {
  if (!message) return null;

  return getMediaLink(message.audio) ?? getMediaLink(message.voice);
}
