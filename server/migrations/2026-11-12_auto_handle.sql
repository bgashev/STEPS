-- v1.763: у каждого пользователя всегда есть @ник (ссылка app.voob.kz/@ник).
-- Временный ник вида voob_3f9a1c7e (8 случайных hex-символов — перебором не найти); человек меняет его в настройках как обычный.
create or replace function public.voob_auto_handle() returns text language plpgsql as $$
declare h text; i int := 0;
begin
  loop
    h := 'voob_' || substr(md5(gen_random_uuid()::text), 1, 8);
    exit when not exists (select 1 from public.users where lower(handle) = h);
    i := i + 1; if i > 20 then raise exception 'auto handle failed'; end if;
  end loop;
  return h;
end $$;

create or replace function public.voob_users_handle_fill() returns trigger language plpgsql as $$
begin
  if new.handle is null or btrim(new.handle) = '' then new.handle := public.voob_auto_handle(); end if;
  return new;
end $$;

drop trigger if exists voob_users_handle_fill on public.users;
create trigger voob_users_handle_fill before insert or update of handle on public.users
  for each row execute function public.voob_users_handle_fill();

-- тем, у кого ника нет сейчас
update public.users set handle = public.voob_auto_handle() where handle is null or btrim(handle) = '';
