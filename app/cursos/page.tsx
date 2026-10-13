// Página de cursos que se abre en el navegador interno de WhatsApp, con la misma portada
// que /paquetes. El bot puede mandar el link directo a un curso:
//   /cursos#capcut-pro
// Las fechas, los precios y la ubicación salen de lib/courses.ts, y la ficha de cada curso
// de lib/course-details.ts: no repetirlos acá.

import type { Metadata } from "next";
import { COURSES, getCourseStatus, type Course } from "../../lib/courses";
import { COURSE_DETAILS, getCourseSchedule } from "../../lib/course-details";
import { CoursesView, type CourseCard } from "./CoursesView";
import "../paquetes/paquetes.css";
import "./cursos.css";

export const metadata: Metadata = {
  title: "Cursos | Conecta Pro",
  description: "Cursos presenciales de Conecta Pro en Santa Cruz de la Sierra: creación de contenido y edición en CapCut.",
};

// La fecha de un curso se apaga sola con la hora, así que la página se arma en cada visita
// y no una sola vez al desplegar.
export const dynamic = "force-dynamic";

export default function CursosPage() {
  const now = new Date();
  const hasDate = (course: Course) => getCourseStatus(course, now) !== "finished";

  // Primero los cursos con fecha, del más próximo al más lejano; después los que esperan fecha.
  const ordered = [
    ...COURSES.filter(hasDate).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
    ...COURSES.filter((course) => !hasDate(course)),
  ];

  // Número del WhatsApp de Conecta Pro. Sin la variable, los botones de WhatsApp no aparecen.
  const businessWhatsapp = (process.env.CONECTA_PRO_WHATSAPP ?? "").replace(/\D/g, "");
  const whatsappLink = (text: string) =>
    businessWhatsapp ? `https://wa.me/${businessWhatsapp}?text=${encodeURIComponent(text)}` : "";

  const courses: CourseCard[] = ordered.map((course) => {
    const schedule = getCourseSchedule(course, now);

    return {
      slug: course.id.replace(/_/g, "-"),
      name: course.name,
      details: COURSE_DETAILS[course.id] ?? null,
      schedule,
      // Con el curso por empezar o en marcha no hay nada que pedir por chat: se paga en la puerta.
      whatsappUrl:
        schedule.state === "on_sale"
          ? whatsappLink(`Hola, quiero reservar mi cupo para el ${course.name}`)
          : schedule.state === "no_date"
            ? whatsappLink(`Hola, quiero saber cuándo es la próxima fecha del ${course.name}`)
            : "",
    };
  });

  return <CoursesView courses={courses} />;
}
