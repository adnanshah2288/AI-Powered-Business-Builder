// ============================================================
// STATE AND HELPERS
// ============================================================
// PURPOSE: Keep the signed-in user and open project in memory, and provide
//          the API helper every screen uses.
// FAILURE CASES: an expired session returns the user to sign-in; other errors
//                show the server's safe message.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const state = { user: null, project: null, oppIndex: null, mode: "login" };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function api(path, method = "GET", body = null) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : null,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error("The server returned an unexpected response.");
  }
  if (!json.success) {
    if (json.error?.type === "AUTH_REQUIRED") showAuth("Your session has ended. Please sign in again.");
    throw new Error(json.error?.message || "Something went wrong.");
  }
  return json.data;
}

function toast(message, kind = "") {
  const t = $("#toast");
  t.textContent = message;
  t.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 3800);
}

function setMsg(sel, message, kind = "") {
  const el = $(sel);
  el.textContent = message;
  el.className = `msg ${kind}`;
}

function setBusy(target, busy) {
  const el = typeof target === "string" ? $(target) : target;
  el.disabled = busy;
  el.classList.toggle("is-busy", busy);
}

// ============================================================
// VIEWS
// ============================================================
// PURPOSE: Show exactly one screen. The top bar hides on the sign-in screen.

function show(view) {
  $("#topbar").hidden = view === "auth";
  $$("[data-view]").forEach((s) => (s.hidden = s.dataset.view !== view));
  window.scrollTo({ top: 0 });
}

function showAuth(message = "") {
  state.user = null;
  show("auth");
  setMsg("#auth-msg", message, message ? "error" : "");
}

// ============================================================
// AI TEXT FORMATTING
// ============================================================
// PURPOSE: Turn AI text (which may contain **bold**, numbered and bulleted lines)
//          into clean HTML. The text is escaped first, so AI output can never
//          inject markup.
// FAILURE CASES: none; unrecognised text is shown as plain paragraphs.

function inlineMarkup(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function formatAiText(raw) {
  let html = "";
  let listTag = null;
  const closeList = () => {
    if (listTag) html += `</${listTag}>`;
    listTag = null;
  };
  for (const line of esc(raw).split("\n")) {
    const text = line.trim();
    if (!text) { closeList(); continue; }
    const numbered = text.match(/^\d+[.)]\s+(.*)$/);
    const bullet = text.match(/^[-*•]\s+(.*)$/);
    if (numbered || bullet) {
      const tag = numbered ? "ol" : "ul";
      if (listTag !== tag) { closeList(); html += `<${tag}>`; listTag = tag; }
      html += `<li>${inlineMarkup((numbered || bullet)[1])}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inlineMarkup(text)}</p>`;
  }
  closeList();
  return html;
}

// ============================================================
// AUTH
// ============================================================
// PURPOSE: Sign in or create an account, then open the dashboard.

function setMode(mode) {
  state.mode = mode;
  $$(".seg-btn").forEach((b) => b.classList.toggle("is-on", b.dataset.mode === mode));
  $("#auth-submit").textContent = mode === "login" ? "Sign in" : "Create account";
  $("#auth-form").password.autocomplete = mode === "login" ? "current-password" : "new-password";
  setMsg("#auth-msg", "");
}

$$(".seg-btn").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  setBusy("#auth-submit", true);
  try {
    const path = state.mode === "login" ? "/api/auth/login" : "/api/auth/register";
    await api(path, "POST", { email: form.email.value.trim(), password: form.password.value });
    form.reset();
    await enter();
  } catch (err) {
    setMsg("#auth-msg", err.message, "error");
  } finally {
    setBusy("#auth-submit", false);
  }
});

async function enter() {
  state.user = await api("/api/auth/me");
  $("#user-email").textContent = state.user.email;
  await showDashboard();
}

$("#sign-out").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", "POST");
  } catch {
    // Signing out locally even if the request fails.
  }
  showAuth("You have signed out.");
});

// ============================================================
// NAVIGATION
// ============================================================
// PURPOSE: Buttons with data-go change the screen; data-back returns to a project.

document.addEventListener("click", (event) => {
  const go = event.target.closest("[data-go]");
  if (go) {
    if (go.dataset.go === "dashboard") showDashboard();
    else show(go.dataset.go);
    return;
  }
  if (event.target.closest("[data-back]")) show("project");
});

// ============================================================
// DASHBOARD
// ============================================================
// PURPOSE: List the user's projects. An empty account sees a clear first step.

async function showDashboard() {
  const projects = await api("/api/businesses");
  $("#projects").innerHTML = projects
    .map((p) => `<button class="row-card" data-id="${p.id}"><span>${esc(p.name)}</span><span class="arrow">→</span></button>`)
    .join("");
  $("#projects").hidden = projects.length === 0;
  $("#empty").hidden = projects.length > 0;
  show("dashboard");
}

$("#projects").addEventListener("click", async (event) => {
  const card = event.target.closest("[data-id]");
  if (!card) return;
  try {
    await openProject(Number(card.dataset.id));
  } catch (err) {
    toast(err.message, "error");
  }
});

// ============================================================
// CREATE PROJECT AND GENERATE OPPORTUNITIES
// ============================================================
// PURPOSE: Save the profile, then generate opportunities for it.
// PROCESS: create the project, run the opportunity agent, open the project.
// FAILURE CASES: if the project was saved but generation failed, the project still
//                opens so the user can retry from its step list.

function animateGeneration() {
  // Visual progression only. The request itself is not reporting progress.
  const items = $$("#gen-steps li");
  let index = 0;
  items.forEach((li) => (li.className = ""));
  items[0].classList.add("is-on");
  const timer = setInterval(() => {
    if (index < items.length) {
      items[index].className = "is-done";
      index++;
      if (index < items.length) items[index].className = "is-on";
    }
  }, 2400);
  return () => clearInterval(timer);
}

$("#builder-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form).entries());
  const profile = {
    ...data,
    budget: Number(data.budget || 0),
    desired_income: Number(data.desired_income || 0),
    currency: data.currency.trim().toUpperCase(),
  };
  let projectId = null;
  const stop = (() => { show("generating"); return animateGeneration(); })();
  try {
    const project = await api("/api/businesses", "POST", { profile });
    projectId = project.id;
    await api(`/api/businesses/${projectId}/opportunities`, "POST", {});
    stop();
    form.reset();
    await openProject(projectId);
    toast("Your opportunities are ready.", "ok");
  } catch (err) {
    stop();
    if (projectId) {
      await openProject(projectId);
      toast(`Opportunities could not be generated: ${err.message}`, "error");
    } else {
      show("builder");
      setMsg("#builder-msg", err.message, "error");
    }
  }
});

// ============================================================
// PROJECT PAGE
// ============================================================
// PURPOSE: Show the project's analysis and chat.

async function openProject(id) {
  state.project = await api(`/api/businesses/${id}`);
  state.oppIndex = null;
  renderProject();
  await loadChat();
  show("project");
}

function renderProject() {
  const p = state.project;
  const pr = p.profile;
  $("#p-title").textContent = p.name;
  $("#p-meta").textContent = [pr.country, pr.city, pr.industry].filter(Boolean).join(" · ") +
    ` · ${pr.currency} ${Number(pr.budget).toLocaleString()} budget`;
  $$("[data-run]").forEach((b) => b.classList.toggle("done", Boolean(p.results[b.dataset.run])));
  renderResults();
}

const STEP_PATH = {
  opportunities: "opportunities", market: "market", pain_points: "pain-points", gaps: "gaps",
  plan: "plan", financials: "financials", globalization: "globalization", execution: "execution",
};
const NEEDS_OPPORTUNITY = new Set(["plan", "financials", "globalization", "execution"]);
const RESULT_ORDER = ["market", "pain_points", "gaps", "plan", "financials", "globalization", "execution"];

// ============================================================
// RESULT RENDERING
// ============================================================
// PURPOSE: Show opportunities as selectable cards, then each saved result as a report.
// SAFETY: every value goes through esc() or formatAiText().

const SECTION_TITLES = {
  market: "Market", pain_points: "Customer pain points", gaps: "Gap analysis",
  plan: "Business plan", financials: "Financial estimates", globalization: "Globalization",
  execution: "Execution plan",
};

const SECTION_FIELDS = {
  market: [["Summary", "market_summary"], ["Characteristics", "market_characteristics"],
    ["Customer needs", "customer_needs"], ["Existing solutions", "existing_solutions"],
    ["Competitors", "major_competitors"], ["Problems", "market_problems"],
    ["Opportunities", "opportunities"], ["Constraints", "business_constraints"], ["Assumptions", "assumptions"]],
  pain_points: [["Pain points", "pain_points"], ["Unmet needs", "unmet_needs"],
    ["Inefficient processes", "inefficient_processes"], ["Expensive solutions", "expensive_solutions"],
    ["Underserved users", "underserved_users"], ["Potential demand", "potential_demand"]],
  gaps: [["Missing features", "missing_features"], ["Underserved markets", "underserved_markets"],
    ["Pricing gaps", "pricing_gaps"], ["Accessibility", "accessibility_gaps"],
    ["Geographic", "geographic_gaps"], ["Workflow", "workflow_problems"],
    ["Technology", "technology_opportunities"], ["Service quality", "service_quality_gaps"],
    ["Assumptions", "assumptions"]],
  plan: [["Executive summary", "executive_summary"], ["Problem", "problem"], ["Solution", "solution"],
    ["Target market", "target_market"], ["Customer profile", "customer_profile"],
    ["Product or service", "product_or_service"], ["Business model", "business_model"],
    ["Revenue model", "revenue_model"], ["Marketing", "marketing_approach"], ["Sales", "sales_approach"],
    ["Operations", "operations"], ["Technology", "technology_requirements"],
    ["Estimated costs", "estimated_costs"], ["Revenue sources", "possible_revenue_sources"],
    ["Risks", "risks"], ["Milestones", "milestones"], ["Launch plan", "launch_plan"],
    ["Growth", "growth_possibilities"]],
  financials: [["Startup costs", "startup_costs"], ["Monthly costs", "monthly_operating_costs"],
    ["Pricing", "pricing"], ["Revenue assumptions", "revenue_assumptions"],
    ["Margin", "estimated_margin"], ["Break even", "break_even_assumption"], ["Scenarios", "scenarios"]],
  globalization: [["Target countries", "target_countries"], ["Currency", "currency_considerations"],
    ["Localization", "localization_needs"], ["Customer differences", "customer_differences"],
    ["Language", "language_considerations"], ["Regulation (general)", "regulatory_considerations"],
    ["Operational complexity", "operational_complexity"], ["Scalability", "scalability"],
    ["International opportunities", "international_opportunities"], ["Assumptions", "assumptions"]],
};

function fmtValue(value) {
  if (value === null || value === undefined || value === "") return `<span class="muted">Not provided</span>`;
  if (Array.isArray(value)) {
    if (!value.length) return `<span class="muted">None listed</span>`;
    const items = value.map((v) => `<li>${formatAiText(typeof v === "object" ? Object.values(v).join(" — ") : String(v))}</li>`);
    return `<ul>${items.join("")}</ul>`;
  }
  return formatAiText(String(value));
}

function kv(pairs) {
  return `<dl class="kv">${pairs.map(([label, value]) =>
    `<div><dt>${esc(label)}</dt><dd>${fmtValue(value)}</dd></div>`).join("")}</dl>`;
}

function renderSection(key, r) {
  if (key === "execution") {
    const phases = (r.phases || []).map((ph, i) => `
      <div class="phase">
        <span class="phase-n">${i + 1}</span>
        <div><strong>${esc(ph.name)}</strong>
          ${kv([["Objectives", ph.objectives], ["Tasks", ph.tasks], ["Expected output", ph.expected_output],
            ["Dependencies", ph.dependencies], ["Risks", ph.risks]])}
        </div>
      </div>`).join("");
    return `<div class="block"><h3>${SECTION_TITLES.execution}</h3>${phases}</div>`;
  }
  const pairs = SECTION_FIELDS[key].map(([label, field]) => [label, r[field]]);
  const note = key === "financials" && r.disclaimer ? `<p class="note">${formatAiText(r.disclaimer)}</p>` : "";
  return `<div class="block"><h3>${SECTION_TITLES[key]}</h3>${kv(pairs)}${note}</div>`;
}

function renderResults() {
  const results = state.project.results;
  const opps = results.opportunities?.opportunities;
  let html = "";
  if (opps) {
    const cards = opps.map((o, i) => `
      <button class="opp" data-opp="${i}">
        <span class="num">${String(i + 1).padStart(2, "0")}</span>
        <span>
          <strong>${esc(o.business_name)}</strong>
          <span class="concept">${esc(o.concept)}</span>
          <span class="tags">
            <span>${esc(o.revenue_model)}</span>
            <span>${esc(o.estimated_startup_cost || "Estimate pending")}</span>
            <span>${esc(o.implementation_difficulty)} difficulty</span>
          </span>
        </span>
      </button>`).join("");
    html += `<div class="block"><h3>Opportunities <span class="count">${opps.length}</span></h3><div class="opps">${cards}</div></div>`;
  } else {
    html += `<div class="empty"><h3>Turn an idea into a business.</h3>
      <p>Run the first step to generate opportunities for this project.</p></div>`;
  }
  RESULT_ORDER.forEach((key) => {
    if (results[key]) html += renderSection(key, results[key]);
  });
  $("#result").innerHTML = html;
}

// ============================================================
// OPPORTUNITY DETAIL
// ============================================================
// PURPOSE: Show every field of one opportunity.

function openOpp(index) {
  const o = state.project.results.opportunities.opportunities[index];
  state.oppIndex = index;
  $("#opp-title").textContent = o.business_name;
  $("#opp-concept").textContent = o.concept;
  const groups = [
    ["Overview", [["Problem", o.problem], ["Target customer", o.target_customer], ["Solution", o.solution],
      ["Advantages", o.advantages], ["Difficulty", o.implementation_difficulty]]],
    ["Revenue", [["Revenue model", o.revenue_model], ["Estimated startup cost", o.estimated_startup_cost],
      ["Estimated monthly cost", o.estimated_monthly_cost]]],
    ["Requirements", [["Startup needs", o.startup_requirements], ["Operating needs", o.operating_requirements],
      ["Skills", o.required_skills], ["Technology", o.required_technology]]],
    ["Risks and assumptions", [["Risks", o.risks], ["Assumptions", o.assumptions]]],
  ];
  $("#opp-body").innerHTML = groups.map(([title, pairs]) =>
    `<div class="block"><h3>${esc(title)}</h3>${kv(pairs)}</div>`).join("");
  show("opportunity");
}

$("#result").addEventListener("click", (event) => {
  const card = event.target.closest("[data-opp]");
  if (card) openOpp(Number(card.dataset.opp));
});

$("#opp-use").addEventListener("click", () => {
  toast("Selected for analysis.", "ok");
  show("project");
});

// ============================================================
// ANALYSIS STEPS
// ============================================================
// PURPOSE: Run one analysis step and store its result in the project.
// FAILURE CASES: steps that need an opportunity ask the user to choose one first.

$("#steps").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-run]");
  if (btn) runStep(btn.dataset.run, btn);
});

async function runStep(key, btn) {
  if (NEEDS_OPPORTUNITY.has(key) && state.oppIndex === null) {
    toast("Open an opportunity and choose it first.", "error");
    return;
  }
  const body = (NEEDS_OPPORTUNITY.has(key) || key === "market" || key === "pain_points")
    ? { opportunity_index: state.oppIndex }
    : {};
  const pid = state.project.id;
  setBusy(btn, true);
  toast("Working on it. This can take up to a minute.");
  try {
    await api(`/api/businesses/${pid}/${STEP_PATH[key]}`, "POST", body);
    state.project = await api(`/api/businesses/${pid}`);
    renderProject();
    toast("Saved to this project.", "ok");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    setBusy(btn, false);
  }
}

// ============================================================
// DELETE PROJECT
// ============================================================

$("#delete-project").addEventListener("click", async () => {
  if (!confirm("Delete this project? This cannot be undone.")) return;
  try {
    await api(`/api/businesses/${state.project.id}`, "DELETE");
    await showDashboard();
    toast("Project deleted.");
  } catch (err) {
    toast(err.message, "error");
  }
});

// ============================================================
// CHAT
// ============================================================
// PURPOSE: Show the saved conversation. Assistant replies are formatted; user text is plain.

async function loadChat() {
  const messages = await api(`/api/businesses/${state.project.id}/chat`);
  $("#chat-log").innerHTML = messages.length
    ? messages.map((m) => `<div class="bubble ${m.role === "user" ? "user" : "assistant"}">${
        m.role === "user" ? esc(m.content) : formatAiText(m.content)}</div>`).join("")
    : `<p class="muted">Ask anything about this project.</p>`;
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
}

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const question = form.message.value.trim();
  if (!question) return;
  setBusy("#chat-send", true);
  try {
    await api(`/api/businesses/${state.project.id}/chat`, "POST", { message: question });
    form.reset();
    await loadChat();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    setBusy("#chat-send", false);
  }
});

// ============================================================
// START
// ============================================================
// PURPOSE: On load, reuse the session cookie if it still works.

(async function start() {
  try {
    await enter();
  } catch {
    showAuth();
  }
})();
