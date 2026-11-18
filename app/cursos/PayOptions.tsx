"use client";

// "Elige tu opción y paga con QR": un curso o el combo de los dos. Al tocar una opción queda
// registrado cuál eligió (/api/course-choice, con el número firmado del link) y aparece el QR con
// el MONTO EXACTO de esa opción: el QR del banco es de monto libre y el cliente tiene que saber
// cuánto escribir. El comprobante se envía por WhatsApp; el equipo recibe la alerta con el monto
// leído y la opción que tocó (ver lib/course-payment-check.ts).

import { useState } from "react";
import "./course-payment.css";

type PayOption = {
  // "combo" o el id de un curso (lib/courses.ts).
  id: string;
  title: string;
  subtitle: string;
  price: number;
  best?: boolean;
};

const formatPrice = (price: number) => price.toLocaleString("es-BO");

function PayOptions({
  options,
  qrUrl,
  whatsappUrl,
}: {
  options: PayOption[];
  qrUrl: string | null;
  // Chat de Conecta Pro para mandar el comprobante. Vacío si no hay número configurado.
  whatsappUrl: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = options.find((option) => option.id === selectedId) ?? null;

  const choose = (option: PayOption) => {
    setSelectedId(option.id);

    // Deja la marca en la conversación del cliente. Sin el número firmado no avisa a nadie.
    const params = new URLSearchParams(window.location.search);
    const wa = params.get("wa");
    const t = params.get("t");
    if (wa && t) {
      fetch("/api/course-choice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ option: option.id, wa, t }),
        keepalive: true,
      }).catch(() => {});
    }
  };

  if (options.length === 0) return null;

  return (
    <section className="cp-options-section" id="pagar">
      <h3 className="cp-options-title">Elige tu opción</h3>

      <div className="cp-options">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`cp-option${option.best ? " cp-option-best" : ""}${
              option.id === selectedId ? " cp-option-active" : ""
            }`}
            onClick={() => choose(option)}
            aria-pressed={option.id === selectedId}
          >
            {option.best && <span className="cp-option-flag">Mejor precio 🔥</span>}
            <strong className="cp-option-price">{formatPrice(option.price)} Bs</strong>
            <span className="cp-option-name">{option.title}</span>
            <span className="cp-option-sub">{option.subtitle}</span>
            <span className="cp-option-cta">Pagar con QR</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="cp-pay cp-pay-panel">
          <h4>Paga {selected.title}</h4>
          <p className="cp-pay-amount">
            Escribe este monto en tu app: <strong>{formatPrice(selected.price)} Bs</strong>
          </p>

          {qrUrl ? (
            <div className="cp-pay-qr">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrUrl} alt="QR de pago" />
            </div>
          ) : (
            <p className="cp-pay-help">
              Escríbenos por WhatsApp y te pasamos el QR de pago.
            </p>
          )}

          <ol className="cp-pay-steps">
            <li>Escanea el QR con la app de tu banco.</li>
            <li>
              Escribe <strong>{formatPrice(selected.price)} Bs</strong> y paga.
            </li>
            <li>Envíanos el comprobante por WhatsApp junto con tu nombre completo.</li>
          </ol>

          {whatsappUrl && (
            <a className="cp-btn cp-btn-wa" href={whatsappUrl}>
              Enviar mi comprobante por WhatsApp
            </a>
          )}
          <button type="button" className="cp-pay-back" onClick={() => setSelectedId(null)}>
            Elegir otra opción
          </button>
        </div>
      )}
    </section>
  );
}

export { PayOptions };
export type { PayOption };
