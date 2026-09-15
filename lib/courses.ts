// Catálogo de cursos con fecha, precios y expiración automática.
//
// Antes las fechas vivían escritas a mano dentro del system prompt, así que un curso
// ya dictado se seguía anunciando como próximo hasta que alguien editaba el prompt.
// Aquí son datos, y cada curso pasa solo por tres estados según la hora actual:
//
//   1. PRÓXIMO  (hasta la hora de inicio): se anuncia, se informa y se vende.
//   2. EN CURSO (desde el inicio hasta COURSE_INFO_MINUTES_AFTER_START después): ya NO
//      se vende, pero se sigue dando su información — ubicación, que es hoy, horario.
//      Existe por un caso real: el día del curso, alumnos que YA habían pagado
//      preguntaban dónde era y el bot les contestaba que "no hay fecha", porque el curso
//      se apagaba antes de empezar.
//   3. TERMINADO: pasa a "ya se dictó" y deja de exponer fecha, precio y ubicación.
//
// PARA ACTUALIZAR: edita SOLO la lista COURSES de abajo. Cuando un curso reciba nueva
// fecha, cambia su `startsAt` y vuelve a estar vigente automáticamente.
//
// La UBICACIÓN sigue la misma lógica: es un dato del curso, no una regla del prompt.
// Por defecto todos los cursos son en MAPS_CURSOS; una fecha puntual puede dictarse en
// otro lado vía `locationOverride`, que se vence solo (ver getCourseLocation).

import { MAPS_CURSOS } from "./locations.ts";

const BOLIVIA_TZ = "America/La_Paz";

// Cuánto tiempo después de la hora de inicio se sigue informando un curso. Con cursos a
// las 16:00, 90 minutos cubren hasta las 17:30: quien llega tarde o recién lee el día del
// curso todavía recibe la ubicación.
const COURSE_INFO_MINUTES_AFTER_START = 90;

// Ubicación EXCEPCIONAL para una fecha puntual de un curso. Existe para no tener que
// escribir la excepción dentro del prompt, donde sobreviviría al evento y obligaría al
// modelo a razonar sobre fechas.
type CourseLocationOverride = {
  mapsUrl: string;
  // Hora de inicio de la fecha excepcional. La excepción sigue vigente durante la
  // ventana EN CURSO (hasta COURSE_INFO_MINUTES_AFTER_START después) y muere sola,
  // AUNQUE el curso reciba un `startsAt` nuevo: es el segundo candado.
  until: string;
  // Qué debe comunicarle el bot al cliente sobre el cambio de lugar.
  note: string;
};

// PLANTILLA (no hay ninguna excepción vigente ahora mismo). Si una fecha puntual se
// dicta en la oficina, pega este bloque DENTRO de ese curso y pon en `until` la misma
// fecha/hora de inicio del curso; así la excepción muere sola con el evento y la
// próxima fecha vuelve a la ubicación habitual aunque nadie borre el bloque:
//
//   locationOverride: {
//     mapsUrl: MAPS_OFICINA,                 // importar MAPS_OFICINA de ./locations.ts
//     until: "2026-09-13T16:00:00-04:00",    // = startsAt de ESA fecha
//     note: "SOLO POR ESTA FECHA el curso se dicta en las oficinas de Conecta Pro (es una excepción, no es lo habitual). Avísale al cliente que para esta fecha el lugar cambió, para que no vaya al lugar de siempre.",
//   },

type Course = {
  id: string;
  name: string;
  // ISO con offset de Bolivia (UTC-4, sin horario de verano).
  startsAt: string;
  pricePreventa: number;
  pricePresencial: number;
  // Ausente = el curso es en la ubicación habitual (MAPS_CURSOS).
  locationOverride?: CourseLocationOverride;
};

type CourseStatus = "upcoming" | "in_progress" | "finished";

const COURSES: Course[] = [
  {
    id: "creacion_contenido",
    name: "Curso de Creación de Contenido",
    startsAt: "2026-09-13T16:00:00-04:00",
    // Preventa en oferta por septiembre 2026: 300 Bs en vez de los 350 habituales.
    // La oferta vence con esta fecha (el curso deja de anunciarse solo), así que la
    // próxima fecha que se cargue debe volver a 350 salvo que se decida lo contrario.
    pricePreventa: 300,
    pricePresencial: 450,
  },
  {
    id: "capcut_pro",
    name: "Curso de Edición en CapCut Pro",
    startsAt: "2026-08-16T16:00:00-04:00",
    pricePreventa: 450,
    pricePresencial: 550,
  },
];

const startTime = (course: Course) => new Date(course.startsAt).getTime();
const infoEndTime = (course: Course) =>
  startTime(course) + COURSE_INFO_MINUTES_AFTER_START * 60_000;

function getCourseStatus(course: Course, now: Date): CourseStatus {
  const t = now.getTime();
  if (t < startTime(course)) return "upcoming";
  if (t < infoEndTime(course)) return "in_progress";
  return "finished";
}

const byStart = (a: Course, b: Course) => startTime(a) - startTime(b);

// Única fuente de la ubicación de un curso. Devuelve `note` solo cuando la excepción
// está vigente; el resto del sistema usa esa presencia para saber que el lugar cambió.
function getCourseLocation(course: Course, now: Date): { mapsUrl: string; note?: string } {
  const override = course.locationOverride;

  if (override) {
    const overrideEnds =
      new Date(override.until).getTime() + COURSE_INFO_MINUTES_AFTER_START * 60_000;

    if (overrideEnds > now.getTime()) {
      return { mapsUrl: override.mapsUrl, note: override.note };
    }
  }

  return { mapsUrl: MAPS_CURSOS };
}

// Cursos que todavía se pueden anunciar y VENDER (aún no empezaron), del más próximo al
// más lejano.
function getActiveCourses(now: Date): Course[] {
  return COURSES.filter((course) => getCourseStatus(course, now) === "upcoming").sort(byStart);
}

// Cursos que se están dictando ahora mismo: se informan, pero no se venden.
function getInProgressCourses(now: Date): Course[] {
  return COURSES.filter((course) => getCourseStatus(course, now) === "in_progress").sort(byStart);
}

// Cursos que ya terminaron: existen en el catálogo pero no tienen fecha vigente. Sirven
// para responder "ese curso ya se dictó".
function getExpiredCourses(now: Date): Course[] {
  return COURSES.filter((course) => getCourseStatus(course, now) === "finished");
}

// ¿Hay algún curso que se pueda cobrar ahora? Lo usa el webhook para no mandar el QR de
// pago cuando lo único vigente es un curso que ya empezó.
function hasSellableCourse(now: Date): boolean {
  return getActiveCourses(now).length > 0;
}

// ¿Algún curso que todavía se informa (próximo o en curso) se dicta en una ubicación
// excepcional? La usa el webhook para no enviar el video de "cómo llegar", que muestra la
// ubicación habitual.
function hasActiveLocationOverride(now: Date): boolean {
  return [...getActiveCourses(now), ...getInProgressCourses(now)].some(
    (course) => getCourseLocation(course, now).note !== undefined,
  );
}

// "domingo 9 de agosto, 4:00 PM" en hora de Bolivia. Intl devuelve "4:00 p. m." en
// es-BO, así que se normaliza al formato que ya usaban los mensajes del bot.
function formatCourseDate(iso: string): string {
  const date = new Date(iso);

  const day = new Intl.DateTimeFormat("es-BO", {
    timeZone: BOLIVIA_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);

  return `${day}, ${formatBoliviaTime(date)}`;
}

function formatBoliviaTime(date: Date): string {
  return new Intl.DateTimeFormat("es-BO", {
    timeZone: BOLIVIA_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(date)
    .replace(/\s*a\.?\s*m\.?/i, " AM")
    .replace(/\s*p\.?\s*m\.?/i, " PM")
    .trim();
}

function formatNowInBolivia(now: Date): string {
  const formatted = new Intl.DateTimeFormat("es-BO", {
    timeZone: BOLIVIA_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(now)
    .replace(/\s*a\.?\s*m\.?/i, " AM")
    .replace(/\s*p\.?\s*m\.?/i, " PM")
    .trim();

  return formatted;
}

// Líneas de ubicación de un curso, comunes a los cursos próximos y a los en curso.
function renderLocationLines(course: Course, now: Date): string[] {
  const location = getCourseLocation(course, now);
  const lines = [
    `    Ubicación de ESTE curso (link tal cual, texto plano, es la fuente de verdad): ${location.mapsUrl}`,
  ];

  if (location.note) {
    lines.push(
      `    ⚠️ ${location.note}`,
      "    ⚠️ NO marques intents.location_video para este curso: el video de cómo llegar muestra la ubicación habitual y contradiría este link.",
    );
  }

  return lines;
}

// Bloque que se inyecta en el contexto del prompt en CADA mensaje. Es la única fuente
// de fechas y precios de cursos: el prompt estático ya no los contiene, para que el
// modelo no pueda recitar de memoria una fecha vencida.
function renderCourseContext(now: Date): string {
  const active = getActiveCourses(now);
  const inProgress = getInProgressCourses(now);
  const expired = getExpiredCourses(now);

  const lines = [
    "CURSOS — FECHAS Y PRECIOS VIGENTES (fuente de verdad, reemplaza cualquier fecha que creas recordar):",
    `- Fecha y hora actual en Bolivia: ${formatNowInBolivia(now)}.`,
  ];

  if (inProgress.length > 0) {
    lines.push(
      "- Cursos que SE ESTÁN DICTANDO AHORA MISMO (hoy). Ya NO se venden: NO envíes el QR (intents.payment_qr = false), NO ofrezcas preventa, NO des precios y NO invites a inscribirse. Pero SÍ das toda su información a quien la pida — muchos son alumnos que YA pagaron y recién preguntan el mismo día. Si preguntan por el curso, di que se está llevando a cabo ahora mismo (empezó a la hora indicada) y responde lo que necesiten: la ubicación (marca intents.location_video = true salvo aviso contrario abajo), que es hoy y el horario. Si alguien que aún no pagó quiere inscribirse, dile con amabilidad que este curso ya está en marcha y que puede seguirnos en TikTok como @marketero7 para enterarse de la próxima fecha. NUNCA digas que la fecha ya pasó ni que no hay fecha para este curso:",
    );

    for (const course of inProgress) {
      lines.push(
        `  • ${course.name} — HOY, empezó a las ${formatBoliviaTime(new Date(course.startsAt))} (${formatCourseDate(course.startsAt)}).`,
        ...renderLocationLines(course, now),
      );
    }
  }

  if (active.length > 0) {
    lines.push("- Cursos CON FECHA VIGENTE (los ÚNICOS que puedes anunciar, ofrecer y cobrar):");

    for (const course of active) {
      lines.push(
        `  • ${course.name} — ${formatCourseDate(course.startsAt)}. Precios: ${course.pricePreventa} Bs preventa (pagando antes del día del curso) / ${course.pricePresencial} Bs presencial (pagando el mismo día).`,
        ...renderLocationLines(course, now),
      );
    }
  } else if (inProgress.length === 0) {
    lines.push(
      "- NINGÚN curso tiene fecha vigente en este momento. Si preguntan por cursos, di que aún no hay una fecha oficial confirmada y que pueden seguirnos en redes como ConectaPro o @marketero7, donde anunciamos las nuevas fechas apenas salen. NUNCA inventes una fecha ni prometas uno próximo con fecha concreta.",
    );
  } else {
    lines.push(
      "- Fuera del curso que se está dictando hoy, NINGÚN otro curso tiene fecha vigente: no hay nada que vender. Para próximas fechas, que nos sigan en TikTok como @marketero7. NUNCA inventes una fecha.",
    );
  }

  if (expired.length > 0) {
    lines.push(
      "- Cursos SIN fecha vigente (ya se dictaron, todavía no hay nueva fecha). NO los anuncies, NO des su fecha ni su precio, y si el cliente pregunta por uno di que esa fecha ya pasó:",
      ...expired.map((course) => `  • ${course.name}`),
    );
  }

  lines.push(
    "- Un curso que no aparezca como vigente arriba NO se puede vender ni agendar, aunque el cliente insista.",
  );

  return lines.join("\n");
}

export {
  COURSES,
  COURSE_INFO_MINUTES_AFTER_START,
  getCourseStatus,
  getActiveCourses,
  getInProgressCourses,
  getExpiredCourses,
  getCourseLocation,
  hasSellableCourse,
  hasActiveLocationOverride,
  formatCourseDate,
  formatNowInBolivia,
  renderCourseContext,
};
export type { Course, CourseLocationOverride, CourseStatus };
