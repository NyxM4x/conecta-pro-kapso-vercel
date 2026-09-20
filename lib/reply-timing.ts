// CUÁNDO RESPONDER Y CUÁNDO CALLARSE — el ahorro de mensajes de WhatsApp.
//
// Desde octubre de 2026 Meta cobra por mensaje, así que cada respuesta de más cuesta dinero.
// Dos reglas, las dos medidas sobre los chats reales de agosto y septiembre de 2026:
//
// 1. ESPERA (REPLY_WAIT_SECONDS, 120 s por defecto). El bot no contesta al primer mensaje:
//    espera a que el cliente termine de escribir. La cuenta va desde el ÚLTIMO mensaje del
//    cliente, no desde que arranca la función, así que si el cliente sigue escribiendo el
//    turno viejo se descarta y el nuevo vuelve a esperar. Con 120 s, el 48 % de las
//    respuestas del último mes se habrían agrupado con la siguiente.
//
// 2. NO REPETIR. El caso típico del gasto: el bot contestaba a los 13 s, el cliente —que
//    seguía escribiendo— mandaba otro mensaje 2 s después y el bot repetía el mismo bloque
//    (94 veces en un mes). Si el texto a enviar es el mismo que ya se mandó hace poco, no se
//    manda nada: el cliente lo tiene ahí arriba en el chat.

const REPLY_WAIT_SECONDS = Number(process.env.REPLY_WAIT_SECONDS ?? 120);

// Vercel corta la función a los `maxDuration` segundos; la espera vive dentro de ese
// presupuesto junto con la generación y el envío, así que se acota por las dudas.
const MAX_REPLY_WAIT_SECONDS = 150;

const REPLY_WAIT_MS =
  Math.min(Math.max(Number.isFinite(REPLY_WAIT_SECONDS) ? REPLY_WAIT_SECONDS : 120, 0), MAX_REPLY_WAIT_SECONDS) * 1000;

// Ventana en la que un texto idéntico se considera una repetición. Corta a propósito: si el
// cliente vuelve a preguntar lo mismo media hora después, merece su respuesta otra vez.
const DUPLICATE_REPLY_WINDOW_MS = 10 * 60 * 1000;

// Solo se callan los BLOQUES largos (paquetes, formulario, saludo con el menú), que son los
// que se repetían. Un "¡Con gusto! 😊" repetido cuesta lo mismo, pero callárselo deja al
// cliente sin respuesta a una pregunta nueva, y eso es peor que gastar el mensaje.
const DUPLICATE_MIN_LENGTH = 60;

// ¿Vale la pena callarse este texto por repetido?
function canSkipAsDuplicate(replyText: string): boolean {
  return replyText.replace(/\s+/g, " ").trim().length >= DUPLICATE_MIN_LENGTH;
}

// Cuánto falta esperar para este mensaje. Se descuenta lo que ya pasó desde que el cliente lo
// mandó (la cola de Kapso, los reintentos y el trabajo previo de la función ya consumieron
// parte de la ventana).
function computeReplyWaitMs(params: {
  lastMessageAt: string | null;
  now: Date;
  waitMs?: number;
}): number {
  const waitMs = params.waitMs ?? REPLY_WAIT_MS;
  if (!params.lastMessageAt) return waitMs;

  const sentAt = new Date(params.lastMessageAt).getTime();
  if (!Number.isFinite(sentAt)) return waitMs;

  const elapsed = params.now.getTime() - sentAt;
  // Un reloj adelantado del proveedor (elapsed negativo) no puede alargar la espera.
  if (elapsed < 0) return waitMs;

  return Math.max(0, waitMs - elapsed);
}

// Dos respuestas son "la misma" si dicen exactamente lo mismo: se ignoran los espacios, los
// saltos de línea y las mayúsculas. No se usa parecido difuso a propósito — cambiar una frase
// ya es una respuesta distinta y merece enviarse.
function isSameReply(a: string, b: string): boolean {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const left = normalize(a);
  return left.length > 0 && left === normalize(b);
}

export {
  DUPLICATE_MIN_LENGTH,
  DUPLICATE_REPLY_WINDOW_MS,
  MAX_REPLY_WAIT_SECONDS,
  REPLY_WAIT_MS,
  canSkipAsDuplicate,
  computeReplyWaitMs,
  isSameReply,
};
