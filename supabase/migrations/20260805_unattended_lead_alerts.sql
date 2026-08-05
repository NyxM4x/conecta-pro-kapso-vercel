-- Escalación de leads sin atender: registra cuándo un humano respondió por primera
-- vez a un lead ya notificado (advisor_replied_at) y cuándo se envió la alerta de
-- escalación 🚨 a Telegram (unattended_alert_sent_at), para que el cron de
-- app/api/cron/unattended-leads detecte leads "olvidados" sin re-escanear
-- kapso_messages en cada corrida. Correr una vez en el SQL Editor de Supabase.

alter table kapso_conversations
  add column if not exists advisor_replied_at timestamptz,
  add column if not exists unattended_alert_sent_at timestamptz;

-- Índice para la query del cron: candidatos son advisor_notified sin respuesta ni
-- alerta previa, ordenados/filtrados por advisor_notified_at.
create index if not exists kapso_conversations_unattended_leads_idx
  on kapso_conversations (flow_stage, advisor_notified_at)
  where advisor_replied_at is null and unattended_alert_sent_at is null;

-- Backfill: para conversaciones ya en advisor_notified con respuesta humana
-- registrada en kapso_messages (marcador business_app_manual posterior a la
-- notificación), completar advisor_replied_at para que no disparen una alerta
-- retroactiva injustificada en la primera corrida del cron.
update kapso_conversations c
set advisor_replied_at = m.first_reply_at
from (
  select kapso_conversation_id, min(message_timestamp) as first_reply_at
  from kapso_messages
  where direction = 'outbound'
    and raw_payload->>'source' = 'business_app_manual'
  group by kapso_conversation_id
) m
where c.kapso_conversation_id = m.kapso_conversation_id
  and c.flow_stage = 'advisor_notified'
  and c.advisor_notified_at is not null
  and m.first_reply_at > c.advisor_notified_at
  and c.advisor_replied_at is null;
