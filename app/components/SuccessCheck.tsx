// Check grande de "listo" para cuando el cliente termina algo en la página: sus datos
// llegaron al asesor, o el pago llegó. Reemplaza al mensaje de confirmación por WhatsApp:
// el bot se queda callado (ahorro de mensajes) y esta animación es la que deja tranquilo al
// cliente.
//
// Copia la animación de referencia: un punto verde entra con estela desde abajo, cae al
// centro y se convierte en el check, que crece con un rebote y suelta unas partículas.
// Solo SVG y CSS (success-check.css), sin librerías.

import "./success-check.css";

function SuccessCheck({ title, message }: { title: string; message?: string }) {
  return (
    <div className="cp-check" role="status" aria-live="polite">
      <svg className="cp-check-art" viewBox="0 0 120 120" aria-hidden="true">
        {/* Estela y punto que entra */}
        <line className="cp-check-trail" x1="30" y1="78" x2="38" y2="52" />
        <circle className="cp-check-dot" cx="60" cy="60" r="6" />

        {/* Anillitos que acompañan al punto */}
        <circle className="cp-check-ring cp-check-ring-a" cx="44" cy="30" r="2.6" />
        <circle className="cp-check-ring cp-check-ring-b" cx="50" cy="27" r="1.4" />

        {/* El check */}
        <path className="cp-check-mark" d="M36 62 L52 77 L84 44" />

        {/* Partículas al terminar */}
        <circle className="cp-check-ring cp-check-burst-a" cx="92" cy="36" r="2.6" />
        <circle className="cp-check-ring cp-check-burst-b" cx="98" cy="32" r="1.3" />
        <line className="cp-check-dash cp-check-burst-c" x1="56" y1="88" x2="66" y2="80" />
        <circle className="cp-check-ring cp-check-burst-d" cx="46" cy="96" r="2" />
        <circle className="cp-check-spark cp-check-burst-e" cx="40" cy="98" r="1.4" />
      </svg>

      <p className="cp-check-title">{title}</p>
      {message && <p className="cp-check-text">{message}</p>}
    </div>
  );
}

export { SuccessCheck };
