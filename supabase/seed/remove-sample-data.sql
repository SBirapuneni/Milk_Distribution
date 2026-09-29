-- Removes everything sample-data.sql created (ids starting with 'DEMO-'),
-- and nothing else. Run in the Supabase SQL Editor before importing real data.

begin;
-- Includes records created in the app on demo routes/shops/products (those
-- get normal ids), so the demo routes etc. can be removed.
delete from app.sessions where staff_id like 'DEMO-%' or shop_id like 'DEMO-%';
delete from app.indents where id like 'DEMO-%' or shop_id like 'DEMO-%' or route_id like 'DEMO-%';
delete from app.trip_items
where trip_id like 'DEMO-%' or product_id like 'DEMO-%'
   or trip_id in (select id from app.trips where route_id like 'DEMO-%');
delete from app.trips where id like 'DEMO-%' or route_id like 'DEMO-%';
delete from app.shops where id like 'DEMO-%';
delete from app.staff where id like 'DEMO-%';
delete from app.routes where id like 'DEMO-%';
delete from app.products where id like 'DEMO-%';
commit;

select 'Sample data removed. Remaining: ' ||
       (select count(*) from app.products) || ' products, ' ||
       (select count(*) from app.routes) || ' routes, ' ||
       (select count(*) from app.trips) || ' trips' as result;
