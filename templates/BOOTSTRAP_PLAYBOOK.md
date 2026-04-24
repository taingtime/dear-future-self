# Bootstrap Playbook

The exact sequence Cowork follows when you say **"bootstrap a new project called `<name>` from my starter template"**. This is documentation for future Cowork sessions — when you reference this playbook, Claude executes each step in order, asking you only for genuinely new inputs (project name and, optionally, Resend/GitHub keys if not already in memory).

---

## Standard stack

| Concern           | Choice                                    | Why                                   |
| ----------------- | ----------------------------------------- | ------------------------------------- |
| Frontend host     | Netlify (team: `taingtime`)               | Already linked to GitHub `taingtime`. |
| Backend / DB      | Supabase (org: `Taing Time`, us-east-1)   | Free tier; Auth + Postgres + pg_cron. |
| Email (optional)  | Resend                                    | One domain, reused across projects.   |
| Version control   | GitHub (`taingtime`)                      | Auto-deploy via Netlify when linked.  |
| Background jobs   | Supabase Edge Functions + pg_cron         | No extra service.                     |
| **Skip Railway** unless the project needs long-running workers. |

---

## Playbook steps (Cowork does these)

### Step 0 — gather inputs
Ask user for:
1. Project name (hyphenated, lowercase — used as Supabase project name, Netlify site name, GitHub repo name).
2. Any project-specific needs that deviate from the standard stack.

### Step 1 — copy template

```
cp -r templates/supabase-netlify-starter <target>/<name>
cd <target>/<name>
```

Replace all `__PROJECT_NAME__` placeholders in index.html, app.html, README with actual name.

### Step 2 — provision Supabase

1. `mcp__.../get_cost` — confirm free tier ($0/mo)
2. `mcp__.../confirm_cost` → get confirmation_id
3. `mcp__.../create_project` with name, region `us-east-1`, org `pwezdczheullymgxsotv`, confirm_cost_id
4. Poll `get_project` until `ACTIVE_HEALTHY` (usually instant)
5. `mcp__.../apply_migration` with name `001_init` and contents of `supabase/migrations/001_init.sql`
6. `mcp__.../get_project_url` and `get_publishable_keys` — capture URL and publishable key (`sb_publishable_...`)
7. Replace `__SUPABASE_URL__` and `__SUPABASE_PUBLISHABLE_KEY__` in `public/js/config.js`

### Step 3 — create Netlify site

1. `mcp__.../netlify-project-services-updater` with operation `create-new-project`, teamSlug `taingtime`, name `<name>`
2. Capture `site_id` from response
3. Replace `__NETLIFY_SITE_ID__` in `deploy.sh`

### Step 4 — create GitHub repo (requires PAT in memory)

If GitHub PAT is stored:
```bash
curl -sS -H "Authorization: token $GH_PAT" \
  -d '{"name":"<name>","private":false}' \
  https://api.github.com/user/repos
```
Then in the project dir:
```bash
git init && git add -A && git commit -m "initial" \
  && git branch -M main \
  && git remote add origin https://github.com/taingtime/<name>.git \
  && git push -u origin main
```

If no PAT: skip, output the commands above for the user to run manually.

### Step 5 — manual steps for the user (listed in chat)

- **Supabase Auth URL allowlist.** Dashboard → Authentication → URL Configuration. Add `https://<name>.netlify.app` and your custom domain if any. (No MCP tool exposes this setting.)
- **First deploy.** User runs `./deploy.sh` from the project folder on their Mac. Netlify CLI will prompt to authenticate on the first run only; subsequent runs are silent.
- **(Optional) Resend for email.** If the project sends email, install Supabase CLI locally, then:
  ```bash
  supabase functions deploy deliver-<name> --no-verify-jwt
  supabase secrets set RESEND_API_KEY=<key> FROM_EMAIL="..." APP_URL="https://<name>.netlify.app"
  ```

### Step 6 — confirm

List the final URLs and keys:
- Netlify: `https://<name>.netlify.app`
- Supabase project: `<project-ref>.supabase.co`
- GitHub repo: `https://github.com/taingtime/<name>`
- Deploy command: `./deploy.sh`

---

## Future optimizations

- **Store a GitHub PAT** once in Cowork memory → Step 4 becomes automatic.
- **Store a Resend API key + verified domain** once → Step 5 email block becomes automatic.
- **Add a 'standard template' skill** that captures this playbook verbatim, so "new project" invocations trigger it without the user naming the playbook.
- **Build a Stripe sibling template** when a project will take payments (test/live API keys, basic Checkout wiring).
