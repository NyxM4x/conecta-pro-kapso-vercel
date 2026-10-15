// Catálogo de cursos con fecha, precios y expiración automática.
//
// Antes las fechas vivían escritas a mano dentro del system prompt, así que un curso
// ya dictado se seguía anunciando como próximo hasta que alguien editaba el prompt.
// Aquí son datos, y cada curso pasa solo por tres estados según la hora actual:
//
//   1. PRÓXIMO  (hasta la hora de inicio): se anuncia, se informa y se vende. La preventa
//      se cobra con QR hasta PRESALE_CLOSES_MINUTES_BEFORE_START antes de empezar —
//      incluido el día del curso—; pasado ese corte el QR ya no sale y solo se puede
//      pagar el precio en puerta, en la puerta (ver isPresaleClosed).
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

// Cuánto ANTES de la hora de inicio cierra la preventa con QR. Antes el corte era la
// medianoche del día del curso: quien escribía a las 10 de la mañana del domingo ya no
// podía pagar con QR aunque faltaran seis horas, y se perdían inscripciones de un día
// que es justo el de más movimiento. Ahora el QR sigue saliendo hasta 10 minutos antes
// (con cursos a las 16:00, hasta las 15:50); pasado ese minuto el bot deja de mandarlo
// y avisa al equipo por Telegram para que lo pasen a mano o le cobren en la puerta.
const PRESALE_CLOSES_MINUTES_BEFORE_START = 10;

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
  // Se cobra con QR hasta la víspera del curso.
  pricePreventa: number;
  // Precio en puerta: el día del curso, pagando en la puerta (sin QR).
  pricePresencial: number;
  // Ausente = el curso es en la ubicación habitual (MAPS_CURSOS).
  locationOverride?: CourseLocationOverride;
  // Cómo lo nombran los clientes (sin tildes, en mayúsculas). Sirve para saber a qué curso
  // corresponde un pago cuando hay más de una fecha a la venta (ver detectMentionedCourses).
  aliases: string[];
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
    aliases: ["CREACION DE CONTENIDO", "CREACION", "CONTENIDO"],
  },
  {
    id: "capcut_pro",
    name: "Curso de Edición Persuasiva en CapCut Pro",
    startsAt: "2026-09-20T16:00:00-04:00",
    pricePreventa: 450,
    pricePresencial: 550,
    aliases: ["CAPCUT", "CAP CUT", "EDICION", "EDITAR", "PERSUASIVA"],
  },
];

const startTime = (course: Course) => new Date(course.startsAt).getTime();
const infoEndTime = (course: Course) =>
  startTime(course) + COURSE_INFO_MINUTES_AFTER_START * 60_000;
// Instante exacto en que deja de salir el QR.
const presaleEndTime = (course: Course) =>
  startTime(course) - PRESALE_CLOSES_MINUTES_BEFORE_START * 60_000;

function getCourseStatus(course: Course, now: Date): CourseStatus {
  const t = now.getTime();
  if (t < startTime(course)) return "upcoming";
  if (t < infoEndTime(course)) return "in_progress";
  return "finished";
}

const byStart = (a: Course, b: Course) => startTime(a) - startTime(b);

// "2026-09-20" en hora de Bolivia, para comparar días de calendario sin depender de la zona
// horaria del servidor (Vercel corre en UTC: a las 21:00 del sábado en Bolivia ya es domingo).
const boliviaDateKey = (date: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: BOLIVIA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

// ¿Hoy (en Bolivia) es el día del curso? Sirve para redactar ("HOY, a las 4:00 PM"), NO
// para decidir si todavía se cobra: eso lo dice isPresaleClosed, porque el día del curso
// la preventa sigue abierta hasta 10 minutos antes de empezar.
function isCourseDay(course: Course, now: Date): boolean {
  return boliviaDateKey(now) === boliviaDateKey(new Date(course.startsAt));
}

// ¿Ya cerró la preventa con QR de este curso? A partir de este momento el bot no manda
// más el QR: quien quiera sumarse paga en la puerta, o el equipo le pasa el QR a mano
// (el webhook avisa por Telegram, ver notifyPresaleClosedQrToTelegram).
function isPresaleClosed(course: Course, now: Date): boolean {
  return now.getTime() >= presaleEndTime(course);
}

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

// Cursos que todavía no empiezan pero cuya preventa ya cerró (los últimos 10 minutos
// antes de la hora de inicio): se anuncian, pero solo se cobran en la puerta.
function getDoorSaleCourses(now: Date): Course[] {
  return getActiveCourses(now).filter((course) => isPresaleClosed(course, now));
}

// ¿Hay algún curso que se pueda cobrar con QR ahora? Lo usa el webhook para no mandar el
// QR de pago cuando lo único vigente es un curso que ya empezó o al que le faltan menos
// de PRESALE_CLOSES_MINUTES_BEFORE_START minutos (ahí solo se paga en la puerta).
function hasSellableCourse(now: Date): boolean {
  return getActiveCourses(now).some((course) => !isPresaleClosed(course, now));
}

// ¿Hay algún curso con fecha cargada (próximo o dictándose ahora)? Es el mismo criterio de
// la página /cursos. Sin ninguno, el bot no manda el botón de cursos: responde que no hay
// fechas confirmadas (ver renderNoCourseDatesText en lib/site-links.ts).
function hasCourseWithDate(now: Date): boolean {
  return COURSES.some((course) => getCourseStatus(course, now) !== "finished");
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
  return `${formatBoliviaDay(date)}, ${formatBoliviaTime(date)}`;
}

// Cierre de la preventa: el mismo día del curso, 10 minutos antes de empezar ("domingo
// 20 de septiembre a las 3:50 PM"). Antes era la víspera y se decía solo el día; ahora
// lleva la hora, porque el corte cae dentro del día del curso y sin la hora el cliente
// no sabe hasta cuándo le sirve el QR.
function formatPresaleDeadline(course: Course): string {
  const deadline = new Date(presaleEndTime(course));
  return `${formatBoliviaDay(deadline)} a las ${formatBoliviaTime(deadline)}`;
}

function formatBoliviaDay(date: Date): string {
  return new Intl.DateTimeFormat("es-BO", {
    timeZone: BOLIVIA_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
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
      const dayLabel = isCourseDay(course, now)
        ? `HOY, ${formatCourseDate(course.startsAt)}`
        : formatCourseDate(course.startsAt);

      lines.push(
        isPresaleClosed(course, now)
          ? `  • ${course.name} — ${dayLabel}. La preventa YA CERRÓ (cerró hace minutos, ${formatPresaleDeadline(course)}, porque el curso está por empezar): NO envíes el QR (intents.payment_qr = false), NO ofrezcas preventa y NO des el precio de preventa. Quien todavía quiera sumarse puede pagar ${course.pricePresencial} Bs EN LA PUERTA del curso: díselo y dale la ubicación. Muchos que escriben hoy YA pagaron: si dice que ya pagó, no le cobres de nuevo, solo confírmale la hora y la ubicación.`
          : `  • ${course.name} — ${dayLabel}. Precios: ${course.pricePreventa} Bs preventa (pagando con QR hasta el ${formatPresaleDeadline(course)}, o sea hasta 10 minutos antes de que empiece — el día del curso TAMBIÉN se puede pagar con QR mientras falte más de eso) / ${course.pricePresencial} Bs en puerta (pagando en la puerta el día del curso).`,
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

// Respuesta fija del día del curso (antes de que empiece) para cuando el modelo igual quiso
// mandar el QR u ofrecer la preventa. Se arma aquí porque lleva el precio en puerta y la
// ubicación del curso. null si hoy no hay ningún curso por empezar.
function renderCourseDayDoorReply(now: Date): string | null {
  const [course] = getDoorSaleCourses(now);
  if (!course) return null;

  return [
    `¡Hoy es el ${course.name}! 🎉 Empieza a las ${formatBoliviaTime(new Date(course.startsAt))}. La preventa ya cerró, pero todavía puedes sumarte pagando ${course.pricePresencial} Bs en la puerta 😊`,
    "",
    "📍 Ubicación:",
    getCourseLocation(course, now).mapsUrl,
    "",
    "Si ya pagaste tu cupo, no tienes que pagar nada más: te esperamos 🙌",
  ].join("\n");
}

// "20/09": fecha corta para las alertas y los botones de Telegram.
function formatCourseShortDate(iso: string): string {
  const [, month, day] = boliviaDateKey(new Date(iso)).split("-");
  return `${day}/${month}`;
}

const normalizeText = (text: string) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();

const WEEKDAYS = "LUNES|MARTES|MIERCOLES|JUEVES|VIERNES|SABADO|DOMINGO";

// ¿De cuáles de estos cursos habla el texto? Por su nombre ("el de CapCut", "creación de
// contenido") o por su día ("el del 20", "el domingo 20"). Un número suelto no cuenta: puede
// ser un monto o un celular. Devuelve todos los que nombra; el que llama decide qué hacer si
// son varios.
function detectMentionedCourses(text: string, options: Course[]): Course[] {
  const normalized = normalizeText(text);
  if (!normalized.trim()) return [];

  return options.filter((course) => {
    const byName = course.aliases.some((alias) =>
      new RegExp(`\\b${alias.replace(/\s+/g, "\\s+")}\\b`).test(normalized),
    );
    if (byName) return true;

    const day = String(Number(boliviaDateKey(new Date(course.startsAt)).slice(-2)));
    return new RegExp(`\\b(DEL|EL|DIA|${WEEKDAYS})\\s+0?${day}\\b`).test(normalized);
  });
}

export {
  COURSES,
  COURSE_INFO_MINUTES_AFTER_START,
  PRESALE_CLOSES_MINUTES_BEFORE_START,
  detectMentionedCourses,
  formatCourseShortDate,
  getCourseStatus,
  getActiveCourses,
  getInProgressCourses,
  getExpiredCourses,
  getDoorSaleCourses,
  getCourseLocation,
  isCourseDay,
  isPresaleClosed,
  hasSellableCourse,
  hasCourseWithDate,
  hasActiveLocationOverride,
  formatCourseDate,
  formatNowInBolivia,
  renderCourseContext,
  renderCourseDayDoorReply,
};
export type { Course, CourseLocationOverride, CourseStatus };
