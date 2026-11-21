// RÓTULOS DE LOS MENSAJES QUE NO SON TEXTO NI ARCHIVO: ubicación, sticker, video y contacto.
//
// Antes todo lo que no era texto, imagen ni documento caía en "🎙️ Audio recibido" (el texto de
// Kapso sin transcripción). Entre el 17 y el 21 nov 2026 llegaron así 3 ubicaciones, 4 stickers
// y 1 video, y a una clienta que mandó la ubicación de su salón el bot le contestó "No pude
// escuchar el audio". Con el rótulo correcto el modelo sabe qué recibió (y la ubicación llega
// con su link de Maps para el equipo).
//
// Función pura: el webhook le pasa el mensaje de WhatsApp tal como llega.

type IncomingMessageLike = {
  type?: string | null;
  location?: { latitude?: unknown; longitude?: unknown; name?: unknown; address?: unknown } | null;
  sticker?: unknown;
  video?: { caption?: unknown } | null;
  contacts?: { name?: { formatted_name?: unknown }; phones?: { phone?: unknown }[] }[] | null;
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function labelNonTextMessage(message: IncomingMessageLike | null | undefined): string | null {
  if (!message) return null;
  const type = message.type ?? null;

  if (type === "location" || message.location) {
    const { latitude, longitude, name, address } = message.location ?? {};
    const lat = Number(latitude);
    const lng = Number(longitude);
    const maps =
      latitude !== undefined && longitude !== undefined && Number.isFinite(lat) && Number.isFinite(lng)
        ? `https://maps.google.com/?q=${lat},${lng}`
        : null;
    return ["📍 Ubicación enviada", text(name), text(address), maps].filter(Boolean).join(" — ");
  }

  if (type === "sticker" || message.sticker) return "😊 Sticker";

  if (type === "video" || message.video) {
    const caption = text(message.video?.caption);
    return caption ? `🎥 Video recibido: ${caption}` : "🎥 Video recibido";
  }

  if (type === "contacts" || (Array.isArray(message.contacts) && message.contacts.length > 0)) {
    const contact = message.contacts?.[0];
    const name = text(contact?.name?.formatted_name);
    const phone = text(contact?.phones?.[0]?.phone);
    return ["👤 Contacto compartido", name, phone].filter(Boolean).join(" — ");
  }

  return null;
}

export { labelNonTextMessage };
export type { IncomingMessageLike };
