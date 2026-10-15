"use client";

// Avisa que el cliente abrió la página desde el botón del bot (ver app/api/site-visit). No
// muestra nada. Sin el número firmado en la URL no avisa: no hay conversación que marcar.

import { useEffect } from "react";
import type { SitePage } from "../../lib/site-links";

function VisitBeacon({ page }: { page: SitePage }) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wa = params.get("wa");
    const t = params.get("t");
    if (!wa || !t) return;

    fetch("/api/site-visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page, wa, t }),
      keepalive: true,
    }).catch(() => {});
  }, [page]);

  return null;
}

export { VisitBeacon };
