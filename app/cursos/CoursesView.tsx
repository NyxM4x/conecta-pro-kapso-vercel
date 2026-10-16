// Vista de /cursos: la misma portada que /paquetes y, al deslizar, la ficha de cada curso
// con lo que se aprende, la fecha vigente (si la hay) y el botón para reservar por WhatsApp.
// Los cursos no usan el formulario de datos: se cierran por el chat, con el QR de pago.

import { PRESALE_CLOSES_MINUTES_BEFORE_START } from "../../lib/courses";
import type { CourseDetails, CourseSchedule } from "../../lib/course-details";
import { Hero } from "../components/Hero";
import { VisitBeacon } from "../components/VisitBeacon";
import { CoursePayment } from "./CoursePayment";

type CourseCard = {
  slug: string;
  name: string;
  details: CourseDetails | null;
  schedule: CourseSchedule;
  // Link a WhatsApp con el mensaje ya escrito. Vacío si no hay nada que pedir por chat.
  whatsappUrl: string;
};

const formatPrice = (price: number) => price.toLocaleString("es-BO");
const pad = (index: number) => String(index + 1).padStart(2, "0");
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
// "Curso de Creación de Contenido" → "Creación de Contenido": la etiqueta ya dice que es un curso.
const shortName = (name: string) => name.replace(/^Curso de\s+/i, "");

function CourseDate({ schedule }: { schedule: CourseSchedule }) {
  if (schedule.state === "no_date") {
    return (
      <div className="cp-date cp-date-off">
        <span className="cp-date-label">Próxima fecha</span>
        <strong>Por confirmar</strong>
        <p>Anunciamos las nuevas fechas en nuestras redes: síguenos en TikTok como @marketero7.</p>
      </div>
    );
  }

  if (schedule.state === "in_progress") {
    return (
      <div className="cp-date">
        <span className="cp-date-label">En curso ahora</span>
        <strong>{capitalize(schedule.date)}</strong>
        <p>Este curso se está dictando en este momento.</p>
      </div>
    );
  }

  if (schedule.state === "door_only") {
    return (
      <div className="cp-date">
        <span className="cp-date-label">Es hoy</span>
        <strong>{capitalize(schedule.date)}</strong>
        <p>
          La preventa ya cerró, pero todavía puedes sumarte pagando{" "}
          {formatPrice(schedule.pricePresencial)} Bs en la puerta.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="cp-date">
        <span className="cp-date-label">{schedule.isToday ? "Es hoy" : "Próxima fecha"}</span>
        <strong>{capitalize(schedule.date)}</strong>
      </div>
      <div className="cp-prices">
        <div>
          <strong>{formatPrice(schedule.pricePreventa)} Bs</strong>
          <span>
            Preventa, pagando con QR hasta {PRESALE_CLOSES_MINUTES_BEFORE_START} minutos antes de
            empezar
          </span>
        </div>
        <div>
          <strong>{formatPrice(schedule.pricePresencial)} Bs</strong>
          <span>En puerta, el día del curso</span>
        </div>
      </div>
    </>
  );
}

function CoursesView({
  courses,
  paymentDemo,
}: {
  courses: CourseCard[];
  // Demostración del pago dentro de la página (/cursos?demo=pago).
  paymentDemo: { courseName: string; price: number } | null;
}) {
  return (
    <main className="cp cp-cursos">
      <VisitBeacon page="cursos" />
      <Hero
        title="Cursos"
        copy="Cursos presenciales en Santa Cruz de la Sierra para que aprendas a crear y editar contenido que venda en redes."
        ctaLabel="Ver cursos"
        ctaHref="#cursos"
        video="cursos"
      />

      <section className="cp-packages" id="cursos">
        <header className="cp-packages-head">
          <h2>
            Nuestros
            <br />
            Cursos
          </h2>
          <p>Presenciales, en Santa Cruz de la Sierra. Mira qué se aprende en cada uno.</p>
        </header>

        {paymentDemo && (
          <div className="cp-pay-demo">
            <CoursePayment courseName={paymentDemo.courseName} price={paymentDemo.price} demo />
          </div>
        )}

        <div className="cp-courses">
          {courses.map(({ slug, name, details, schedule, whatsappUrl }, index) => (
            <article key={slug} id={slug} className="cp-course">
              <div className={`cp-course-cover cp-card-${(index % 4) + 1}`}>
                <span className="cp-card-num">{pad(index)}</span>
                <div className="cp-card-body">
                  <span className="cp-tag">Curso presencial</span>
                  <h3 className="cp-card-name">{shortName(name)}</h3>
                  {details && <p className="cp-card-text">{details.tagline}</p>}
                </div>
              </div>

              <div className="cp-course-info">
                <CourseDate schedule={schedule} />

                {details && (
                  <>
                    <ul className="cp-facts">
                      {details.facts.map((fact) => (
                        <li key={fact.label}>
                          <strong>{fact.value}</strong>
                          <span>{fact.label}</span>
                        </li>
                      ))}
                    </ul>

                    <h4>Lo que vas a aprender</h4>
                    <ul className="cp-includes">
                      {details.topics.map((topic) => (
                        <li key={topic}>{topic}</li>
                      ))}
                    </ul>

                    {details.bonus && (
                      <>
                        <h4>Bonus de edición avanzada</h4>
                        <ul className="cp-includes cp-includes-bonus">
                          {details.bonus.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </>
                    )}

                    {details.bring && (
                      <>
                        <h4>Qué traer</h4>
                        <p className="cp-course-text">{details.bring}</p>
                      </>
                    )}

                    {details.outcome && <p className="cp-course-outcome">{details.outcome}</p>}
                  </>
                )}

                <div className="cp-course-actions">
                  {whatsappUrl && (
                    <a className="cp-btn cp-btn-wa" href={whatsappUrl}>
                      Reservar mi cupo por WhatsApp
                    </a>
                  )}
                  {schedule.state !== "no_date" && (
                    <a className="cp-btn cp-btn-light" href={schedule.mapsUrl} target="_blank" rel="noopener noreferrer">
                      Cómo llegar
                    </a>
                  )}
                  {schedule.state === "on_sale" && (
                    <p className="cp-course-note">
                      {whatsappUrl
                        ? "Te pasamos el QR de pago por el chat."
                        : "Para reservar tu cupo, vuelve al chat de WhatsApp y pídenos el QR de pago."}
                    </p>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <footer className="cp-footer">© {new Date().getFullYear()} Conecta Pro</footer>
    </main>
  );
}

export { CoursesView };
export type { CourseCard };
