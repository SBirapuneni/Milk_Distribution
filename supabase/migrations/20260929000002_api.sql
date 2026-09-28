-- Milk Distribution — API.
--
-- Every function the app calls lives in `public` and is exposed by Supabase
-- as POST /rest/v1/rpc/<name>. Each takes the caller's session token and a
-- JSON payload, checks the session (and role) first, and runs in a single
-- transaction. They run as the schema owner (security definer), so they can
-- read the private `app` tables that the browser can't reach directly.
--
-- Responses use the same field names as the earlier Google Sheets backend,
-- so the app's screens didn't need to change.

-- ============================================================================
-- Internal helpers (schema `app`, not exposed)
-- ============================================================================

create or replace function app.tz() returns text
language sql stable as $$
  select coalesce((select value from app.settings where key = 'timezone'), 'Asia/Kolkata')
$$;

/** Current wall-clock time in the business time zone. */
create or replace function app.local_now() returns timestamp
language sql stable as $$
  select (now() at time zone app.tz())::timestamp(0)
$$;

create or replace function app.today() returns date
language sql stable as $$
  select app.local_now()::date
$$;

/** Last 10 digits, so "+91 98480-12345" and "9848012345" match; null if too short. */
create or replace function app.normalize_phone(p text) returns text
language sql immutable as $$
  select case when length(d) >= 10 then right(d, 10) end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$$;

create or replace function app.parse_date(v text) returns date
language plpgsql immutable as $$
begin
  if v is null or v !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Date must be in yyyy-MM-dd format';
  end if;
  return v::date;
end $$;

create or replace function app.parse_session(v text) returns text
language plpgsql immutable as $$
begin
  if v is distinct from 'Morning' and v is distinct from 'Evening' then
    raise exception 'Session must be Morning or Evening';
  end if;
  return v;
end $$;

/** Non-negative number from a JSON value; blank → 0. */
create or replace function app.num(v text, p_label text default 'quantity') returns numeric
language plpgsql immutable as $$
begin
  if v is null or btrim(v) = '' then return 0; end if;
  if v !~ '^\s*\d+(\.\d+)?\s*$' then
    raise exception 'Invalid %: %', p_label, v;
  end if;
  return v::numeric;
end $$;

-- ---- PINs and sessions --------------------------------------------------------

create or replace function app.new_pin() returns text
language sql volatile as $$
  select lpad(((('x' || lpad(encode(extensions.gen_random_bytes(4), 'hex'), 16, '0'))::bit(64)::bigint) % 1000000)::text, 6, '0')
$$;

create or replace function app.hash_pin(pin text) returns text
language sql volatile as $$
  select extensions.crypt(pin, extensions.gen_salt('bf', 8))
$$;

create or replace function app.pin_ok(pin text, hash text) returns boolean
language sql stable as $$
  select hash is not null and hash = extensions.crypt(coalesce(pin, ''), hash)
$$;

create or replace function app.hash_token(t text) returns text
language sql immutable as $$
  select encode(extensions.digest(coalesce(t, ''), 'sha256'), 'hex')
$$;

create or replace function app.start_session(p_staff text, p_shop text, p_days int) returns text
language plpgsql as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  delete from app.sessions where expires_at < now();
  insert into app.sessions (token_hash, staff_id, shop_id, expires_at)
  values (app.hash_token(v_token), p_staff, p_shop, now() + make_interval(days => p_days));
  return v_token;
end $$;

-- Staff sessions last 7 days, shop sessions 30 (shop owners order daily and
-- shouldn't have to keep re-entering their PIN). Both slide: using the app
-- extends them.
create or replace function app.require_staff(p_token text, p_admin boolean default false) returns app.staff
language plpgsql as $$
declare
  v app.staff;
  v_hash text := app.hash_token(p_token);
begin
  select s.* into v
  from app.sessions ss join app.staff s on s.id = ss.staff_id
  where ss.token_hash = v_hash and ss.expires_at > now() and s.active;
  if not found then
    raise exception 'Please log in again.' using hint = 'relogin';
  end if;
  update app.sessions set expires_at = now() + interval '7 days'
  where token_hash = v_hash and expires_at < now() + interval '6 days';
  if p_admin and v.role <> 'admin' then
    raise exception 'Only an admin can do this.';
  end if;
  return v;
end $$;

create or replace function app.require_shop(p_token text) returns app.shops
language plpgsql as $$
declare
  v app.shops;
  v_hash text := app.hash_token(p_token);
begin
  select s.* into v
  from app.sessions ss join app.shops s on s.id = ss.shop_id
  where ss.token_hash = v_hash and ss.expires_at > now() and s.active;
  if not found then
    raise exception 'Please log in again.' using hint = 'relogin';
  end if;
  update app.sessions set expires_at = now() + interval '30 days'
  where token_hash = v_hash and expires_at < now() + interval '29 days';
  return v;
end $$;

-- ---- JSON shapes ----------------------------------------------------------------

/** Value as JSON, or "" for null (the app's types use '' for "not set yet"). */
create or replace function app.j(x anyelement) returns jsonb
language sql immutable as $$
  select coalesce(to_jsonb(x), '""'::jsonb)
$$;

create or replace function app.trip_json(t app.trips) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'TripId', t.id,
    'Date', to_char(t.date, 'YYYY-MM-DD'),
    'Session', t.session,
    'RouteId', t.route_id,
    'Driver', t.driver,
    'Vehicle', t.vehicle,
    'Status', t.status,
    'DispatchedTotal', t.dispatched_total,
    'ReturnedTotal', app.j(t.returned_total),
    'AmountDue', app.j(t.amount_due),
    'CashHandedOver', app.j(t.cash_handed_over),
    'Discrepancy', app.j(t.discrepancy),
    'CreatedAt', app.j(t.created_at),
    'SettledAt', app.j(t.settled_at),
    'DispatchedBy', t.dispatched_by,
    'SettledBy', t.settled_by,
    'ReopenedBy', t.reopened_by,
    'ReopenedAt', app.j(t.reopened_at)
  )
$$;

create or replace function app.item_json(i app.trip_items) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'TripItemId', i.id,
    'TripId', i.trip_id,
    'ProductId', i.product_id,
    'Price', i.price,
    'QtyDispatched', i.qty_dispatched,
    'QtyReturned', i.qty_returned,
    'DispatchedValue', i.dispatched_value,
    'ReturnedValue', i.returned_value
  )
$$;

create or replace function app.trip_with_items(p_trip_id text) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'trip', app.trip_json(t),
    -- Items in the same order as the product list.
    'items', coalesce((select jsonb_agg(app.item_json(i) order by pr.created_at, pr.name)
                       from app.trip_items i join app.products pr on pr.id = i.product_id
                       where i.trip_id = t.id), '[]'::jsonb)
  )
  from app.trips t where t.id = p_trip_id
$$;

create or replace function app.indent_json(o app.indents) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'indentId', o.id,
    'date', to_char(o.date, 'YYYY-MM-DD'),
    'session', o.session,
    'shopId', o.shop_id,
    'routeId', o.route_id,
    'items', o.items,
    'total', o.total,
    'updatedAt', to_char(o.updated_at at time zone app.tz(), 'YYYY-MM-DD HH24:MI')
  )
$$;

create or replace function app.master_json(p_admin boolean) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('ProductId', id, 'Name', name, 'Unit', unit, 'Price', price, 'Active', active)
                       order by created_at, name)
      from app.products), '[]'::jsonb),
    'routes', coalesce((
      select jsonb_agg(jsonb_build_object('RouteId', id, 'Name', name, 'Villages', villages,
                                          'DefaultVehicle', default_vehicle, 'DefaultDriver', default_driver, 'Active', active)
                       order by created_at, name)
      from app.routes), '[]'::jsonb),
    -- Never includes PIN hashes.
    'shops', coalesce((
      select jsonb_agg(jsonb_build_object('ShopId', id, 'Name', name, 'OwnerName', owner_name, 'Phone', phone,
                                          'RouteId', route_id, 'Active', active,
                                          'HasPin', pin_hash is not null or legacy_pin_hash is not null)
                       order by name)
      from app.shops), '[]'::jsonb),
    'staff', case when p_admin then coalesce((
      select jsonb_agg(jsonb_build_object('StaffId', id, 'Name', name, 'Phone', phone, 'Role', role, 'Active', active)
                       order by name)
      from app.staff), '[]'::jsonb) else '[]'::jsonb end
  )
$$;

-- ---- Shop order cutoffs --------------------------------------------------------
-- Morning delivery on day D closes at 21:00 on D-1; Evening on D closes at
-- 12:00 on D (business time zone).

create or replace function app.cutoff_for(p_date date, p_session text) returns timestamp
language sql immutable as $$
  select case when p_session = 'Morning' then (p_date - 1) + time '21:00' else p_date + time '12:00' end
$$;

-- Deliveries still open for ordering: cutoff not passed and at most 24 hours
-- away (stretched to always include tomorrow's Evening).
create or replace function app.open_slots() returns table (slot_date date, slot_session text, cutoff timestamp)
language sql stable as $$
  with n as (select app.local_now() as now)
  select c.slot_date, c.slot_session, c.cutoff
  from n,
       lateral (
         select d::date as slot_date, s as slot_session, app.cutoff_for(d::date, s) as cutoff
         from generate_series(n.now::date, n.now::date + 2, interval '1 day') d,
              unnest(array['Morning', 'Evening']) s
       ) c
  where c.cutoff > n.now
    and c.cutoff <= greatest(n.now + interval '24 hours', (n.now::date + 1) + time '12:00')
  order by c.cutoff
$$;

create or replace function app.shop_home_json(v app.shops) returns jsonb
language sql stable as $$
  with slots as (
    select s.slot_date, s.slot_session, s.cutoff, o as indent
    from app.open_slots() s
    left join app.indents o on o.shop_id = v.id and o.date = s.slot_date and o.session = s.slot_session
  ),
  first_open as (select min(cutoff) as cutoff from slots)
  select jsonb_build_object(
    'shop', jsonb_build_object('name', v.name, 'ownerName', v.owner_name,
                               'routeName', coalesce((select name from app.routes where id = v.route_id), '')),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('ProductId', id, 'Name', name, 'Unit', unit, 'Price', price) order by created_at, name)
      from app.products where active), '[]'::jsonb),
    'slots', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', to_char(slot_date, 'YYYY-MM-DD'),
               'session', slot_session,
               'cutoff', to_char(cutoff, 'YYYY-MM-DD HH24:MI'),
               'order', case when (indent).id is null then null else app.indent_json(indent) end)
             order by cutoff)
      from slots), '[]'::jsonb),
    -- Most recent non-empty order for an earlier delivery ("same as last order").
    'lastOrder', (
      select app.indent_json(o)
      from app.indents o, first_open f
      where o.shop_id = v.id and o.items <> '[]'::jsonb
        and app.cutoff_for(o.date, o.session) < coalesce(f.cutoff, 'infinity'::timestamp)
      order by app.cutoff_for(o.date, o.session) desc
      limit 1),
    'now', to_char(app.local_now(), 'YYYY-MM-DD HH24:MI')
  )
$$;

-- ---- Returns / settlement --------------------------------------------------------

create or replace function app.apply_returns(p_trip app.trips, p jsonb, p_finalize boolean, p_by text) returns jsonb
language plpgsql as $$
declare
  v_bad text;
  v_returned numeric;
  v_cash numeric := app.num(p->>'cashHandedOver', 'cash amount');
begin
  create temp table if not exists _returns (product_id text primary key, qty numeric) on commit drop;
  truncate _returns;
  insert into _returns (product_id, qty)
  select distinct on (e->>'productId') e->>'productId', app.num(e->>'qtyReturned')
  from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) e
  where e->>'productId' is not null;

  -- Validate everything before writing anything.
  select i.product_id into v_bad
  from app.trip_items i left join _returns r on r.product_id = i.product_id
  where i.trip_id = p_trip.id and coalesce(r.qty, 0) > i.qty_dispatched
  limit 1;
  if v_bad is not null then
    raise exception 'Returned qty exceeds dispatched qty for product %', v_bad;
  end if;

  update app.trip_items i
  set qty_returned = coalesce(r.qty, 0),
      returned_value = round(coalesce(r.qty, 0) * i.price, 2)
  from app.trip_items i2 left join _returns r on r.product_id = i2.product_id
  where i.id = i2.id and i.trip_id = p_trip.id;

  select coalesce(sum(returned_value), 0) into v_returned from app.trip_items where trip_id = p_trip.id;

  update app.trips
  set status = case when p_finalize then 'Settled' else 'Dispatched' end,
      returned_total = v_returned,
      amount_due = dispatched_total - v_returned,
      cash_handed_over = v_cash,
      discrepancy = v_cash - (dispatched_total - v_returned),
      settled_at = case when p_finalize then now() end,
      settled_by = case when p_finalize then p_by else '' end
  where id = p_trip.id;

  return app.trip_with_items(p_trip.id);
end $$;

-- ============================================================================
-- Public API (exposed at /rest/v1/rpc/<name>)
-- ============================================================================
-- Logins return {ok:false, error} instead of raising, because raising would
-- roll back the failed-attempt counter that drives the lock-out.

create or replace function public.staff_login(p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v app.staff;
  v_phone text := app.normalize_phone(p->>'phone');
begin
  if v_phone is null then
    return jsonb_build_object('ok', false, 'error', 'Enter your 10-digit phone number.');
  end if;
  select * into v from app.staff where phone = v_phone;
  if not found or not v.active then
    return jsonb_build_object('ok', false, 'error', 'Incorrect phone number or PIN.');
  end if;
  if v.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong PINs. Try again in 15 minutes, or ask an admin to reset your PIN.');
  end if;
  if not app.pin_ok(p->>'pin', v.pin_hash) then
    update app.staff
    set failed_logins = case when failed_logins + 1 >= 5 then 0 else failed_logins + 1 end,
        locked_until = case when failed_logins + 1 >= 5 then now() + interval '15 minutes' else locked_until end
    where id = v.id;
    return jsonb_build_object('ok', false, 'error', 'Incorrect phone number or PIN.');
  end if;
  update app.staff set failed_logins = 0, locked_until = null where id = v.id;
  return jsonb_build_object(
    'ok', true,
    'token', app.start_session(v.id, null, 7),
    'staff', jsonb_build_object('id', v.id, 'name', v.name, 'role', v.role),
    'master', app.master_json(v.role = 'admin')
  );
end $$;

create or replace function public.shop_login(p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v app.shops;
  v_phone text := app.normalize_phone(p->>'phone');
  v_pin text := coalesce(p->>'pin', '');
  v_ok boolean;
begin
  if v_phone is null then
    return jsonb_build_object('ok', false, 'error', 'Enter your 10-digit phone number.');
  end if;
  select * into v from app.shops where phone = v_phone;
  if not found or not v.active then
    return jsonb_build_object('ok', false, 'error', 'Incorrect phone number or PIN.');
  end if;
  if v.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong PINs. Try again in 15 minutes, or ask the distributor to reset your PIN.');
  end if;

  v_ok := app.pin_ok(v_pin, v.pin_hash);
  if not v_ok and v.pin_hash is null and v.legacy_pin_hash is not null then
    -- PIN from the Google Sheets version: base64(sha256(salt + ':' + pin)).
    v_ok := encode(extensions.digest(v.legacy_pin_salt || ':' || v_pin, 'sha256'), 'base64') = v.legacy_pin_hash;
    if v_ok then
      update app.shops set pin_hash = app.hash_pin(v_pin), legacy_pin_hash = null, legacy_pin_salt = null where id = v.id;
    end if;
  end if;

  if not v_ok then
    update app.shops
    set failed_logins = case when failed_logins + 1 >= 5 then 0 else failed_logins + 1 end,
        locked_until = case when failed_logins + 1 >= 5 then now() + interval '15 minutes' else locked_until end
    where id = v.id;
    return jsonb_build_object('ok', false, 'error', 'Incorrect phone number or PIN.');
  end if;
  update app.shops set failed_logins = 0, locked_until = null where id = v.id;
  return jsonb_build_object('ok', true, 'token', app.start_session(null, v.id, 30), 'home', app.shop_home_json(v));
end $$;

create or replace function public.logout(p_token text) returns jsonb
language sql security definer set search_path = app, extensions, pg_temp as $$
  delete from app.sessions where token_hash = app.hash_token(p_token);
  select '{}'::jsonb;
$$;

-- ---- Master data --------------------------------------------------------------------

create or replace function public.get_master_data(p_token text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare v app.staff := app.require_staff(p_token);
begin
  return app.master_json(v.role = 'admin');
end $$;

create or replace function public.save_product(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_staff app.staff := app.require_staff(p_token, true);
  v_id text := nullif(p->>'productId', '');
  v_name text := btrim(coalesce(p->>'name', ''));
  v_price numeric;
begin
  if v_name = '' then raise exception 'Product name is required'; end if;
  if coalesce(p->>'price', '') !~ '^\d+(\.\d+)?$' then raise exception 'Price must be a positive number'; end if;
  v_price := (p->>'price')::numeric;
  if v_id is not null then
    update app.products
    set name = v_name, unit = coalesce(p->>'unit', ''), price = v_price, active = coalesce((p->>'active')::boolean, true)
    where id = v_id;
    if not found then raise exception 'Product not found'; end if;
  else
    insert into app.products (name, unit, price, active)
    values (v_name, coalesce(p->>'unit', ''), v_price, coalesce((p->>'active')::boolean, true))
    returning id into v_id;
  end if;
  return app.master_json(true) || jsonb_build_object('productId', v_id);
end $$;

create or replace function public.save_route(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_staff app.staff := app.require_staff(p_token, true);
  v_id text := nullif(p->>'routeId', '');
  v_name text := btrim(coalesce(p->>'name', ''));
begin
  if v_name = '' then raise exception 'Route name is required'; end if;
  if v_id is not null then
    update app.routes
    set name = v_name, villages = coalesce(p->>'villages', ''), default_vehicle = coalesce(p->>'defaultVehicle', ''),
        default_driver = coalesce(p->>'defaultDriver', ''), active = coalesce((p->>'active')::boolean, true)
    where id = v_id;
    if not found then raise exception 'Route not found'; end if;
  else
    insert into app.routes (name, villages, default_vehicle, default_driver, active)
    values (v_name, coalesce(p->>'villages', ''), coalesce(p->>'defaultVehicle', ''),
            coalesce(p->>'defaultDriver', ''), coalesce((p->>'active')::boolean, true))
    returning id into v_id;
  end if;
  return app.master_json(true) || jsonb_build_object('routeId', v_id);
end $$;

-- ---- Shops (admin) -----------------------------------------------------------------------

-- A new shop gets a PIN, returned once (only its hash is stored).
create or replace function public.save_shop(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_staff app.staff := app.require_staff(p_token, true);
  v_id text := nullif(p->>'shopId', '');
  v_name text := btrim(coalesce(p->>'name', ''));
  v_phone text := app.normalize_phone(p->>'phone');
  v_route text := nullif(p->>'routeId', '');
  v_pin text;
  v_clash text;
begin
  if v_name = '' then raise exception 'Shop name is required'; end if;
  if v_phone is null then raise exception 'Enter a 10-digit phone number'; end if;
  if v_route is null or not exists (select 1 from app.routes where id = v_route) then
    raise exception 'Pick the route that serves this shop';
  end if;
  select name into v_clash from app.shops where phone = v_phone and id is distinct from v_id;
  if v_clash is not null then
    raise exception 'Another shop (%) already uses this phone number', v_clash;
  end if;

  if v_id is not null then
    update app.shops
    set name = v_name, owner_name = btrim(coalesce(p->>'ownerName', '')), phone = v_phone,
        route_id = v_route, active = coalesce((p->>'active')::boolean, true)
    where id = v_id;
    if not found then raise exception 'Shop not found'; end if;
    if not coalesce((p->>'active')::boolean, true) then
      delete from app.sessions where shop_id = v_id;
    end if;
  else
    v_pin := app.new_pin();
    insert into app.shops (name, owner_name, phone, route_id, active, pin_hash)
    values (v_name, btrim(coalesce(p->>'ownerName', '')), v_phone, v_route,
            coalesce((p->>'active')::boolean, true), app.hash_pin(v_pin))
    returning id into v_id;
  end if;
  return app.master_json(true) || jsonb_build_object('shopId', v_id, 'pin', v_pin);
end $$;

create or replace function public.reset_shop_pin(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_staff app.staff := app.require_staff(p_token, true);
  v_pin text := app.new_pin();
begin
  update app.shops
  set pin_hash = app.hash_pin(v_pin), legacy_pin_hash = null, legacy_pin_salt = null,
      failed_logins = 0, locked_until = null
  where id = p->>'shopId';
  if not found then raise exception 'Shop not found'; end if;
  delete from app.sessions where shop_id = p->>'shopId'; -- old PIN's logins end too
  return jsonb_build_object('shopId', p->>'shopId', 'pin', v_pin);
end $$;

-- ---- Staff (admin) ---------------------------------------------------------------------

create or replace function public.save_staff(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_me app.staff := app.require_staff(p_token, true);
  v_id text := nullif(p->>'staffId', '');
  v_name text := btrim(coalesce(p->>'name', ''));
  v_phone text := app.normalize_phone(p->>'phone');
  v_role text := coalesce(p->>'role', 'staff');
  v_active boolean := coalesce((p->>'active')::boolean, true);
  v_pin text;
  v_clash text;
begin
  if v_name = '' then raise exception 'Name is required'; end if;
  if v_phone is null then raise exception 'Enter a 10-digit phone number'; end if;
  if v_role not in ('admin', 'staff') then raise exception 'Role must be admin or staff'; end if;
  select name into v_clash from app.staff where phone = v_phone and id is distinct from v_id;
  if v_clash is not null then
    raise exception '% already uses this phone number', v_clash;
  end if;

  if v_id is not null then
    if v_id = v_me.id and (v_role <> 'admin' or not v_active) then
      raise exception 'You can''t remove your own admin access. Ask another admin.';
    end if;
    update app.staff set name = v_name, phone = v_phone, role = v_role, active = v_active where id = v_id;
    if not found then raise exception 'Staff member not found'; end if;
    if not v_active then
      delete from app.sessions where staff_id = v_id;
    end if;
  else
    v_pin := app.new_pin();
    insert into app.staff (name, phone, role, active, pin_hash)
    values (v_name, v_phone, v_role, v_active, app.hash_pin(v_pin))
    returning id into v_id;
  end if;
  return app.master_json(true) || jsonb_build_object('staffId', v_id, 'pin', v_pin);
end $$;

create or replace function public.reset_staff_pin(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_me app.staff := app.require_staff(p_token, true);
  v_pin text := app.new_pin();
begin
  update app.staff set pin_hash = app.hash_pin(v_pin), failed_logins = 0, locked_until = null
  where id = p->>'staffId';
  if not found then raise exception 'Staff member not found'; end if;
  -- End their other logins (but not the session making this request).
  delete from app.sessions where staff_id = p->>'staffId' and token_hash <> app.hash_token(p_token);
  return jsonb_build_object('staffId', p->>'staffId', 'pin', v_pin);
end $$;

-- ---- Trips ---------------------------------------------------------------------------------

-- Everything the Route screen needs in one request.
create or replace function public.get_route_day(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_staff app.staff := app.require_staff(p_token);
  v_date date := app.parse_date(p->>'date');
  v_route text := p->>'routeId';
  v_session text := p->>'session';
begin
  if v_session is distinct from 'Morning' and v_session is distinct from 'Evening' then
    -- Open whichever session is still awaiting its return, else the caller's default.
    select session into v_session from app.trips
    where route_id = v_route and date = v_date and status = 'Dispatched'
    order by session = 'Morning' desc limit 1;
    v_session := coalesce(v_session, case when p->>'fallbackSession' = 'Evening' then 'Evening' else 'Morning' end);
  end if;
  return app.master_json(v_staff.role = 'admin') || jsonb_build_object(
    'session', v_session,
    'trips', coalesce((select jsonb_agg(app.trip_with_items(t.id) order by t.session = 'Evening')
                       from app.trips t where t.route_id = v_route and t.date = v_date), '[]'::jsonb),
    'indents', coalesce((select jsonb_agg(app.indent_json(o) order by o.updated_at)
                         from app.indents o
                         where o.route_id = v_route and o.date = v_date and o.items <> '[]'::jsonb), '[]'::jsonb)
  );
end $$;

create or replace function public.get_last_trip(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_staff app.staff := app.require_staff(p_token);
  v_id text;
begin
  select id into v_id from app.trips
  where route_id = p->>'routeId' and session = p->>'session' and date < app.parse_date(p->>'beforeDate')
  order by date desc limit 1;
  return case when v_id is null then 'null'::jsonb else app.trip_with_items(v_id) end;
end $$;

create or replace function public.dispatch_trip(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_staff app.staff := app.require_staff(p_token);
  v_session text := app.parse_session(p->>'session');
  v_date date := app.parse_date(p->>'date');
  v_route text := p->>'routeId';
  v_trip text;
  v_missing text;
begin
  if not exists (select 1 from app.routes where id = v_route) then raise exception 'Route not found'; end if;

  create temp table if not exists _dispatch (product_id text primary key, qty numeric) on commit drop;
  truncate _dispatch;
  insert into _dispatch (product_id, qty)
  select e->>'productId', sum(app.num(e->>'qty'))
  from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) e
  group by e->>'productId'
  having sum(app.num(e->>'qty')) > 0;

  select d.product_id into v_missing from _dispatch d left join app.products pr on pr.id = d.product_id
  where pr.id is null limit 1;
  if v_missing is not null then raise exception 'Unknown product: %', v_missing; end if;
  if not exists (select 1 from _dispatch) then
    raise exception 'At least one product with quantity is required';
  end if;

  begin
    insert into app.trips (date, session, route_id, driver, vehicle, dispatched_by)
    values (v_date, v_session, v_route, coalesce(p->>'driver', ''), coalesce(p->>'vehicle', ''), v_staff.name)
    returning id into v_trip;
  exception when unique_violation then
    raise exception 'This route already has a % trip for %', v_session, to_char(v_date, 'YYYY-MM-DD');
  end;

  insert into app.trip_items (trip_id, product_id, price, qty_dispatched, dispatched_value)
  select v_trip, d.product_id, pr.price, d.qty, round(d.qty * pr.price, 2)
  from _dispatch d join app.products pr on pr.id = d.product_id;

  update app.trips set dispatched_total = (select sum(dispatched_value) from app.trip_items where trip_id = v_trip)
  where id = v_trip;

  return app.trip_with_items(v_trip);
end $$;

create or replace function public.save_trip_progress(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_staff app.staff := app.require_staff(p_token);
  v_trip app.trips;
begin
  select * into v_trip from app.trips where id = p->>'tripId' for update;
  if not found then raise exception 'Trip not found'; end if;
  if v_trip.status = 'Settled' then raise exception 'Trip already settled'; end if;
  return app.apply_returns(v_trip, p, false, v_staff.name);
end $$;

create or replace function public.settle_trip(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_staff app.staff := app.require_staff(p_token);
  v_trip app.trips;
begin
  select * into v_trip from app.trips where id = p->>'tripId' for update;
  if not found then raise exception 'Trip not found'; end if;
  if v_trip.status = 'Settled' then raise exception 'Trip already settled'; end if;
  return app.apply_returns(v_trip, p, true, v_staff.name);
end $$;

-- Admins only: puts a settled trip back to Dispatched (figures kept) so a
-- mistake can be corrected and the trip settled again.
create or replace function public.reopen_trip(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_staff app.staff := app.require_staff(p_token, true);
  v_trip app.trips;
begin
  select * into v_trip from app.trips where id = p->>'tripId' for update;
  if not found then raise exception 'Trip not found'; end if;
  if v_trip.status <> 'Settled' then raise exception 'Trip is not settled'; end if;
  update app.trips
  set status = 'Dispatched', settled_at = null, settled_by = '', reopened_by = v_staff.name, reopened_at = now()
  where id = v_trip.id;
  return app.trip_with_items(v_trip.id);
end $$;

create or replace function public.list_trips(p_token text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_staff app.staff := app.require_staff(p_token);
  v_from date := case when coalesce(p->>'dateFrom', '') <> '' then app.parse_date(p->>'dateFrom') end;
  v_to date := case when coalesce(p->>'dateTo', '') <> '' then app.parse_date(p->>'dateTo') end;
begin
  return coalesce((
    select jsonb_agg(app.trip_json(t) || jsonb_build_object('RouteName', r.name)
                     order by t.date desc, r.name, t.session = 'Evening')
    from (
      select * from app.trips
      where (nullif(p->>'routeId', '') is null or route_id = p->>'routeId')
        and (v_from is null or date >= v_from)
        and (v_to is null or date <= v_to)
      order by date desc
      limit 5000
    ) t join app.routes r on r.id = t.route_id
  ), '[]'::jsonb);
end $$;

-- Dashboard in one request: the day's trips plus shop-order counts per route
-- and session.
create or replace function public.get_dashboard(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_staff app.staff := app.require_staff(p_token);
  v_date date := app.parse_date(p->>'date');
begin
  return jsonb_build_object(
    'trips', coalesce((select jsonb_agg(app.trip_json(t)) from app.trips t where t.date = v_date), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object('routeId', x.route_id, 'session', x.session, 'shops', x.shops, 'ordered', x.ordered))
      from (
        select s.route_id, ss.session, count(*) as shops,
               count(*) filter (where exists (
                 select 1 from app.indents o
                 where o.shop_id = s.id and o.date = v_date and o.session = ss.session and o.items <> '[]'::jsonb)) as ordered
        from app.shops s cross join (values ('Morning'), ('Evening')) ss(session)
        where s.active
        group by s.route_id, ss.session
      ) x), '[]'::jsonb)
  );
end $$;

-- Raw settled trips + items for a date range; the app computes the analytics
-- (same code as demo mode), keeping the SQL simple.
create or replace function public.get_analytics_data(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_staff app.staff := app.require_staff(p_token);
  v_from date := app.parse_date(p->>'dateFrom');
  v_to date := app.parse_date(p->>'dateTo');
begin
  if v_to - v_from > 800 then raise exception 'Pick a range of at most two years'; end if;
  return jsonb_build_object(
    'trips', coalesce((select jsonb_agg(app.trip_json(t)) from app.trips t
                       where t.status = 'Settled' and t.date between v_from and v_to), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(app.item_json(i)) from app.trip_items i join app.trips t on t.id = i.trip_id
                       where t.status = 'Settled' and t.date between v_from and v_to), '[]'::jsonb),
    'routeNames', coalesce((select jsonb_object_agg(id, name) from app.routes), '{}'::jsonb),
    'productNames', coalesce((select jsonb_object_agg(id, name) from app.products), '{}'::jsonb)
  );
end $$;

-- ---- Shop owners ---------------------------------------------------------------------------

create or replace function public.shop_home(p_token text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
begin
  return app.shop_home_json(app.require_shop(p_token));
end $$;

create or replace function public.shop_save_order(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_shop app.shops := app.require_shop(p_token);
  v_session text := app.parse_session(p->>'session');
  v_date date := app.parse_date(p->>'date');
  v_items jsonb;
  v_total numeric;
begin
  if not exists (select 1 from app.open_slots() where slot_date = v_date and slot_session = v_session) then
    raise exception 'Ordering for this delivery has closed.';
  end if;

  create temp table if not exists _order (product_id text primary key, qty numeric) on commit drop;
  truncate _order;
  insert into _order (product_id, qty)
  select e->>'productId', sum(app.num(e->>'qty'))
  from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) e
  group by e->>'productId'
  having sum(app.num(e->>'qty')) > 0;

  if exists (select 1 from _order where qty > 10000) then raise exception 'Quantity too large'; end if;
  if exists (select 1 from _order o left join app.products pr on pr.id = o.product_id and pr.active where pr.id is null) then
    raise exception 'This product is no longer available. Refresh and try again.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('productId', o.product_id, 'qty', o.qty) order by pr.created_at, pr.name), '[]'::jsonb),
         coalesce(sum(o.qty * pr.price), 0)
  into v_items, v_total
  from _order o join app.products pr on pr.id = o.product_id;

  insert into app.indents (date, session, shop_id, route_id, items, total, updated_at)
  values (v_date, v_session, v_shop.id, v_shop.route_id, v_items, v_total, now())
  on conflict (shop_id, date, session)
  do update set items = excluded.items, total = excluded.total, route_id = excluded.route_id, updated_at = now();

  return app.shop_home_json(v_shop);
end $$;

-- ============================================================================
-- One-off admin tools (run in the Supabase SQL editor; not exposed to the app)
-- ============================================================================

-- Creates the first admin, e.g.:
--   select app.create_admin('Srinivas', '9848012345', '482913');
create or replace function app.create_admin(p_name text, p_phone text, p_pin text) returns text
language plpgsql as $$
declare v_id text;
begin
  if p_pin !~ '^\d{6}$' then raise exception 'PIN must be 6 digits'; end if;
  insert into app.staff (name, phone, role, pin_hash)
  values (btrim(p_name), app.normalize_phone(p_phone), 'admin', app.hash_pin(p_pin))
  on conflict (phone) do update set name = excluded.name, role = 'admin', active = true,
                                    pin_hash = excluded.pin_hash, failed_logins = 0, locked_until = null
  returning id into v_id;
  return v_id;
end $$;

-- ============================================================================
-- Permissions
-- ============================================================================
-- Postgres lets everyone execute new functions by default; take that away
-- for the internal helpers and grant only the API to the site's public key.

revoke all on all functions in schema app from public;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'staff_login', 'shop_login', 'logout', 'get_master_data', 'save_product', 'save_route',
      'save_shop', 'reset_shop_pin', 'save_staff', 'reset_staff_pin', 'get_route_day', 'get_last_trip',
      'dispatch_trip', 'save_trip_progress', 'settle_trip', 'reopen_trip', 'list_trips', 'get_dashboard',
      'get_analytics_data', 'shop_home', 'shop_save_order')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
