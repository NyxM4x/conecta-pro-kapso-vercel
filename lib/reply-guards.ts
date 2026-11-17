// GUARDAS DE SALIDA: lo último que se revisa antes de que el texto llegue al cliente.
// Funciones PURAS, probadas en reply-guards.test.mts.

// Marcadores internos del sistema, tal como se guardan en kapso_messages. Nunca deben salir al
// cliente ni se tocan aquí: si llegaran a un texto es otro bug, pero no es éste.
const INTERNAL_MARKER = /^\[[A-Z][A-Z0-9_]*(?::[A-Za-z0-9_]+)?\]/;

// Un texto entre corchetes que escribió el modelo como si fuera un adjunto: "[QR de Pago]",
// "[imagen]", "[Nombre]". El cliente lo veía literal (28 oct 2026: "Aquí tienes el QR 👇 [QR de
// Pago]" sin ningún QR). Solo se quita lo que está entre corchetes: los puntos suspensivos, los
// paréntesis, los emojis y los links NO se tocan.
const BRACKET_PLACEHOLDER = /\[[^\[\]\n]{1,60}\]/g;

function stripPlaceholderBrackets(text: string): string {
  if (!text || !text.includes("[")) return text;

  const cleaned = text
    .replace(BRACKET_PLACEHOLDER, (match) => (INTERNAL_MARKER.test(match) ? match : ""))
    // Limpia el hueco que deja: espacios dobles y espacios antes de salto de línea.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned;
}

// "¡Gracias por el comprobante!" solo tiene sentido si en ESTE turno llegó un comprobante (o el
// cliente dijo con todas las letras que pagó). El 13 nov 2026 un cliente que escribió "Buenas
// tardes quería saber más información" la recibió.
function isReceiptThanksReply(text: string): boolean {
  return /GRACIAS POR EL COMPROBANTE/.test(
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toUpperCase(),
  );
}

function shouldBlockReceiptThanks(params: {
  reply: string;
  receiptThisTurn: boolean;
  explicitPaymentPhrase: boolean;
  receiptMedia: boolean;
}): boolean {
  if (!isReceiptThanksReply(params.reply)) return false;
  return !(params.receiptThisTurn || params.explicitPaymentPhrase || params.receiptMedia);
}

export { stripPlaceholderBrackets, isReceiptThanksReply, shouldBlockReceiptThanks };
