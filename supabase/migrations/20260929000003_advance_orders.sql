-- Advance shop orders: shops may order for any delivery up to 30 days ahead,
-- not just the next few, as long as that delivery's cutoff hasn't passed.
-- Safe to run on a database that already has 0001 and 0002.

/** How far ahead a shop may order. */
create or replace function app.max_order_days() returns int
language sql immutable as $$ select 30 $$;

/** True if a shop can still place or change an order for this delivery. */
create or replace function app.slot_open(p_date date, p_session text) returns boolean
language sql stable as $$
  select p_session in ('Morning', 'Evening')
     and app.cutoff_for(p_date, p_session) > app.local_now()
     and p_date <= app.today() + app.max_order_days()
$$;

-- Same as before, plus:
--   orders  — every order this shop has for today or later (advance orders
--             included), so the app can show and edit them;
--   maxDate — the last date the shop may order for.
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
    'orders', coalesce((
      select jsonb_agg(app.indent_json(o) order by o.date, o.session = 'Evening')
      from app.indents o
      where o.shop_id = v.id and o.date >= app.today() and o.items <> '[]'::jsonb), '[]'::jsonb),
    'lastOrder', (
      select app.indent_json(o)
      from app.indents o, first_open f
      where o.shop_id = v.id and o.items <> '[]'::jsonb
        and app.cutoff_for(o.date, o.session) < coalesce(f.cutoff, 'infinity'::timestamp)
      order by app.cutoff_for(o.date, o.session) desc
      limit 1),
    'maxDate', to_char(app.today() + app.max_order_days(), 'YYYY-MM-DD'),
    'now', to_char(app.local_now(), 'YYYY-MM-DD HH24:MI')
  )
$$;

-- Same as before, but accepts any open delivery (app.slot_open) instead of
-- only the next few.
create or replace function public.shop_save_order(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = app, extensions, pg_temp as $$
declare
  v_shop app.shops := app.require_shop(p_token);
  v_session text := app.parse_session(p->>'session');
  v_date date := app.parse_date(p->>'date');
  v_items jsonb;
  v_total numeric;
begin
  if v_date > app.today() + app.max_order_days() then
    raise exception 'You can order up to % days ahead.', app.max_order_days();
  end if;
  if not app.slot_open(v_date, v_session) then
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

revoke all on function app.max_order_days() from public;
revoke all on function app.slot_open(date, text) from public;
