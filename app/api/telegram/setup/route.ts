// Registro del webhook del bot de Telegram. Se llama UNA vez después de desplegar (o si
// cambia el dominio o el secreto):
//
//   curl -X POST https://<dominio>/api/telegram/setup -H "X-Bot-Control-Secret: <BOT_CONTROL_SECRET>"
//
// Apunta el bot a /api/telegram/webhook con TELEGRAM_WEBHOOK_SECRET y publica los comandos
// en el menú del bot (el webhook también los republica solo al arrancar). Protegido con el
// mismo secreto que /api/bot-control.

import { callTelegramApi } from "../../../../lib/telegram";

export async function POST(request: Request) {
  const controlSecret = process.env.BOT_CONTROL_SECRET;
  if (!controlSecret || request.headers.get("X-Bot-Control-Secret") !== controlSecret) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!webhookSecret || !process.env.TELEGRAM_BOT_TOKEN) {
    return Response.json(
      { ok: false, error: "Faltan TELEGRAM_WEBHOOK_SECRET o TELEGRAM_BOT_TOKEN" },
      { status: 400 },
    );
  }

  // Detrás de un proxy (Traefik en Dokploy) request.url trae "localhost:3000", que Telegram
  // rechaza. El dominio público viaja en X-Forwarded-Host / X-Forwarded-Proto.
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const origin = forwardedHost ? `${forwardedProto}://${forwardedHost}` : new URL(request.url).origin;
  const url = `${origin}/api/telegram/webhook`;

  const webhook = await callTelegramApi("setWebhook", {
    url,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
  });

  const commands = await callTelegramApi("setMyCommands", {
    commands: [
      { command: "menu", description: "Botones del equipo" },
      { command: "pagos", description: "Lista de comprobantes por rango de fechas" },
      { command: "visitas", description: "Visitas a la oficina por coordinar" },
    ],
  });

  return Response.json({ ok: Boolean(webhook && commands), url, webhook, commands });
}
