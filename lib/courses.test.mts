// Pruebas del catálogo de cursos, con foco en la UBICACIÓN.
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Lo que se protege aquí: los cursos y la oficina son lugares distintos, y una fecha
// puntual puede dictarse excepcionalmente en la oficina sin que esa excepción sobreviva
// al evento. Correr también con TZ=UTC y TZ=America/La_Paz (Vercel corre en UTC).

import assert from "node:assert/strict";
import {
  getActiveCourses,
  getCourseLocation,
  hasActiveLocationOverride,
  renderCourseContext,
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

// El curso de CapCut del 16/08/2026 se dicta excepcionalmente en la oficina.
const ANTES = at("2026-08-15T10:00:00-04:00"); // víspera: excepción vigente
const DESPUES = at("2026-08-17T10:00:00-04:00"); // día siguiente: ya venció

const capcut = COURSES.find((c) => c.id === "capcut_pro")!;

// --- La excepción mientras está vigente -----------------------------------

test("la víspera, la ubicación del curso de CapCut es la oficina", () => {
  const location = getCourseLocation(capcut, ANTES);
  assert.equal(location.mapsUrl, MAPS_OFICINA);
  assert.ok(location.note, "debe traer el aviso de que el lugar cambió");
});

test("la víspera, el contexto anuncia el cambio de lugar", () => {
  const context = renderCourseContext(ANTES);
  assert.ok(context.includes(MAPS_OFICINA), "falta el link de la oficina");
  assert.ok(context.includes("SOLO POR ESTA FECHA"), "falta el aviso de excepción");
  assert.ok(
    context.includes("NO marques intents.location_video"),
    "falta el bloqueo del video de cómo llegar",
  );
});

test("hasActiveLocationOverride distingue antes y después", () => {
  assert.equal(hasActiveLocationOverride(ANTES), true);
  assert.equal(hasActiveLocationOverride(DESPUES), false);
});

// --- Lo que importa: que la excepción NO sobreviva al evento ---------------

test("pasado el curso, el link de la oficina desaparece del contexto de cursos", () => {
  const context = renderCourseContext(DESPUES);
  assert.ok(
    !context.includes(MAPS_OFICINA),
    "el link de la oficina NO debe aparecer para ninguna fecha posterior",
  );
  assert.ok(!context.includes("SOLO POR ESTA FECHA"));
});

test("si CapCut recibe una fecha nueva, la ubicación vuelve a la habitual", () => {
  // Segundo candado: `until` vence aunque alguien mueva `startsAt` hacia adelante y
  // se olvide de borrar el bloque locationOverride.
  const reprogramado: Course = { ...capcut, startsAt: "2026-09-20T16:00:00-04:00" };
  const location = getCourseLocation(reprogramado, DESPUES);

  assert.equal(location.mapsUrl, MAPS_CURSOS);
  assert.equal(location.note, undefined);
});

test("el override vence exactamente en `until`, no después", () => {
  const justoAntes = at("2026-08-16T15:59:59-04:00");
  const justoEn = at("2026-08-16T16:00:00-04:00");

  assert.equal(getCourseLocation(capcut, justoAntes).mapsUrl, MAPS_OFICINA);
  assert.equal(getCourseLocation(capcut, justoEn).mapsUrl, MAPS_CURSOS);
});

// --- El caso normal, sin excepción ----------------------------------------

test("un curso sin override siempre usa la ubicación habitual", () => {
  const normal = COURSES.find((c) => c.id === "creacion_contenido")!;
  assert.equal(normal.locationOverride, undefined);
  assert.equal(getCourseLocation(normal, ANTES).mapsUrl, MAPS_CURSOS);
  assert.equal(getCourseLocation(normal, DESPUES).mapsUrl, MAPS_CURSOS);
});

test("todo curso vigente lleva su ubicación en el contexto", () => {
  const context = renderCourseContext(ANTES);
  const activos = getActiveCourses(ANTES);

  assert.ok(activos.length > 0, "el escenario de prueba necesita cursos vigentes");
  const lineasUbicacion = context.match(/Ubicación de ESTE curso/g) ?? [];
  assert.equal(lineasUbicacion.length, activos.length);
});

test("los cursos vencidos no exponen ninguna ubicación", () => {
  // El 17 CapCut ya pasó: se lista como sin fecha vigente, pero sin link.
  const context = renderCourseContext(DESPUES);
  const seccionVencidos = context.slice(context.indexOf("Cursos SIN fecha vigente"));

  assert.ok(!seccionVencidos.includes("maps.app.goo.gl"));
});

console.log(`TZ=${process.env.TZ ?? "(sistema)"} — ${passed} pruebas OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
