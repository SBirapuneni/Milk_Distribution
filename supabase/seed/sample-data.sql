-- Demo data covering every scenario the app handles. Run in the Supabase SQL
-- Editor (after migrations 0001–0003). Re-running it replaces the previous
-- demo data. Everything has an id starting with 'DEMO-' and phone numbers
-- starting with 1 (not real Indian mobiles); remove-sample-data.sql removes
-- all of it and nothing else. Real products, routes, shops, staff and trips
-- are never touched.
--
-- Logins (phone / PIN):
--   staff   1000000100 / 246802  Kiran — regular staff
--           1000000101 / 246803  Mahesh — deactivated (left), can't log in
--   shops   1000000001 / 111111  Lakshmi Stores   (Route 4) orders today, tomorrow and 5 days ahead
--           1000000002 / 222222  Sri Sai Traders  (Route 4) ordered for today
--           1000000003 / 333333  Balaji Kirana    (Route 1) ordered for tomorrow morning
--           1000000004 / 444444  Venkateswara     (Route 4) never orders
--           1000000005 / 555555  Durga Stores     (Route 2) cancelled tomorrow's order
--           1000000006 / 666666  Old Corner Shop  (Route 3) deactivated, can't log in
--           1000000007 / 777777  Ganesh Kirana    (Route 5) locked after wrong PINs (for a day)
--
-- Today (India time):
--   Route 1 Morning  settled, cash exact
--   Route 2 Morning  still out (no returns yet)
--   Route 3 Morning  settled, ₹150 short
--   Route 4 Morning  not dispatched yet — two shop orders waiting (Dispatch form pre-fills)
--   Route 5 Morning  returns and cash saved, not settled yet
-- Yesterday:
--   Route 2 Evening  ₹50 excess
--   Route 4 Evening  settled, reopened by an admin, corrected and settled again
-- Older: 30 days of trips; Route 4's driver is sometimes short; Route 6 was
-- closed 10 days ago; "Flavoured Milk" was discontinued 20 days ago; Toned
-- Milk went from ₹28 to ₹29 fifteen days ago (older trips keep ₹28).

begin;

-- Replace any earlier demo data.
delete from app.sessions where staff_id like 'DEMO-%' or shop_id like 'DEMO-%';
delete from app.indents where id like 'DEMO-%' or shop_id like 'DEMO-%';
delete from app.trip_items where trip_id like 'DEMO-%';
delete from app.trips where id like 'DEMO-%';
delete from app.shops where id like 'DEMO-%';
delete from app.staff where id like 'DEMO-%';
delete from app.routes where id like 'DEMO-%';
delete from app.products where id like 'DEMO-%';

insert into app.products (id, name, unit, price, active, created_at) values
  ('DEMO-P1', 'Toned Milk',        '500 ml pouch', 29, true,  now() - interval '7 min'),
  ('DEMO-P2', 'Double Toned Milk', '500 ml pouch', 26, true,  now() - interval '6 min'),
  ('DEMO-P3', 'Full Cream Milk',   '500 ml pouch', 36, true,  now() - interval '5 min'),
  ('DEMO-P4', 'Curd',              '500 g cup',    35, true,  now() - interval '4 min'),
  ('DEMO-P5', 'Buttermilk',        '200 ml pouch', 10, true,  now() - interval '3 min'),
  ('DEMO-P6', 'Paneer',            '200 g pack',   90, true,  now() - interval '2 min'),
  ('DEMO-P7', 'Flavoured Milk',    '200 ml bottle', 25, false, now() - interval '1 min');  -- discontinued

insert into app.routes (id, name, villages, default_vehicle, default_driver, active, created_at) values
  ('DEMO-R1', 'Route 1', 'Tenali, Kollipara',      'AP-07-TA-1101', 'Ramesh', true,  now() - interval '6 min'),
  ('DEMO-R2', 'Route 2', 'Mangalagiri, Nidamarru', 'AP-07-TA-1102', 'Suresh', true,  now() - interval '5 min'),
  ('DEMO-R3', 'Route 3', 'Pedakakani, Nambur',     'AP-07-TA-1103', 'Manoj',  true,  now() - interval '4 min'),
  ('DEMO-R4', 'Route 4', 'Tadepalli, Undavalli',   'AP-07-TA-1104', 'Vijay',  true,  now() - interval '3 min'),
  ('DEMO-R5', 'Route 5', 'Chebrolu, Vadlamudi',    'AP-07-TA-1105', 'Ganesh', true,  now() - interval '2 min'),
  ('DEMO-R6', 'Route 6 (closed)', 'Ponnur',        'AP-07-TA-1106', 'Prasad', false, now() - interval '1 min');

insert into app.staff (id, name, phone, role, active, pin_hash) values
  ('DEMO-U1', 'Kiran (sample)',  '1000000100', 'staff', true,  app.hash_pin('246802')),
  ('DEMO-U2', 'Mahesh (left)',   '1000000101', 'staff', false, app.hash_pin('246803'));

insert into app.shops (id, name, owner_name, phone, route_id, active, pin_hash, failed_logins, locked_until) values
  ('DEMO-S1', 'Lakshmi Stores',  'Ravi',    '1000000001', 'DEMO-R4', true,  app.hash_pin('111111'), 0, null),
  ('DEMO-S2', 'Sri Sai Traders', 'Padma',   '1000000002', 'DEMO-R4', true,  app.hash_pin('222222'), 0, null),
  ('DEMO-S3', 'Balaji Kirana',   'Suresh',  '1000000003', 'DEMO-R1', true,  app.hash_pin('333333'), 0, null),
  ('DEMO-S4', 'Venkateswara',    'Naidu',   '1000000004', 'DEMO-R4', true,  app.hash_pin('444444'), 0, null),
  ('DEMO-S5', 'Durga Stores',    'Lalitha', '1000000005', 'DEMO-R2', true,  app.hash_pin('555555'), 0, null),
  ('DEMO-S6', 'Old Corner Shop', 'Rao',     '1000000006', 'DEMO-R3', false, app.hash_pin('666666'), 0, null),
  ('DEMO-S7', 'Ganesh Kirana',   'Kumar',   '1000000007', 'DEMO-R5', true,  app.hash_pin('777777'), 0, now() + interval '1 day');

do $$
declare
  today date := app.today();
  d date;
  r int;
  s text;
  t text;
  disp numeric;
  ret numeric;
  cash numeric;
  drivers text[] := array['Ramesh', 'Suresh', 'Manoj', 'Vijay', 'Ganesh', 'Prasad'];
  -- Today's Morning plan per route: settled / out / short / not dispatched / saved
  plan text[] := array['settled', 'out', 'short', 'none', 'saved', 'none'];
begin
  perform setseed(0.42);
  for d in select generate_series(today - 30, today, interval '1 day')::date loop
    for r in 1..6 loop
      foreach s in array array['Morning', 'Evening'] loop
        continue when r = 6 and d > today - 10;                      -- Route 6 closed 10 days ago
        continue when d = today and s = 'Evening';                    -- evening not started yet
        continue when d = today and plan[r] = 'none';                 -- Route 4 waits for dispatch
        t := 'DEMO-T-' || to_char(d, 'YYYYMMDD') || '-' || r || left(s, 1);

        insert into app.trips (id, date, session, route_id, driver, vehicle, dispatched_by, created_at)
        values (t, d, s, 'DEMO-R' || r, drivers[r], 'AP-07-TA-110' || r, 'Owner (sample)',
                least(now(), (d + case when s = 'Morning' then time '05:30' else time '15:30' end) at time zone app.tz()));

        insert into app.trip_items (id, trip_id, product_id, price, qty_dispatched, qty_returned, dispatched_value, returned_value)
        select 'DEMO-TI-' || substr(t, 8) || '-' || right(p.id, 1), t, p.id,
               -- Toned Milk cost ₹28 until 15 days ago
               case when p.id = 'DEMO-P1' and d < today - 15 then 28 else p.price end,
               q.qty, least(q.qty, round(q.qty * q.ret_rate * (0.4 + random() * 1.2))), 0, 0
        from app.products p
        cross join lateral (
          select round(
                   (case when s = 'Morning' then 1.0 else 0.6 end)
                   * (1 + r * 0.12)
                   * case p.id when 'DEMO-P1' then 120 when 'DEMO-P2' then 80 when 'DEMO-P3' then 50
                               when 'DEMO-P4' then 40 when 'DEMO-P5' then 60 when 'DEMO-P6' then 8 else 30 end
                   * (0.85 + random() * 0.3)) as qty,
                 case p.id when 'DEMO-P4' then 0.12 when 'DEMO-P6' then 0.10 when 'DEMO-P7' then 0.2 else 0.04 end as ret_rate
        ) q
        where p.id like 'DEMO-%'
          and (p.id <> 'DEMO-P7' or d < today - 20);                   -- Flavoured Milk discontinued 20 days ago

        update app.trip_items set dispatched_value = qty_dispatched * price, returned_value = qty_returned * price
        where trip_id = t;
        select sum(dispatched_value), sum(returned_value) into disp, ret from app.trip_items where trip_id = t;
        update app.trips set dispatched_total = disp where id = t;

        if d = today and plan[r] = 'out' then
          update app.trip_items set qty_returned = 0, returned_value = 0 where trip_id = t;   -- still out
        elsif d = today and plan[r] = 'saved' then
          -- returns and cash entered and saved, not settled yet
          update app.trips set returned_total = ret, amount_due = disp - ret, cash_handed_over = disp - ret - 40,
                 discrepancy = -40 where id = t;
        else
          cash := (disp - ret)
                  - case when d = today and plan[r] = 'short' then 150
                         when d < today and r = 4 and random() < 0.2 then round(50 + random() * 350)
                         else 0 end
                  + case when d = today - 1 and r = 2 and s = 'Evening' then 50                -- excess
                         when d < today - 1 and random() < 0.03 then 20
                         else 0 end;
          update app.trips
          set returned_total = ret, amount_due = disp - ret, cash_handed_over = cash, discrepancy = cash - (disp - ret),
              status = 'Settled', settled_by = 'Kiran (sample)',
              settled_at = least(now(), (d + case when s = 'Morning' then time '11:30' else time '19:30' end) at time zone app.tz())
          where id = t;
        end if;
      end loop;
    end loop;
  end loop;

  -- Yesterday's Route 4 Evening: settled, reopened by an admin, corrected, settled again.
  update app.trips
  set reopened_by = 'Owner (sample)',
      reopened_at = least(now(), ((today - 1) + time '20:15') at time zone app.tz()),
      settled_by = 'Owner (sample)',
      settled_at = least(now(), ((today - 1) + time '20:20') at time zone app.tz())
  where id = 'DEMO-T-' || to_char(today - 1, 'YYYYMMDD') || '-4E';

  -- Shop orders.
  insert into app.indents (id, date, session, shop_id, route_id, items, total, updated_at) values
    -- today's Route 4 Morning (not dispatched yet → pre-fills the Dispatch form)
    ('DEMO-I1', today, 'Morning', 'DEMO-S1', 'DEMO-R4',
     '[{"productId":"DEMO-P1","qty":40},{"productId":"DEMO-P4","qty":10},{"productId":"DEMO-P5","qty":20}]', 40*29 + 10*35 + 20*10,
     ((today - 1) + time '19:40') at time zone app.tz()),
    ('DEMO-I2', today, 'Morning', 'DEMO-S2', 'DEMO-R4',
     '[{"productId":"DEMO-P1","qty":30},{"productId":"DEMO-P2","qty":20},{"productId":"DEMO-P6","qty":2}]', 30*29 + 20*26 + 2*90,
     ((today - 1) + time '20:05') at time zone app.tz()),
    -- tomorrow
    ('DEMO-I3', today + 1, 'Morning', 'DEMO-S1', 'DEMO-R4',
     '[{"productId":"DEMO-P1","qty":40},{"productId":"DEMO-P4","qty":12},{"productId":"DEMO-P5","qty":20}]', 40*29 + 12*35 + 20*10, now()),
    ('DEMO-I4', today + 1, 'Evening', 'DEMO-S1', 'DEMO-R4',
     '[{"productId":"DEMO-P1","qty":20},{"productId":"DEMO-P5","qty":10}]', 20*29 + 10*10, now()),
    ('DEMO-I5', today + 1, 'Morning', 'DEMO-S3', 'DEMO-R1',
     '[{"productId":"DEMO-P1","qty":25},{"productId":"DEMO-P3","qty":10}]', 25*29 + 10*36, now()),
    -- cancelled (saved with no items)
    ('DEMO-I6', today + 1, 'Morning', 'DEMO-S5', 'DEMO-R2', '[]', 0, now()),
    -- advance order, 5 days ahead
    ('DEMO-I7', today + 5, 'Morning', 'DEMO-S1', 'DEMO-R4',
     '[{"productId":"DEMO-P1","qty":150},{"productId":"DEMO-P4","qty":40},{"productId":"DEMO-P6","qty":10}]', 150*29 + 40*35 + 10*90, now());
end $$;

commit;

select 'Demo data loaded: ' ||
       (select count(*) from app.products where id like 'DEMO-%') || ' products, ' ||
       (select count(*) from app.routes where id like 'DEMO-%') || ' routes, ' ||
       (select count(*) from app.shops where id like 'DEMO-%') || ' shops, ' ||
       (select count(*) from app.staff where id like 'DEMO-%') || ' staff, ' ||
       (select count(*) from app.trips where id like 'DEMO-%') || ' trips, ' ||
       (select count(*) from app.indents where id like 'DEMO-%') || ' shop orders' as result;
