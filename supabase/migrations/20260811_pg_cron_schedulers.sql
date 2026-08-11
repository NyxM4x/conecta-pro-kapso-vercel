-- Disparadores de los dos jobs programados del proyecto, que quedaron muertos
-- cuando se sacaron los crons de vercel.json (el plan Hobby de Vercel solo permite
-- una corrida diaria y bloqueaba el deploy). Desde acá los invoca pg_cron dentro de
-- Supabase, sin depender del plan de Vercel:
--   */10 * * * *  -> /api/cron/unattended-leads  (alerta 🚨 de lead sin atender)
--   */10 * * * *  -> /api/followups/run          (reactivación de intake incompleto)
-- El umbral de 30 min NO se define acá: lo aplica el propio endpoint
-- (UNATTENDED_LEAD_THRESHOLD_MINUTES). El cron solo corre lo bastante seguido para
-- que la alerta no llegue tarde.
--
-- Correr una vez en el SQL Editor de Supabase. Antes de correr, REEMPLAZAR el valor
-- de app_base_url en el bloque de abajo por la URL de producción del proyecto.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- El secret viaja en el header X-Followup-Secret y tiene que coincidir con la env
-- var FOLLOWUP_SECRET del proyecto en Vercel (ver isAuthorized en ambos endpoints).
-- Se guarda en Vault para no versionarlo en git ni dejarlo legible en cron.job.
-- REEMPLAZAR '<FOLLOWUP_SECRET>' por el valor real; correr este bloque una sola vez.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'followup_secret') then
    perform vault.create_secret('<FOLLOWUP_SECRET>', 'followup_secret');
  end if;

  if not exists (select 1 from vault.secrets where name = 'app_base_url') then
    perform vault.create_secret('https://<APP>.vercel.app', 'app_base_url');
  end if;
end $$;

-- Desprogramar primero para que la migración sea re-ejecutable sin duplicar jobs.
select cron.unschedule(jobid)
from cron.job
where jobname in ('unattended-leads', 'followups-run');

-- Ambos endpoints exportan GET y POST contra el mismo handler; GET sin body es lo
-- más simple con pg_net. Las llamadas son asíncronas: el resultado HTTP real no
-- queda en cron.job_run_details sino en net._http_response.
select cron.schedule(
  'unattended-leads',
  '*/10 * * * *',
  $cron$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'app_base_url')
           || '/api/cron/unattended-leads',
    headers := jsonb_build_object(
      'X-Followup-Secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'followup_secret')
    )
  );
  $cron$
);

select cron.schedule(
  'followups-run',
  '*/10 * * * *',
  $cron$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'app_base_url')
           || '/api/followups/run',
    headers := jsonb_build_object(
      'X-Followup-Secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'followup_secret')
    )
  );
  $cron$
);

-- Verificación:
--   select jobid, jobname, schedule, active from cron.job;
--   select jobid, status, return_message, start_time
--     from cron.job_run_details order by start_time desc limit 10;
--   select id, status_code, content, created
--     from net._http_response order by created desc limit 10;   -- 200 esperado, 401 = secret mal

