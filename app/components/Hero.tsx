"use client";

// Portada que comparten /paquetes y /cursos: el título gigante y la franja con el video,
// las cifras y el botón que baja a la sección de cada página. Los estilos están en
// app/paquetes/paquetes.css.

import { useEffect, useRef } from "react";

// ⚠️ CIFRAS DE EJEMPLO: reemplazarlas por los datos reales de Conecta Pro antes de publicar.
const HERO_STATS = [
  { value: "+50K", label: "Seguidores en redes" },
  { value: "+20", label: "Empresas confían en nosotros" },
  { value: "+500", label: "Videos producidos" },
];

function Hero({
  title,
  copy,
  ctaLabel,
  ctaHref,
}: {
  title: string;
  copy: string;
  ctaLabel: string;
  ctaHref: string;
}) {
  // React no siempre deja puesto el atributo muted en el HTML, y sin él el navegador
  // interno de WhatsApp (sobre todo en iPhone) bloquea el autoplay. Se fuerza acá.
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
    video.play().catch(() => {});
  }, []);

  return (
    <>
      <section className="cp-hero">
        <div className="cp-topbar">
          <span>©2026</span>
          <span>CONECTA PRO</span>
        </div>
        <h1 className="cp-giant" aria-label={title}>
          {title.toUpperCase()}
        </h1>
      </section>

      <section className="cp-band">
        {/* Video de fondo: img_paginaWeb/video_1.mp4 comprimido y sin audio. */}
        <div className="cp-band-video" aria-hidden>
          <video ref={videoRef} src="/paquetes/portada.mp4" poster="/paquetes/portada.jpg" autoPlay muted loop playsInline preload="auto" />
        </div>
        <ul className="cp-stats-row">
          {HERO_STATS.map((stat) => (
            <li key={stat.label}>
              <strong>{stat.value}</strong>
              <span>{stat.label}</span>
            </li>
          ))}
        </ul>
        <div className="cp-band-left">
          <p className="cp-band-copy">{copy}</p>
          <a className="cp-btn cp-btn-hero" href={ctaHref}>
            {ctaLabel} <span className="cp-btn-arrow" aria-hidden>↓</span>
          </a>
        </div>
      </section>
    </>
  );
}

export { Hero };
