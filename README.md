# Milk Distribution Tracker

Tracks daily stock dispatch and cash settlement for a milk distribution business's routes, and lets shops place their own orders. The app is a static site (hosted on Cloudflare Pages); the data lives in a Postgres database on Supabase.

## How it fits together

- **Database (Supabase):** tables in a private `app` schema that the browser can't reach. The app talks only to the functions in [`supabase/migrations/…_api.sql`](supabase/migrations/20260929000002_api.sql) (called as `/rest/v1/rpc/<name>`). Each function checks the caller's login session and role before doing anything, and runs as one transaction.
- **Logins:** staff and shop owners log in with **phone number + 6-digit PIN**. PINs are stored only as bcrypt hashes; 5 wrong PINs lock that account for 15 minutes.
  - **Admins** manage products, routes, shops and staff, and can reopen settled trips.
  - **Staff** dispatch and settle trips and see History and Analytics.
  - **Shop owners** only see products, prices and their own orders.
- **Website:** everything goes through [`src/api.ts`](src/api.ts). Without Supabase settings, the app runs in **demo mode** with sample data.

## 1. Create the database (Supabase)

1. Sign up at [supabase.com](https://supabase.com) and create a **new project**. Pick region **Mumbai (ap-south-1)** and save the database password somewhere safe.
2. Open **SQL Editor → New query**. Paste in the whole of [`supabase/migrations/20260929000001_schema.sql`](supabase/migrations/20260929000001_schema.sql) and click **Run**. Then do the same with [`supabase/migrations/20260929000002_api.sql`](supabase/migrations/20260929000002_api.sql).
3. Create your own admin login in a new query, with your name, phone number and a 6-digit PIN of your choice:
   ```sql
   select app.create_admin('Your name', '98480xxxxx', '123456');
   ```
4. Go to **Project Settings → API** (or the **Connect** button) and copy the **Project URL** and the **publishable** key (older projects call it the **anon** key). These go in the website settings below.

Everyone else (staff and shops) is added from inside the app.

## 2. Moving data from the Google Sheet (one time)

If you used the earlier Google Sheets version, bring all its data across, including trip history and shop PINs:

1. In the Google Sheet, open each tab (**Products, Routes, Trips, TripItems, Shops, Indents**) and use **File → Download → Comma Separated Values (.csv)**. Put the files in one folder.
2. Run:
   ```bash
   node scripts/import-from-sheets.mjs ~/Downloads/milk-export
   ```
   This writes `import.sql` into that folder and prints what it found, plus any rows it had to skip and why. If it asks, add `--dates=dmy` (dates like 28/09/2026) or `--dates=mdy` (9/28/2026).
3. Open `import.sql`, paste it into the Supabase **SQL Editor** and **Run**. It loads everything in one transaction. It's safe to re-run: rows that already exist are skipped.

Shops keep their existing PINs, which are upgraded to the new hashing on each shop's first login. Staff get new personal logins (see **Staff** below).

## 3. Put the website online (Cloudflare Pages)

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com), then go to **Workers & Pages → Create → Pages → Connect to Git** and pick this GitHub repository.
2. Build settings:
   - Framework preset: **Vite** (or None)
   - Build command: `npm run build`
   - Build output directory: `dist`
3. Under **Environment variables**, add:
   - `VITE_SUPABASE_URL` = the Project URL from step 1.4
   - `VITE_SUPABASE_KEY` = the publishable/anon key from step 1.4
4. **Save and Deploy.** Every push to `main` then redeploys automatically. Your site gets an address like `milk-distribution.pages.dev`; you can add your own domain later.

The publishable key is meant to be public: on its own it can only call the functions above, which all require a valid login.

## Run it locally

```bash
npm install
cp .env.example .env   # fill in the two Supabase values, or leave them empty for demo mode
npm run dev
```

**Demo mode** logins: admin `9000000009` with PIN `999999`, staff `9000000008` with PIN `888888`, shop `9000000001` with PIN `111111`.

## Staff

**Staff** (admins only) lists everyone who can log in. **Add a person** creates their login with a 6-digit PIN, shown once. Tap **Share on WhatsApp** to send it. Make someone an **Admin** to let them manage products, routes, shops and staff and reopen trips. **New PIN** replaces a forgotten PIN and logs them out on other phones. Deactivating someone logs them out everywhere immediately.

The name on each trip's "dispatched by" and "settled by" is the logged-in person's, so it can be trusted.

## Shop orders

1. Go to **Shops** and add each shop: name, owner, WhatsApp number and the route that serves it. Saving creates a **6-digit PIN**, shown once. Tap **Share on WhatsApp** to send the owner the link, their phone number and PIN. **New PIN** replaces a lost or leaked PIN.
2. The shop owner opens the link (the site address ending in `#/order`, also linked from the staff login screen), logs in with phone + PIN, and enters quantities for each upcoming delivery. They can change an order until its cutoff:
   - **Morning** delivery: by **9 PM the night before**
   - **Evening** delivery: by **12 noon the same day**

   Cutoffs use India time (the `timezone` row in the `app.settings` table).
3. On the **Route** screen, the Dispatch form lists that trip's shop orders, shows which shops haven't ordered, and pre-fills the quantities with the order totals. Add extra for walk-in sales. The **Dashboard** shows how many shops on each route have ordered.

## Daily use

- **Dashboard:** today's totals (sent out, cash collected, trips awaiting return, cash short) and each route's Morning/Evening status. Tap a session to go straight to it. Shortfalls show in red.
- **Route screen:** pick a date (defaults to today). It opens whichever session still needs its return settled, and warns you if the other session is still awaiting return. **Same as last trip** fills in the quantities from the previous trip for that route and session. In the evening, enter quantities returned and the cash handed over and tap **Settle**. The app shows the discrepancy and asks you to confirm.
- **Reopening:** a settled trip is locked. An admin can open it and tap **Reopen this trip**. It goes back to "awaiting return" with its figures kept, ready to correct and settle again.
- **Products / Routes** (admins): manage the master lists.
- **History:** past trips for a route and date range (last 30 days by default), including who dispatched and settled each one, with a totals row.
- **Analytics:** pick a range with the quick buttons (Today, Last 7 days, …). Summary cards compare the complete days of the range with the same number of days before it. The page includes:
  - the sales trend
  - cash **short** and **excess** shown separately, per day and per driver
  - return rates by day, product and route
  - sales by route, product and session

## Backups

The free Supabase plan doesn't include automatic backups. Every so often (weekly is a good habit), use **Table Editor →** each table **→ Export to CSV**, or run `pg_dump` with the connection string from **Project Settings → Database**.

## Tests (for developers)

`supabase/tests/` contains the database tests (they need Docker). Run them with:

```bash
node supabase/tests/run.mjs
```

They start a throwaway Postgres, load the migrations, and exercise every API function: logins and lock-outs, roles, dispatch/settle/reopen rules, shop order cutoffs, and the Sheet import.
