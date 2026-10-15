"use client";

// Vista de /oficina: la portada, el texto que el bot mandaba por chat y el formulario. Al
// enviar, el check grande de "listo": el bot no manda nada por WhatsApp.

import { useState } from "react";
import type { OfficeForm, OfficeVisitType } from "../../lib/office-form";
import { Hero } from "../components/Hero";
import { SuccessCheck } from "../components/SuccessCheck";
import { VisitBeacon } from "../components/VisitBeacon";

function OfficeView({
  visitType,
  form,
  originPhone,
  originToken,
  businessWhatsapp,
}: {
  visitType: OfficeVisitType;
  form: OfficeForm;
  originPhone: string;
  originToken: string;
  businessWhatsapp: string;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [honeypot, setHoneypot] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending) return;

    setSending(true);
    setError("");

    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...values,
          form: "oficina",
          visitType,
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

      setDone(true);
    } catch {
      setError("Sin conexión. Revisa tu internet e inténtalo de nuevo.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="cp cp-oficina">
      <VisitBeacon page="oficina" />
      <Hero
        title="Visítanos"
        copy="Antes de reunirnos en la oficina, un asesor te llama para coordinar el día y la hora."
        ctaLabel="Agendar visita"
        ctaHref="#agendar"
      />

      <section className="cp-packages" id="agendar">
        <div className="cp-office">
          {done ? (
            <>
              <SuccessCheck
                title="Tus datos fueron enviados a un Asesor"
                message="Te llamará para coordinar el día y la hora de tu visita"
              />
              {businessWhatsapp && (
                // Sin texto escrito: un mensaje le llegaría al bot, que queda apagado para
                // que lo atienda el asesor.
                <a className="cp-btn cp-btn-wa cp-btn-block" href={`https://wa.me/${businessWhatsapp}`}>
                  Volver a WhatsApp
                </a>
              )}
            </>
          ) : (
            <form className="cp-form" onSubmit={submit}>
              <span className="cp-tag">Reunión en oficina · {form.label}</span>
              <h3>
                Agenda tu <em>visita</em>
              </h3>
              <p className="cp-muted">{form.intro}</p>

              {form.fields.map((field) => (
                <label key={field.key} className="cp-field">
                  <span>
                    {field.label}
                    {!field.required && <small> (opcional)</small>}
                  </span>
                  {field.kind === "textarea" ? (
                    <textarea
                      rows={3}
                      maxLength={field.maxLength}
                      placeholder={field.placeholder}
                      value={values[field.key] ?? ""}
                      onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                    />
                  ) : (
                    <input
                      type="text"
                      autoComplete={field.key === "name" ? "name" : "off"}
                      required={field.required}
                      maxLength={field.maxLength}
                      placeholder={field.placeholder}
                      value={values[field.key] ?? ""}
                      onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
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
        </div>
      </section>

      <footer className="cp-footer">© {new Date().getFullYear()} Conecta Pro</footer>
    </main>
  );
}

export { OfficeView };
