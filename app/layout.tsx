// Layout raíz. Hasta ahora la app solo tenía rutas de API; la primera página pública
// (/paquetes) necesita este archivo para que Next la pueda renderizar.

import type { Metadata, Viewport } from "next";
import { Bebas_Neue, Plus_Jakarta_Sans, Unbounded } from "next/font/google";

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-body", display: "swap" });
// Títulos, cifras y números de las tarjetas.
const unbounded = Unbounded({ subsets: ["latin"], weight: ["500", "700"], variable: "--font-heading", display: "swap" });
const bebas = Bebas_Neue({ subsets: ["latin"], weight: "400", variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  title: "Conecta Pro",
  description: "Paquetes de contenido para tu negocio.",
};

// El navegador interno de WhatsApp pinta la barra con este color.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${jakarta.variable} ${unbounded.variable} ${bebas.variable}`}>
      <body>{children}</body>
    </html>
  );
}
