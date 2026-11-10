-- Вход в WEB по @username и паролю (функция voob-pass). Храним только PBKDF2-хеш с солью.
create table if not exists public.user_passwords (
  tg_id bigint primary key,
  pwd_hash text not null,
  pwd_salt text not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.pass_attempts (
  id bigserial primary key,
  k text not null,
  at timestamptz not null default now()
);
create index if not exists pass_attempts_k_at on public.pass_attempts (k, at);
alter table public.user_passwords enable row level security;
alter table public.pass_attempts enable row level security;
grant select, insert, update, delete on public.user_passwords, public.pass_attempts to service_role;
grant usage, select on sequence public.pass_attempts_id_seq to service_role;
