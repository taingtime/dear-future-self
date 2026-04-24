// Minimal auth shell. Extend for your domain.
const CFG = window.APP_CONFIG || { supabaseUrl: "", supabaseAnonKey: "" };
const DEMO_MODE = !CFG.supabaseUrl || !CFG.supabaseAnonKey;
const supa = DEMO_MODE ? null : window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
const $ = (s) => document.querySelector(s);

function show(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $("#view-" + id).classList.remove("hidden");
}

async function render() {
  let user = null;
  if (DEMO_MODE) {
    const raw = localStorage.getItem("demo_user");
    user = raw ? JSON.parse(raw) : null;
  } else {
    const { data } = await supa.auth.getUser();
    user = data.user;
  }
  if (!user) { show("auth"); return; }
  $("#user-chip").textContent = user.email;
  show("dashboard");
}

document.addEventListener("DOMContentLoaded", () => {
  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#auth-email").value.trim();
    if (!email) return;
    if (DEMO_MODE) {
      localStorage.setItem("demo_user", JSON.stringify({ id: "demo", email }));
      render();
    } else {
      const { error } = await supa.auth.signInWithOtp({
        email, options: { emailRedirectTo: window.location.href },
      });
      if (error) alert(error.message);
      else $("#auth-sent").classList.remove("hidden");
    }
  });
  $("#sign-out").addEventListener("click", async () => {
    if (DEMO_MODE) localStorage.removeItem("demo_user");
    else await supa.auth.signOut();
    render();
  });
  if (!DEMO_MODE) supa.auth.onAuthStateChange(render);
  render();
});
