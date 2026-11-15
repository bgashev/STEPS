-- №6 «друг за награду» (v1.836)
create table if not exists public.referral_rewards (
  newbie bigint primary key references public.users(tg_id) on delete cascade,
  inviter bigint not null references public.users(tg_id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists referral_rewards_inviter on public.referral_rewards(inviter);
alter table public.referral_rewards enable row level security;
grant select, insert, update, delete on public.referral_rewards to service_role;
