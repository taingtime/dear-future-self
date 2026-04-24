// Dear Future Self — main app logic.
//
// Supports two modes:
//   - REAL: Supabase URL + anon key in window.DFS_CONFIG
//   - DEMO: no config → localStorage-only, auth is a display-name only.

const CFG = window.DFS_CONFIG || { supabaseUrl: "", supabaseAnonKey: "" };
const DEMO_MODE = !CFG.supabaseUrl || !CFG.supabaseAnonKey;

// ---------- Supabase client (real mode only) ----------
let supa = null;
if (!DEMO_MODE) {
  // Loaded via CDN <script> tag on the page.
  supa = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
}

// ---------- DOM helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
function show(id) {
  $$(".view").forEach((el) => el.classList.add("hidden"));
  $("#view-" + id).classList.remove("hidden");
}
function escapeHtml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function formatMoney(cents, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format((cents || 0) / 100);
}

const TYPE_META = {
  letter_self: { label: "To myself", icon: "✎", desc: "A letter to future-you" },
  letter_other: { label: "To someone", icon: "✉", desc: "For a friend or loved one" },
  gesture: { label: "Gesture", icon: "✿", desc: "A small prompt or nudge" },
  experience: { label: "Remember", icon: "❋", desc: "Preferences & experiences to recall" },
  micro_gift: { label: "Micro gift", icon: "✦", desc: "Pledge a small gift" },
};

// ---------- State ----------
let currentUser = null; // { id, email, display_name }
let currentCapsules = [];
let currentPins = [];
let currentSection = "capsules"; // "capsules" | "pins"
let composingPinTags = []; // in-progress tag list during pin compose
let currentPosition = null; // { lat, lng } from browser geolocation
let locationWatchId = null;
const notifiedPinIds = new Map(); // pinId -> timestamp of last notification (debounce)
const NOTIFY_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

// ---------- Auth ----------
async function getUser() {
  if (DEMO_MODE) {
    const raw = localStorage.getItem("dfs_demo_user");
    return raw ? JSON.parse(raw) : null;
  }
  const { data } = await supa.auth.getUser();
  if (!data.user) return null;
  return {
    id: data.user.id,
    email: data.user.email,
    display_name: data.user.user_metadata?.display_name || data.user.email,
  };
}

async function signInMagicLink(email) {
  if (DEMO_MODE) {
    const user = { id: "demo-" + Date.now(), email, display_name: email };
    localStorage.setItem("dfs_demo_user", JSON.stringify(user));
    return { ok: true, demo: true };
  }
  const { error } = await supa.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

async function signOut() {
  if (DEMO_MODE) {
    localStorage.removeItem("dfs_demo_user");
  } else {
    await supa.auth.signOut();
  }
  currentUser = null;
  render();
}

// ---------- Capsule CRUD ----------
async function loadCapsules() {
  if (DEMO_MODE) {
    const raw = localStorage.getItem("dfs_demo_capsules_" + currentUser.id);
    return raw ? JSON.parse(raw) : [];
  }
  const { data, error } = await supa
    .from("capsules")
    .select("*")
    .order("deliver_at", { ascending: true });
  if (error) { console.error(error); return []; }
  return data || [];
}

async function createCapsule(c) {
  if (DEMO_MODE) {
    const list = await loadCapsules();
    const newOne = {
      ...c,
      id: "c-" + Date.now(),
      author_id: currentUser.id,
      status: "scheduled",
      created_at: new Date().toISOString(),
    };
    list.push(newOne);
    localStorage.setItem("dfs_demo_capsules_" + currentUser.id, JSON.stringify(list));
    return { ok: true };
  }
  const { error } = await supa.from("capsules").insert({
    ...c,
    author_id: currentUser.id,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ---------- Pins CRUD ----------
async function loadPins() {
  if (DEMO_MODE) {
    const raw = localStorage.getItem("dfs_demo_pins_" + currentUser.id);
    return raw ? JSON.parse(raw) : [];
  }
  const { data, error } = await supa
    .from("preference_pins")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) { console.error(error); return []; }
  return data || [];
}

async function createPin(p) {
  if (DEMO_MODE) {
    const list = await loadPins();
    const newOne = {
      ...p,
      id: "p-" + Date.now(),
      author_id: currentUser.id,
      active: true,
      trigger_count: 0,
      created_at: new Date().toISOString(),
    };
    list.push(newOne);
    localStorage.setItem("dfs_demo_pins_" + currentUser.id, JSON.stringify(list));
    return { ok: true };
  }
  const { error } = await supa.from("preference_pins").insert({
    ...p,
    author_id: currentUser.id,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

async function deletePin(id) {
  if (DEMO_MODE) {
    const list = (await loadPins()).filter((p) => p.id !== id);
    localStorage.setItem("dfs_demo_pins_" + currentUser.id, JSON.stringify(list));
    return;
  }
  await supa.from("preference_pins").delete().eq("id", id);
}

async function markPinTriggered(id) {
  if (DEMO_MODE) {
    const list = (await loadPins()).map((p) =>
      p.id === id
        ? { ...p, trigger_count: (p.trigger_count || 0) + 1, last_triggered_at: new Date().toISOString() }
        : p,
    );
    localStorage.setItem("dfs_demo_pins_" + currentUser.id, JSON.stringify(list));
    return;
  }
  // Use an RPC or two-step: fetch current count then update.
  const { data } = await supa.from("preference_pins").select("trigger_count").eq("id", id).maybeSingle();
  const n = (data?.trigger_count || 0) + 1;
  await supa.from("preference_pins")
    .update({ trigger_count: n, last_triggered_at: new Date().toISOString() })
    .eq("id", id);
}

// ---------- Geo helpers ----------
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function pinDistance(p) {
  if (!currentPosition || p.latitude == null || p.longitude == null) return null;
  return haversineMeters(currentPosition.lat, currentPosition.lng, p.latitude, p.longitude);
}

function formatDistance(m) {
  if (m == null) return "";
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

async function cancelCapsule(id) {
  if (DEMO_MODE) {
    const list = (await loadCapsules()).map((c) =>
      c.id === id ? { ...c, status: "cancelled" } : c,
    );
    localStorage.setItem("dfs_demo_capsules_" + currentUser.id, JSON.stringify(list));
    return;
  }
  await supa.from("capsules").update({ status: "cancelled" }).eq("id", id);
}

// ---------- Render ----------
async function render() {
  currentUser = await getUser();
  if (!currentUser) {
    show("auth");
    $("#topnav").classList.add("hidden");
    return;
  }
  $("#user-chip").textContent = currentUser.email;
  $("#topnav").classList.remove("hidden");
  // Update topnav highlighting
  $$("#topnav .topnav-link").forEach((b) =>
    b.classList.toggle("active", b.dataset.section === currentSection),
  );

  if (currentSection === "pins") {
    show("pins");
    currentPins = await loadPins();
    renderPinList();
    // kick off location if previously granted
    maybeStartLocationWatch();
  } else {
    show("dashboard");
    currentCapsules = await loadCapsules();
    renderCapsuleList();
  }
}

function renderCapsuleList() {
  const tab = $("#view-dashboard .tab.active").dataset.tab;
  let list = currentCapsules;
  const now = new Date();
  if (tab === "upcoming") {
    list = list.filter(
      (c) => c.status === "scheduled" && new Date(c.deliver_at) > now,
    );
  } else if (tab === "delivered") {
    list = list.filter((c) => c.status === "delivered");
  } else if (tab === "all") {
    // show everything
  }

  const host = $("#capsule-list");
  if (list.length === 0) {
    host.innerHTML = `<div class="empty">No capsules here yet. <a href="#" id="empty-write">Write one</a>.</div>`;
    const link = $("#empty-write");
    if (link) link.onclick = (e) => { e.preventDefault(); openCompose(); };
    return;
  }

  host.innerHTML = list
    .sort((a, b) => new Date(a.deliver_at) - new Date(b.deliver_at))
    .map(renderCapsuleRow)
    .join("");
  host.querySelectorAll("[data-open]").forEach((el) => {
    el.onclick = () => openCapsule(el.dataset.open);
  });
}

function renderCapsuleRow(c) {
  const when = new Date(c.deliver_at);
  const day = when.getDate();
  const mon = when.toLocaleString("en-US", { month: "short" });
  const yr = when.getFullYear();
  const meta = TYPE_META[c.type] || { label: c.type, icon: "•" };
  const preview = (c.title || c.body || "").slice(0, 120);
  const statusCls = `status-${c.status}`;
  const recipient =
    c.type === "letter_other" && c.recipient_name
      ? ` · for ${escapeHtml(c.recipient_name)}`
      : "";
  return `
    <div class="capsule-item" data-open="${c.id}" style="cursor:pointer">
      <div class="when">
        <div class="day">${day}</div>
        <div class="mon">${mon} ${yr}</div>
      </div>
      <div>
        <div class="meta">${meta.icon} ${meta.label}${recipient}</div>
        <div class="title">${escapeHtml(c.title || "(untitled)")}</div>
        <div class="preview">${escapeHtml(preview)}</div>
      </div>
      <div class="status ${statusCls}">${c.status}</div>
    </div>
  `;
}

// ---------- Pin list render ----------
function renderPinList() {
  const tabEl = $("#view-pins .tab.active");
  const tab = tabEl ? tabEl.dataset.pintab : "nearby";
  const query = ($("#tag-search").value || "").trim().toLowerCase();

  let list = currentPins.filter((p) => p.active !== false);

  if (query) {
    list = list.filter((p) => {
      const hay = [
        p.title || "",
        p.body || "",
        p.place_name || "",
        (p.tags || []).join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(query);
    });
  } else if (tab === "nearby") {
    if (!currentPosition) {
      list = [];
    } else {
      list = list
        .map((p) => ({ pin: p, d: pinDistance(p) }))
        .filter(({ d }) => d != null)
        .sort((a, b) => a.d - b.d)
        .slice(0, 20)
        .map(({ pin }) => pin);
    }
  }

  const host = $("#pin-list");
  if (list.length === 0) {
    let msg;
    if (query) msg = `No pins matching "${escapeHtml(query)}".`;
    else if (tab === "nearby" && !currentPosition) msg = "Enable location to see pins near you.";
    else if (tab === "nearby") msg = "No pins near you right now.";
    else msg = `No pins yet. <a href="#" id="empty-pin">Create one</a>.`;
    host.innerHTML = `<div class="empty">${msg}</div>`;
    const link = $("#empty-pin");
    if (link) link.onclick = (e) => { e.preventDefault(); openPinCompose(); };
    return;
  }

  host.innerHTML = list.map(renderPinRow).join("");
  host.querySelectorAll("[data-open-pin]").forEach((el) => {
    el.onclick = () => openPin(el.dataset.openPin);
  });
}

function renderPinRow(p) {
  const sent = p.sentiment || "neutral";
  const sentIcon = sent === "positive" ? "✓" : sent === "negative" ? "✗" : "•";
  const d = pinDistance(p);
  const distLabel = d != null ? formatDistance(d) : "";
  const tags = (p.tags || [])
    .slice(0, 5)
    .map((t) => `<span class="pin-tag">${escapeHtml(t)}</span>`)
    .join("");
  const where = p.place_name
    ? `${escapeHtml(p.place_name)}${p.place_address ? " · " + escapeHtml(p.place_address) : ""}`
    : p.place_address
      ? escapeHtml(p.place_address)
      : "";
  return `
    <div class="pin-item" data-open-pin="${p.id}">
      <div class="pin-head">
        <span class="pin-sentiment ${sent}">${sentIcon}</span>
        <div class="pin-title">${escapeHtml(p.title)}</div>
        ${distLabel ? `<div class="pin-distance">${distLabel}</div>` : ""}
      </div>
      ${where ? `<div class="pin-meta">${where}</div>` : ""}
      ${p.body ? `<div class="pin-body">${escapeHtml(p.body)}</div>` : ""}
      ${tags ? `<div class="pin-tags">${tags}</div>` : ""}
    </div>
  `;
}

// ---------- Pin compose ----------
function openPinCompose() {
  const form = $("#pin-form");
  form.reset();
  $("#pin-lat").value = "";
  $("#pin-lng").value = "";
  $("#pin-radius").value = "150";
  $("#pin-loc-status").textContent = "";
  $("#pin-loc-status").className = "loc-status";
  composingPinTags = [];
  renderComposingChips();
  $$(".sentiment-opt").forEach((o) =>
    o.classList.toggle("active", o.dataset.sent === "positive"),
  );
  $("#pin-sentiment").value = "positive";
  show("pin-compose");
}

function renderComposingChips() {
  const host = $("#pin-chips");
  // Remove all chips but keep input
  const input = $("#pin-tag-input");
  host.querySelectorAll(".chip").forEach((c) => c.remove());
  composingPinTags.forEach((t) => {
    const el = document.createElement("span");
    el.className = "chip";
    el.innerHTML = `${escapeHtml(t)} <span class="x" data-rm="${escapeHtml(t)}">×</span>`;
    host.insertBefore(el, input);
  });
  host.querySelectorAll(".chip .x").forEach((x) => {
    x.onclick = () => {
      composingPinTags = composingPinTags.filter((t) => t !== x.dataset.rm);
      renderComposingChips();
    };
  });
}

function bindPinForm() {
  // Sentiment picker
  $$("#view-pin-compose .sentiment-opt").forEach((opt) => {
    opt.addEventListener("click", () => {
      $$("#view-pin-compose .sentiment-opt").forEach((o) => o.classList.remove("active"));
      opt.classList.add("active");
      $("#pin-sentiment").value = opt.dataset.sent;
    });
  });

  // Tag input — enter or comma commits a chip
  const tagInput = $("#pin-tag-input");
  tagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const v = tagInput.value.trim().replace(/,$/, "");
      if (v && !composingPinTags.includes(v)) {
        composingPinTags.push(v);
        renderComposingChips();
      }
      tagInput.value = "";
    } else if (e.key === "Backspace" && !tagInput.value && composingPinTags.length) {
      composingPinTags.pop();
      renderComposingChips();
    }
  });
  // Also commit on blur
  tagInput.addEventListener("blur", () => {
    const v = tagInput.value.trim();
    if (v && !composingPinTags.includes(v)) {
      composingPinTags.push(v);
      renderComposingChips();
    }
    tagInput.value = "";
  });

  // "Use current location"
  $("#pin-use-current").addEventListener("click", () => {
    if (!navigator.geolocation) {
      $("#pin-loc-status").className = "loc-status err";
      $("#pin-loc-status").textContent = "This browser doesn't support geolocation.";
      return;
    }
    $("#pin-loc-status").className = "loc-status";
    $("#pin-loc-status").textContent = "Getting your location…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        $("#pin-lat").value = pos.coords.latitude.toFixed(6);
        $("#pin-lng").value = pos.coords.longitude.toFixed(6);
        $("#pin-loc-status").className = "loc-status ok";
        $("#pin-loc-status").textContent = `Got it: ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)} (±${Math.round(pos.coords.accuracy)}m)`;
      },
      (err) => {
        $("#pin-loc-status").className = "loc-status err";
        $("#pin-loc-status").textContent = "Could not get location: " + err.message;
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });

  // Submit
  $("#pin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#pin-title").value.trim();
    if (!title) return;

    // Flush any pending tag input
    const pending = $("#pin-tag-input").value.trim();
    if (pending && !composingPinTags.includes(pending)) composingPinTags.push(pending);

    const lat = parseFloat($("#pin-lat").value);
    const lng = parseFloat($("#pin-lng").value);
    const payload = {
      title,
      body: $("#pin-body").value.trim() || null,
      sentiment: $("#pin-sentiment").value,
      place_name: $("#pin-place-name").value.trim() || null,
      place_address: $("#pin-place-address").value.trim() || null,
      latitude: isFinite(lat) ? lat : null,
      longitude: isFinite(lng) ? lng : null,
      radius_meters: parseInt($("#pin-radius").value, 10) || 150,
      tags: composingPinTags.slice(),
    };

    if (!payload.latitude && payload.tags.length === 0) {
      alert("Add either a location or at least one tag so the pin has something to trigger on.");
      return;
    }

    const btn = $("#pin-submit");
    btn.disabled = true; btn.textContent = "Saving…";
    const res = await createPin(payload);
    btn.disabled = false; btn.textContent = "Save pin";
    if (!res.ok) {
      alert("Could not save pin: " + (res.error || "unknown error"));
      return;
    }
    currentSection = "pins";
    await render();
  });

  $("#pin-cancel").addEventListener("click", (e) => {
    e.preventDefault();
    currentSection = "pins";
    render();
  });
}

// ---------- Pin detail ----------
function openPin(id) {
  const p = currentPins.find((x) => x.id === id);
  if (!p) return;
  const sent = p.sentiment || "neutral";
  const sentIcon = sent === "positive" ? "✓" : sent === "negative" ? "✗" : "•";
  const d = pinDistance(p);
  const tags = (p.tags || []).map((t) => `<span class="pin-tag">${escapeHtml(t)}</span>`).join(" ");
  const where = p.place_name ? escapeHtml(p.place_name) : "";
  const addr = p.place_address ? escapeHtml(p.place_address) : "";

  // Build an Apple Reminders / Shortcuts export: a `shortcuts://` URL runs
  // a user-side shortcut (they install once), falling back to a plain
  // reminder URL scheme `x-apple-reminderkit://` is not public, so we
  // offer a Shortcuts Gallery link explaining how to set up one-tap import.
  const reminderText =
    `${p.title}` +
    (p.body ? `\n\n${p.body}` : "") +
    (p.place_name ? `\n\nPlace: ${p.place_name}` : "") +
    (p.place_address ? `\n${p.place_address}` : "") +
    (p.latitude ? `\nCoords: ${p.latitude}, ${p.longitude} (radius ${p.radius_meters}m)` : "") +
    ((p.tags || []).length ? `\nTags: ${p.tags.join(", ")}` : "");

  $("#pin-full").innerHTML = `
    <div class="pin-head">
      <span class="pin-sentiment ${sent}">${sentIcon}</span>
      <h2 style="margin:0;flex:1;">${escapeHtml(p.title)}</h2>
      ${d != null ? `<div class="pin-distance">${formatDistance(d)}</div>` : ""}
    </div>
    ${where ? `<div class="pin-meta" style="margin-top:4px;">${where}${addr ? " · " + addr : ""}</div>` : addr ? `<div class="pin-meta">${addr}</div>` : ""}
    ${p.body ? `<div class="body" style="margin-top:20px;">${escapeHtml(p.body)}</div>` : ""}
    ${tags ? `<div class="pin-tags" style="margin-top:16px;">${tags}</div>` : ""}
    ${p.latitude ? `<div class="small muted" style="margin-top:18px;">Coords ${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)} · radius ${p.radius_meters}m</div>` : ""}
    ${p.trigger_count ? `<div class="small muted">Surfaced ${p.trigger_count} time${p.trigger_count === 1 ? "" : "s"}${p.last_triggered_at ? " · last " + new Date(p.last_triggered_at).toLocaleString() : ""}</div>` : ""}

    <div class="card" style="background:var(--bg-inset);margin-top:24px;padding:16px 20px;box-shadow:none;">
      <div class="eyebrow">Real background alerts (iPhone)</div>
      <p class="small muted" style="margin:6px 0 10px;">
        Safari can't geofence in the background — but iOS Reminders can. Install the
        <a href="#" id="shortcut-install-link">DFS&nbsp;Pin shortcut</a> once, then tap
        the button below and it becomes a real location-triggered reminder on your iPhone.
      </p>
      <div class="row" style="margin-top:10px; flex-wrap: wrap;">
        <a class="btn btn-primary" id="send-to-shortcut">Add to iOS Reminders</a>
        <button class="btn btn-secondary" id="copy-export">Copy as text</button>
        ${p.latitude ? `<a class="btn btn-secondary" target="_blank" rel="noreferrer" href="https://maps.apple.com/?ll=${p.latitude},${p.longitude}&q=${encodeURIComponent(p.place_name || p.title)}">Open in Maps</a>` : ""}
      </div>
      <textarea id="pin-export" readonly rows="4" style="font-family:ui-monospace,monospace;font-size:12px;margin-top:12px;">${escapeHtml(reminderText)}</textarea>
    </div>

    <div class="row end" style="margin-top:28px;">
      <button class="btn btn-danger" id="pin-delete">Delete pin</button>
      <button class="btn btn-secondary" id="pin-back">Back</button>
    </div>
  `;
  show("pin");

  $("#pin-back").onclick = () => { currentSection = "pins"; render(); };

  // iOS Shortcuts deep link — fires a user-installed "DFS Pin" Shortcut
  // that creates a location-triggered iOS Reminder. Pipe-delimited input
  // so the Shortcut can parse it with a single Text action.
  const shortcutPayload = [
    p.title || "",
    p.body || "",
    p.place_name || "",
    p.place_address || "",
    p.latitude != null ? String(p.latitude) : "",
    p.longitude != null ? String(p.longitude) : "",
    String(p.radius_meters || 150),
    (p.tags || []).join(","),
  ].join("|");
  const shortcutUrl =
    "shortcuts://run-shortcut?name=" + encodeURIComponent("DFS Pin") +
    "&input=text&text=" + encodeURIComponent(shortcutPayload);
  const sendBtn = $("#send-to-shortcut");
  if (sendBtn) sendBtn.href = shortcutUrl;

  const installLink = $("#shortcut-install-link");
  if (installLink) {
    installLink.onclick = (e) => {
      e.preventDefault();
      alert(
        "One-time setup:\n\n" +
        "1. Open the Shortcuts app on iPhone.\n" +
        "2. Tap the + button to create a new shortcut, named exactly 'DFS Pin'.\n" +
        "3. Add a 'Get text from input' action, then a 'Split text' action (by '|').\n" +
        "4. Add 'Add new reminder' — map the split parts to title/notes/location.\n" +
        "5. Set the reminder's location trigger using the lat/lng and radius fields.\n\n" +
        "After that, every pin's 'Add to iOS Reminders' button will fire this Shortcut with the pin's data."
      );
    };
  }

  $("#copy-export").onclick = async () => {
    try {
      await navigator.clipboard.writeText(reminderText);
      $("#copy-export").textContent = "Copied";
      setTimeout(() => { const b = $("#copy-export"); if (b) b.textContent = "Copy text"; }, 1500);
    } catch { /* older browser, user can select the text manually */ }
  };
  $("#pin-delete").onclick = async () => {
    if (!confirm("Delete this pin? This can't be undone.")) return;
    await deletePin(id);
    currentSection = "pins";
    await render();
  };
}

// ---------- Location watch + notifications ----------
async function requestNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const res = await Notification.requestPermission();
  return res === "granted";
}

function notifyPinEntered(p) {
  const key = p.id;
  const last = notifiedPinIds.get(key) || 0;
  if (Date.now() - last < NOTIFY_COOLDOWN_MS) return;
  notifiedPinIds.set(key, Date.now());

  const sentIcon = p.sentiment === "positive" ? "✓" : p.sentiment === "negative" ? "✗" : "•";
  const title = `${sentIcon} ${p.place_name || p.title}`;
  const body = p.title + (p.body ? "\n" + p.body : "");

  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification(title, { body }); } catch { /* ignore */ }
  }
  markPinTriggered(p.id).catch(() => {});
}

function checkNearby() {
  if (!currentPosition || !currentPins || currentPins.length === 0) return;
  for (const p of currentPins) {
    if (!p.active || p.latitude == null || p.longitude == null) continue;
    const d = pinDistance(p);
    if (d != null && d <= (p.radius_meters || 150)) {
      notifyPinEntered(p);
    }
  }
}

function updateNearbyStrip() {
  const strip = $("#nearby-strip");
  const status = $("#nearby-status");
  if (!strip || !status) return;
  if (currentPosition) {
    strip.classList.remove("inactive");
    const count = (currentPins || []).filter((p) => {
      const d = pinDistance(p);
      return d != null && d <= (p.radius_meters || 150);
    }).length;
    if (count > 0) {
      status.textContent = `${count} pin${count === 1 ? "" : "s"} firing nearby — see below.`;
    } else {
      status.textContent = `Location on. Watching ${(currentPins || []).filter((p) => p.latitude != null).length} pin${((currentPins || []).filter((p) => p.latitude != null).length) === 1 ? "" : "s"}.`;
    }
    $("#enable-location").textContent = "Refresh";
  } else {
    strip.classList.add("inactive");
    status.textContent = "Location not enabled — click to allow nearby detection.";
    $("#enable-location").textContent = "Enable location";
  }
}

function maybeStartLocationWatch() {
  if (!navigator.geolocation) return;
  if (locationWatchId != null) return;
  // Only auto-start if permission was previously granted.
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: "geolocation" }).then((status) => {
      if (status.state === "granted") startLocationWatch();
    }).catch(() => {});
  }
}

function startLocationWatch() {
  if (!navigator.geolocation || locationWatchId != null) return;
  locationWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      currentPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      updateNearbyStrip();
      if (currentSection === "pins") renderPinList();
      checkNearby();
    },
    (err) => {
      console.warn("geolocation error", err);
      updateNearbyStrip();
    },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 },
  );
}

// ---------- Compose ----------
function openCompose() {
  const form = $("#compose-form");
  form.reset();
  $$("#type-picker .type-tile").forEach((t) => t.classList.remove("active"));
  $('#type-picker .type-tile[data-type="letter_self"]').classList.add("active");
  $("#compose-type").value = "letter_self";
  applyTypeUI("letter_self");

  // default deliver date: 1 week from today, 9am local
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(9, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  $("#deliver-at").value =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  show("compose");
}

function applyTypeUI(type) {
  const showIf = (sel, cond) =>
    $$(sel).forEach((el) => el.classList.toggle("hidden", !cond));
  showIf(".only-other", type === "letter_other");
  showIf(".only-gesture", type === "gesture");
  showIf(".only-gift", type === "micro_gift");
  showIf(".only-self", type === "letter_self" || type === "experience");

  const bodyHint = $("#body-hint");
  if (type === "letter_self") bodyHint.textContent = "Speak to yourself. What do you want them to remember you said today?";
  else if (type === "letter_other") bodyHint.textContent = "Write as if you're handing them a sealed envelope.";
  else if (type === "gesture") bodyHint.textContent = "A few words of context or warmth (optional).";
  else if (type === "experience") bodyHint.textContent = "Details, textures, feelings — the things you'd want to recall.";
  else if (type === "micro_gift") bodyHint.textContent = "The note matters more than the amount. What's the intention?";
}

function bindComposeForm() {
  $("#type-picker").addEventListener("click", (e) => {
    const tile = e.target.closest(".type-tile");
    if (!tile) return;
    $$("#type-picker .type-tile").forEach((t) => t.classList.remove("active"));
    tile.classList.add("active");
    $("#compose-type").value = tile.dataset.type;
    applyTypeUI(tile.dataset.type);
  });

  $("#compose-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const type = $("#compose-type").value;
    const deliver_at = new Date($("#deliver-at").value).toISOString();
    const body = $("#body").value.trim();
    if (!body) {
      alert("Write a few words first — that's the whole point.");
      return;
    }
    const payload = {
      type,
      title: $("#title").value.trim() || null,
      body,
      seal_note: $("#seal-note").value.trim() || null,
      deliver_at,
      from_name: currentUser.display_name || currentUser.email,
    };
    if (type === "letter_other") {
      payload.recipient_email = $("#recipient-email").value.trim() || null;
      payload.recipient_name = $("#recipient-name").value.trim() || null;
    }
    if (type === "gesture") {
      payload.gesture_prompt = $("#gesture-prompt").value.trim() || null;
    }
    if (type === "micro_gift") {
      const dollars = parseFloat($("#gift-amount").value || "0");
      payload.gift_amount_cents = Math.round(dollars * 100) || null;
      payload.gift_link = $("#gift-link").value.trim() || null;
      payload.recipient_email = $("#gift-recipient").value.trim() || null;
    }

    const btn = $("#compose-submit");
    btn.disabled = true; btn.textContent = "Sealing…";
    const res = await createCapsule(payload);
    btn.disabled = false; btn.textContent = "Seal the capsule";
    if (!res.ok) {
      alert("Could not save capsule: " + (res.error || "unknown error"));
      return;
    }
    await render();
  });

  $("#compose-cancel").addEventListener("click", (e) => {
    e.preventDefault();
    render();
  });
}

// ---------- Read single capsule ----------
async function openCapsule(id) {
  const c = currentCapsules.find((x) => x.id === id);
  if (!c) return;
  const when = new Date(c.deliver_at);
  const sealed = new Date(c.created_at);
  const meta = TYPE_META[c.type] || { label: c.type, icon: "•" };
  const inPast = when < new Date() || c.status === "delivered";

  let extra = "";
  if (c.type === "gesture" && c.gesture_prompt) {
    extra = `<div class="gesture-block"><div class="eyebrow">The gesture</div><div style="font-size:20px;margin-top:6px;">${escapeHtml(c.gesture_prompt)}</div></div>`;
  }
  if (c.type === "micro_gift" && c.gift_amount_cents) {
    extra = `<div class="gift-block"><div class="eyebrow">Pledged</div><div class="gift-amount">${formatMoney(c.gift_amount_cents, c.gift_currency || "USD")}</div>${c.gift_link ? `<div class="small" style="margin-top:6px;"><a href="${escapeHtml(c.gift_link)}" target="_blank" rel="noreferrer">${escapeHtml(c.gift_link)}</a></div>` : ""}</div>`;
  }

  const recipientLine =
    c.type === "letter_other"
      ? `<div class="small muted">For ${escapeHtml(c.recipient_name || c.recipient_email || "(someone)")}</div>`
      : "";

  $("#capsule-full").innerHTML = `
    <button class="close" aria-label="back">&larr; back</button>
    <div class="eyebrow">${meta.icon} ${meta.label} · ${c.status}</div>
    <h2>${escapeHtml(c.title || "(untitled)")}</h2>
    ${recipientLine}
    <div class="small muted" style="margin-top:6px;">
      Sealed ${sealed.toLocaleDateString()} · ${inPast ? "Delivered" : "Arrives"}
      ${when.toLocaleString()}
    </div>
    ${c.seal_note ? `<div class="seal-note"><div class="eyebrow">When this was written</div>${escapeHtml(c.seal_note)}</div>` : ""}
    ${extra}
    <div class="body">${escapeHtml(c.body)}</div>
    <div class="row end" style="margin-top:28px;">
      ${c.status === "scheduled" ? `<button class="btn btn-danger" id="cancel-btn">Cancel this capsule</button>` : ""}
      <button class="btn btn-secondary" id="back-btn">Back</button>
    </div>
  `;
  show("capsule");
  $("#capsule-full .close").onclick = () => render();
  $("#back-btn").onclick = () => render();
  const cancel = $("#cancel-btn");
  if (cancel) {
    cancel.onclick = async () => {
      if (!confirm("Cancel this capsule? It won't be delivered.")) return;
      await cancelCapsule(id);
      await render();
    };
  }
}

// ---------- Boot ----------
document.addEventListener("DOMContentLoaded", async () => {
  if (DEMO_MODE) $("#demo-banner").classList.remove("hidden");

  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#auth-email").value.trim();
    if (!email) return;
    const btn = $("#auth-submit");
    btn.disabled = true; btn.textContent = "Sending…";
    const res = await signInMagicLink(email);
    btn.disabled = false; btn.textContent = "Continue";
    if (!res.ok) { alert(res.error); return; }
    if (res.demo) {
      await render();
    } else {
      $("#auth-sent").classList.remove("hidden");
    }
  });

  $("#sign-out").addEventListener("click", signOut);
  $("#new-capsule").addEventListener("click", openCompose);
  $("#new-pin").addEventListener("click", openPinCompose);

  $$("#view-dashboard .tab").forEach((t) => {
    t.addEventListener("click", () => {
      $$("#view-dashboard .tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      renderCapsuleList();
    });
  });

  // Top-level nav
  $$("#topnav .topnav-link").forEach((b) => {
    b.addEventListener("click", () => {
      currentSection = b.dataset.section;
      render();
    });
  });

  // Pins sub-tabs
  $$("#view-pins .tab").forEach((t) => {
    t.addEventListener("click", () => {
      $$("#view-pins .tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      $("#tag-search").value = "";
      renderPinList();
    });
  });

  // Tag search
  $("#tag-search").addEventListener("input", renderPinList);

  // Enable-location button
  $("#enable-location").addEventListener("click", async () => {
    if (!navigator.geolocation) {
      alert("This browser doesn't support geolocation.");
      return;
    }
    // Request notification permission as well (pairs nicely with nearby alerts)
    await requestNotificationPermission();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        currentPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        startLocationWatch();
        updateNearbyStrip();
        renderPinList();
        checkNearby();
      },
      (err) => alert("Could not access location: " + err.message),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });

  bindComposeForm();
  bindPinForm();

  // Handle Supabase magic-link callback
  if (!DEMO_MODE) {
    supa.auth.onAuthStateChange((_event, _session) => render());
  }

  await render();
});
