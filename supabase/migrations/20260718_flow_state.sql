-- Máquina de estados del flujo de paquetes en kapso_conversations.
-- Reemplaza la inferencia frágil por marcadores de texto ([INTAKE_FORM_SENT]…)
-- por estado explícito y consultable. Correr una vez en el SQL Editor de Supabase.
--
-- flow_stage: browsing -> package_selected -> intake_sent -> lead_captured -> advisor_notified

alter table kapso_conversations
  add column if not exists flow_stage text not null default 'browsing',
  add column if not exists selected_package text,            -- 'express' | 'premium' | null
  add column if not exists intake_form_sent_at timestamptz,
  add column if not exists lead_captured_at timestamptz,
  add column if not exists advisor_notified_at timestamptz;

-- Índice para el consumidor de follow-ups (busca pendientes vencidos).
create index if not exists kapso_followups_pending_due_idx
  on kapso_followups (status, scheduled_at);

-- Backfill: marcar como intake_sent las conversaciones que ya enviaron el
-- formulario (según el marcador histórico en kapso_messages), y como
-- advisor_notified las que ya generaron un lead a Telegram. Así el estado
-- explícito arranca coherente con el historial existente.
update kapso_conversations c
set
  flow_stage = 'intake_sent',
  intake_form_sent_at = coalesce(c.intake_form_sent_at, m.first_at)
from (
  select kapso_conversation_id, min(created_at) as first_at
  from kapso_messages
  where direction = 'outbound' and content ilike '[INTAKE_FORM_SENT]%'
  group by kapso_conversation_id
) m
where c.kapso_conversation_id = m.kapso_conversation_id
  and c.flow_stage = 'browsing';

update kapso_conversations c
set
  flow_stage = 'advisor_notified',
  advisor_notified_at = coalesce(c.advisor_notified_at, m.first_at),
  lead_captured_at = coalesce(c.lead_captured_at, m.first_at)
from (
  select kapso_conversation_id, min(created_at) as first_at
  from kapso_messages
  where direction = 'outbound' and content ilike '[TELEGRAM_LEAD_SENT]%'
  group by kapso_conversation_id
) m
where c.kapso_conversation_id = m.kapso_conversation_id
  and c.flow_stage in ('browsing', 'intake_sent', 'package_selected');
