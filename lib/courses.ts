// Catálogo de cursos con fecha, precios y expiración automática.
//
// Antes las fechas vivían escritas a mano dentro del system prompt, así que un curso
// ya dictado se seguía anunciando como próximo hasta que alguien editaba el prompt.
// Aquí son datos: un curso deja de anunciarse solo cuando faltan menos de
// COURSE_CLOSES_MINUTES_BEFORE minutos para su hora de inicio.
//
// PARA ACTUALIZAR: edita SOLO la lista COURSES de abajo. Cuando un curso reciba nueva
// fecha, cambia su `startsAt` y vuelve a estar vigente automáticamente.
//
// La UBICACIÓN sigue la misma lógica: es un dato del curso, no una regla del prompt.
// Por defecto todos los cursos son en MAPS_CURSOS; una fecha puntual puede dictarse en
// otro lado vía `locationOverride`, que se vence solo (ver getCourseLocation).

import { MAPS_CURSOS, MAPS_OFICINA } from "./locations.ts";

const BOLIVIA_TZ = "America/La_Paz";

// Un curso se cierra 30 minutos antes de empezar: pasado ese punto ya no se anuncia
// ni se vende, porque el cliente no llegaría a tiempo.
const COURSE_CLOSES_MINUTES_BEFORE = 30;

// Ubicación EXCEPCIONAL para una fecha puntual de un curso. Existe para no tener que
// escribir la excepción dentro del prompt, donde sobreviviría al evento y obligaría al
// modelo a razonar sobre fechas.
type CourseLocationOverride = {
  mapsUrl: string;
  // Se ignora pasada esta fecha, AUNQUE el curso reciba un `startsAt` nuevo. Es el
  // segundo candado: la excepción muere por su cuenta, no solo junto con la fecha.
  until: string;
  // Qué debe comunicarle el bot al cliente sobre el cambio de lugar.
  note: string;
};

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

const COURSES: Course[] = [
  {
    id: "creacion_contenido",
    name: "Curso de Creación de Contenido",
    startsAt: "2026-08-02T16:00:00-04:00",
    pricePreventa: 350,
    pricePresencial: 450,
  },
  {
    id: "capcut_pro",
    name: "Curso de Edición en CapCut Pro",
    startsAt: "2026-08-16T16:00:00-04:00",
    pricePreventa: 450,
    pricePresencial: 550,
    // ⚠️ EXCEPCIÓN SOLO PARA LA FECHA DEL 16/08/2026: esta vez el curso se dicta en la
    // oficina. NO es lo habitual y NO hay que copiar este bloque a la próxima fecha de
    // CapCut. Se desactiva solo al llegar `until`, así que olvidarse de borrarlo no
    // rompe nada.
    locationOverride: {
      mapsUrl: MAPS_OFICINA,
      until: "2026-08-16T16:00:00-04:00",
      note: "SOLO POR ESTA FECHA el curso se dicta en las oficinas de Conecta Pro (es una excepción, no es lo habitual). Avísale al cliente que para esta fecha el lugar cambió, para que no vaya al lugar de siempre.",
    },
  },
];

// Única fuente de la ubicación de un curso. Devuelve `note` solo cuando la excepción
// está vigente; el resto del sistema usa esa presencia para saber que el lugar cambió.
function getCourseLocation(course: Course, now: Date): { mapsUrl: string; note?: string } {
  const override = course.locationOverride;

  if (override && new Date(override.until).getTime() > now.getTime()) {
    return { mapsUrl: override.mapsUrl, note: override.note };
  }

  return { mapsUrl: MAPS_CURSOS };
}

// ¿Algún curso vigente se dicta ahora mismo en una ubicación excepcional? La usa el
// webhook para no enviar el video de "cómo llegar", que muestra la ubicación habitual.
function hasActiveLocationOverride(now: Date): boolean {
  return getActiveCourses(now).some((course) => getCourseLocation(course, now).note !== undefined);
}

function getCourseCloseTime(course: Course): number {
  return new Date(course.startsAt).getTime() - COURSE_CLOSES_MINUTES_BEFORE * 60_000;
}

// Cursos que todavía se pueden anunciar y vender, ordenados del más próximo al más lejano.
function getActiveCourses(now: Date): Course[] {
  return COURSES.filter((course) => getCourseCloseTime(course) > now.getTime()).sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
}

// Cursos cuya fecha ya pasó (o está por empezar): existen en el catálogo pero no
// tienen fecha vigente. Sirven para responder "ese curso ya se dictó".
function getExpiredCourses(now: Date): Course[] {
  return COURSES.filter((course) => getCourseCloseTime(course) <= now.getTime());
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

  const time = new Intl.DateTimeFormat("es-BO", {
    timeZone: BOLIVIA_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(date)
    .replace(/\s*a\.?\s*m\.?/i, " AM")
    .replace(/\s*p\.?\s*m\.?/i, " PM")
    .trim();

  return `${day}, ${time}`;
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

// Bloque que se inyecta en el contexto del prompt en CADA mensaje. Es la única fuente
// de fechas y precios de cursos: el prompt estático ya no los contiene, para que el
// modelo no pueda recitar de memoria una fecha vencida.
function renderCourseContext(now: Date): string {
  const active = getActiveCourses(now);
  const expired = getExpiredCourses(now);

  const lines = [
    "CURSOS — FECHAS Y PRECIOS VIGENTES (fuente de verdad, reemplaza cualquier fecha que creas recordar):",
    `- Fecha y hora actual en Bolivia: ${formatNowInBolivia(now)}.`,
  ];

  if (active.length > 0) {
    lines.push("- Cursos CON FECHA VIGENTE (los ÚNICOS que puedes anunciar, ofrecer y cobrar):");

    for (const course of active) {
      const location = getCourseLocation(course, now);

      lines.push(
        `  • ${course.name} — ${formatCourseDate(course.startsAt)}. Precios: ${course.pricePreventa} Bs preventa (pagando antes del día del curso) / ${course.pricePresencial} Bs presencial (pagando el mismo día).`,
        `    Ubicación de ESTE curso (link tal cual, texto plano, es la fuente de verdad): ${location.mapsUrl}`,
      );

      if (location.note) {
        lines.push(
          `    ⚠️ ${location.note}`,
          "    ⚠️ NO marques intents.location_video para este curso: el video de cómo llegar muestra la ubicación habitual y contradiría este link.",
        );
      }
    }
  } else {
    lines.push(
      "- NINGÚN curso tiene fecha vigente en este momento. Si preguntan por cursos, di que aún no hay una fecha oficial confirmada y que pueden seguirnos en redes como ConectaPro o @marketero7, donde anunciamos las nuevas fechas apenas salen. NUNCA inventes una fecha ni prometas uno próximo con fecha concreta.",
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
  COURSE_CLOSES_MINUTES_BEFORE,
  getActiveCourses,
  getExpiredCourses,
  getCourseLocation,
  hasActiveLocationOverride,
  formatCourseDate,
  formatNowInBolivia,
  renderCourseContext,
};
export type { Course, CourseLocationOverride };
