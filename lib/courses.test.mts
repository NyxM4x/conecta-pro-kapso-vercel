// Pruebas del catálogo de cursos: CADUCIDAD de la fecha y UBICACIÓN.
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Lo que se protege aquí:
//   1. Un curso se apaga SOLO al pasar su fecha: deja de anunciarse y pasa a "sin fecha
//      vigente", sin que nadie edite nada. Es la regla de oro de la operación.
//   2. El día del curso, desde la hora de inicio y durante 90 minutos, el curso ya no se
//      vende pero SÍ se informa (caso real: alumnos que ya pagaron preguntaban la
//      ubicación y el bot les decía que no había fecha).
//   3. Los cursos y la oficina son lugares distintos, y una fecha puntual puede dictarse
//      excepcionalmente en la oficina sin que esa excepción sobreviva al evento.
//   4. La preventa se cobra con QR hasta la víspera. El día del curso (desde las 00:00 en
//      Bolivia) el curso se sigue anunciando, pero sin QR: solo se paga en la puerta.
//
// La excepción de ubicación se prueba con un curso SINTÉTICO, no con uno del catálogo
// real: así el catálogo puede quedar limpio (sin excepciones vigentes) y el mecanismo
// sigue cubierto para el día que haga falta usarlo.
//
// Correr también con TZ=UTC y TZ=America/La_Paz (Vercel corre en UTC).

import assert from "node:assert/strict";
import {
  getActiveCourses,
  getInProgressCourses,
  getExpiredCourses,
  getDoorSaleCourses,
  getCourseLocation,
  hasSellableCourse,
  isPresaleClosed,
  hasActiveLocationOverride,
  renderCourseContext,
  renderCourseDayDoorReply,
  COURSES,
} from "./courses.ts";
import type { Course } from "./courses.ts";
import { MAPS_CURSOS, MAPS_OFICINA } from "./locations.ts";

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (error) {
    failures.push(`${name}\n    ${(error as Error).message.split("\n")[0]}`);
  }
}

const at = (iso: string) => new Date(iso);

// --- 1. La fecha se apaga sola --------------------------------------------
//
// Se prueba sobre cada curso REAL del catálogo, con su propia fecha: así la garantía
// vale para las fechas que estén cargadas hoy, sean cuales sean.

for (const course of COURSES) {
  const inicio = new Date(course.startsAt).getTime();
  const vispera = new Date(inicio - 24 * 60 * 60_000);
  const minutoAntes = new Date(inicio - 60_000);
  // El corte de la preventa: 15:50 para un curso a las 16:00.
  const cierrePreventa = new Date(inicio - 10 * 60_000);
  const justoAntesDelCierre = new Date(cierrePreventa.getTime() - 60_000); // 15:49
  const mananaDelDia = new Date(inicio - 6 * 60 * 60_000); // 10:00 del día del curso
  const recienEmpezado = new Date(inicio + 10 * 60_000);
  const casiTermina = new Date(inicio + 89 * 60_000); // 17:29 para un curso a las 16:00
  const terminoVentana = new Date(inicio + 90 * 60_000); // 17:30
  const diaSiguiente = new Date(inicio + 24 * 60 * 60_000);
  // 00:00 del día del curso en Bolivia (startsAt ya viene con offset -04:00).
  const medianocheDelDia = new Date(`${course.startsAt.slice(0, 10)}T00:00:00-04:00`);
  const finDeLaVispera = new Date(medianocheDelDia.getTime() - 60_000); // 23:59 de la víspera

  const lineaDelCurso = (momento: Date) =>
    renderCourseContext(momento).split("\n").find((line) => line.includes(course.name)) ?? "";

  test(`${course.name}: la víspera está vigente y se puede vender`, () => {
    assert.ok(getActiveCourses(vispera).includes(course));
    assert.ok(renderCourseContext(vispera).includes(course.name));
  });

  test(`${course.name}: la preventa se cobra con QR hasta el último minuto de la víspera`, () => {
    // 23:59 del sábado en Bolivia ya es domingo en UTC: el día se cuenta en hora de Bolivia.
    assert.ok(!getDoorSaleCourses(finDeLaVispera).includes(course), "todavía no cerró la preventa");
    assert.ok(lineaDelCurso(finDeLaVispera).includes(`${course.pricePreventa} Bs preventa`));
  });

  test(`${course.name}: el día del curso el QR sigue saliendo hasta 10 minutos antes`, () => {
    // El caso que motivó el cambio: escribe a las 10:00 del domingo y quiere pagar con QR.
    for (const momento of [medianocheDelDia, mananaDelDia, justoAntesDelCierre]) {
      assert.ok(!isPresaleClosed(course, momento), "la preventa sigue abierta");
      assert.ok(!getDoorSaleCourses(momento).includes(course), "todavía no es solo-puerta");

      const linea = lineaDelCurso(momento);
      assert.ok(linea.includes(`${course.pricePreventa} Bs preventa`), "debe ofrecer la preventa");
    }
  });

  test(`${course.name}: se sigue anunciando hasta la hora de inicio`, () => {
    assert.ok(getActiveCourses(minutoAntes).includes(course));
  });

  test(`${course.name}: pasado el corte de 10 minutos no hay QR, solo se paga en la puerta`, () => {
    for (const momento of [cierrePreventa, minutoAntes]) {
      assert.ok(isPresaleClosed(course, momento), "la preventa debe estar cerrada");
      assert.ok(getActiveCourses(momento).includes(course), "debe seguir anunciándose");
      assert.ok(getDoorSaleCourses(momento).includes(course), "debe cobrarse en la puerta");

      const linea = lineaDelCurso(momento);
      assert.ok(linea.includes("HOY"), "debe decir que es hoy");
      assert.ok(linea.includes(`${course.pricePresencial} Bs EN LA PUERTA`), "debe dar el precio en puerta");
      assert.ok(!linea.includes(`${course.pricePreventa} Bs`), "no debe ofrecer la preventa");

      const reply = renderCourseDayDoorReply(momento) ?? "";
      assert.ok(reply.includes(`${course.pricePresencial} Bs en la puerta`), "la respuesta fija lleva el precio en puerta");
      assert.ok(reply.includes(getCourseLocation(course, momento).mapsUrl), "la respuesta fija lleva la ubicación");
    }
  });

  test(`${course.name}: ya empezado, se informa pero no se vende`, () => {
    for (const momento of [recienEmpezado, casiTermina]) {
      assert.ok(!getActiveCourses(momento).includes(course), "no debe venderse");
      assert.ok(getInProgressCourses(momento).includes(course), "debe seguir informándose");
      assert.ok(!getExpiredCourses(momento).includes(course), "no debe decir que ya pasó");

      // Solo la sección "en curso": termina donde empieza la siguiente sección del bloque.
      const context = renderCourseContext(momento);
      const start = context.indexOf("SE ESTÁN DICTANDO AHORA MISMO");
      const nextSection = context.slice(start).search(/\n- (Cursos CON FECHA|Cursos SIN fecha|Fuera del curso|Un curso que)/);
      const enCurso = context.slice(start, start + nextSection);
      assert.ok(enCurso.includes(course.name), "debe listarse como en curso");
      assert.ok(enCurso.includes("maps.app.goo.gl"), "debe llevar la ubicación");
      assert.ok(!enCurso.includes(`${course.pricePreventa} Bs`), "no debe llevar precio");
      assert.ok(!context.includes("NINGÚN curso tiene fecha vigente"), "no debe decir que no hay fecha");
    }
  });

  test(`${course.name}: se apaga solo al terminar la ventana, sin tocar el código`, () => {
    for (const momento of [terminoVentana, diaSiguiente]) {
      assert.ok(!getActiveCourses(momento).includes(course), "no debe seguir vigente");
      assert.ok(!getInProgressCourses(momento).includes(course), "no debe seguir en curso");
      assert.ok(getExpiredCourses(momento).includes(course), "debe pasar a sin fecha");
    }
  });

  test(`${course.name}: pasada su fecha, el contexto no expone fecha ni precio`, () => {
    const context = renderCourseContext(diaSiguiente);
    const vencidos = context.slice(context.indexOf("Cursos SIN fecha vigente"));

    assert.ok(vencidos.includes(course.name), "debe listarse como sin fecha vigente");
    assert.ok(!vencidos.includes(`${course.pricePreventa} Bs`), "no debe quedar el precio");
    assert.ok(!vencidos.includes("maps.app.goo.gl"), "no debe quedar la ubicación");
  });
}

test("con un único curso por delante, el QR sale hasta 10 minutos antes de empezar", () => {
  const ultimo = Math.max(...COURSES.map((c) => new Date(c.startsAt).getTime()));
  assert.equal(hasSellableCourse(new Date(ultimo - 24 * 60 * 60_000)), true, "la víspera");
  assert.equal(hasSellableCourse(new Date(ultimo - 60 * 60_000)), true, "una hora antes, el mismo día");
  assert.equal(hasSellableCourse(new Date(ultimo - 11 * 60_000)), true, "11 minutos antes");
  assert.equal(hasSellableCourse(new Date(ultimo - 10 * 60_000)), false, "justo en el corte");
  assert.equal(hasSellableCourse(new Date(ultimo - 60_000)), false, "un minuto antes");
  assert.equal(hasSellableCourse(new Date(ultimo + 30 * 60_000)), false, "ya empezado");
  assert.equal(renderCourseDayDoorReply(new Date(ultimo + 30 * 60_000)), null, "ya empezado no se cobra ni en la puerta");
});

test("sin ninguna fecha cargada, el bot dice que no hay fecha confirmada", () => {
  // El caso que más se da: el cliente pregunta después de que pasaron todas las fechas.
  const ultimo = Math.max(...COURSES.map((c) => new Date(c.startsAt).getTime()));
  const context = renderCourseContext(new Date(ultimo + 24 * 60 * 60_000));

  assert.ok(context.includes("NINGÚN curso tiene fecha vigente"));
  assert.ok(context.includes("NUNCA inventes una fecha"));
  assert.ok(!context.includes("Cursos CON FECHA VIGENTE"));
});

// --- 2. La ubicación excepcional (mecanismo, con curso sintético) ----------

const CURSO_EN_OFICINA: Course = {
  id: "curso_de_prueba",
  name: "Curso de Prueba",
  startsAt: "2026-08-16T16:00:00-04:00",
  pricePreventa: 450,
  pricePresencial: 550,
  aliases: ["PRUEBA"],
  locationOverride: {
    mapsUrl: MAPS_OFICINA,
    until: "2026-08-16T16:00:00-04:00",
    note: "SOLO POR ESTA FECHA el curso se dicta en las oficinas de Conecta Pro.",
  },
};

const ANTES = at("2026-08-15T10:00:00-04:00"); // víspera: excepción vigente
const DESPUES = at("2026-08-17T10:00:00-04:00"); // día siguiente: ya venció

test("la víspera, la ubicación del curso excepcional es la oficina", () => {
  const location = getCourseLocation(CURSO_EN_OFICINA, ANTES);
  assert.equal(location.mapsUrl, MAPS_OFICINA);
  assert.ok(location.note, "debe traer el aviso de que el lugar cambió");
});

test("pasado el curso, la excepción NO sobrevive al evento", () => {
  const location = getCourseLocation(CURSO_EN_OFICINA, DESPUES);
  assert.equal(location.mapsUrl, MAPS_CURSOS);
  assert.equal(location.note, undefined);
});

test("si el curso recibe una fecha nueva, la ubicación vuelve a la habitual", () => {
  // Segundo candado: `until` vence aunque alguien mueva `startsAt` hacia adelante y
  // se olvide de borrar el bloque locationOverride.
  const reprogramado: Course = { ...CURSO_EN_OFICINA, startsAt: "2026-10-18T16:00:00-04:00" };
  const location = getCourseLocation(reprogramado, DESPUES);

  assert.equal(location.mapsUrl, MAPS_CURSOS);
  assert.equal(location.note, undefined);
});

test("el override sigue durante el curso y vence al terminar la ventana de información", () => {
  // Quien llega tarde a una fecha excepcional necesita el lugar excepcional, no el de
  // siempre: la excepción cubre también los 90 minutos del curso en marcha.
  const durante = at("2026-08-16T17:29:59-04:00");
  const alTerminar = at("2026-08-16T17:30:00-04:00");

  assert.equal(getCourseLocation(CURSO_EN_OFICINA, durante).mapsUrl, MAPS_OFICINA);
  assert.equal(getCourseLocation(CURSO_EN_OFICINA, alTerminar).mapsUrl, MAPS_CURSOS);
});

// --- 3. El catálogo real: ubicación habitual, sin excepciones colgadas -----

test("hoy ningún curso del catálogo tiene una excepción de ubicación vigente", () => {
  // Si alguien deja un locationOverride vencido en el catálogo, esto no falla (vence
  // solo), pero sí falla si queda uno apuntando al futuro sin querer.
  for (const course of COURSES) {
    const inicio = new Date(course.startsAt);
    const location = getCourseLocation(course, new Date(inicio.getTime() - 60_000));

    if (course.locationOverride === undefined) {
      assert.equal(location.mapsUrl, MAPS_CURSOS, `${course.name} debe usar el lugar habitual`);
      assert.equal(location.note, undefined);
    }
  }
});

test("todo curso vigente lleva su ubicación en el contexto", () => {
  const momento = at("2026-08-01T10:00:00-04:00"); // antes de todas las fechas cargadas
  const context = renderCourseContext(momento);
  const activos = getActiveCourses(momento);

  assert.ok(activos.length > 0, "el escenario de prueba necesita cursos vigentes");
  const lineasUbicacion = context.match(/Ubicación de ESTE curso/g) ?? [];
  assert.equal(lineasUbicacion.length, activos.length);
});

test("hasActiveLocationOverride es false mientras no haya excepción en el catálogo", () => {
  assert.equal(hasActiveLocationOverride(at("2026-09-06T10:00:00-04:00")), false);
});

console.log(`TZ=${process.env.TZ ?? "(sistema)"} — ${passed} pruebas OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
