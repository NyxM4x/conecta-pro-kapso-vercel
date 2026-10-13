// Pruebas de lo que la página /cursos muestra de cada curso.
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Lo que se protege aquí:
//   1. Todo curso del catálogo tiene su ficha: sin ella la página lo muestra vacío.
//   2. La página sigue los mismos estados que el bot: vende con los dos precios mientras
//      la preventa está abierta, deja solo el precio en puerta en los últimos minutos, no
//      vende con el curso en marcha y no expone fecha ni precio de un curso ya dictado.

import assert from "node:assert/strict";
import { COURSES, PRESALE_CLOSES_MINUTES_BEFORE_START } from "./courses.ts";
import { COURSE_DETAILS, getCourseSchedule } from "./course-details.ts";

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

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

for (const course of COURSES) {
  const inicio = new Date(course.startsAt).getTime();

  test(`${course.id}: tiene ficha con temas`, () => {
    const details = COURSE_DETAILS[course.id];
    assert.ok(details, "falta la ficha en COURSE_DETAILS");
    assert.ok(details.tagline.length > 0);
    assert.ok(details.topics.length > 0);
  });

  test(`${course.id}: la víspera se vende con los dos precios`, () => {
    const schedule = getCourseSchedule(course, new Date(inicio - DAY));
    if (schedule.state !== "on_sale") assert.fail(`estado ${schedule.state}`);
    assert.equal(schedule.isToday, false);
    assert.equal(schedule.pricePreventa, course.pricePreventa);
    assert.equal(schedule.pricePresencial, course.pricePresencial);
    assert.ok(schedule.date.length > 0);
    assert.ok(schedule.mapsUrl.startsWith("https://"));
  });

  test(`${course.id}: el día del curso, horas antes, sigue en preventa`, () => {
    const schedule = getCourseSchedule(course, new Date(inicio - 3 * 60 * MINUTE));
    if (schedule.state !== "on_sale") assert.fail(`estado ${schedule.state}`);
    assert.equal(schedule.isToday, true);
  });

  test(`${course.id}: en los últimos minutos solo queda el precio en puerta`, () => {
    const schedule = getCourseSchedule(
      course,
      new Date(inicio - (PRESALE_CLOSES_MINUTES_BEFORE_START - 1) * MINUTE),
    );
    assert.equal(schedule.state, "door_only");
    assert.equal("pricePreventa" in schedule, false);
  });

  test(`${course.id}: con el curso en marcha no se vende, pero se dice dónde es`, () => {
    const schedule = getCourseSchedule(course, new Date(inicio + 30 * MINUTE));
    if (schedule.state !== "in_progress") assert.fail(`estado ${schedule.state}`);
    assert.equal("pricePresencial" in schedule, false);
    assert.ok(schedule.mapsUrl.startsWith("https://"));
  });

  test(`${course.id}: ya dictado, no expone fecha, precio ni ubicación`, () => {
    assert.deepEqual(getCourseSchedule(course, new Date(inicio + DAY)), { state: "no_date" });
  });
}

console.log(`TZ=${process.env.TZ ?? "(sistema)"} — ${passed} pruebas OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
