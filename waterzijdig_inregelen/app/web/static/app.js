/* Waterzijdig Inregelen — ingress-UI (vanilla JS, geen build-stap).
 * Alle URL's zijn relatief zodat de app onder /api/hassio_ingress/<token>/ werkt. */
"use strict";

const S = {
  projects: [], project: null, analysis: null, results: new Map(),
  fpId: null, selectedId: null, mode: "plan", zoom: 1, compact: false,
};
// pdf.js 3.11.174 (Apache-2.0) wordt met de add-on meegeleverd: werkt offline en zonder CDN.
const PDFJS = "static/pdfjs/";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 1) => (v === null || v === undefined || v === "" ? "–"
  : Number(v).toLocaleString("nl-NL", { minimumFractionDigits: d, maximumFractionDigits: d }));
const numOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("nl-NL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

const STATUS = {
  ok: { icon: "✓", text: "Goed" },
  open: { icon: "▲", text: "Verder open" },
  dicht: { icon: "▼", text: "Verder dicht" },
  ongeldig: { icon: "!", text: "Meting ongeldig" },
  geen_meting: { icon: "–", text: "Geen meting" },
};
const TYPES = {
  radiator: { label: "Radiator", icon: "R" },
  vloerverwarming: { label: "Vloerverwarming", icon: "V" },
  convector: { label: "Convector", icon: "C" },
};

// ---- API ------------------------------------------------------------------

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch("api/" + path, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* geen JSON */ }
  if (!res.ok) {
    let msg = data && data.detail;
    if (Array.isArray(msg)) msg = msg.map((d) => d.msg).join("; ");
    throw new Error(msg || `Fout ${res.status}`);
  }
  return data;
}

function setProject(data) {
  S.project = data.project;
  S.analysis = data.analysis;
  S.results = new Map(data.analysis.emitters.map((r) => [r.id, r]));
  if (!S.project.floorplans.some((f) => f.id === S.fpId)) S.fpId = S.project.floorplans[0]?.id || null;
  if (S.selectedId && !S.project.emitters.some((e) => e.id === S.selectedId)) S.selectedId = null;
}

async function mutate(method, path, body, { rerender = true } = {}) {
  try {
    // geen afsluitende slash: FastAPI zou absoluut redirecten, wat buiten ingress valt
    const data = await api(method, `projects/${S.project.id}${path ? "/" + path : ""}`, body);
    setProject(data);
    if (rerender) renderProject();
    return data;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (error ? " error" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), error ? 5000 : 2200);
}

function result(id) { return S.results.get(id) || {}; }
function emitter(id) { return S.project.emitters.find((e) => e.id === id); }
function valveOf(em) { return S.project.valve_types.find((v) => v.id === em.valve_type); }
function presetLabel(valve, s) {
  if (s === null || s === undefined) return "–";
  const step = valve?.steps.find((st) => st[2] && Math.abs(st[0] - s) < 1e-6);
  return step ? step[2] : String(s).replace(".", ",");
}

// ---- dialoog --------------------------------------------------------------

function dialog(title, bodyHtml, { ok = "Opslaan", onOpen } = {}) {
  const dlg = $("#dlg");
  $("#dlg-title").textContent = title;
  $("#dlg-body").innerHTML = bodyHtml;
  $("#dlg-ok").textContent = ok;
  if (onOpen) onOpen($("#dlg-body"));
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok" ? $("#dlg-body") : null),
      { once: true });
  });
}

// ---- routing --------------------------------------------------------------

window.addEventListener("hashchange", route);
window.addEventListener("resize", () => { if (S.project && S.mode === "plan") sizePlan(); });

async function route() {
  const m = location.hash.match(/^#\/p\/([0-9a-f]+)/);
  if (m) {
    try {
      if (!S.project || S.project.id !== m[1]) {
        S.selectedId = null; S.fpId = null; S.zoom = 1;
        setProject(await api("GET", `projects/${m[1]}`));
      }
      renderProject();
    } catch (e) {
      toast(e.message, true);
      location.hash = "#/";
    }
  } else {
    S.project = null;
    renderProjects();
  }
}

// ---- projectenlijst -------------------------------------------------------

async function renderProjects() {
  $("#title").textContent = "Waterzijdig Inregelen";
  $("#btn-back").hidden = true;
  $("#top-actions").innerHTML = `<button class="btn primary" id="btn-new">+ Nieuw project</button>`;
  $("#btn-new").onclick = newProject;
  const view = $("#view");
  try { S.projects = await api("GET", "projects"); } catch (e) { toast(e.message, true); }
  if (!S.projects.length) {
    view.innerHTML = `<div class="empty"><p><b>Nog geen projecten.</b></p>
      <p>Maak een project aan, upload een of meer plattegronden en sleep de radiatoren
      en vloerverwarmingsgroepen op hun plek.</p>
      <button class="btn primary" id="btn-new2">+ Nieuw project</button></div>`;
    $("#btn-new2").onclick = newProject;
    return;
  }
  view.innerHTML = `<div class="projects">${S.projects.map((p) => `
    <div class="card" data-id="${p.id}">
      <div class="thumb" style="${p.cover ? `background-image:url('api/projects/${p.id}/floorplans/${p.cover}/image')` : ""}"></div>
      <div class="body"><b>${esc(p.name)}</b>
        <div class="muted small">${esc(p.address || "")}</div>
        <div class="muted small">${p.floorplans} plattegrond(en) · ${p.emitters} element(en) ·
          bijgewerkt ${fmtDate(p.updated)}</div>
      </div>
    </div>`).join("")}</div>`;
  $$(".card", view).forEach((c) => (c.onclick = () => (location.hash = `#/p/${c.dataset.id}`)));
}

async function newProject() {
  const body = await dialog("Nieuw project", `
    <label>Naam<input name="name" required value="" placeholder="bijv. Woonhuis Dorpsstraat 1"></label>
    <label>Adres / omschrijving<input name="address"></label>
    <label>Warmtebron
      <select name="heat_source">
        <option value="ketel">Cv-ketel (doel-ΔT radiatoren 20 K)</option>
        <option value="warmtepomp">Warmtepomp (doel-ΔT radiatoren 5 K)</option>
        <option value="anders">Anders</option>
      </select></label>`, { ok: "Aanmaken" });
  if (!body) return;
  try {
    const data = await api("POST", "projects", {
      name: $("[name=name]", body).value, address: $("[name=address]", body).value,
      heat_source: $("[name=heat_source]", body).value,
    });
    setProject(data);
    location.hash = `#/p/${data.project.id}`;
  } catch (e) { toast(e.message, true); }
}

// ---- project --------------------------------------------------------------

function renderProject() {
  const p = S.project;
  $("#title").textContent = p.name;
  $("#btn-back").hidden = false;
  $("#top-actions").innerHTML = `
    <button class="btn ${S.mode === "plan" ? "primary" : ""}" data-mode="plan">Plattegrond</button>
    <button class="btn ${S.mode === "table" ? "primary" : ""}" data-mode="table">Meetronde</button>
    <a class="btn" href="api/projects/${p.id}/export.csv" download>CSV</a>
    <button class="icon-btn" id="btn-settings" title="Projectinstellingen">⚙</button>`;
  $$("[data-mode]").forEach((b) => (b.onclick = () => { S.mode = b.dataset.mode; renderProject(); }));
  $("#btn-settings").onclick = editSettings;
  if (S.mode === "table") renderTable();
  else renderPlan();
}

function tabsHtml() {
  const p = S.project;
  return `<div class="tabs">${p.floorplans.map((f) => `
    <button class="tab ${f.id === S.fpId ? "active" : ""}" data-fp="${f.id}" title="Dubbelklik om te hernoemen">${esc(f.name)}
      <span class="muted small">(${p.emitters.filter((e) => e.floorplan_id === f.id).length})</span></button>`).join("")}
    <button class="tab add" id="btn-upload">+ Plattegrond</button>
    <input type="file" id="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" multiple hidden>
  </div>`;
}

function bindTabs(root) {
  $$("[data-fp]", root).forEach((b) => {
    b.onclick = () => { S.fpId = b.dataset.fp; S.selectedId = null; renderProject(); };
    b.ondblclick = () => editFloorplan(b.dataset.fp);
  });
  $("#btn-upload", root).onclick = () => $("#file", root).click();
  $("#file", root).onchange = (ev) => uploadFiles([...ev.target.files]);
}

function renderPlan() {
  const p = S.project;
  const fp = p.floorplans.find((f) => f.id === S.fpId);
  const view = $("#view");
  view.innerHTML = `${tabsHtml()}
    <div class="workspace">
      <div class="plan-area">
        ${fp ? `
        <div class="toolbar">
          ${Object.entries(TYPES).map(([k, t]) => `
            <div class="chip" data-type="${k}" title="Sleep naar de plattegrond">${markerIcon(k, "geen_meting")}${t.label}</div>`).join("")}
          <span class="hint">← sleep op de plattegrond · klik een element om waarden in te voeren</span>
          <span class="spacer"></span>
          <button class="icon-btn" data-zoom="-1" title="Uitzoomen">−</button>
          <button class="icon-btn" data-zoom="0" title="Passend">⤢</button>
          <button class="icon-btn" data-zoom="1" title="Inzoomen">+</button>
          <button class="icon-btn" id="btn-compact" title="Namen tonen/verbergen">${S.compact ? "Aa" : "A"}</button>
        </div>` : ""}
        <div class="plan-scroll" id="plan-scroll">
          ${fp ? `<div class="plan ${S.compact ? "compact" : ""}" id="plan">
              <img src="api/projects/${p.id}/floorplans/${fp.id}/image" alt="${esc(fp.name)}" id="plan-img">
              ${p.emitters.filter((e) => e.floorplan_id === fp.id).map(markerHtml).join("")}
            </div>`
          : `<div class="dropzone" id="dropzone"><p><b>Upload een plattegrond</b></p>
              <p>Sleep een afbeelding (PNG, JPG, WebP) of PDF hierheen, of
              <button class="btn" id="btn-upload2">kies een bestand</button></p>
              <p class="small">Een PDF met meerdere pagina's wordt per pagina een plattegrond.</p></div>`}
        </div>
      </div>
      <aside class="side" id="side"></aside>
    </div>`;
  bindTabs(view);
  bindFileDrop($(".plan-area", view));
  if (!fp) {
    $("#btn-upload2").onclick = () => $("#file").click();
  } else {
    const img = $("#plan-img");
    if (img.complete) sizePlan(); else img.onload = sizePlan;
    $$(".marker", view).forEach(bindMarker);
    $$(".chip", view).forEach(bindPaletteChip);
    $$("[data-zoom]", view).forEach((b) => (b.onclick = () => {
      const z = Number(b.dataset.zoom);
      S.zoom = z === 0 ? 1 : Math.min(6, Math.max(0.25, S.zoom * (z > 0 ? 1.4 : 1 / 1.4)));
      sizePlan();
    }));
    $("#btn-compact").onclick = () => { S.compact = !S.compact; renderPlan(); };
    $("#plan").addEventListener("pointerdown", (ev) => {
      if (ev.target.id === "plan" && S.selectedId) { S.selectedId = null; renderPlan(); }
    });
  }
  renderSide();
}

function sizePlan() {
  const plan = $("#plan"), img = $("#plan-img"), sc = $("#plan-scroll");
  if (!plan || !img || !img.naturalWidth) return;
  const availW = sc.clientWidth - 32, availH = sc.clientHeight - 32;
  const fit = Math.min(availW / img.naturalWidth, availH > 100 ? availH / img.naturalHeight : Infinity);
  plan.style.width = Math.max(200, img.naturalWidth * fit * S.zoom) + "px";
}

function markerIcon(type, status) {
  return `<span class="ic">${status && status !== "geen_meting" ? STATUS[status].icon : TYPES[type]?.icon || "R"}</span>`;
}

function markerHtml(e) {
  const r = result(e.id);
  const st = r.status || "geen_meting";
  const val = r.dt !== undefined && st !== "ongeldig" ? `ΔT ${fmt(r.dt, 1)}` : "";
  const preset = r.stale ? " · meten" : r.preset_advice_label && (st === "open" || st === "dicht")
    ? ` → ${esc(r.preset_advice_label)}` : "";
  return `<div class="marker st-${st} ${r.stale ? "stale" : ""} ${e.id === S.selectedId ? "selected" : ""}" data-id="${e.id}"
      style="left:${e.x * 100}%;top:${e.y * 100}%" title="${esc(e.name)}: ${esc(r.advice || "")}">
      ${markerIcon(e.type, st)}<span class="lbl">${esc(e.name)}</span>
      ${val || preset ? `<span class="val">${val}${preset}</span>` : ""}</div>`;
}

function planCoords(ev) {
  const rect = $("#plan").getBoundingClientRect();
  return {
    x: (ev.clientX - rect.left) / rect.width, y: (ev.clientY - rect.top) / rect.height,
    inside: ev.clientX >= rect.left && ev.clientX <= rect.right &&
      ev.clientY >= rect.top && ev.clientY <= rect.bottom,
  };
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function bindMarker(el) {
  el.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    el.setPointerCapture(ev.pointerId);
    const start = { x: ev.clientX, y: ev.clientY };
    let moved = false, pos = null;
    const move = (e) => {
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
      moved = true;
      el.classList.add("dragging");
      const c = planCoords(e);
      pos = { x: clamp01(c.x), y: clamp01(c.y) };
      el.style.left = pos.x * 100 + "%";
      el.style.top = pos.y * 100 + "%";
    };
    const up = async () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.classList.remove("dragging");
      const id = el.dataset.id;
      if (moved && pos) {
        S.selectedId = id;
        await mutate("PUT", `emitters/${id}`, { x: pos.x, y: pos.y }).catch(() => renderPlan());
      } else {
        S.selectedId = id;
        $$(".marker").forEach((m) => m.classList.toggle("selected", m.dataset.id === id));
        renderSide();
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
}

function bindPaletteChip(chip) {
  chip.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    chip.setPointerCapture(ev.pointerId);
    const type = chip.dataset.type;
    const ghost = document.createElement("div");
    ghost.className = "marker ghost st-geen_meting";
    ghost.innerHTML = `${markerIcon(type)}<span class="lbl">${TYPES[type].label}</span>`;
    document.body.appendChild(ghost);
    const place = (e) => { ghost.style.left = e.clientX + "px"; ghost.style.top = e.clientY + "px"; };
    place(ev);
    const plan = $("#plan");
    const move = (e) => { place(e); plan.classList.toggle("drop-hint", planCoords(e).inside); };
    const up = async (e) => {
      chip.removeEventListener("pointermove", move);
      chip.removeEventListener("pointerup", up);
      chip.removeEventListener("pointercancel", up);
      ghost.remove();
      plan.classList.remove("drop-hint");
      const c = planCoords(e);
      if (e.type === "pointercancel" || !c.inside) return;
      const data = await mutate("POST", "emitters",
        { floorplan_id: S.fpId, type, x: clamp01(c.x), y: clamp01(c.y) }, { rerender: false });
      S.selectedId = data.created_id;
      renderPlan();
      setTimeout(() => $("#side [name=room]")?.focus(), 50);
    };
    chip.addEventListener("pointermove", move);
    chip.addEventListener("pointerup", up);
    chip.addEventListener("pointercancel", up);
  });
}

// ---- zijpaneel ------------------------------------------------------------

function summaryHtml() {
  const a = S.analysis, s = a.summary, c = s.counts;
  const pills = ["ok", "open", "dicht", "ongeldig", "geen_meting"].filter((k) => c[k])
    .map((k) => `<span class="pill st-${k}"><span class="dot"></span>${c[k]} ${STATUS[k].text.toLowerCase()}</span>`).join("");
  const groups = s.groups.map((g) => `
    <dt>${esc(g.label)}</dt><dd>${g.method === "vraag" ? "op warmtevraag" : `gelijk ΔT, doel ${fmt(g.target_dt, 1)} K`}
      ${g.dt_mean !== undefined ? `<br>gemeten gem. ΔT ${fmt(g.dt_mean, 1)} K${g.dt_weighted !== undefined ? ` (debietgewogen ${fmt(g.dt_weighted, 1)} K)` : ""}` : ""}
      ${g.flow_total !== undefined ? `<br>${fmt(g.flow_total, 0)} l/h · ${fmt(g.q_total / 1000, 1)} kW` : ""}
      <span class="muted">· ${g.measured}/${g.members} gemeten</span></dd>`).join("");
  return `
    <h3 style="margin-top:0">Overzicht</h3>
    <div class="summary">${pills || '<span class="muted">Nog geen elementen</span>'}</div>
    ${groups ? `<dl class="kv">${groups}</dl>` : ""}
    ${s.pump_advice.map((t) => `<div class="notice warn">${esc(t)}</div>`).join("")}
    ${s.notes.map((n) => `<div class="notice">${esc(n)}</div>`).join("")}`;
}

function renderSide() {
  const side = $("#side");
  if (!side) return;
  const em = S.selectedId && emitter(S.selectedId);
  if (!em) {
    const list = S.project.emitters.filter((e) => e.floorplan_id === S.fpId);
    side.innerHTML = `${summaryHtml()}
      <h3>Elementen op deze plattegrond</h3>
      ${list.length ? `<ul class="list">${list.map((e) => {
        const r = result(e.id);
        return `<li class="st-${r.status || "geen_meting"}" data-id="${e.id}"><span class="dot"></span>
          <div class="grow"><div><b>${esc(e.name)}</b> <span class="muted">${esc(e.room || "")}</span></div>
          <div class="muted small">${esc(r.advice || "")}</div></div></li>`;
      }).join("")}</ul>` : `<p class="muted">Sleep een radiator of vloerverwarmingsgroep uit het palet op de plattegrond.</p>`}`;
    $$(".list li", side).forEach((li) => (li.onclick = () => { S.selectedId = li.dataset.id; renderPlan(); }));
    return;
  }
  side.innerHTML = emitterPanelHtml(em);
  bindEmitterPanel(side, em);
}

function emitterPanelHtml(em) {
  const p = S.project, r = result(em.id), set = p.settings;
  const st = r.status || "geen_meting";
  const valve = valveOf(em);
  const isUfh = em.type === "vloerverwarming";
  const nom = isUfh ? set.ufh_nominal : set.radiator_nominal;
  const ms = [...(em.measurements || [])].sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  const canApply = r.preset_advice !== undefined && r.preset_advice !== null &&
    (st === "open" || st === "dicht") && r.preset_advice !== em.preset;
  return `
    <div style="display:flex;align-items:center;gap:8px">
      <button class="icon-btn" id="btn-close" title="Sluiten">←</button>
      <h2 style="margin:0;flex:1">${esc(em.name)}</h2>
    </div>

    <div class="advice st-${st}">
      <div class="big">${STATUS[st].icon} ${esc(STATUS[st].text)}</div>
      ${(st === "open" || st === "dicht") && r.preset_advice_label
        ? `<div class="preset">${esc(r.preset_basis_label)} → ${esc(r.preset_advice_label)}</div>` : ""}
      <div>${esc(r.advice || "")}</div>
      ${r.dt !== undefined ? `<dl class="kv" style="margin-top:8px">
        <dt>Gemeten</dt><dd>${fmt(r.t_in, 1)} → ${fmt(r.t_out, 1)} °C (ΔT ${fmt(r.dt, 1)} K), ruimte ${fmt(r.t_room, 1)} °C</dd>
        ${r.ratio !== undefined ? `<dt>Debietfactor</dt><dd>× ${fmt(r.ratio, 2)}</dd>` : ""}
        ${r.flow_act ? `<dt>Debiet</dt><dd>${fmt(r.flow_act, 0)} → ${fmt(r.flow_target, 0)} l/h</dd>` : ""}
        ${r.q_act ? `<dt>Afgifte</dt><dd>${fmt(r.q_act, 0)} W${r.q_target ? ` → doel ${fmt(r.q_target, 0)} W` : ""}</dd>` : ""}
        ${r.target_t_out !== undefined ? `<dt>Doelretour</dt><dd>${fmt(r.target_t_out, 1)} °C</dd>` : ""}
        <dt>Gemeten op</dt><dd>${fmtDate(r.measured_at)}</dd>
      </dl>` : ""}
      ${r.warnings?.length ? `<ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      ${canApply ? `<button class="btn primary" id="btn-apply" style="margin-top:10px">Stand ${esc(r.preset_advice_label)} ingesteld</button>` : ""}
    </div>

    <h3>Nieuwe meting</h3>
    <form id="meas" class="grid3" autocomplete="off">
      <label>Aanvoer °C<input name="t_in" inputmode="decimal" required></label>
      <label>Retour °C<input name="t_out" inputmode="decimal" required></label>
      <label>Ruimte °C<input name="t_room" inputmode="decimal" placeholder="${fmt(set.room_temp, 1)}"></label>
      <div style="grid-column:1/-1"><button class="btn primary" style="width:100%">Opslaan &amp; herberekenen</button></div>
    </form>
    <p class="muted small">Huidige stand bij deze meting: <b>${esc(presetLabel(valve, em.preset))}</b>
      ${valve ? `(${esc(valve.name)})` : ""}. Meet pas als de installatie een tijdje stabiel draait.</p>

    <h3>Gegevens</h3>
    <div class="grid2">
      <label>Naam<input name="name" value="${esc(em.name)}"></label>
      <label>Ruimte<input name="room" value="${esc(em.room || "")}" placeholder="bijv. Woonkamer"></label>
      <label>Type<select name="type">${Object.entries(TYPES).map(([k, t]) =>
        `<option value="${k}" ${k === em.type ? "selected" : ""}>${t.label}</option>`).join("")}</select></label>
      <label>Plattegrond<select name="floorplan_id">${p.floorplans.map((f) =>
        `<option value="${f.id}" ${f.id === em.floorplan_id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select></label>
      <label title="Vermogen volgens typeplaatje/fabrikant bij het nominale regime">Vermogen (W) bij ${nom.join("/")}
        <input name="power_w" inputmode="decimal" value="${em.power_w ?? ""}" placeholder="optioneel"></label>
      <label title="Berekende warmtevraag van (het deel van) de ruimte dat dit element verwarmt">Warmtevraag (W)
        <input name="demand_w" inputmode="decimal" value="${em.demand_w ?? ""}" placeholder="optioneel"></label>
      <label>Ventieltype<select name="valve_type">
        <option value="">— geen / onbekend —</option>
        ${p.valve_types.map((v) => `<option value="${esc(v.id)}" ${v.id === em.valve_type ? "selected" : ""}>${esc(v.name)}</option>`).join("")}
      </select></label>
      <label>Huidige stand${valve ? ` (${esc(stepsHint(valve))})` : ""}
        <input name="preset" inputmode="decimal" value="${em.preset ?? ""}" placeholder="bijv. 4"></label>
    </div>
    <label>Notities<textarea name="notes">${esc(em.notes || "")}</textarea></label>

    <h3>Meethistorie</h3>
    ${ms.length ? `<table class="history"><thead><tr><th>Wanneer</th><th>Aanv.</th><th>Ret.</th><th>ΔT</th><th>Ruimte</th><th>Stand</th><th></th></tr></thead>
      <tbody>${ms.map((m) => `<tr><td>${fmtDate(m.ts)}</td><td>${fmt(m.t_in, 1)}</td><td>${fmt(m.t_out, 1)}</td>
        <td>${fmt(m.t_in - m.t_out, 1)}</td><td>${m.t_room === null || m.t_room === undefined ? "–" : fmt(m.t_room, 1)}</td>
        <td>${esc(presetLabel(valve, m.preset))}</td>
        <td><button class="x" data-del-m="${m.id}" title="Meting verwijderen">✕</button></td></tr>`).join("")}</tbody></table>`
      : `<p class="muted">Nog geen metingen.</p>`}

    <p style="margin-top:24px"><button class="btn danger" id="btn-del">Element verwijderen</button></p>`;
}

function stepsHint(valve) {
  const st = valve.steps;
  if (!st.length) return "";
  const lo = st[0], hi = st[st.length - 1];
  return `${presetLabel(valve, lo[0])}–${presetLabel(valve, hi[0])}${valve.resolution ? `, stap ${String(valve.resolution).replace(".", ",")}` : ""}`;
}

function bindEmitterPanel(side, em) {
  $("#btn-close", side).onclick = () => { S.selectedId = null; renderPlan(); };
  $("#btn-del", side).onclick = async () => {
    if (!confirm(`'${em.name}' en alle metingen verwijderen?`)) return;
    S.selectedId = null;
    await mutate("DELETE", `emitters/${em.id}`);
  };
  const apply = $("#btn-apply", side);
  if (apply) apply.onclick = async () => {
    await mutate("PUT", `emitters/${em.id}`, { preset: result(em.id).preset_advice });
    toast("Stand bijgewerkt — doe na een tijdje een nieuwe meting");
  };
  $("#meas", side).onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const t_in = numOrNull(f.t_in.value), t_out = numOrNull(f.t_out.value);
    if (t_in === null || t_out === null) return toast("Vul aanvoer en retour in", true);
    await mutate("POST", `emitters/${em.id}/measurements`,
      { t_in, t_out, t_room: numOrNull(f.t_room.value) });
    toast("Opgeslagen en herberekend");
  };
  const numeric = new Set(["power_w", "demand_w", "preset"]);
  $$("input[name], select[name], textarea[name]", side).forEach((inp) => {
    if (inp.closest("#meas")) return;
    inp.addEventListener("change", async () => {
      let v = inp.value;
      if (numeric.has(inp.name)) {
        v = numOrNull(v);
        if (inp.value.trim() !== "" && v === null) return toast("Ongeldig getal", true);
      }
      if (inp.name === "floorplan_id") S.fpId = v;
      await mutate("PUT", `emitters/${em.id}`, { [inp.name]: v });
    });
  });
  $$("[data-del-m]", side).forEach((b) => (b.onclick = async () => {
    if (!confirm("Meting verwijderen?")) return;
    await mutate("DELETE", `emitters/${em.id}/measurements/${b.dataset.delM}`);
  }));
}

// ---- meetronde (tabel) ----------------------------------------------------

function renderTable() {
  const p = S.project, view = $("#view");
  const rows = [];
  for (const fp of p.floorplans) {
    const ems = p.emitters.filter((e) => e.floorplan_id === fp.id);
    if (!ems.length) continue;
    rows.push(`<tr class="group"><td colspan="9">${esc(fp.name)}</td></tr>`);
    for (const e of ems) {
      const r = result(e.id), st = r.status || "geen_meting", valve = valveOf(e);
      rows.push(`<tr data-id="${e.id}">
        <td><b>${esc(e.name)}</b><div class="muted small">${esc(e.room || "")}</div></td>
        <td><input name="preset" inputmode="decimal" value="${e.preset ?? ""}" title="${valve ? esc(valve.name) : "Geen ventieltype"}"></td>
        <td><input name="t_in" inputmode="decimal" placeholder="${r.t_in ?? ""}"></td>
        <td><input name="t_out" inputmode="decimal" placeholder="${r.t_out ?? ""}"></td>
        <td><input name="t_room" inputmode="decimal" placeholder="${r.t_room ?? fmt(p.settings.room_temp, 1)}"></td>
        <td class="num">${r.dt !== undefined ? fmt(r.dt, 1) : "–"}</td>
        <td class="num">${r.ratio !== undefined ? "× " + fmt(r.ratio, 2) : "–"}</td>
        <td class="num"><b>${(st === "open" || st === "dicht") && r.preset_advice_label ? esc(r.preset_advice_label) : "–"}</b></td>
        <td><div class="status st-${st}"><span class="dot"></span><span>${esc(r.advice || "")}
          ${r.warnings?.length ? `<div class="muted small">${r.warnings.map(esc).join("<br>")}</div>` : ""}</span></div></td>
      </tr>`);
    }
  }
  const anyAdvice = S.analysis.emitters.some((r) => (r.status === "open" || r.status === "dicht") &&
    r.preset_advice !== undefined && r.preset_advice !== emitter(r.id)?.preset);
  view.innerHTML = `
    <div class="table-wrap">
      <div class="round-actions">
        <button class="btn primary" id="btn-save-round">Meetronde opslaan &amp; herberekenen</button>
        <button class="btn" id="btn-apply-all" ${anyAdvice ? "" : "disabled"}>Alle geadviseerde standen ingesteld</button>
        <span class="muted small">Vul aanvoer/retour in (Enter = volgend veld). Lege regels worden overgeslagen;
          grijze waarden zijn de laatste meting.</span>
      </div>
      <div class="side" style="width:auto;max-width:none;border:none;padding:0 0 12px;background:none">${summaryHtml()}</div>
      ${rows.length ? `<table class="round"><thead><tr>
          <th>Element</th><th>Stand</th><th>Aanvoer °C</th><th>Retour °C</th><th>Ruimte °C</th>
          <th>ΔT</th><th>Factor</th><th>Nieuwe stand</th><th>Advies</th></tr></thead>
        <tbody>${rows.join("")}</tbody></table>`
      : `<p class="muted">Nog geen elementen. Plaats ze eerst op de plattegrond.</p>`}
    </div>`;
  const inputs = $$(".round input", view);
  inputs.forEach((inp, i) => inp.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); (inputs[i + 1] || $("#btn-save-round")).focus(); }
  }));
  $$(".round input[name=preset]", view).forEach((inp) => inp.addEventListener("change", async () => {
    const v = numOrNull(inp.value);
    if (inp.value.trim() !== "" && v === null) return toast("Ongeldig getal", true);
    const pending = collectRound();
    await mutate("PUT", `emitters/${inp.closest("tr").dataset.id}`, { preset: v });
    restoreRound(pending);
  }));
  $("#btn-save-round").onclick = async () => {
    const items = [];
    for (const tr of $$(".round tr[data-id]", view)) {
      const t_in = numOrNull($("[name=t_in]", tr).value), t_out = numOrNull($("[name=t_out]", tr).value);
      if (t_in === null && t_out === null) continue;
      if (t_in === null || t_out === null) {
        toast(`Vul bij ${emitter(tr.dataset.id).name} zowel aanvoer als retour in`, true);
        return;
      }
      items.push({ emitter_id: tr.dataset.id, t_in, t_out, t_room: numOrNull($("[name=t_room]", tr).value) });
    }
    if (!items.length) return toast("Geen nieuwe waarden ingevuld", true);
    await mutate("POST", "measurements", { items });
    toast(`${items.length} meting(en) opgeslagen en herberekend`);
  };
  $("#btn-apply-all").onclick = async () => {
    const todo = S.analysis.emitters.filter((r) => (r.status === "open" || r.status === "dicht") &&
      r.preset_advice !== undefined && r.preset_advice !== emitter(r.id)?.preset);
    if (!confirm(`De stand van ${todo.length} element(en) bijwerken naar het advies? Doe dit pas als je ze ook echt zo hebt ingesteld.`)) return;
    const pending = collectRound();
    for (const r of todo) await mutate("PUT", `emitters/${r.id}`, { preset: r.preset_advice }, { rerender: false });
    renderProject();
    restoreRound(pending);
    toast("Standen bijgewerkt — meet over een tijdje opnieuw");
  };
}

function collectRound() {
  return $$(".round tr[data-id]").map((tr) => ({
    id: tr.dataset.id,
    v: ["t_in", "t_out", "t_room"].map((n) => $(`[name=${n}]`, tr).value),
  }));
}
function restoreRound(pending) {
  for (const p of pending) {
    const tr = $(`.round tr[data-id="${p.id}"]`);
    if (tr) ["t_in", "t_out", "t_room"].forEach((n, i) => ($(`[name=${n}]`, tr).value = p.v[i]));
  }
}

// ---- plattegronden uploaden -------------------------------------------------

function bindFileDrop(area) {
  const dz = $("#dropzone");
  area.addEventListener("dragover", (ev) => {
    if (![...ev.dataTransfer.types].includes("Files")) return;
    ev.preventDefault();
    dz?.classList.add("over");
  });
  area.addEventListener("dragleave", () => dz?.classList.remove("over"));
  area.addEventListener("drop", (ev) => {
    if (!ev.dataTransfer.files.length) return;
    ev.preventDefault();
    dz?.classList.remove("over");
    uploadFiles([...ev.dataTransfer.files]);
  });
}

async function uploadFiles(files) {
  for (const file of files) {
    try {
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
        const pages = await pdfToImages(file);
        for (const [i, pg] of pages.entries()) {
          const base = file.name.replace(/\.pdf$/i, "");
          await uploadBlob(pg.blob, pages.length > 1 ? `${base} p${i + 1}` : base, pg.w, pg.h);
        }
      } else {
        const dim = await imageSize(file);
        await uploadBlob(file, file.name.replace(/\.[^.]+$/, ""), dim.w, dim.h);
      }
    } catch (e) {
      toast(`${file.name}: ${e.message}`, true);
    }
  }
  renderProject();
}

async function uploadBlob(blob, name, w, h) {
  const fd = new FormData();
  fd.append("file", blob, name);
  fd.append("name", name);
  fd.append("width", String(Math.round(w || 0)));
  fd.append("height", String(Math.round(h || 0)));
  toast(`Uploaden: ${name}…`);
  const data = await mutate("POST", "floorplans", fd, { rerender: false });
  S.fpId = data.project.floorplans[data.project.floorplans.length - 1].id;
}

function imageSize(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve({ w: 0, h: 0 }); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve;
    s.onerror = () => reject(new Error("PDF-ondersteuning kon niet geladen worden. Exporteer de PDF als PNG/JPG."));
    document.head.appendChild(s);
  });
}

async function pdfToImages(file) {
  if (!window.pdfjsLib) {
    toast("PDF-ondersteuning laden…");
    await loadScript(PDFJS + "pdf.min.js");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js";
  }
  // isEvalSupported: false sluit CVE-2024-4367 (code uitvoeren via een kwaadaardig PDF-font).
  const pdf = await window.pdfjsLib.getDocument({
    data: await file.arrayBuffer(), isEvalSupported: false, enableXfa: false,
  }).promise;
  const out = [];
  for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, 2400 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    out.push({ blob, w: canvas.width, h: canvas.height });
  }
  return out;
}

async function editFloorplan(fid) {
  const fp = S.project.floorplans.find((f) => f.id === fid);
  const n = S.project.emitters.filter((e) => e.floorplan_id === fid).length;
  const body = await dialog("Plattegrond", `
    <label>Naam<input name="name" value="${esc(fp.name)}" required></label>
    <p><button type="button" class="btn danger" id="btn-del-fp">Plattegrond verwijderen</button>
    <span class="muted small">(met ${n} element(en) en hun metingen)</span></p>`, {
    onOpen: (b) => {
      $("#btn-del-fp", b).onclick = async () => {
        if (!confirm(`'${fp.name}' verwijderen, inclusief ${n} element(en)?`)) return;
        $("#dlg").close("cancel");
        await mutate("DELETE", `floorplans/${fid}`);
      };
    },
  });
  if (!body) return;
  await mutate("PUT", `floorplans/${fid}`, { name: $("[name=name]", body).value });
}

// ---- projectinstellingen ----------------------------------------------------

function valveStepsText(v) {
  return v.steps.map((s) => `${s[0]}=${s[1]}${s[2] ? ":" + s[2] : ""}`).join("; ");
}
function parseSteps(txt) {
  const out = [];
  for (const part of txt.split(/[;\n]+/)) {
    const m = part.trim().match(/^([\d.,]+)\s*=\s*([\d.,]+)\s*(?::\s*(\S+))?$/);
    if (!m) { if (part.trim()) throw new Error(`Ongeldige stap: "${part.trim()}"`); continue; }
    out.push([Number(m[1].replace(",", ".")), Number(m[2].replace(",", ".")), m[3] || ""]);
  }
  if (!out.length) throw new Error("Een ventieltype heeft minstens één stap nodig");
  return out.sort((a, b) => a[0] - b[0]);
}

function valveEditHtml(v) {
  return `<div class="valve-edit" data-vid="${esc(v.id)}">
    <div class="grid2" style="grid-template-columns:2fr 1fr">
      <label>Naam<input name="v_name" value="${esc(v.name)}"></label>
      <label>Stapgrootte<input name="v_res" inputmode="decimal" value="${v.resolution}"></label>
    </div>
    <label>Standen (stand=kv, optioneel :label)<textarea name="v_steps" style="min-height:44px">${esc(valveStepsText(v))}</textarea></label>
    <button type="button" class="btn small danger" data-rm-valve>Verwijderen</button>
  </div>`;
}

async function editSettings() {
  const p = S.project, s = p.settings;
  const body = await dialog("Projectinstellingen", `
    <label>Naam<input name="name" value="${esc(p.name)}" required></label>
    <label>Adres / omschrijving<input name="address" value="${esc(p.address || "")}"></label>
    <div class="grid2">
      <label>Warmtebron<select name="heat_source">
        ${[["ketel", "Cv-ketel"], ["warmtepomp", "Warmtepomp"], ["anders", "Anders"]].map(([k, l]) =>
          `<option value="${k}" ${s.heat_source === k ? "selected" : ""}>${l}</option>`).join("")}
      </select></label>
      <label>Doel-ΔT radiatoren (K)<input name="target_dt" inputmode="decimal" value="${s.target_dt}"></label>
      <label>Doel-ΔT vloerverwarming (K)<input name="ufh_target_dt" inputmode="decimal" value="${s.ufh_target_dt}"></label>
      <label>Ruimtetemperatuur standaard (°C)<input name="room_temp" inputmode="decimal" value="${s.room_temp}"></label>
      <label>Tolerantie "goed" (± % debiet)<input name="tolerance_pct" inputmode="decimal" value="${s.tolerance_pct}"></label>
    </div>
    <label>Methode<select name="method">
      <option value="auto" ${s.method === "auto" ? "selected" : ""}>Automatisch: op warmtevraag als die overal is ingevuld, anders gelijk ΔT</option>
      <option value="dt" ${s.method === "dt" ? "selected" : ""}>Altijd gelijk ΔT</option>
    </select></label>
    <label class="check"><input type="checkbox" name="keep_total_flow" ${s.keep_total_flow ? "checked" : ""}>
      Totaal pompdebiet gelijk houden bij het verdelen (aanbevolen)</label>
    <h3>Afgiftekarakteristiek</h3>
    <div class="grid2">
      <label>Exponent n radiator<input name="radiator_exponent" inputmode="decimal" value="${s.radiator_exponent}"></label>
      <label>Exponent n vloerverwarming<input name="ufh_exponent" inputmode="decimal" value="${s.ufh_exponent}"></label>
      <label>Nominaal regime radiator (aanv/ret/ruimte)<input name="radiator_nominal" value="${s.radiator_nominal.join("/")}"></label>
      <label>Nominaal regime vloerverw. (aanv/ret/ruimte)<input name="ufh_nominal" value="${s.ufh_nominal.join("/")}"></label>
    </div>
    <h3>Ventieltypes</h3>
    <p class="muted small">De kv-waarden zijn indicatief; neem bij voorkeur die uit het datablad van je ventiel.
      Alleen de verhouding tussen standen telt. Voor een debietmeter is de stand het debiet zelf.</p>
    <div id="valves">${p.valve_types.map(valveEditHtml).join("")}</div>
    <button type="button" class="btn small" id="btn-add-valve">+ Ventieltype</button>
    <h3>Notities</h3>
    <textarea name="notes">${esc(p.notes || "")}</textarea>
    <p style="margin-top:20px"><button type="button" class="btn danger" id="btn-del-project">Project verwijderen</button></p>`, {
    onOpen: (b) => {
      const bindRm = () => $$("[data-rm-valve]", b).forEach((x) => (x.onclick = () => x.closest(".valve-edit").remove()));
      bindRm();
      $("#btn-add-valve", b).onclick = () => {
        $("#valves", b).insertAdjacentHTML("beforeend", valveEditHtml({
          id: "v" + Math.random().toString(16).slice(2, 10), name: "Eigen ventiel", resolution: 0.5,
          steps: [[1, 0.1, ""], [2, 0.2, ""], [3, 0.3, ""]],
        }));
        bindRm();
      };
      $("[name=heat_source]", b).onchange = (ev) => {
        const dt = { ketel: 20, warmtepomp: 5 }[ev.target.value];
        if (dt) $("[name=target_dt]", b).value = dt;
      };
      $("#btn-del-project", b).onclick = async () => {
        if (!confirm(`Project '${p.name}' met alle plattegronden en metingen definitief verwijderen?`)) return;
        $("#dlg").close("cancel");
        try { await api("DELETE", `projects/${p.id}`); location.hash = "#/"; } catch (e) { toast(e.message, true); }
      };
    },
  });
  if (!body) return;
  try {
    const regime = (v) => {
      const a = v.split(/[\/;\s]+/).map((x) => numOrNull(x)).filter((x) => x !== null);
      if (a.length !== 3) throw new Error("Regime als aanvoer/retour/ruimte, bijv. 75/65/20");
      return a;
    };
    const val = (n) => $(`[name=${n}]`, body).value;
    const valve_types = $$(".valve-edit", body).map((el) => ({
      id: el.dataset.vid, name: $("[name=v_name]", el).value || "Ventiel",
      resolution: numOrNull($("[name=v_res]", el).value) ?? 0, steps: parseSteps($("[name=v_steps]", el).value),
    }));
    await mutate("PUT", "", {
      name: val("name"), address: val("address"), notes: val("notes"),
      settings: {
        heat_source: val("heat_source"), target_dt: numOrNull(val("target_dt")),
        ufh_target_dt: numOrNull(val("ufh_target_dt")),
        room_temp: numOrNull(val("room_temp")), tolerance_pct: numOrNull(val("tolerance_pct")),
        method: val("method"), keep_total_flow: $("[name=keep_total_flow]", body).checked,
        radiator_exponent: numOrNull(val("radiator_exponent")), ufh_exponent: numOrNull(val("ufh_exponent")),
        radiator_nominal: regime(val("radiator_nominal")), ufh_nominal: regime(val("ufh_nominal")),
      },
      valve_types,
    });
    toast("Instellingen opgeslagen en herberekend");
  } catch (e) { toast(e.message, true); }
}

// ---- start ----------------------------------------------------------------

$("#btn-back").onclick = () => (location.hash = "#/");
route();
