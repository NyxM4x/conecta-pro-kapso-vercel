// Vigencia por fecha de los materiales de kapso_media_assets.
//
// Columnas OPCIONALES (ver supabase/migrations/20260806_promo_bolivia_service_packages.sql):
//   starts_at  — inclusivo. Antes de ese instante el material aún no se anuncia.
//   expires_at — EXCLUSIVO. Desde ese instante deja de enviarse.
//
// Una fila sin fechas es válida para siempre: es el comportamiento que existía antes de
// que hubiera materiales temporales, y es lo que mantiene intactos los flyers, el QR de
// pago y el video de ubicación.
//
// Son timestamptz, es decir instantes absolutos: la comparación no depende de la zona
// horaria del servidor (Vercel corre en UTC, el negocio en America/La_Paz). Para vencer
// al final del 7 de agosto en Bolivia se guarda 2026-08-08T00:00:00-04:00.

type MediaAssetWindow = {
  starts_at?: string | null;
  expires_at?: string | null;
};

// Una fecha ilegible se ignora (se trata como "sin límite") en vez de descartar la fila:
// un typo en la base no debe dejar al cliente sin su material.
function parseWindowDate(value: string | null | undefined): number | null {
  if (!value) return null;

  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isMediaAssetInWindow(asset: MediaAssetWindow, now: number): boolean {
  const startsAt = parseWindowDate(asset.starts_at);
  const expiresAt = parseWindowDate(asset.expires_at);

  if (startsAt !== null && now < startsAt) return false;
  if (expiresAt !== null && now >= expiresAt) return false;

  return true;
}

export { isMediaAssetInWindow };
export type { MediaAssetWindow };
