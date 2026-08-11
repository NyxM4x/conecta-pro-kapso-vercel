// Promociones temporales con vigencia propia, en el mismo espíritu que lib/courses.ts:
// una promo deja de anunciarse SOLA cuando pasa su ventana, sin cron y sin que nadie
// tenga que acordarse de apagar un flag.
//
// Por qué existe este archivo aparte del registro en kapso_media_assets:
//   - La IMAGEN vive en la base (kapso_media_assets, con starts_at/expires_at).
//   - El TEXTO y la VENTANA viven aquí, porque el modelo necesita el copy en el prompt
//     y el backend necesita poder apagar el intent aunque la fila de la base quede mal
//     configurada (o al revés). Son dos candados independientes sobre la misma fecha.
//
// PARA ACTUALIZAR: edita SOLO la lista PROMOS. Al vencer una promo se puede borrar de
// la lista o dejarla: pasada su ventana el sistema la ignora igual.

const BOLIVIA_TZ = "America/La_Paz";

// Intents de material promocional. Debe coincidir con MediaIntent en el webhook y con
// la columna `intent` de kapso_media_assets.
type PromoIntent = "service_packages_promo";

type Promo = {
  id: string;
  // Intent con el que está registrada la imagen en kapso_media_assets.
  intent: PromoIntent;
  name: string;
  // ISO con offset de Bolivia (UTC-4, sin horario de verano).
  startsAt: string;
  // Instante EXCLUSIVO en que deja de estar vigente. Para una promo válida "los días
  // 6 y 7", esto es el 8 a las 00:00 hora de Bolivia.
  endsAt: string;
  // Precio promocional en Bs. Se usa además para desambiguar la promo del live
  // (ver getActivePromoAmounts).
  price: number;
  // Cantidad de videos de la promo. Es una cantidad que NO está en el catálogo normal
  // (6/12/18), así que mientras la promo está vigente el backend tiene que reconocerla
  // como "esta promo" y no como un pedido fuera de catálogo.
  videoCount: number;
  // Línea de negocio a la que pertenece: define con qué otros materiales es excluyente.
  line: "service_packages";
  // Copy que se inyecta al prompt. Una línea por viñeta.
  details: string[];
};

const PROMOS: Promo[] = [
  {
    id: "promo_bolivia_2026_08",
    intent: "service_packages_promo",
    name: "Promo por Bolivia — Paquete Exprés: 4 videos por 1.000 Bs",
    startsAt: "2026-08-06T00:00:00-04:00",
    endsAt: "2026-08-08T00:00:00-04:00",
    price: 1000,
    videoCount: 4,
    line: "service_packages",
    details: [
      "Paquete Exprés promocional: 4 videos por 1.000 Bs (precio total, no mensual).",
      "Incluye estrategia, guiones, grabación profesional, edición y publicación.",
      "Los 4 videos se graban en un solo día.",
      "Válida ÚNICAMENTE los días jueves 6 y viernes 7 de agosto de 2026 (hora de Bolivia).",
    ],
  },
];

// ¿La promo está dentro de su ventana en este instante? La comparación es entre
// instantes absolutos (los ISO llevan offset -04:00), así que no depende de la zona
// horaria del servidor: en Vercel corre en UTC y da el mismo resultado.
function isPromoActive(promo: Promo, now: Date): boolean {
  const time = now.getTime();
  return (
    time >= new Date(promo.startsAt).getTime() && time < new Date(promo.endsAt).getTime()
  );
}

function getActivePromos(now: Date): Promo[] {
  return PROMOS.filter((promo) => isPromoActive(promo, now));
}

// ¿Hay alguna promo vigente registrada bajo este intent? Es el candado del lado del
// código: aunque la fila de kapso_media_assets siga con is_active = true, el intent no
// se envía fuera de la ventana.
function isPromoIntentActive(intent: PromoIntent, now: Date): boolean {
  return getActivePromos(now).some((promo) => promo.intent === intent);
}

// Montos de las promos vigentes. Los usa el webhook para no confundir "promo 1000"
// (esta promoción de videos) con la PROMO DEL LIVE, que usa la misma palabra clave
// seguida del precio del CURSO anunciado en la transmisión.
function getActivePromoAmounts(now: Date): number[] {
  return getActivePromos(now).map((promo) => promo.price);
}

// Cantidades de video de las promos vigentes ("4 videos"). Mientras la promo está
// vigente esa cantidad identifica a la promo, no un pedido fuera de catálogo.
function getActivePromoVideoCounts(now: Date): number[] {
  return getActivePromos(now).map((promo) => promo.videoCount);
}

// "jueves 6 de agosto" en hora de Bolivia, para el copy del contexto.
function formatPromoDay(iso: string): string {
  return new Intl.DateTimeFormat("es-BO", {
    timeZone: BOLIVIA_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(iso));
}

// Bloque que se inyecta en el contexto del prompt en CADA mensaje. Es la única fuente
// de verdad sobre promociones: el prompt estático no nombra ninguna, así que cuando la
// ventana pasa el modelo deja de tener con qué inventarla.
function renderPromoContext(now: Date): string {
  const active = getActivePromos(now);

  if (active.length === 0) {
    return [
      "PROMOCIONES TEMPORALES: NINGUNA vigente en este momento.",
      '- Si el cliente pregunta por promociones, ofertas o descuentos, dile con naturalidad que por ahora no hay una promoción activa y ofrécele los paquetes normales (FLUJO B). NUNCA inventes una promo, un precio promocional ni una fecha de promoción.',
      "- NO marques intents.service_packages_promo: no hay material promocional que enviar.",
    ].join("\n");
  }

  const lines = [
    "PROMOCIONES TEMPORALES VIGENTES (fuente de verdad; si una promo no aparece aquí, NO existe):",
  ];

  for (const promo of active) {
    lines.push(
      `- ${promo.name} — vigente desde el ${formatPromoDay(promo.startsAt)} hasta el final del día ${formatPromoDay(
        new Date(new Date(promo.endsAt).getTime() - 1).toISOString(),
      )} (hora de Bolivia).`,
      ...promo.details.map((detail) => `  • ${detail}`),
    );
  }

  lines.push(
    "- Esta promo pertenece a la LÍNEA B (paquetes de producción). Cuando el cliente pregunte por promociones, ofertas o descuentos, o mencione los 4 videos / los 1.000 Bs, o pida esta promo: responde con sus datos concretos (sí puedes decir el precio y qué incluye, están arriba) y marca intents.service_packages_promo = true.",
    "- En ese turno marca intents.service_packages = false: la promo y el flyer normal de paquetes NUNCA salen juntos, se enviaría material contradictorio (4 videos por 1.000 Bs vs. 6/12/18 videos mensuales).",
    "- Si el cliente pregunta por los paquetes NORMALES sin mencionar promoción, sigue el FLUJO B de siempre (intents.service_packages = true) y, si viene al caso, menciona en UNA línea que hay una promo vigente por si le interesa. NO marques los dos intents a la vez.",
    "- La promo NO reemplaza a los paquetes de 6, 12 y 18 videos: es una oferta temporal adicional.",
    `- EXCEPCIÓN al flujo "CANTIDAD SINGULAR / INDEFINIDA / NO ESTÁNDAR": mientras esta promo esté vigente, pedir ${active
      .map((promo) => promo.videoCount)
      .join(" o ")} videos NO es una cantidad fuera de catálogo — es exactamente esta promo. En ese caso NO respondas que solo existen paquetes de 6, 12 o 18, NO marques advisor_handoff con "out_of_catalog" y NO ofrezcas cotización a medida: ofrécele la promo y marca intents.service_packages_promo = true.`,
    "- NUNCA prometas la promo para después de su última fecha de vigencia ni la extiendas.",
  );

  return lines.join("\n");
}

export {
  PROMOS,
  getActivePromos,
  getActivePromoAmounts,
  getActivePromoVideoCounts,
  isPromoActive,
  isPromoIntentActive,
  renderPromoContext,
};
export type { Promo, PromoIntent };
