// ============================================================
// STATE AND HELPERS
// ============================================================
// PURPOSE: Keep the current user, project and opportunity in memory and
//          provide one function for every API call.
// FAILURE CASES: a 401 sends the user back to sign-in. Other errors show
//                the server's message, which never contains secrets.

const state = {
  user: null,
  project: null,        // the open project, as returned by the API
  opportunityIndex: null,
  authMode: "login",
};

const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  if (res.status === 401 && path !== "/api/auth/me") {
    showAuth("Your session has ended. Please sign in again.");
  }
  if (!json.success) throw new Error(json.error?.message || "Something went wrong.");
  return json.data;
}

// Escape text before placing it in HTML. AI output is untrusted.
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function list(items) {
  if (!items || items.length === 0) return "<span class='hint'>None listed.</span>";
  return `<ul class="bullets">${items.map((i) => `<li>${esc(typeof i === "string" ? i : JSON.stringify(i))}</li>`).join("")}</ul>`;
}

function text(value) {
  return value ? esc(value) : "<span class='hint'>Not provided.</span>";
}

function row(label, html) {
  return `<dt>${esc(label)}</dt><dd>${html}</dd>`;
}

function showMessage(id, msg, kind = "") {
  const el = $(id);
  el.textContent = msg;
  el.className = `message ${kind}`;
}

// ------------------------------------------------------------
// Presentation helpers (no effect on data or API behavior)
// ------------------------------------------------------------

function toast(message, kind = "info", ms = 6000) {
  const t = document.createElement("div");
  t.className = "toast" + (kind === "info" ? "" : " " + kind);
  t.setAttribute("role", kind === "error" ? "alert" : "status");
  const span = document.createElement("span");
  span.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Dismiss";
  const remove = () => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 300);
  };
  close.addEventListener("click", remove);
  t.append(span, close);
  $("toasts").append(t);
  if (ms) setTimeout(remove, ms);
}

function countUp(node, to, duration = 900) {
  const fmt = (n) => Math.round(n).toLocaleString();
  if (reduceMotion || !isFinite(to)) {
    node.textContent = fmt(to);
    return;
  }
  const start = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - start) / duration);
    node.textContent = fmt(to * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let revealObserver = null;
function revealIn(root) {
  const items = root.querySelectorAll(".reveal:not(.in)");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    items.forEach((n) => n.classList.add("in"));
    return;
  }
  if (!revealObserver) {
    revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            revealObserver.unobserve(e.target);
          }
        });
      },
      { threshold: 0.08, rootMargin: "0px 0px -30px 0px" }
    );
  }
  items.forEach((n) => revealObserver.observe(n));
}

// Promise-based confirmation using the <dialog> element.
function askConfirm(title, message, confirmLabel) {
  const dlg = $("confirm-dialog");
  if (typeof dlg.showModal !== "function") return Promise.resolve(confirm(`${title} ${message}`));
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = message;
  dlg.querySelector('button[value="yes"]').textContent = confirmLabel;
  dlg.returnValue = "";
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "yes"), { once: true });
    dlg.showModal();
  });
}

// ============================================================
// VIEWS
// ============================================================
// PURPOSE: Show exactly one screen at a time.
// PROCESS: hide every section, then show the one requested.

function restartAnimation(node) {
  node.classList.remove("enter");
  void node.offsetWidth;
  node.classList.add("enter");
}

function showView(name) {
  $("auth-view").hidden = name !== "auth";
  $("app-view").hidden = name === "auth";
  if (name === "auth") {
    restartAnimation($("auth-view"));
  } else {
    document.querySelectorAll(".page-section").forEach((s) => (s.hidden = true));
    const section = $(`page-${name}`);
    section.hidden = false;
    restartAnimation(section);
    const heading = section.querySelector("h2");
    if (heading) heading.focus({ preventScroll: true });
  }
  window.scrollTo(0, 0);
}

function showAuth(message = "") {
  state.user = null;
  showView("auth");
  showMessage("auth-message", message, message ? "error" : "");
}

// ============================================================
// AUTH SCREEN
// ============================================================
// PURPOSE: Sign in or create an account.
// FAILURE CASES: wrong password -> generic message from the server.

function setAuthMode(mode) {
  state.authMode = mode;
  document.querySelectorAll(".tab").forEach((t) => {
    const active = t.dataset.mode === mode;
    t.classList.toggle("is-active", active);
    t.setAttribute("aria-selected", String(active));
  });
  $("auth-submit").textContent = mode === "login" ? "Sign in" : "Create account";
  $("auth-hint").textContent = mode === "login" ? "" : "At least 8 characters.";
  $("auth-heading").textContent = mode === "login" ? "Welcome back" : "Create your account";
  $("auth-sub").textContent = mode === "login"
    ? "Sign in to continue to your projects."
    : "Your projects stay private to your account.";
  $("auth-form").password.autocomplete = mode === "login" ? "current-password" : "new-password";
  showMessage("auth-message", "");
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => setAuthMode(t.dataset.mode))
);

$("pw-toggle").addEventListener("click", () => {
  const input = $("auth-form").password;
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("pw-toggle").textContent = show ? "Hide" : "Show";
  $("pw-toggle").setAttribute("aria-label", show ? "Hide password" : "Show password");
});

$("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const btn = $("auth-submit");
  btn.disabled = true;
  try {
    const body = { email: form.email.value.trim(), password: form.password.value };
    const path = state.authMode === "login" ? "/api/auth/login" : "/api/auth/register";
    await api(path, "POST", body);
    form.reset();
    await enterApp();
  } catch (err) {
    showMessage("auth-message", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// APP ENTRY
// ============================================================
// PURPOSE: After sign-in, show the dashboard. On page load, check for an
//          existing session first.

async function enterApp() {
  const user = await api("/api/auth/me");
  state.user = user;
  $("user-email").textContent = user.email;
  $("user-avatar").textContent = (user.email || "?").trim().charAt(0);
  await showDashboard();
}

$("sign-out").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", "POST");
  } finally {
    showAuth("You have signed out.");
  }
});

// ============================================================
// NAVIGATION
// ============================================================
// PURPOSE: Buttons with data-go or data-back change the screen.

document.addEventListener("click", (event) => {
  const go = event.target.closest("[data-go]");
  if (go) {
    const target = go.dataset.go;
    if (target === "dashboard") showDashboard().catch((err) => toast(err.message, "error"));
    if (target === "builder") showView("builder");
    return;
  }
  const back = event.target.closest("[data-back]");
  if (back && back.dataset.back === "project") showView("project");
});

// ============================================================
// DASHBOARD
// ============================================================
// PURPOSE: List the user's projects. Each row opens the project.

async function showDashboard() {
  showView("dashboard");
  const projects = await api("/api/businesses");
  $("project-empty").hidden = projects.length > 0;
  $("project-list").innerHTML = projects
    .map(
      (p, i) => `
      <button type="button" class="list-item" data-project="${p.id}" style="--i:${i}">
        <span>${esc(p.name)}</span>
        <small>Open</small>
      </button>`
    )
    .join("");
}

$("project-list").addEventListener("click", (event) => {
  const item = event.target.closest("[data-project]");
  if (item) openProject(Number(item.dataset.project));
});

// ============================================================
// CREATE PROJECT
// ============================================================
// PURPOSE: Read the builder form and create a project from it.
// FAILURE CASES: validation error from the server is shown next to the button.

$("profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const profile = Object.fromEntries(data.entries());
  ["budget", "desired_income"].forEach((k) => (profile[k] = Number(profile[k] || 0)));
  profile.currency = profile.currency.trim().toUpperCase();
  const btn = $("create-btn");
  btn.disabled = true;
  btn.textContent = "Creating...";
  try {
    const project = await api("/api/businesses", "POST", { profile });
    form.reset();
    form.budget.value = "500";
    form.currency.value = "PKR";
    form.country.value = "Pakistan";
    form.desired_income.value = "0";
    showMessage("builder-message", "");
    await openProject(project.id);
  } catch (err) {
    showMessage("builder-message", err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create project";
  }
});

// ============================================================
// PROJECT PAGE
// ============================================================
// PURPOSE: Show the project's profile, its analysis results and the chat.
// FAILURE CASES: a project that cannot be loaded returns to the dashboard.

async function openProject(id) {
  try {
    state.project = await api(`/api/businesses/${id}`);
  } catch (err) {
    showDashboard();
    return;
  }
  state.opportunityIndex = null;
  showMessage("run-message", "");
  stopRun();
  renderProject(true);
  await loadChat();
  showView("project");
  revealIn($("result-area"));
}

const STEP_KEYS = ["opportunities", "market", "pain_points", "gaps", "plan", "financials", "globalization", "execution"];

function renderProject(animate = false) {
  const p = state.project;
  const profile = p.profile;
  $("project-title").textContent = p.name;
  $("project-meta").textContent =
    `${profile.country}${profile.city ? ", " + profile.city : ""} · ${profile.currency} ${profile.budget.toLocaleString()} budget`;

  document.querySelectorAll(".step").forEach((btn) => {
    const key = btn.dataset.run;
    btn.classList.toggle("is-done", Boolean(p.results[key]));
  });

  // Summary strip: budget, market, analyses completed.
  const done = STEP_KEYS.filter((k) => p.results[k]).length;
  $("project-stats").innerHTML = `
    <div><dt>Budget</dt><dd><span id="stat-budget"></span><small>${esc(profile.currency)}</small></dd></div>
    <div><dt>Market</dt><dd>${esc(profile.country)}</dd></div>
    <div><dt>Analyses</dt><dd><span id="stat-done"></span><small>of ${STEP_KEYS.length} complete</small></dd></div>`;
  const budgetNode = $("stat-budget");
  const doneNode = $("stat-done");
  if (animate) {
    countUp(budgetNode, Number(profile.budget) || 0);
    countUp(doneNode, done, 600);
  } else {
    budgetNode.textContent = (Number(profile.budget) || 0).toLocaleString();
    doneNode.textContent = String(done);
  }

  renderResults();
}

// Result area shows opportunities by default. Other results appear
// after the matching step is run.
function renderResults() {
  const p = state.project;
  const area = $("result-area");
  area.innerHTML = "";

  const opps = p.results.opportunities?.opportunities;
  if (!opps) {
    area.innerHTML = `
      <div class="empty-state">
        <h3>Start with opportunities.</h3>
        <p>Run step 1 to generate business opportunities for this project.</p>
        <button type="button" class="btn btn-primary" data-start="opportunities">Generate opportunities</button>
      </div>`;
    return;
  }

  const rows = opps
    .map(
      (o, i) => `
      <button type="button" class="opp-row${state.opportunityIndex === i ? " is-selected" : ""}" data-opp="${i}">
        <span class="opp-index">${String.fromCharCode(65 + (i % 26))}</span>
        <span class="opp-body">
          <h3>${esc(o.business_name)}${state.opportunityIndex === i ? ' <span class="chosen">Selected</span>' : ""}</h3>
          <p>${esc(o.concept)}</p>
          <span class="opp-meta">
            <span><strong>Revenue</strong>${esc(o.revenue_model)}</span>
            <span><strong>Startup</strong>${esc(o.estimated_startup_cost || "Not estimated")}</span>
            <span><strong>Difficulty</strong>${esc(o.implementation_difficulty)}</span>
          </span>
        </span>
      </button>`
    )
    .join("");
  area.innerHTML = `<div class="card reveal"><div class="card-head"><h3>Opportunities</h3><span class="badge">${opps.length} found</span></div><div class="list">${rows}</div></div>`;

  // Show any other results the user has run, below the opportunities.
  ["market", "pain_points", "gaps", "plan", "financials", "globalization", "execution"].forEach((key) => {
    if (p.results[key]) area.insertAdjacentHTML("beforeend", renderResult(key, p.results[key]));
  });
  revealIn(area);
}

// ============================================================
// RESULT RENDERERS
// ============================================================
// PURPOSE: One function per analysis result. Each shows its keys in sections.

const RESULT_TITLES = {
  market: "Market analysis",
  pain_points: "Customer pain points",
  gaps: "Gap analysis",
  plan: "Business plan",
  financials: "Financial estimates",
  globalization: "Globalization",
  execution: "Execution plan",
};

function renderResult(key, r) {
  const title = RESULT_TITLES[key];
  let body = "";
  if (key === "market") {
    body = `<dl class="kv">${row("Summary", text(r.market_summary))}${row("Characteristics", list(r.market_characteristics))}${row("Customer needs", list(r.customer_needs))}${row("Existing solutions", list(r.existing_solutions))}${row("Competitors", list(r.major_competitors))}${row("Problems", list(r.market_problems))}${row("Opportunities", list(r.opportunities))}${row("Constraints", list(r.business_constraints))}${row("Assumptions", list(r.assumptions))}</dl>`;
  } else if (key === "pain_points") {
    const points = (r.pain_points || []).map((p) =>
      `<li><strong>${esc(p.problem)}</strong>. ${esc(p.frustration)} <span class="hint">Who feels it: ${esc(p.who_feels_it)}. Severity: ${esc(p.severity)}.</span></li>`
    ).join("");
    body = `<dl class="kv">${row("Pain points", points ? `<ul class="bullets">${points}</ul>` : text(""))}${row("Unmet needs", list(r.unmet_needs))}${row("Inefficient processes", list(r.inefficient_processes))}${row("Expensive solutions", list(r.expensive_solutions))}${row("Underserved users", list(r.underserved_users))}${row("Potential demand", text(r.potential_demand))}</dl>`;
  } else if (key === "gaps") {
    body = `<dl class="kv">${row("Missing features", list(r.missing_features))}${row("Underserved markets", list(r.underserved_markets))}${row("Pricing gaps", list(r.pricing_gaps))}${row("Accessibility", list(r.accessibility_gaps))}${row("Geographic", list(r.geographic_gaps))}${row("Workflow", list(r.workflow_problems))}${row("Technology", list(r.technology_opportunities))}${row("Service quality", list(r.service_quality_gaps))}${row("Assumptions", list(r.assumptions))}</dl>`;
  } else if (key === "plan") {
    body = `<dl class="kv">${row("Executive summary", text(r.executive_summary))}${row("Problem", text(r.problem))}${row("Solution", text(r.solution))}${row("Target market", text(r.target_market))}${row("Customer profile", text(r.customer_profile))}${row("Product or service", text(r.product_or_service))}${row("Business model", text(r.business_model))}${row("Revenue model", text(r.revenue_model))}${row("Marketing", text(r.marketing_approach))}${row("Sales", text(r.sales_approach))}${row("Operations", text(r.operations))}${row("Technology", list(r.technology_requirements))}${row("Estimated costs", list(r.estimated_costs))}${row("Revenue sources", list(r.possible_revenue_sources))}${row("Risks", list(r.risks))}${row("Milestones", list(r.milestones))}${row("Launch plan", text(r.launch_plan))}${row("Growth", list(r.growth_possibilities))}</dl>`;
  } else if (key === "financials") {
    const fmt = (items) => (items || []).map((i) => `<li>${esc(i.item)}: ${esc(i.estimate)}</li>`).join("");
    const scen = (r.scenarios || []).map((s) => `<li><strong>${esc(s.name)}</strong>. ${esc(s.description)} <span class="hint">Monthly revenue estimate: ${esc(s.monthly_revenue_estimate)}</span></li>`).join("");
    body = `<dl class="kv">${row("Startup costs", fmt(r.startup_costs) ? `<ul class="bullets">${fmt(r.startup_costs)}</ul>` : text(""))}${row("Monthly costs", fmt(r.monthly_operating_costs) ? `<ul class="bullets">${fmt(r.monthly_operating_costs)}</ul>` : text(""))}${row("Pricing", text(r.pricing))}${row("Revenue assumptions", list(r.revenue_assumptions))}${row("Margin", text(r.estimated_margin))}${row("Break even", text(r.break_even_assumption))}${row("Scenarios", scen ? `<ul class="bullets">${scen}</ul>` : text(""))}</dl><p class="hint">${esc(r.disclaimer)}</p>`;
  } else if (key === "globalization") {
    body = `<dl class="kv">${row("Target countries", list(r.target_countries))}${row("Currency", list(r.currency_considerations))}${row("Localization", list(r.localization_needs))}${row("Customer differences", list(r.customer_differences))}${row("Language", list(r.language_considerations))}${row("Regulation (general)", list(r.regulatory_considerations))}${row("Operational complexity", text(r.operational_complexity))}${row("Scalability", text(r.scalability))}${row("International opportunities", list(r.international_opportunities))}${row("Assumptions", list(r.assumptions))}</dl>`;
  } else if (key === "execution") {
    body = (r.phases || []).map((ph, i) => `
      <div class="card reveal"><div class="card-head"><h3>Phase ${i + 1}: ${esc(ph.name)}</h3></div>
        <dl class="kv">${row("Objectives", list(ph.objectives))}${row("Tasks", list(ph.tasks))}${row("Expected output", text(ph.expected_output))}${row("Dependencies", list(ph.dependencies))}${row("Risks", list(ph.risks))}</dl>
      </div>`).join("");
    return body;
  }
  return `<div class="card reveal"><div class="card-head"><h3>${esc(title)}</h3><span class="badge neutral">Saved</span></div>${body}</div>`;
}

// ============================================================
// OPPORTUNITY DETAIL
// ============================================================
// PURPOSE: Show every field of one opportunity, from concept to assumptions.
// FAILURE CASES: missing field shows "Not provided." rather than breaking the page.

function openOpportunity(index) {
  const o = state.project.results.opportunities.opportunities[index];
  state.opportunityIndex = index;
  $("opp-title").textContent = o.business_name;
  $("opp-concept").textContent = o.concept;
  $("opp-detail").innerHTML = `
    <div class="card"><h3>Overview</h3><dl class="kv">
      ${row("Problem", text(o.problem))}
      ${row("Target customer", text(o.target_customer))}
      ${row("Solution", text(o.solution))}
      ${row("Value", list(o.advantages))}
      ${row("Difficulty", text(o.implementation_difficulty))}
    </dl></div>
    <div class="card"><h3>Revenue</h3><dl class="kv">
      ${row("Revenue model", text(o.revenue_model))}
      ${row("Estimated startup cost", text(o.estimated_startup_cost))}
      ${row("Estimated monthly cost", text(o.estimated_monthly_cost))}
    </dl></div>
    <div class="card"><h3>Requirements</h3><dl class="kv">
      ${row("Startup needs", text(o.startup_requirements))}
      ${row("Operating needs", text(o.operating_requirements))}
      ${row("Skills", list(o.required_skills))}
      ${row("Technology", list(o.required_technology))}
    </dl></div>
    <div class="card"><h3>Risks and assumptions</h3><dl class="kv">
      ${row("Risks", list(o.risks))}
      ${row("Assumptions", list(o.assumptions))}
    </dl></div>`;
  showView("opportunity");
  $("opp-detail").querySelectorAll(".card").forEach((c) => c.classList.add("reveal"));
  revealIn($("opp-detail"));
}

$("opp-use").addEventListener("click", () => {
  if (state.opportunityIndex === null) return;
  showMessage("run-message", `Using "${state.project.results.opportunities.opportunities[state.opportunityIndex].business_name}" for the next analysis steps.`, "ok");
  renderResults();
  showView("project");
});

$("result-area").addEventListener("click", (event) => {
  const start = event.target.closest("[data-start]");
  if (start) {
    document.querySelector(`.step[data-run="${start.dataset.start}"]`).click();
    return;
  }
  const r = event.target.closest("[data-opp]");
  if (r) openOpportunity(Number(r.dataset.opp));
});

// ============================================================
// RUNNING ANALYSIS STEPS
// ============================================================
// PURPOSE: Each step button calls its endpoint and stores the result in the project.
// FAILURE CASES: steps that need an opportunity show a clear message when none is chosen.

document.querySelectorAll(".step").forEach((btn) =>
  btn.addEventListener("click", () => runStep(btn.dataset.run, btn))
);

const STEP_PATHS = {
  opportunities: "opportunities",
  market: "market",
  pain_points: "pain-points",
  gaps: "gaps",
  plan: "plan",
  financials: "financials",
  globalization: "globalization",
  execution: "execution",
};
const NEEDS_OPPORTUNITY = new Set(["plan", "financials", "globalization", "execution"]);

// Generation panel: calm staged progress while the request is in flight.
// The stages are timed for feedback; they do not reflect server progress.
let runTimer = null;
const OPPORTUNITY_STAGES = ["Analyzing your market", "Finding opportunities", "Evaluating demand", "Building your business plan"];
const GENERIC_STAGES = ["Gathering context", "Analyzing your project", "Structuring the result"];

function startRun(key) {
  const stages = key === "opportunities" ? OPPORTUNITY_STAGES : GENERIC_STAGES;
  $("run-title").textContent = key === "opportunities" ? "Finding opportunities" : (RESULT_TITLES[key] || "Working");
  const ol = $("run-steps");
  ol.innerHTML = stages.map((s) => `<li class="gen-step"><span class="tick"></span><span>${esc(s)}</span></li>`).join("");
  const items = ol.children;
  let i = 0;
  items[0].classList.add("active");
  $("run-panel").hidden = false;
  $("run-panel").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
  clearInterval(runTimer);
  runTimer = setInterval(() => {
    if (i >= items.length - 1) return; // hold on the last stage until the response arrives
    items[i].classList.replace("active", "done");
    i += 1;
    items[i].classList.add("active");
  }, 3000);
}

function stopRun() {
  clearInterval(runTimer);
  $("run-panel").hidden = true;
}

async function runStep(key, btn) {
  const pid = state.project.id;
  const body = {};
  if (state.opportunityIndex !== null) body.opportunity_index = state.opportunityIndex;

  if (NEEDS_OPPORTUNITY.has(key) && body.opportunity_index === undefined) {
    showMessage("run-message", "Open an opportunity and choose it first.", "error");
    return;
  }

  const bodyForRequest = key === "opportunities" || key === "gaps" ? null : body;
  const allSteps = document.querySelectorAll(".step");
  allSteps.forEach((b) => (b.disabled = true));
  btn.classList.add("is-running");
  showMessage("run-message", "Working on it. This can take up to a minute.");
  startRun(key);
  try {
    const path = `/api/businesses/${pid}/${STEP_PATHS[key]}`;
    await api(path, "POST", bodyForRequest);
    state.project = await api(`/api/businesses/${pid}`);
    stopRun();
    renderProject();
    showMessage("run-message", "Saved to this project.", "ok");
  } catch (err) {
    stopRun();
    showMessage("run-message", err.message, "error");
    toast(err.message, "error");
  } finally {
    btn.classList.remove("is-running");
    allSteps.forEach((b) => (b.disabled = false));
  }
}

// ============================================================
// DELETE PROJECT
// ============================================================
// PURPOSE: Remove a project and its chat after a confirmation.

$("delete-project").addEventListener("click", async () => {
  if (!(await askConfirm("Delete this project?", "This cannot be undone.", "Delete"))) return;
  try {
    await api(`/api/businesses/${state.project.id}`, "DELETE");
    await showDashboard();
  } catch (err) {
    showMessage("run-message", err.message, "error");
    toast(err.message, "error");
  }
});

// ============================================================
// CHAT
// ============================================================
// PURPOSE: Show the saved conversation and send new questions.
// FAILURE CASES: errors appear under the chat box.

async function loadChat() {
  const messages = await api(`/api/businesses/${state.project.id}/chat`);
  renderChat(messages);
}

function renderChat(messages) {
  $("chat-empty").hidden = messages.length > 0;
  $("chat-log").innerHTML = messages
    .map((m) => `<div class="bubble ${m.role === "user" ? "user" : "assistant"}">${esc(m.content)}</div>`)
    .join("");
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
}

document.querySelectorAll(".suggest").forEach((b) =>
  b.addEventListener("click", () => {
    const input = $("chat-form").message;
    input.value = b.dataset.text;
    input.focus();
  })
);

$("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.message;
  const question = input.value.trim();
  if (!question) return;
  $("chat-send").disabled = true;

  // Show the question and a typing indicator right away.
  const log = $("chat-log");
  $("chat-empty").hidden = true;
  log.insertAdjacentHTML(
    "beforeend",
    `<div class="bubble user">${esc(question)}</div><div class="bubble assistant typing" aria-label="Thinking"><i></i><i></i><i></i></div>`
  );
  log.scrollTop = log.scrollHeight;

  try {
    await api(`/api/businesses/${state.project.id}/chat`, "POST", { message: question });
    input.value = "";
    await loadChat();
  } catch (err) {
    showMessage("run-message", err.message, "error");
    toast(err.message, "error");
    try { await loadChat(); } catch { /* keep the typed question in the box */ }
  } finally {
    $("chat-send").disabled = false;
  }
});

// ============================================================
// START
// ============================================================
// PURPOSE: On page load, use the session cookie if it still works.

(async function start() {
  try {
    await enterApp();
  } catch {
    showAuth();
  }
})();
