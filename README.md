# Dear Future Self

A platform for sending messages, gestures, and micro-gifts into the future — to yourself, or to someone else. Pay-it-forward, delay-gratification, and compounding-care as a product.

## What's in here

```
public/                   ← the frontend (static, deploy anywhere)
  index.html              landing page
  app.html                the app (auth, dashboard, compose, read)
  css/styles.css
  js/config.js            ← you fill this in (Supabase URL + anon key)
  js/app.js

supabase/
  migrations/001_init.sql             ← capsules schema
  migrations/002_preference_pins.sql  ← pins schema (run after 001)
  functions/deliver-capsules/         ← scheduled delivery edge function

netlify.toml              Netlify deploy config
```

## Try it immediately (demo mode, no setup)

Open `public/index.html` (or `public/app.html`) in a browser, or serve the folder:

```bash
cd "Dear Future Self"
python3 -m http.server --directory public 5173
# visit http://localhost:5173
```

With `config.js` blank, the app runs in **demo mode** — it stores capsules in your browser's `localStorage` only and nothing is actually sent. This is enough to feel the flow.

## Wire up real delivery (~10 min, one-time)

You need two free accounts: **Supabase** (database + auth + scheduled functions) and **Resend** (transactional email). Both have generous free tiers.

### 1. Create a Supabase project

1. Go to <https://supabase.com/dashboard> → New project.
2. In the project's SQL editor, paste the contents of `supabase/migrations/001_init.sql` and run it.
3. Then paste `supabase/migrations/002_preference_pins.sql` and run it (adds the pins table).
4. Copy your project URL and anon key (Settings → API).

### 2. Fill in `public/js/config.js`

```js
window.DFS_CONFIG = {
  supabaseUrl: "https://YOURPROJECT.supabase.co",
  supabaseAnonKey: "eyJhbGciOi...",
};
```

### 3. Set up Resend for email

1. Sign up at <https://resend.com>.
2. Create an API key.
3. Verify a sending domain (or use the `onboarding@resend.dev` sandbox address for testing — Resend will only let you send to your own verified email in that mode).

### 4. Deploy the edge function

Install the Supabase CLI (<https://supabase.com/docs/guides/cli>), then:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF

supabase secrets set \
  RESEND_API_KEY=re_xxx \
  FROM_EMAIL="Dear Future Self <notes@yourdomain.com>" \
  APP_URL="https://yoursite.netlify.app"

supabase functions deploy deliver-capsules --no-verify-jwt
```

### 5. Schedule the delivery job

In the Supabase SQL editor, run (replace `<PROJECT_REF>` and paste your service-role key):

```sql
-- Store the service role key in a Postgres setting (only needed once)
alter database postgres set "app.settings.service_role_key"
  = 'YOUR_SERVICE_ROLE_KEY';

select cron.schedule(
  'deliver-capsules-every-5-min',
  '*/5 * * * *',
  $$
    select net.http_post(
      url := 'https://<PROJECT_REF>.functions.supabase.co/deliver-capsules',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      body := '{}'::jsonb
    ) as request_id;
  $$
);
```

### 6. Deploy the frontend

Any static host works. With Netlify:

```bash
npx netlify deploy --prod --dir=public
```

Or drag the `public/` folder into <https://app.netlify.com/drop>.

Configure the allowed redirect URL in Supabase (Auth → URL Configuration) to your deployed site so magic-link sign-in works.

### 7. Test it

1. Open the app, sign in with your email, click the magic link.
2. Write a capsule scheduled to deliver in ~6 minutes.
3. Wait for the next cron tick. Check your inbox.

## Architecture notes

**Delivery timing.** `pg_cron` pings the edge function every 5 minutes. The function pulls scheduled capsules where `deliver_at <= now()` and sends each via Resend. Up to 50 per run, so if you ever have a huge backlog, it drains over a few minutes.

**Security.** Row-Level Security policies mean users can only see and modify their own capsules. The anon key in the browser is safe. The service role key lives only in Supabase Vault / edge function secrets, never in frontend code.

**The "pledge" model for gifts.** v1 treats micro-gifts as a pledge — the amount appears in the delivery, but no payment processor is involved. This keeps the MVP simple and honors the project ethos: the note is the point, the amount is the reminder.

**Preference pins (context-triggered reminders).** Separate from capsules — a pin is a note about a place / preference / experience that fires when context matches, not on a schedule. Two trigger mechanisms:

- *Location* — when you open the app with location granted, it watches your position. When you enter a pin's radius, the app shows a browser notification (OS-level) and the pin surfaces at the top of the Nearby tab. Works on iPhone when the app is open in Safari; Safari can't wake a closed tab, so for true background alerts use the per-pin "Copy text" export and paste it into Apple Reminders, which supports location-based alerts natively.
- *Tag search* — every pin can carry free-form tags ("noodles", "dentist", "parking", "dad's allergies"). A search box on the Pins view does a fuzzy match across title, body, place, and tags.

Pins support a sentiment flag (liked it / just a note / avoid it) so the same mechanism works for both positive recommendations and things to warn future-you about.

**What's explicitly NOT here yet (v2 candidates):**
- Actual money movement (Stripe Connect, gift card APIs)
- Recipient "claim" flow with token links
- File/photo attachments
- Recurring capsules (e.g. yearly check-in)
- SMS / physical-mail delivery
- True background geofencing (would need a native iOS/Android app or iOS Shortcuts integration beyond the text export)
- Map view for pins
- Rich-text editor

## Running locally against a real Supabase project

Fill in `config.js`, then serve `public/` with any static server:

```bash
python3 -m http.server --directory public 5173
```

Add `http://localhost:5173` as an allowed redirect in your Supabase Auth settings.
