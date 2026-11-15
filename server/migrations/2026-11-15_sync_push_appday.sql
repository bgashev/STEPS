-- v1.847: вода и еда из «Приложений» синхронизируются между Telegram и WEB (запись на день, kind = 'appday')
create or replace function public.sync_push(p_tg bigint, p_rows jsonb)
returns integer language plpgsql security definer set search_path to 'public' as $function$
declare n integer;
begin
  insert into records (tg_id, kind, id, data, updated, deleted, rev)
  select p_tg, kind, id, data, updated, deleted, nextval('records_rev_seq')
  from (
    select distinct on (r->>'kind', r->>'id')
           r->>'kind' as kind, r->>'id' as id,
           coalesce(r->'data', '{}'::jsonb) as data,
           coalesce((r->>'updated')::bigint, 0) as updated,
           coalesce((r->>'deleted')::boolean, false) as deleted
    from jsonb_array_elements(p_rows) r
    where r->>'kind' in ('workout', 'weight', 'plan', 'meta', 'appday') and coalesce(r->>'id', '') <> ''
    order by r->>'kind', r->>'id', coalesce((r->>'updated')::bigint, 0) desc
  ) s
  on conflict (tg_id, kind, id) do update
    set data = excluded.data, updated = excluded.updated, deleted = excluded.deleted, rev = excluded.rev
    where excluded.updated > records.updated;
  get diagnostics n = row_count;
  return n;
end $function$;
