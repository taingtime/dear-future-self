// Supabase Edge Function — deliver-capsules
// Runs on a pg_cron schedule (every 5 min). Finds scheduled capsules that
// are due and sends them via Resend.
//
// Deploy:
//   supabase functions deploy deliver-capsules --no-verify-jwt
// Required secrets (set via `supabase secrets set KEY=VALUE`):
//   RESEND_API_KEY     — Resend transactional email key
//   FROM_EMAIL         — e.g. "Dear Future Self <notes@yourdomain.com>"
//   APP_URL            — e.g. "https://dearfutureself.netlify.app" (used in links)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") ?? "Dear Future Self <onboarding@resend.dev>";
const APP_URL = Deno.env.get("APP_URL") ?? "";

type CapsuleType =
  | "letter_self"
  | "letter_other"
  | "gesture"
  | "experience"
  | "micro_gift";

interface Capsule {
  id: string;
  author_id: string;
  type: CapsuleType;
  title: string | null;
  body: string;
  seal_note: string | null;
  gesture_prompt: string | null;
  recipient_email: string | null;
  recipient_name: string | null;
  from_name: string | null;
  gift_amount_cents: number | null;
  gift_currency: string | null;
  gift_link: string | null;
  deliver_at: string;
  created_at: string;
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

function formatMoney(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100,
  );
}

function subjectFor(c: Capsule): string {
  if (c.title) return c.title;
  switch (c.type) {
    case "letter_self":
      return "A note you sent yourself";
    case "letter_other":
      return `A note from ${c.from_name ?? "someone who was thinking of you"}`;
    case "gesture":
      return "A small gesture for today";
    case "experience":
      return "Something past-you wanted you to remember";
    case "micro_gift":
      return c.from_name
        ? `A small gift from ${c.from_name}`
        : "A small gift from past-you";
  }
}

function renderHtml(c: Capsule): string {
  const sent = new Date(c.created_at).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const sealBlock = c.seal_note
    ? `<blockquote style="margin:24px 0;padding:16px 20px;border-left:3px solid #c7a97a;background:#fbf7ef;color:#5b4a34;font-style:italic;border-radius:4px;">
         <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#8a7654;margin-bottom:6px;">When this was written</div>
         ${escapeHtml(c.seal_note)}
       </blockquote>`
    : "";

  let extra = "";
  if (c.type === "gesture" && c.gesture_prompt) {
    extra = `<div style="margin:24px 0;padding:20px;background:#f5ead7;border-radius:8px;text-align:center;">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#8a7654;margin-bottom:8px;">Today's gesture</div>
      <div style="font-size:20px;color:#3a2e1e;font-family:Georgia,serif;">${escapeHtml(c.gesture_prompt)}</div>
    </div>`;
  }
  if (c.type === "micro_gift" && c.gift_amount_cents) {
    const amount = formatMoney(c.gift_amount_cents, c.gift_currency ?? "USD");
    extra = `<div style="margin:24px 0;padding:20px;background:#f5ead7;border-radius:8px;text-align:center;">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#8a7654;margin-bottom:8px;">Pledged</div>
      <div style="font-size:28px;color:#3a2e1e;font-family:Georgia,serif;">${amount}</div>
      ${c.gift_link ? `<a href="${escapeAttr(c.gift_link)}" style="display:inline-block;margin-top:12px;color:#7a5a2a;">Claim / view</a>` : ""}
    </div>`;
  }

  const bodyHtml = escapeHtml(c.body).replace(/\n/g, "<br/>");

  const footer = APP_URL
    ? `<div style="margin-top:40px;padding-top:20px;border-top:1px solid #e8dec9;font-size:12px;color:#8a7654;text-align:center;">
         Delivered by <a href="${APP_URL}" style="color:#8a7654;">Dear Future Self</a>
       </div>`
    : "";

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f7f1e5;font-family:Georgia,'Times New Roman',serif;color:#3a2e1e;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="background:#fffaf0;border-radius:12px;padding:40px 32px;box-shadow:0 2px 12px rgba(90,70,40,0.08);">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.15em;color:#8a7654;margin-bottom:8px;">Sealed ${sent}</div>
      ${c.title ? `<h1 style="font-size:26px;margin:0 0 24px 0;color:#2a2015;">${escapeHtml(c.title)}</h1>` : ""}
      ${sealBlock}
      ${extra}
      <div style="font-size:17px;line-height:1.7;margin-top:24px;">${bodyHtml}</div>
      ${c.from_name ? `<div style="margin-top:32px;font-style:italic;color:#5b4a34;">— ${escapeHtml(c.from_name)}</div>` : ""}
      ${footer}
    </div>
  </div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

async function sendEmail(to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend ${res.status}: ${text}`);
  }
  return res.json();
}

async function deliverOne(c: Capsule, authorEmail: string): Promise<void> {
  const toSelf =
    c.type === "letter_self" ||
    c.type === "experience" ||
    (c.type === "gesture" && !c.recipient_email) ||
    (c.type === "micro_gift" && !c.recipient_email);

  const to = toSelf ? authorEmail : c.recipient_email!;
  const subject = subjectFor(c);
  const html = renderHtml(c);

  await sendEmail(to, subject, html);
}

Deno.serve(async (_req) => {
  const nowIso = new Date().toISOString();

  // Find due, scheduled capsules (cap at 50 per run to stay within time limits).
  const { data: capsules, error } = await admin
    .from("capsules")
    .select("*")
    .eq("status", "scheduled")
    .lte("deliver_at", nowIso)
    .limit(50);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
    });
  }
  if (!capsules || capsules.length === 0) {
    return new Response(JSON.stringify({ delivered: 0 }), { status: 200 });
  }

  // Load author emails in one shot
  const authorIds = [...new Set(capsules.map((c: Capsule) => c.author_id))];
  const { data: authors } = await admin
    .from("profiles")
    .select("id, email")
    .in("id", authorIds);
  const emailById = new Map<string, string>();
  for (const p of authors ?? []) emailById.set(p.id, p.email);

  const results = { delivered: 0, failed: 0, errors: [] as string[] };

  for (const c of capsules as Capsule[]) {
    const authorEmail = emailById.get(c.author_id);
    if (!authorEmail) {
      await admin
        .from("capsules")
        .update({ status: "failed", delivery_error: "no author email" })
        .eq("id", c.id);
      results.failed++;
      continue;
    }
    try {
      await deliverOne(c, authorEmail);
      await admin
        .from("capsules")
        .update({ status: "delivered", delivered_at: new Date().toISOString() })
        .eq("id", c.id);
      results.delivered++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin
        .from("capsules")
        .update({ status: "failed", delivery_error: msg })
        .eq("id", c.id);
      results.failed++;
      results.errors.push(`${c.id}: ${msg}`);
    }
  }

  return new Response(JSON.stringify(results), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
