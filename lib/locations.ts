// Ubicaciones: DOS lugares DISTINTOS, nunca intercambiables.
//
// Viven aquí (y no dentro del prompt) para que no puedan cruzarse por un copy/paste:
//   MAPS_CURSOS  -> donde se dictan los cursos presenciales (LÍNEA A), por defecto.
//   MAPS_OFICINA -> oficina de Conecta Pro (visitas, citas con asesor).
//
// La ubicación de un curso NO se decide aquí ni en el prompt: cada curso resuelve la
// suya en lib/courses.ts (getCourseLocation), porque una fecha puntual puede dictarse
// excepcionalmente en otro lado. El prompt solo copia el link que le llega en el
// contexto de cursos vigentes.

const MAPS_CURSOS = "https://maps.app.goo.gl/Qk6XXohdNf735gKAA";
const MAPS_OFICINA = "https://maps.app.goo.gl/dw7oXDDSYygE7WFW9";

export { MAPS_CURSOS, MAPS_OFICINA };
