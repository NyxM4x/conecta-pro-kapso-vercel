"use client";

// Vista de /paquetes: portada, tarjetas de paquetes (estilo "Our Process") y, al tocar
// una, la hoja de detalle con el formulario de datos que llega a Telegram.

import { useCallback, useEffect, useState } from "react";
import { HOW_WE_WORK_GOAL, HOW_WE_WORK_STEPS } from "../../lib/how-we-work";
import { CONTENT_TYPE_OPTIONS, LEAD_FIELDS, type LeadFieldKey } from "../../lib/lead-form";
import { Hero } from "../components/Hero";
import { SuccessCheck } from "../components/SuccessCheck";
import { VisitBeacon } from "../components/VisitBeacon";

type PackageCard = {
  name: string;
  slug: string;
  videos: number;
  price: number;
  drone: boolean;
  includes: string[];
  tagline: string;
};

type Step = "detail" | "form" | "done";

const EMPTY_FORM = Object.fromEntries(LEAD_FIELDS.map((field) => [field.key, ""])) as Record<LeadFieldKey, string>;

const formatPrice = (price: number) => price.toLocaleString("es-BO");
const pad = (index: number) => String(index + 1).padStart(2, "0");
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function PackagesView({
  packages,
  originPhone,
  originToken,
  initialSlug,
  openForm,
  businessWhatsapp,
}: {
  packages: PackageCard[];
  originPhone: string;
  originToken: string;
  initialSlug: string | null;
  // El bot mandó el link al pedirle los datos: la hoja abre directo en el formulario.
  openForm: boolean;
  businessWhatsapp: string;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [step, setStep] = useState<Step>("detail");
  const [form, setForm] = useState(EMPTY_FORM);
  const [contentTypes, setContentTypes] = useState<string[]>([]);
  const [honeypot, setHoneypot] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const selected = openIndex === null ? null : packages[openIndex];

  // La hoja abierta ocupa una entrada del historial: así el botón "atrás" del teléfono la
  // cierra en vez de sacar al cliente del navegador de WhatsApp.
  const openPackage = useCallback((index: number) => {
    setOpenIndex(index);
    setStep("detail");
    setError("");
    window.history.pushState({ sheet: true }, "");
  }, []);

  const closeSheet = useCallback(() => {
    if (window.history.state?.sheet) window.history.back();
    else setOpenIndex(null);
  }, []);

  useEffect(() => {
    const onPop = () => setOpenIndex(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (initialSlug) {
      const index = packages.findIndex((pkg) => pkg.slug === initialSlug);
      if (index >= 0) {
        openPackage(index);
        if (openForm) setStep("form");
      }
    }
  }, [initialSlug, openForm, packages, openPackage]);

  useEffect(() => {
    document.body.style.overflow = selected ? "hidden" : "";
  }, [selected]);

  const toggleContentType = (option: string) =>
    setContentTypes((current) =>
      current.includes(option) ? current.filter((item) => item !== option) : [...current, option],
    );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || sending) return;

    if (contentTypes.length === 0) {
      setError("Elige al menos un tipo de contenido.");
      return;
    }

    setSending(true);
    setError("");

    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          contentType: contentTypes.join(", "),
          packageName: selected.name,
          originPhone,
          originToken,
          website: honeypot,
        }),
      });
      const json = await response.json().catch(() => null);

      if (!response.ok || !json?.ok) {
        setError(
          json?.errors?.length
            ? `Revisa: ${json.errors.join(", ")}.`
            : "No pudimos enviar tus datos. Inténtalo de nuevo en un momento.",
        );
        return;
      }

      setStep("done");
    } catch {
      setError("Sin conexión. Revisa tu internet e inténtalo de nuevo.");
    } finally {
      setSending(false);
    }
  }

  // Vuelve al chat sin texto escrito: los datos ya llegaron al asesor, y un "ya envié mis
  // datos" solo le llegaría al bot, que queda apagado para que lo atienda una persona.
  const whatsappBack = businessWhatsapp && selected ? `https://wa.me/${businessWhatsapp}` : "";


  return (
    <main className="cp">
      <VisitBeacon page="paquetes" />
      <Hero
        title="Marketing"
        copy="Estrategia, guiones, grabación y edición: creamos el contenido de tu negocio para que tú solo te ocupes de vender."
        ctaLabel="Ver paquetes"
        ctaHref="#paquetes"
      />

      <section className="cp-packages" id="paquetes">
        <header className="cp-packages-head">
          <h2>
            Nuestros
            <br />
            Paquetes
          </h2>
          <p>Elige uno, déjanos tus datos y un asesor te escribe por WhatsApp.</p>
        </header>

        <div className="cp-cards">
          {packages.map((pkg, index) => (
            <button
              key={pkg.slug}
              type="button"
              className={`cp-card cp-card-${(index % 4) + 1}`}
              onClick={() => openPackage(index)}
            >
              <span className="cp-card-num">{pad(index)}</span>
              <span className="cp-card-body">
                <span className="cp-card-name">{pkg.name}</span>
                <span className="cp-card-meta">
                  {pkg.videos} videos · {formatPrice(pkg.price)} Bs/mes
                </span>
                {pkg.tagline && <span className="cp-card-text">{pkg.tagline}</span>}
                <span className="cp-card-cta">
                  Ver detalle <span aria-hidden>→</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Lo que antes el bot mandaba como texto largo por WhatsApp. */}
      <section className="cp-packages cp-how" id="como-trabajamos">
        <header className="cp-packages-head">
          <h2>
            Cómo
            <br />
            Trabajamos
          </h2>
          <p>Una metodología organizada para que tengas contenido constante y profesional.</p>
        </header>

        <ol className="cp-how-steps">
          {HOW_WE_WORK_STEPS.map((step, index) => (
            <li key={step.title}>
              <span className="cp-how-num">{pad(index)}</span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
                {step.points && (
                  <ul className="cp-includes">
                    {step.points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ol>

        <p className="cp-how-goal">{HOW_WE_WORK_GOAL}</p>
      </section>

      <footer className="cp-footer">© {new Date().getFullYear()} Conecta Pro</footer>

      {selected && openIndex !== null && (
        <div className="cp-sheet-backdrop" onClick={closeSheet}>
          <div
            className="cp-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={`Paquete ${selected.name}`}
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" className="cp-close" onClick={closeSheet} aria-label="Cerrar">
              ×
            </button>

            {step === "detail" && (
              <>
                <div className="cp-detail">
                  <div className={`cp-photo cp-card-${(openIndex % 4) + 1}`}>
                    <span className="cp-photo-num">{pad(openIndex)}</span>
                    <div className="cp-photo-foot">
                      <span>{selected.name}</span>
                      <span>{selected.videos} videos</span>
                    </div>
                  </div>

                  <div className="cp-detail-info">
                    <span className="cp-tag">Paquete</span>
                    <h3>
                      Paquete <em>{selected.name}</em>
                    </h3>
                    {selected.tagline && <p className="cp-muted">{selected.tagline}</p>}
                    <button type="button" className="cp-btn cp-btn-accent" onClick={() => setStep("form")}>
                      Lo quiero
                    </button>

                    <h4>Qué incluye</h4>
                    <ul className="cp-includes">
                      {selected.includes.map((item) => (
                        <li key={item}>{capitalize(item)}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                <h4 className="cp-stats-title">Tu plan mensual</h4>
                <div className="cp-stats">
                  <div>
                    <strong>{selected.videos}</strong>
                    <span>Videos al mes</span>
                  </div>
                  <div>
                    <strong>{formatPrice(selected.price)}</strong>
                    <span>Bs al mes</span>
                  </div>
                  <div>
                    <strong>{selected.drone ? "Sí" : "Extra"}</strong>
                    <span>{selected.drone ? "Dron incluido" : "Dron se cotiza"}</span>
                  </div>
                </div>
              </>
            )}

            {step === "form" && (
              <form className="cp-form" onSubmit={submit}>
                <button type="button" className="cp-back" onClick={() => setStep("detail")}>
                  ← Volver al paquete
                </button>
                <span className="cp-tag">Paquete {selected.name}</span>
                <h3>
                  Cuéntanos de <em>tu negocio</em>
                </h3>
                <p className="cp-muted">
                  Con estos datos un asesor estudia tu caso y te escribe por WhatsApp.
                </p>

                {LEAD_FIELDS.map((field) => (
                  <label key={field.key} className="cp-field">
                    <span>
                      {field.label}
                      {!field.required && <small> (opcional)</small>}
                    </span>
                    {field.kind === "chips" ? (
                      <span className="cp-chips" role="group">
                        {CONTENT_TYPE_OPTIONS.map((option) => (
                          <button
                            key={option}
                            type="button"
                            aria-pressed={contentTypes.includes(option)}
                            className={contentTypes.includes(option) ? "is-on" : ""}
                            onClick={() => toggleContentType(option)}
                          >
                            {option}
                          </button>
                        ))}
                      </span>
                    ) : field.kind === "textarea" ? (
                      <textarea
                        rows={3}
                        maxLength={field.maxLength}
                        placeholder={field.placeholder}
                        value={form[field.key]}
                        onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}
                      />
                    ) : (
                      <input
                        type="text"
                        autoComplete={field.key === "name" ? "name" : "off"}
                        required={field.required}
                        maxLength={field.maxLength}
                        placeholder={field.placeholder}
                        value={form[field.key]}
                        onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}
                      />
                    )}
                  </label>
                ))}

                {/* Trampa para bots: oculta para las personas. */}
                <input
                  className="cp-hp"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden
                  value={honeypot}
                  onChange={(event) => setHoneypot(event.target.value)}
                />

                {error && <p className="cp-error">{error}</p>}

                <button type="submit" className="cp-btn cp-btn-accent cp-btn-block" disabled={sending}>
                  {sending ? "Enviando…" : "Enviar mis datos"}
                </button>
              </form>
            )}

            {step === "done" && (
              <div className="cp-done">
                {/* El bot no manda nada por WhatsApp (ahorro de mensajes): este check es la
                    confirmación que deja tranquilo al cliente. */}
                <SuccessCheck
                  title="Tus datos fueron enviados a un Asesor"
                  message={`Paquete ${selected.name} · te hablará muy pronto por WhatsApp`}
                />
                {whatsappBack ? (
                  <a className="cp-btn cp-btn-wa cp-btn-block" href={whatsappBack}>
                    Volver a WhatsApp
                  </a>
                ) : (
                  <button type="button" className="cp-btn cp-btn-light cp-btn-block" onClick={closeSheet}>
                    Ver otros paquetes
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

export { PackagesView };
export type { PackageCard };
