// ¿CUÁNTO PAGÓ Y POR QUÉ OPCIÓN? Función PURA (el instante entra por parámetro).
//
// El QR del banco es de monto libre: el cliente escribe cuánto paga. Para saber si pagó UN curso
// (300 Bs) o el COMBO de los dos (500 Bs) se cruzan dos señales:
//
//   1. El monto que la visión leyó en el comprobante (la más fiable).
//   2. El botón de pago que tocó en la página /cursos ("combo" o el id de un curso).
//
// El resultado viaja en la alerta de Telegram: un renglón corto con ✅ si coinciden, ⚠️ si no, y
// 🔎 si el monto no se pudo leer.
//
// Un comprobante puede pagar a VARIAS personas (20 nov 2026: "de dos", 1000 Bs = dos combos):
// un múltiplo exacto del combo o de un curso se lee como esa cantidad de cupos.

import { COURSES, getActiveBundle } from "./courses.ts";

// Opción elegida en la página: "combo" o el id de un curso (lib/courses.ts).
type WebChoice = string;

type AmountVerdict = {
  status: "ok" | "warn" | "unread";
  // Texto corto para la alerta, sin HTML.
  text: string;
  // true = pagó el combo, false = pagó un curso, null = no se sabe.
  bundle: boolean | null;
  // Cuántas personas paga el comprobante (2 = "1000 Bs = 2 combos"). null = no se sabe.
  seats: number | null;
};

type PaymentEvidence = {
  amount: number | null;
  bank: string | null;
  operation: string | null;
  webChoice: WebChoice | null;
  verdict: AmountVerdict;
};

const MAX_REASONABLE_AMOUNT = 100_000;
// Un grupo más grande que esto en un solo comprobante no es un pago de cursos.
const MAX_SEATS_PER_RECEIPT = 10;

// Cuántas veces entra `unit` exacto en `amount` (2 o más), o null.
function exactMultiple(amount: number, unit: number | null): number | null {
  if (!unit || amount % unit !== 0) return null;
  const times = amount / unit;
  return times >= 2 && times <= MAX_SEATS_PER_RECEIPT ? times : null;
}

// Un monto leído por un modelo de visión: solo números positivos y razonables.
function sanitizeAmount(value: unknown): number | null {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_REASONABLE_AMOUNT) return null;
  return Math.round(amount * 100) / 100;
}

function cleanText(value: unknown, max: number): string | null {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return text ? text.slice(0, max) : null;
}

function choiceLabel(choice: WebChoice | null): string | null {
  if (!choice) return null;
  if (choice === "combo") return "el combo";
  const course = COURSES.find((candidate) => candidate.id === choice);
  return course ? `un curso (${course.name.replace(/^Curso de\s+/i, "")})` : null;
}

function judgePaymentAmount(params: {
  amount: number | null;
  webChoice: WebChoice | null;
  now: Date;
}): AmountVerdict {
  const { amount, webChoice, now } = params;
  const bundle = getActiveBundle(now);
  const bundlePrice = bundle?.price ?? null;
  const singlePrices = new Set(COURSES.map((course) => course.pricePreventa));
  const doorPrices = new Set(COURSES.map((course) => course.pricePresencial));
  const chose = choiceLabel(webChoice);
  const choseBundle = webChoice === "combo";
  const choseSingle = webChoice !== null && webChoice !== "combo" && chose !== null;

  if (amount === null) {
    return {
      status: "unread",
      text: chose
        ? `🔎 Monto no leído — en la web eligió ${chose}. Revisar el comprobante`
        : "🔎 Monto no leído — revisar el comprobante",
      bundle: choseBundle ? true : choseSingle ? false : null,
      seats: null,
    };
  }

  if (bundlePrice !== null && amount === bundlePrice) {
    return choseSingle
      ? { status: "warn", text: `⚠️ ${amount} Bs (combo) pero en la web eligió ${chose}`, bundle: true, seats: 1 }
      : { status: "ok", text: `✅ ${amount} Bs = combo, los dos cursos`, bundle: true, seats: 1 };
  }

  if (singlePrices.has(amount)) {
    return choseBundle
      ? { status: "warn", text: `⚠️ ${amount} Bs (un curso) pero en la web eligió el combo`, bundle: false, seats: 1 }
      : { status: "ok", text: `✅ ${amount} Bs = un curso`, bundle: false, seats: 1 };
  }

  // Sin combo vigente, el precio en puerta (500 Bs) es de UN curso.
  if (doorPrices.has(amount)) {
    return { status: "ok", text: `✅ ${amount} Bs = un curso (precio en puerta)`, bundle: false, seats: 1 };
  }

  // Varias personas en un comprobante. Si el monto encaja en los dos (1500 = 3 combos o 5
  // cursos) no se adivina: lo decide el equipo con el chat.
  const bundleTimes = exactMultiple(amount, bundlePrice);
  const singleTimes = [...singlePrices].map((price) => exactMultiple(amount, price)).find(Boolean) ?? null;

  if (bundleTimes && singleTimes) {
    return {
      status: "warn",
      text: `⚠️ ${amount} Bs: ${bundleTimes} combos o ${singleTimes} cursos sueltos — revisar el chat`,
      bundle: null,
      seats: null,
    };
  }

  if (bundleTimes) {
    return choseSingle
      ? { status: "warn", text: `⚠️ ${amount} Bs (${bundleTimes} combos) pero en la web eligió ${chose}`, bundle: true, seats: bundleTimes }
      : { status: "ok", text: `✅ ${amount} Bs = ${bundleTimes} combos (${bundleTimes} personas, los dos cursos)`, bundle: true, seats: bundleTimes };
  }

  if (singleTimes) {
    return choseBundle
      ? { status: "warn", text: `⚠️ ${amount} Bs (${singleTimes} cursos) pero en la web eligió el combo`, bundle: false, seats: singleTimes }
      : { status: "ok", text: `✅ ${amount} Bs = ${singleTimes} cupos de un curso`, bundle: false, seats: singleTimes };
  }

  const expected = bundlePrice !== null ? "300 ni 500" : "los precios vigentes";
  return { status: "warn", text: `⚠️ ${amount} Bs no coincide con ${expected}`, bundle: null, seats: null };
}

function buildPaymentEvidence(params: {
  amount: unknown;
  bank: unknown;
  operation: unknown;
  webChoice: WebChoice | null;
  now: Date;
}): PaymentEvidence {
  const amount = sanitizeAmount(params.amount);
  return {
    amount,
    bank: cleanText(params.bank, 40),
    operation: cleanText(params.operation, 40),
    webChoice: params.webChoice,
    verdict: judgePaymentAmount({ amount, webChoice: params.webChoice, now: params.now }),
  };
}

export { buildPaymentEvidence, choiceLabel, judgePaymentAmount, sanitizeAmount };
export type { AmountVerdict, PaymentEvidence, WebChoice };
