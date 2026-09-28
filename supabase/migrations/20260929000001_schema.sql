-- Milk Distribution — database schema (Supabase / Postgres).
--
-- All tables live in the private `app` schema, which Supabase's API does not
-- expose. The app's only way in is the functions in `public` (see
-- ..._api.sql): each checks the caller's session and role before touching
-- data, so security can't be bypassed from the browser.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;

-- ---- Settings ------------------------------------------------------------

create table app.settings (
  key text primary key,
  value text not null
);

-- Business day, order cutoffs etc. are all in this time zone.
insert into app.settings (key, value) values ('timezone', 'Asia/Kolkata');

-- ---- Master data ---------------------------------------------------------

create table app.products (
  id text primary key default 'P' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
  name text not null check (btrim(name) <> ''),
  unit text not null default '',
  price numeric(12, 2) not null check (price >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table app.routes (
  id text primary key default 'R' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
  name text not null check (btrim(name) <> ''),
  villages text not null default '',
  default_vehicle text not null default '',
  default_driver text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---- People ----------------------------------------------------------------
-- Staff and shop owners log in with phone number + 6-digit PIN. PINs are
-- stored as bcrypt hashes. After 5 wrong PINs an account is locked for 15
-- minutes (failed_logins / locked_until).

create table app.staff (
  id text primary key default 'U' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
  name text not null check (btrim(name) <> ''),
  phone text not null unique check (phone ~ '^\d{10}$'),
  pin_hash text not null,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  active boolean not null default true,
  failed_logins int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

create table app.shops (
  id text primary key default 'S' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
  name text not null check (btrim(name) <> ''),
  owner_name text not null default '',
  phone text not null unique check (phone ~ '^\d{10}$'),
  route_id text not null references app.routes (id),
  active boolean not null default true,
  pin_hash text,
  -- PINs imported from the Google Sheet version (salted SHA-256). Accepted
  -- once, then replaced by a bcrypt hash — so shops keep their PINs.
  legacy_pin_hash text,
  legacy_pin_salt text,
  failed_logins int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

-- Login sessions. Only a SHA-256 of the token is stored, so a leaked table
-- can't be used to log in.
create table app.sessions (
  token_hash text primary key,
  staff_id text references app.staff (id) on delete cascade,
  shop_id text references app.shops (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check ((staff_id is null) <> (shop_id is null))
);
create index sessions_expires_idx on app.sessions (expires_at);

-- ---- Trips -----------------------------------------------------------------

create table app.trips (
  id text primary key default 'T' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
  date date not null,
  session text not null check (session in ('Morning', 'Evening')),
  route_id text not null references app.routes (id),
  driver text not null default '',
  vehicle text not null default '',
  status text not null default 'Dispatched' check (status in ('Dispatched', 'Settled')),
  dispatched_total numeric(12, 2) not null default 0,
  returned_total numeric(12, 2),
  amount_due numeric(12, 2),
  cash_handed_over numeric(12, 2),
  discrepancy numeric(12, 2),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  dispatched_by text not null default '',
  settled_by text not null default '',
  reopened_by text not null default '',
  reopened_at timestamptz,
  -- One trip per route per session per day. Enforced here, so two phones
  -- dispatching at once can't create duplicates (no app-level lock needed).
  unique (route_id, date, session)
);
create index trips_date_idx on app.trips (date);
create index trips_status_date_idx on app.trips (status, date);

create table app.trip_items (
  id text primary key default 'TI' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
  trip_id text not null references app.trips (id) on delete cascade,
  product_id text not null references app.products (id),
  price numeric(12, 2) not null,
  qty_dispatched numeric(12, 3) not null check (qty_dispatched >= 0),
  qty_returned numeric(12, 3) not null default 0 check (qty_returned >= 0 and qty_returned <= qty_dispatched),
  dispatched_value numeric(12, 2) not null,
  returned_value numeric(12, 2) not null default 0,
  unique (trip_id, product_id)
);
create index trip_items_trip_idx on app.trip_items (trip_id);

-- ---- Shop orders (indents) ---------------------------------------------------

create table app.indents (
  id text primary key default 'I' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
  date date not null,
  session text not null check (session in ('Morning', 'Evening')),
  shop_id text not null references app.shops (id) on delete cascade,
  route_id text not null references app.routes (id),
  items jsonb not null default '[]'::jsonb, -- [{productId, qty}]
  total numeric(12, 2) not null default 0,
  updated_at timestamptz not null default now(),
  unique (shop_id, date, session)
);
create index indents_date_route_idx on app.indents (date, route_id);

-- ---- Lock the schema down ------------------------------------------------------
-- Nothing in `app` is reachable directly; the public API functions run as
-- the owner (security definer) and do their own checks.

revoke all on schema app from public;
revoke all on all tables in schema app from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema app from anon, authenticated';
    execute 'revoke all on all tables in schema app from anon, authenticated';
  end if;
end $$;
