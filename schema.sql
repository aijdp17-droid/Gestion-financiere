-- ============================================================
-- LAMINA — Schema Supabase
-- Apetaho ity ao amin'ny SQL Editor > New query > Run
-- ============================================================

-- 1) PROFILES
-- Mifandray amin'ny auth.users (ny tabilao Auth an'i Supabase)
create table if not exists profiles (
  id uuid references auth.users on delete cascade primary key,
  name text not null default '',
  email text not null,
  avatar_url text,
  pin text default '0000',
  last_backup timestamptz,
  created_at timestamptz default now()
);

alter table profiles enable row level security;

create policy "Ny olona afaka mahita/manova ny profil-ny ihany"
  on profiles for all
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- 2) TRANSACTIONS
create table if not exists transactions (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users on delete cascade not null,
  type text not null check (type in ('income','expense')),
  amount numeric not null,
  category text not null,
  note text,
  tx_date timestamptz not null default now(),
  created_at timestamptz default now()
);

alter table transactions enable row level security;

create policy "Ny olona afaka mahita/manova ny transaction-ny ihany"
  on transactions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 3) DEBTS (Trosa)
create table if not exists debts (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users on delete cascade not null,
  type text not null check (type in ('lent','borrowed')),
  person text not null,
  amount numeric not null,
  status text not null default 'unpaid' check (status in ('unpaid','paid')),
  debt_date timestamptz not null default now(),
  due_date timestamptz,
  created_at timestamptz default now()
);

alter table debts enable row level security;

create policy "Ny olona afaka mahita/manova ny trosa-ny ihany"
  on debts for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 4) Fomba mahazo profil vaovao mandeha ho azy rehefa misy fisoratana anarana
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', ''), new.email);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
