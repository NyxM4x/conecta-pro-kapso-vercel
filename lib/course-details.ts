// Ficha de cada curso para la página /cursos: qué se aprende, la modalidad y qué traer.
// Dice lo mismo que el bot afirma por chat (bloque "LÍNEA A — Cursos" del SYSTEM_PROMPT en
// app/api/webhooks/kapso/route.ts). Si cambia allá, cambiarlo también acá, y no agregar
// certificados, materiales, cupos ni temas que no estén confirmados.
//
// Las fechas, los precios y la ubicación NO van acá: salen de lib/courses.ts, igual que
// para el bot, y se apagan solos cuando el curso pasa (ver getCourseSchedule).

import {
  formatCourseDate,
  getCourseLocation,
  getCourseStatus,
  isCourseDay,
  isPresaleClosed,
} from "./courses.ts";
import type { Course } from "./courses.ts";

type CourseDetails = {
  // Frase corta para la tarjeta.
  tagline: string;
  // Datos cortos (modalidad, duración). Solo los confirmados.
  facts: { value: string; label: string }[];
  topics: string[];
  bonus?: string[];
  bring?: string;
  outcome?: string;
};

// La clave es el `id` del curso en lib/courses.ts. Un curso sin ficha igual aparece en la
// página, solo con su nombre y su fecha.
const COURSE_DETAILS: Record<string, CourseDetails> = {
  creacion_contenido: {
    tagline: "Aprende a crear videos profesionales que atraigan clientes y generen ventas en tus redes.",
    facts: [
      { value: "Presencial", label: "Modalidad" },
      { value: "4 a 5 horas", label: "Duración" },
    ],
    topics: [
      "Estrategias de contenido para generar ventas",
      "Cómo grabar videos profesionales con tu celular",
      "Cómo crear guiones persuasivos y virales",
      "Cómo publicar correctamente en TikTok",
      "Cómo diferenciarte de tu competencia y atraer clientes",
    ],
  },
  capcut_pro: {
    tagline: "Aprende a editar videos profesionales y persuasivos, con prácticas personalizadas paso a paso.",
    facts: [
      { value: "Presencial", label: "Modalidad" },
      { value: "4 a 5 horas", label: "Duración" },
    ],
    topics: [
      "Edición de videos desde cero",
      "Edición profesional y persuasiva",
      "Efectos, transiciones y subtítulos dinámicos",
      "Herramientas para mejorar tus videos",
      "Prácticas personalizadas paso a paso",
    ],
  },
};

// Qué puede mostrar la página de la fecha de un curso en este momento. Sigue los mismos
// estados que usa el bot, para que la página nunca anuncie algo que el chat ya no vende.
type CourseSchedule =
  // Con fecha y preventa abierta: fecha, los dos precios y la ubicación.
  | {
      state: "on_sale";
      date: string;
      isToday: boolean;
      pricePreventa: number;
      pricePresencial: number;
      mapsUrl: string;
    }
  // Faltan minutos para empezar: ya no hay QR, solo el precio en puerta.
  | { state: "door_only"; date: string; pricePresencial: number; mapsUrl: string }
  // Se está dictando ahora: no se vende, pero se muestra dónde es.
  | { state: "in_progress"; date: string; mapsUrl: string }
  // Ya se dictó y todavía no hay fecha nueva: sin fecha, sin precio y sin ubicación.
  | { state: "no_date" };

// Función PURA: el instante entra por parámetro, igual que en lib/courses.ts.
function getCourseSchedule(course: Course, now: Date): CourseSchedule {
  const status = getCourseStatus(course, now);
  if (status === "finished") return { state: "no_date" };

  const date = formatCourseDate(course.startsAt);
  const { mapsUrl } = getCourseLocation(course, now);

  if (status === "in_progress") return { state: "in_progress", date, mapsUrl };

  if (isPresaleClosed(course, now)) {
    return { state: "door_only", date, pricePresencial: course.pricePresencial, mapsUrl };
  }

  return {
    state: "on_sale",
    date,
    isToday: isCourseDay(course, now),
    pricePreventa: course.pricePreventa,
    pricePresencial: course.pricePresencial,
    mapsUrl,
  };
}

export { COURSE_DETAILS, getCourseSchedule };
export type { CourseDetails, CourseSchedule };
