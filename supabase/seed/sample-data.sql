-- Sample data for trying the app. Run in the Supabase SQL Editor.
-- Everything here has an id starting with 'DEMO-' and phone numbers starting
-- with 1 (not real Indian mobiles), so it can't clash with real data.
-- Remove it all with remove-sample-data.sql before importing real data.
--
-- Logins it creates (phone / PIN):
--   staff  1000000100 / 246802   (Kiran, regular staff)
--   shops  1000000001 / 111111   (Lakshmi Stores, Route 4)
--          1000000002 / 222222   (Sri Sai Traders, Route 4)
--          1000000003 / 333333   (Balaji Kirana, Route 1)

begin;

insert into app.products (id, name, unit, price, created_at) values
  ('DEMO-P1', 'Toned Milk',        '500 ml pouch', 29, now() - interval '6 min'),
  ('DEMO-P2', 'Double Toned Milk', '500 ml pouch', 26, now() - interval '5 min'),
  ('DEMO-P3', 'Full Cream Milk',   '500 ml pouch', 36, now() - interval '4 min'),
  ('DEMO-P4', 'Curd',              '500 g cup',    35, now() - interval '3 min'),
  ('DEMO-P5', 'Buttermilk',        '200 ml pouch', 10, now() - interval '2 min'),
  ('DEMO-P6', 'Paneer',            '200 g pack',   90, now() - interval '1 min');

insert into app.routes (id, name, villages, default_vehicle, default_driver, created_at) values
  ('DEMO-R1', 'Route 1', 'Tenali, Kollipara',        'AP-07-TA-1101', 'Ramesh', now() - interval '5 min'),
  ('DEMO-R2', 'Route 2', 'Mangalagiri, Nidamarru',   'AP-07-TA-1102', 'Suresh', now() - interval '4 min'),
  ('DEMO-R3', 'Route 3', 'Pedakakani, Nambur',       'AP-07-TA-1103', 'Manoj',  now() - interval '3 min'),
  ('DEMO-R4', 'Route 4', 'Tadepalli, Undavalli',     'AP-07-TA-1104', 'Vijay',  now() - interval '2 min'),
  ('DEMO-R5', 'Route 5', 'Chebrolu, Vadlamudi',      'AP-07-TA-1105', 'Ganesh', now() - interval '1 min');

insert into app.staff (id, name, phone, role, pin_hash) values
  ('DEMO-U1', 'Kiran (sample)', '1000000100', 'staff', app.hash_pin('246802'));

insert into app.shops (id, name, owner_name, phone, route_id, pin_hash) values
  ('DEMO-S1', 'Lakshmi Stores',  'Ravi',   '1000000001', 'DEMO-R4', app.hash_pin('111111')),
  ('DEMO-S2', 'Sri Sai Traders', 'Padma',  '1000000002', 'DEMO-R4', app.hash_pin('222222')),
  ('DEMO-S3', 'Balaji Kirana',   'Suresh', '1000000003', 'DEMO-R1', app.hash_pin('333333'));

-- 30 days of trips. Today (India time): Routes 1–3 went out this morning;
-- Route 2 is still out, the others are settled. Route 4's driver is
-- occasionally short on cash, so Analytics has something to show.
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
  drivers text[] := array['Ramesh', 'Suresh', 'Manoj', 'Vijay', 'Ganesh'];
begin
  perform setseed(0.42);
  for d in select generate_series(today - 30, today, interval '1 day')::date loop
    for r in 1..5 loop
      foreach s in array array['Morning', 'Evening'] loop
        if d = today and (s = 'Evening' or r > 3) then continue; end if;
        t := 'DEMO-T-' || to_char(d, 'YYYYMMDD') || '-' || r || left(s, 1);

        insert into app.trips (id, date, session, route_id, driver, vehicle, dispatched_by, created_at)
        values (t, d, s, 'DEMO-R' || r, drivers[r], 'AP-07-TA-110' || r, 'Owner (sample)', (d + time '05:30') at time zone app.tz());

        insert into app.trip_items (id, trip_id, product_id, price, qty_dispatched, qty_returned, dispatched_value, returned_value)
        select 'DEMO-TI-' || substr(t, 8) || '-' || right(p.id, 1), t, p.id, p.price, q.qty,
               least(q.qty, round(q.qty * q.ret_rate * (0.4 + random() * 1.2))), 0, 0
        from app.products p
        cross join lateral (
          select round(
                   (case when s = 'Morning' then 1.0 else 0.6 end)
                   * (1 + r * 0.12)
                   * case p.id when 'DEMO-P1' then 120 when 'DEMO-P2' then 80 when 'DEMO-P3' then 50
                               when 'DEMO-P4' then 40 when 'DEMO-P5' then 60 else 8 end
                   * (0.85 + random() * 0.3)) as qty,
                 case p.id when 'DEMO-P4' then 0.12 when 'DEMO-P6' then 0.10 else 0.04 end as ret_rate
        ) q
        where p.id like 'DEMO-%';

        update app.trip_items set dispatched_value = qty_dispatched * price, returned_value = qty_returned * price
        where trip_id = t;
        select sum(dispatched_value), sum(returned_value) into disp, ret from app.trip_items where trip_id = t;

        if d = today and r = 2 then
          -- still out: no returns or cash yet
          update app.trip_items set qty_returned = 0, returned_value = 0 where trip_id = t;
          update app.trips set dispatched_total = disp where id = t;
        else
          cash := (disp - ret)
                  - case when r = 4 and random() < 0.2 then round(50 + random() * 350) else 0 end
                  + case when random() < 0.03 then 20 else 0 end;
          update app.trips
          set dispatched_total = disp, returned_total = ret, amount_due = disp - ret,
              cash_handed_over = cash, discrepancy = cash - (disp - ret), status = 'Settled',
              settled_at = least(now(), (d + case when s = 'Morning' then time '11:30' else time '19:30' end) at time zone app.tz()),
              settled_by = 'Kiran (sample)'
          where id = t;
        end if;
      end loop;
    end loop;
  end loop;

  -- Shop orders: today's Morning (already delivered) and tomorrow's Morning.
  insert into app.indents (id, date, session, shop_id, route_id, items, total) values
    ('DEMO-I1', today, 'Morning', 'DEMO-S1', 'DEMO-R4',
     '[{"productId":"DEMO-P1","qty":40},{"productId":"DEMO-P4","qty":10},{"productId":"DEMO-P5","qty":20}]', 40*29 + 10*35 + 20*10),
    ('DEMO-I2', today, 'Morning', 'DEMO-S2', 'DEMO-R4',
     '[{"productId":"DEMO-P1","qty":30},{"productId":"DEMO-P2","qty":20},{"productId":"DEMO-P6","qty":2}]', 30*29 + 20*26 + 2*90),
    ('DEMO-I3', today + 1, 'Morning', 'DEMO-S1', 'DEMO-R4',
     '[{"productId":"DEMO-P1","qty":40},{"productId":"DEMO-P4","qty":12},{"productId":"DEMO-P5","qty":20}]', 40*29 + 12*35 + 20*10),
    ('DEMO-I4', today + 1, 'Morning', 'DEMO-S3', 'DEMO-R1',
     '[{"productId":"DEMO-P1","qty":25},{"productId":"DEMO-P3","qty":10}]', 25*29 + 10*36);
end $$;

commit;

select 'Sample data loaded: ' ||
       (select count(*) from app.products where id like 'DEMO-%') || ' products, ' ||
       (select count(*) from app.routes where id like 'DEMO-%') || ' routes, ' ||
       (select count(*) from app.shops where id like 'DEMO-%') || ' shops, ' ||
       (select count(*) from app.trips where id like 'DEMO-%') || ' trips, ' ||
       (select count(*) from app.indents where id like 'DEMO-%') || ' shop orders' as result;
