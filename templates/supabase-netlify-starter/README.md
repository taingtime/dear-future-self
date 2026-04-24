# supabase-netlify-starter

Minimal starter for a static-frontend + Supabase + Netlify app. Copy this folder to a new project directory, then in Cowork say:

> "Bootstrap a new project called `<project-name>` from my starter template."

See `BOOTSTRAP_PLAYBOOK.md` one level up for the exact sequence Cowork will follow.

## What's here

```
public/
  index.html           landing page skeleton
  app.html             auth + app shell
  css/styles.css       warm-tones base
  js/config.js         Supabase URL + key (Cowork fills in)
  js/app.js            auth + demo-mode fallback

supabase/
  migrations/
    001_init.sql       profiles table + RLS + auth trigger

netlify.toml           publish = "public"
deploy.sh              one-command deploy (fills in your siteId)
.gitignore
README.md              (you fill this in per project)
```

## What it is NOT

No specific domain model — the `profiles` table is the only one. Add your own migrations numbered `002_*`, `003_*`, etc.

The app.js is a thin shell: auth (Supabase + localStorage demo fallback), sign-in view, empty dashboard. You extend it.

## Reminder: what to fill in manually after bootstrap

- Resend API key if this project sends email (set as Supabase function secret, not in the browser).
- Supabase Auth → URL Configuration → add your Netlify domain as a redirect.
- Any additional migrations for your specific domain.
