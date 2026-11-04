"use client";

// Vista de /paquetes y /promocion: portada, tarjetas (los paquetes del catálogo, estilo "Our
// Process", o la promoción vigente) y, al tocar una, la hoja de detalle con el formulario de
// datos que llega a Telegram. Cada página muestra solo lo suyo y enlaza a la otra al final.

import { useCallback, useEffect, useRef, useState } from "react";
import { HOW_WE_WORK_GOAL, HOW_WE_WORK_STEPS } from "../../lib/how-we-work";
import {
  CONTENT_TYPE_OPTIONS,
  SOCIAL_NETWORK_OPTIONS,
  LEAD_FIELDS,
  PREFERRED_DATE_MAX_LENGTH,
  PRESENTER_OPTIONS,
  type LeadFieldKey,
  type PresenterChoice,
} from "../../lib/lead-form";
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
  // Video de la portada de su ficha, sin extensión (".mp4" y ".jpg"). Sin video, el degradado.
  video: string | null;
  // Cuánto dura: "mes" o, en el Básico, "14 días" (lib/packages.ts).
  period: "mes" | "14 días";
};

// Promoción vigente (lib/promos.ts). Solo llegan las que están dentro de su ventana.
type PromoCard = {
  slug: string;
  // Nombre corto: título de la tarjeta y lo que viaja como packageName al formulario.
  shortName: string;
  videos: number;
  price: number;
  includes: string[];
  notes: string[];
  presenterPrice: number | null;
  // Último día de vigencia ya formateado ("viernes, 31 de octubre").
  validUntil: string;
};

// Qué hoja está abierta: un paquete del catálogo o una promo, por su posición.
type OpenSheet = { kind: "package" | "promo"; index: number };

type Step = "detail" | "form" | "done";

const EMPTY_FORM = Object.fromEntries(LEAD_FIELDS.map((field) => [field.key, ""])) as Record<LeadFieldKey, string>;

const formatPrice = (price: number) => price.toLocaleString("es-BO");
const pad = (index: number) => String(index + 1).padStart(2, "0");
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
// "Bs/mes" o "Bs por 14 días": el Básico no es mensual.
const pricePeriod = (period: PackageCard["period"]) => (period === "mes" ? "Bs/mes" : `Bs por ${period}`);
const periodPhrase = (period: PackageCard["period"]) => (period === "mes" ? "al mes" : `en ${period}`);

function PackagesView({
  view,
  packages,
  promos,
  originPhone,
  originToken,
  initialSlug,
  openForm,
  businessWhatsapp,
}: {
  // "packages" en /paquetes, "promo" en /promocion.
  view: "packages" | "promo";
  packages: PackageCard[];
  promos: PromoCard[];
  originPhone: string;
  originToken: string;
  initialSlug: string | null;
  // El bot mandó el link al pedirle los datos: la hoja abre directo en el formulario.
  openForm: boolean;
  businessWhatsapp: string;
}) {
  const [open, setOpen] = useState<OpenSheet | null>(null);
  const [step, setStep] = useState<Step>("detail");
  const [form, setForm] = useState(EMPTY_FORM);
  const [contentTypes, setContentTypes] = useState<string[]>([]);
  const [presenter, setPresenter] = useState<PresenterChoice | "">("");
  const [preferredDate, setPreferredDate] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const selected = open?.kind === "package" ? packages[open.index] ?? null : null;
  const selectedPromo = open?.kind === "promo" ? promos[open.index] ?? null : null;
  // Lo que viaja al formulario y se muestra en la etiqueta: el paquete o la promo.
  const selectedName = selected?.name ?? selectedPromo?.shortName ?? "";
  const sheetRef = useRef<HTMLDivElement>(null);
  const infoRef = useRef<HTMLDivElement>(null);

  // Cada paquete y cada paso arrancan arriba: con el video a pantalla completa, abrir el
  // siguiente paquete a mitad de la hoja dejaría al cliente sin ver el video.
  useEffect(() => {
    sheetRef.current?.scrollTo({ top: 0 });
  }, [open, step]);

  // La hoja abierta ocupa una entrada del historial: así el botón "atrás" del teléfono la
  // cierra en vez de sacar al cliente del navegador de WhatsApp.
  const openSheet = useCallback((sheet: OpenSheet) => {
    setOpen(sheet);
    setStep("detail");
    setError("");
    window.history.pushState({ sheet: true }, "");
  }, []);

  const closeSheet = useCallback(() => {
    if (window.history.state?.sheet) window.history.back();
    else setOpen(null);
  }, []);

  useEffect(() => {
    const onPop = () => setOpen(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!initialSlug) return;
    const promoIndex = promos.findIndex((promo) => promo.slug === initialSlug);
    const packageIndex = packages.findIndex((pkg) => pkg.slug === initialSlug);
    const sheet: OpenSheet | null =
      promoIndex >= 0
        ? { kind: "promo", index: promoIndex }
        : packageIndex >= 0
          ? { kind: "package", index: packageIndex }
          : null;
    if (sheet) {
      openSheet(sheet);
      if (openForm) setStep("form");
    }
  }, [initialSlug, openForm, packages, promos, openSheet]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
  }, [open]);

  const toggleContentType = (option: string) =>
    setContentTypes((current) =>
      current.includes(option) ? current.filter((item) => item !== option) : [...current, option],
    );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedName || sending) return;

    if (!form.socialNetwork) {
      setError("Elige en qué red social te encuentras.");
      return;
    }

    if (contentTypes.length === 0) {
      setError("Elige al menos un tipo de contenido.");
      return;
    }

    if (selectedPromo?.presenterPrice && !presenter) {
      setError("Elige quién sale en los videos.");
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
          packageName: selectedName,
          ...(selectedPromo ? { presenter: presenter || undefined, preferredDate } : {}),
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
  const whatsappBack = businessWhatsapp && open ? `https://wa.me/${businessWhatsapp}` : "";

  // Enlace a la otra página, con el número firmado: el lead que deje allá también se cierra en
  // su conversación. En /paquetes solo aparece si hay una promo vigente.
  const signed = new URLSearchParams({
    ...(originPhone ? { wa: originPhone } : {}),
    ...(originToken ? { t: originToken } : {}),
  }).toString();
  const crossLink =
    view === "promo"
      ? { href: `/paquetes${signed ? `?${signed}` : ""}`, label: "Ver nuestros paquetes mensuales" }
      : promos.length > 0
        ? { href: `/promocion${signed ? `?${signed}` : ""}`, label: "🔥 Ver la promoción vigente" }
        : null;

  return (
    <main className="cp">
      <VisitBeacon page={view === "promo" ? "promocion" : "paquetes"} />
      {view === "promo" ? (
        <Hero
          title="Promoción"
          copy="Una oferta por tiempo limitado: estrategia, guiones, grabación y edición de tus videos para que tu negocio destaque en TikTok."
          ctaLabel="Ver promoción"
          ctaHref="#promo"
        />
      ) : (
        <Hero
          title="Marketing"
          copy="Estrategia, guiones, grabación y edición: creamos el contenido de tu negocio para que tú solo te ocupes de vender."
          ctaLabel="Ver paquetes"
          ctaHref="#paquetes"
        />
      )}

      {/* Promoción vigente, solo en /promocion. Pasada su fecha la página lleva a /paquetes. */}
      {view === "promo" && promos.length > 0 && (
        <section className="cp-packages cp-promo-section" id="promo">
          <header className="cp-packages-head">
            <h2>
              Promoción
              <br />
              Especial
            </h2>
            <p>Por tiempo limitado. Déjanos tus datos y un asesor te agenda la fecha por WhatsApp.</p>
          </header>

          <div className="cp-promo-list">
            {promos.map((promo, index) => (
              <button
                key={promo.slug}
                type="button"
                className="cp-promo-card"
                onClick={() => openSheet({ kind: "promo", index })}
              >
                <span className="cp-promo-badge">🔥 Promo</span>
                <span className="cp-promo-title">
                  {promo.videos} videos profesionales
                  <br />
                  por solo <strong>{formatPrice(promo.price)} Bs</strong>
                </span>
                <span className="cp-card-text">{promo.includes.join(" · ")}</span>
                <span className="cp-promo-until">Válida hasta el {promo.validUntil}</span>
                <span className="cp-card-cta">
                  Ver promoción <span className="cp-btn-arrow cp-btn-arrow-side" aria-hidden>→</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {view === "packages" && (
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
                className={`cp-card cp-card-${(index % 4) + 1}${pkg.video ? " cp-card-has-video" : ""}`}
                onClick={() => openSheet({ kind: "package", index })}
              >
                {/* El video del paquete corre desde antes de tocarlo, de fondo y sin audio. */}
                {pkg.video && (
                  <video
                    className="cp-card-video"
                    src={`${pkg.video}.mp4`}
                    poster={`${pkg.video}.jpg`}
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="auto"
                    aria-hidden
                  />
                )}
                <span className="cp-card-num">{pad(index)}</span>
                <span className="cp-card-body">
                  <span className="cp-card-name">{pkg.name}</span>
                  <span className="cp-card-meta">
                    {pkg.videos} videos · {formatPrice(pkg.price)} {pricePeriod(pkg.period)}
                  </span>
                  {pkg.tagline && <span className="cp-card-text">{pkg.tagline}</span>}
                  {/* Mismo estilo que "Ver paquetes": el de antes pasaba desapercibido. */}
                  <span className="cp-card-cta">
                    Ver detalle <span className="cp-btn-arrow cp-btn-arrow-side" aria-hidden>→</span>
                  </span>
                </span>
              </button>
            ))}
          </div>

          {/* En el celular las tarjetas se deslizan de lado: sin aviso, el tercer paquete no se ve. */}
          <p className="cp-swipe-hint" aria-hidden>
            Desliza para ver los {packages.length} paquetes <span>→</span>
          </p>

          {/* Lleva a "Cómo trabajamos", que sin este botón casi nadie bajaba a leer. */}
          <div className="cp-next">
            <a className="cp-btn cp-btn-hero" href="#como-trabajamos">
              ¿Cómo trabajamos? <span className="cp-btn-arrow" aria-hidden>↓</span>
            </a>
          </div>
        </section>
      )}

      {/* Lo que antes el bot mandaba como texto largo por WhatsApp. */}
      {view === "packages" && (
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
      )}

      {crossLink && (
        <div className="cp-next">
          <a className="cp-btn cp-btn-hero" href={crossLink.href}>
            {crossLink.label} <span className="cp-btn-arrow" aria-hidden>→</span>
          </a>
        </div>
      )}

      <footer className="cp-footer">© {new Date().getFullYear()} Conecta Pro</footer>

      {open && selectedName && (
        <div className="cp-sheet-backdrop" onClick={closeSheet}>
          <div
            ref={sheetRef}
            className={`cp-sheet${selected?.video && step === "detail" ? " cp-sheet-video" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={selectedPromo ? selectedPromo.shortName : `Paquete ${selectedName}`}
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" className="cp-close" onClick={closeSheet} aria-label="Cerrar">
              ×
            </button>

            {step === "detail" && selected && (
              <>
                <div className="cp-detail">
                  <div
                    className={`cp-photo cp-card-${(open.index % 4) + 1}${selected.video ? " cp-photo-has-video" : ""}`}
                  >
                    {selected.video && (
                      // key: al cambiar de paquete el video empieza de nuevo.
                      <video
                        key={selected.video}
                        className="cp-photo-video"
                        src={`${selected.video}.mp4`}
                        poster={`${selected.video}.jpg`}
                        autoPlay
                        muted
                        loop
                        playsInline
                        preload="auto"
                        aria-hidden
                      />
                    )}
                    <span className="cp-photo-num">{pad(open.index)}</span>
                    <div className="cp-photo-foot">
                      <span>{selected.name}</span>
                      <span>{selected.videos} videos</span>
                    </div>
                    {/* En el celular el video ocupa toda la pantalla: este botón avisa que
                        abajo está la información y baja hasta ella. */}
                    {selected.video && (
                      <button
                        type="button"
                        className="cp-btn cp-btn-hero cp-photo-cta"
                        onClick={() => infoRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                      >
                        Ver Información Del Paquete <span className="cp-btn-arrow" aria-hidden>↓</span>
                      </button>
                    )}
                  </div>

                  <div className="cp-detail-info" ref={infoRef}>
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

                <h4 className="cp-stats-title">
                  {selected.period === "mes" ? "Tu plan mensual" : `Tu plan de ${selected.period}`}
                </h4>
                <div className="cp-stats">
                  <div>
                    <strong>{selected.videos}</strong>
                    <span>Videos {periodPhrase(selected.period)}</span>
                  </div>
                  <div>
                    <strong>{formatPrice(selected.price)}</strong>
                    <span>{selected.period === "mes" ? "Bs al mes" : `Bs por ${selected.period}`}</span>
                  </div>
                  <div>
                    <strong>{selected.drone ? "Sí" : "Extra"}</strong>
                    <span>{selected.drone ? "Dron incluido" : "Dron se cotiza"}</span>
                  </div>
                </div>
              </>
            )}

            {step === "detail" && selectedPromo && (
              <>
                <div className="cp-detail">
                  <div className="cp-photo cp-promo-photo">
                    <span className="cp-photo-num">🔥</span>
                    <div className="cp-photo-foot">
                      <span>{selectedPromo.shortName}</span>
                      <span>{formatPrice(selectedPromo.price)} Bs</span>
                    </div>
                  </div>

                  <div className="cp-detail-info">
                    <span className="cp-tag">Promoción especial</span>
                    <h3>
                      {selectedPromo.videos} videos por <em>{formatPrice(selectedPromo.price)} Bs</em>
                    </h3>
                    <p className="cp-muted">
                      Haz que tu negocio destaque en TikTok con contenido estratégico y profesional.
                      Válida hasta el {selectedPromo.validUntil}.
                    </p>
                    <button type="button" className="cp-btn cp-btn-accent" onClick={() => setStep("form")}>
                      ¡La quiero!
                    </button>

                    <h4>Qué incluye</h4>
                    <ul className="cp-includes">
                      {selectedPromo.includes.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>

                    {selectedPromo.notes.length > 0 && (
                      <>
                        <h4>Importante</h4>
                        <ul className="cp-includes cp-promo-notes">
                          {selectedPromo.notes.map((note) => (
                            <li key={note}>{note}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                </div>

                <h4 className="cp-stats-title">Tu promoción</h4>
                <div className="cp-stats">
                  <div>
                    <strong>{selectedPromo.videos}</strong>
                    <span>Videos, grabados el mismo día</span>
                  </div>
                  <div>
                    <strong>{formatPrice(selectedPromo.price)}</strong>
                    <span>Bs en total</span>
                  </div>
                  <div>
                    <strong>{selectedPromo.presenterPrice ? `+${selectedPromo.presenterPrice}` : "—"}</strong>
                    <span>{selectedPromo.presenterPrice ? "Bs presentadora (opcional)" : "Sin extras"}</span>
                  </div>
                </div>
              </>
            )}

            {step === "form" && (
              <form className="cp-form" onSubmit={submit}>
                <button type="button" className="cp-back" onClick={() => setStep("detail")}>
                  {selectedPromo ? "← Volver a la promoción" : "← Volver al paquete"}
                </button>
                <span className="cp-tag">{selectedPromo ? selectedPromo.shortName : `Paquete ${selectedName}`}</span>
                <h3>
                  Cuéntanos de <em>tu negocio</em>
                </h3>
                <p className="cp-muted">
                  {selectedPromo
                    ? "Con estos datos un asesor te escribe por WhatsApp para agendar la fecha de grabación."
                    : "Con estos datos un asesor estudia tu caso y te escribe por WhatsApp."}
                </p>
                {/* El botón del bot abre el formulario directo, sin pasar por la ficha: este
                    resumen le recuerda qué está pidiendo sin hacerlo volver atrás. */}
                {selectedPromo && (
                  <p className="cp-promo-summary">
                    🎬 {selectedPromo.videos} videos · <strong>{formatPrice(selectedPromo.price)} Bs</strong> en total ·
                    válida hasta el {selectedPromo.validUntil}
                  </p>
                )}

                {LEAD_FIELDS.map((field) => (
                  <label key={field.key} className="cp-field">
                    <span>
                      {field.label}
                      {!field.required && <small> (opcional)</small>}
                    </span>
                    {field.kind === "chips" ? (
                      field.key === "socialNetwork" ? (
                        <span className="cp-chips" role="radiogroup">
                          {SOCIAL_NETWORK_OPTIONS.map((option) => (
                            <button
                              key={option}
                              type="button"
                              role="radio"
                              aria-checked={form.socialNetwork === option}
                              className={form.socialNetwork === option ? "is-on" : ""}
                              onClick={() => setForm({ ...form, socialNetwork: option })}
                            >
                              {option}
                            </button>
                          ))}
                        </span>
                      ) : (
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
                      )
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

                {/* Preguntas propias de la promo: quién sale en los videos y qué día le sirve. */}
                {selectedPromo?.presenterPrice ? (
                  <div className="cp-field">
                    <span>¿Quién sale en los videos?</span>
                    <span className="cp-chips" role="radiogroup">
                      {PRESENTER_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={presenter === option.value}
                          className={presenter === option.value ? "is-on" : ""}
                          onClick={() => setPresenter(option.value)}
                        >
                          {option.value === "presenter"
                            ? `${option.label} (+${selectedPromo.presenterPrice} Bs)`
                            : option.label}
                        </button>
                      ))}
                    </span>
                  </div>
                ) : null}

                {selectedPromo && (
                  <label className="cp-field">
                    <span>
                      ¿Qué fecha te gustaría para la grabación?<small> (opcional)</small>
                    </span>
                    <input
                      type="text"
                      autoComplete="off"
                      maxLength={PREFERRED_DATE_MAX_LENGTH}
                      placeholder="Ej. el sábado 25 por la mañana"
                      value={preferredDate}
                      onChange={(event) => setPreferredDate(event.target.value)}
                    />
                  </label>
                )}

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
                  message={
                    selectedPromo
                      ? `${selectedPromo.shortName} · te hablará muy pronto por WhatsApp para agendar tu fecha`
                      : `Paquete ${selectedName} · te hablará muy pronto por WhatsApp`
                  }
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
export type { PackageCard, PromoCard };
