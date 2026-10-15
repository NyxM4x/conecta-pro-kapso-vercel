"use client";

// Pago del curso dentro de la página: el QR, una barra de espera mientras el banco confirma y,
// cuando llega el pago, el check grande con "El pago llegó con éxito".
//
// ⚠️ Todavía NO hay API del banco: este componente está listo, pero /cursos solo lo muestra
// en modo demostración (/cursos?demo=pago, con un QR de ejemplo y una confirmación simulada).
// Mientras tanto el pago real sigue por el chat, con el QR que manda el bot. Para conectarlo:
// pasar `checkPayment` con la consulta a la API del banco y mostrarlo cuando el curso esté a
// la venta.

import { useEffect, useState } from "react";
import { SuccessCheck } from "../components/SuccessCheck";
import "./course-payment.css";

type PaymentStatus = "pending" | "paid";

// Cada cuánto se pregunta al banco si el pago llegó.
const POLL_EVERY_MS = 4000;
// En la demostración el "banco" confirma solo a los pocos segundos.
const DEMO_CONFIRM_AFTER_MS = 9000;

function CoursePayment({
  courseName,
  price,
  qrUrl,
  checkPayment,
  demo = false,
}: {
  courseName: string;
  price: number;
  // Imagen del QR. Sin ella (demostración) se dibuja uno de ejemplo.
  qrUrl?: string;
  checkPayment?: () => Promise<PaymentStatus>;
  demo?: boolean;
}) {
  const [status, setStatus] = useState<PaymentStatus>("pending");

  useEffect(() => {
    if (status === "paid") return;

    if (demo) {
      const timer = setTimeout(() => setStatus("paid"), DEMO_CONFIRM_AFTER_MS);
      return () => clearTimeout(timer);
    }

    if (!checkPayment) return;
    const timer = setInterval(async () => {
      try {
        if ((await checkPayment()) === "paid") setStatus("paid");
      } catch {
        // Un fallo de red no corta la espera: se vuelve a preguntar en el próximo ciclo.
      }
    }, POLL_EVERY_MS);
    return () => clearInterval(timer);
  }, [status, demo, checkPayment]);

  if (status === "paid") {
    return (
      <SuccessCheck
        title="El pago llegó con éxito"
        message={`Tu cupo para el ${courseName} está reservado`}
      />
    );
  }

  return (
    <div className="cp-pay">
      {demo && <span className="cp-tag">Demostración · QR de ejemplo</span>}
      <h4>Paga tu cupo con QR</h4>
      <p className="cp-pay-amount">
        <strong>{price.toLocaleString("es-BO")} Bs</strong> · {courseName}
      </p>

      <div className="cp-pay-qr">
        {qrUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qrUrl} alt="QR de pago" />
        ) : (
          <DemoQr />
        )}
      </div>

      <p className="cp-pay-help">Escanéalo con la app de tu banco y no cierres esta página.</p>

      <div className="cp-pay-wait" role="status" aria-live="polite">
        <div className="cp-pay-bar">
          <span />
        </div>
        <p>Esperando la confirmación del banco…</p>
      </div>
    </div>
  );
}

// QR de mentira para la demostración: no se puede pagar con él.
function DemoQr() {
  const cells: string[] = [];
  for (let y = 0; y < 21; y++) {
    for (let x = 0; x < 21; x++) {
      const finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
      const on = finder
        ? x % 6 === 0 || y % 6 === 0 || (x % 7 > 1 && x % 7 < 5 && y % 7 > 1 && y % 7 < 5)
        : (x * 7 + y * 13 + x * y) % 3 === 0;
      if (on) cells.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  return (
    <svg viewBox="-1 -1 23 23" aria-label="QR de ejemplo" role="img">
      <rect x="-1" y="-1" width="23" height="23" fill="#fff" />
      <path d={cells.join("")} fill="#111" />
    </svg>
  );
}

export { CoursePayment };
export type { PaymentStatus };
