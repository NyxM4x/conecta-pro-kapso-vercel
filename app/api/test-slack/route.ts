export async function GET() {
  const webhookUrl = process.env.SLACK_ALERT_WEBHOOK_URL;

  if (!webhookUrl) {
    return Response.json(
      { ok: false, error: "SLACK_ALERT_WEBHOOK_URL missing" },
      { status: 500 },
    );
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "✅ Prueba de alerta Slack desde Vercel funcionando.",
    }),
  });

  return Response.json({
    ok: response.ok,
    status: response.status,
  });
}