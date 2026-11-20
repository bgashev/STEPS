-- v1.1062: свои активности. Определение активности — запись синка kind = 'cact' (id вида c<tg>_<n>), лежит рядом с тренировками.
-- Сервер проверяет форму записи, название, лимит (1 бесплатно, 5 с PRO) в routeSync до sync_push; тут только разрешаем сам вид записи.
alter table public.records drop constraint if exists records_kind_check;
alter table public.records add constraint records_kind_check check (kind = any (array['workout','weight','plan','meta','appday','cact']));

create or replace function public.sync_push(p_tg bigint, p_rows jsonb)
returns integer language plpgsql security definer set search_path to 'public' as $function$
declare n integer;
begin
  insert into records (tg_id, kind, id, data, updated, deleted, rev)
  select p_tg, kind, id, data, updated, deleted, nextval('records_rev_seq')
  from (
    select distinct on (kind, id) kind, id, data, updated, deleted
    from (
      select r->>'kind' as kind, r->>'id' as id,
             coalesce(r->'data', '{}'::jsonb) as data,
             case
               when r->>'updated' ~ '^\d+$' then (r->>'updated')::bigint
               when r->>'updated' ~ '^\d+\.\d+$' then floor((r->>'updated')::numeric)::bigint
               when r->>'updated' ~ '^\d{4}-\d{2}-\d{2}T' then (extract(epoch from (r->>'updated')::timestamptz) * 1000)::bigint
               else 0
             end as updated,
             coalesce((r->>'deleted')::boolean, false) as deleted
      from jsonb_array_elements(p_rows) r
      where r->>'kind' in ('workout', 'weight', 'plan', 'meta', 'appday', 'cact') and coalesce(r->>'id', '') <> ''
    ) q
    order by kind, id, updated desc
  ) s
  on conflict (tg_id, kind, id) do update
    set data = excluded.data, updated = excluded.updated, deleted = excluded.deleted, rev = excluded.rev
    where excluded.updated > records.updated;
  get diagnostics n = row_count;
  return n;
end $function$;
