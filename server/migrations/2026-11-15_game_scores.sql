-- v1.861: рекорды в играх для рейтинга друзей
create table if not exists public.game_scores (
  tg_id bigint not null,
  game text not null check (game ~ '^[a-z0-9]{2,12}$'),
  best integer not null check (best > 0 and best < 1000000),
  updated timestamptz not null default now(),
  primary key (tg_id, game)
);
create index if not exists game_scores_game_best on public.game_scores (game, best desc);
alter table public.game_scores enable row level security;
