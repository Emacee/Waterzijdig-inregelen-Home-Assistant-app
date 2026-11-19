/* Waterzijdig Inregelen — ingress-UI (vanilla JS, geen build-stap).
 * Alle URL's zijn relatief zodat de app onder /api/hassio_ingress/<token>/ werkt. */
"use strict";

const S = {
  projects: [], project: null, analysis: null, results: new Map(),
  fpId: null, selectedId: null, mode: "plan", zoom: 1, compact: false,
  pipeId: null, draw: null, schema: null, schemaZoom: 1, heating: null,
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
  S.schema = data.schema;
  S.heating = data.heating;
  S.results = new Map(data.analysis.emitters.map((r) => [r.id, r]));
  if (!S.project.floorplans.some((f) => f.id === S.fpId)) S.fpId = S.project.floorplans[0]?.id || null;
  if (S.selectedId && !S.project.emitters.some((e) => e.id === S.selectedId)) S.selectedId = null;
  if (S.pipeId && !curPipes().some((l) => l.id === S.pipeId)) S.pipeId = null;
}

function curPipes() {
  return S.project.floorplans.find((f) => f.id === S.fpId)?.pipes || [];
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
// Ingestelde cv-aanvoertemperatuur voor dit element (vloerverwarming kan een eigen hebben), of null.
function supplyFor(em) {
  const s = S.project.settings;
  return em.type === "vloerverwarming" && s.ufh_supply_temp != null ? s.ufh_supply_temp : s.supply_temp ?? null;
}
// Zelfde normalisatie als de server (balance.norm_room): hoofdletters en leestekens tellen niet.
const normRoom = (v) => String(v ?? "").toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, " ").trim().replace(/\s+/g, " ");
function roomNames() {
  const seen = new Map();
  for (const r of S.project.rooms || []) seen.set(normRoom(r.name), r.name);
  for (const e of S.project.emitters) if (normRoom(e.room) && !seen.has(normRoom(e.room))) seen.set(normRoom(e.room), e.room.trim());
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "nl"));
}
function valveOf(em) { return S.project.valve_types.find((v) => v.id === em.valve_type); }
function presetLabel(valve, s) {
  if (s === null || s === undefined) return "–";
  const step = valve?.steps.find((st) => st[2] && Math.abs(st[0] - s) < 1e-6);
  return step ? step[2] : String(s).replace(".", ",");
}

// ---- dialoog --------------------------------------------------------------

function dialog(title, bodyHtml, { ok = "Opslaan", onOpen, wide = false } = {}) {
  const dlg = $("#dlg");
  dlg.classList.toggle("wide", wide);
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
    <button class="btn ${S.mode === "rooms" ? "primary" : ""}" data-mode="rooms" title="Ruimtes uit de warmteverliesberekening: ontwerptemperatuur, warmteverlies en ontwerpretour">Warmteverlies</button>
    <button class="btn ${S.mode === "heating" ? "primary" : ""}" data-mode="heating" title="Stooklijn uit gasverbruik, graaddagen en de radiatoren per ruimte">Stooklijn</button>
    <button class="btn ${S.mode === "schema" ? "primary" : ""}" data-mode="schema">Schema</button>
    <a class="btn" href="api/projects/${p.id}/export.csv" download>CSV</a>
    <button class="icon-btn" id="btn-settings" title="Projectinstellingen">⚙</button>`;
  $$("[data-mode]").forEach((b) => (b.onclick = () => { S.mode = b.dataset.mode; S.draw = null; renderProject(); }));
  $("#btn-settings").onclick = editSettings;
  if (S.mode === "table") renderTable();
  else if (S.mode === "schema") renderSchema();
  else if (S.mode === "rooms") renderRooms();
  else if (S.mode === "heating") renderHeating();
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
    b.onclick = () => { S.fpId = b.dataset.fp; S.selectedId = null; S.pipeId = null; S.draw = null; renderProject(); };
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
          <button class="btn ${S.draw ? "primary" : ""}" id="btn-pipe" title="Leidingverloop intekenen voor het hydraulisch schema">✎ Leiding</button>
          ${S.draw ? `<button class="btn" id="btn-pipe-done">Klaar</button>
            <span class="hint">klik punten · dubbelklik/Enter = leiding klaar · Backspace = punt terug ·
              Shift = haaks · Esc = stoppen. Begin een aftakking óp een bestaande leiding.</span>`
          : `<span class="hint">← sleep op de plattegrond · klik een element om waarden in te voeren</span>`}
          <span class="spacer"></span>
          <button class="icon-btn" data-zoom="-1" title="Uitzoomen">−</button>
          <button class="icon-btn" data-zoom="0" title="Passend">⤢</button>
          <button class="icon-btn" data-zoom="1" title="Inzoomen">+</button>
          <button class="icon-btn" id="btn-compact" title="Namen tonen/verbergen">${S.compact ? "Aa" : "A"}</button>
        </div>` : ""}
        <div class="plan-scroll" id="plan-scroll">
          ${fp ? `<div class="plan ${S.compact ? "compact" : ""} ${S.draw ? "drawing" : ""}" id="plan">
              <img src="api/projects/${p.id}/floorplans/${fp.id}/image" alt="${esc(fp.name)}" id="plan-img">
              <svg class="pipes" id="pipes" viewBox="0 0 1 1" preserveAspectRatio="none">${pipesSvg(fp)}</svg>
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
    $("#btn-pipe").onclick = () => {
      S.draw = S.draw ? null : []; S.selectedId = null; S.pipeId = null; renderPlan();
    };
    if (S.draw) $("#btn-pipe-done").onclick = () => finishPipe(true);
    bindPipes();
    $("#plan").addEventListener("pointerdown", (ev) => {
      if (S.draw || !["plan", "pipes"].includes(ev.target.id)) return;
      if (S.selectedId || S.pipeId) { S.selectedId = null; S.pipeId = null; renderPlan(); }
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
      S.pipeId = null;
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

// ---- leidingverloop -----------------------------------------------------

const ptsAttr = (pts) => pts.map((q) => `${q[0]},${q[1]}`).join(" ");

function pipesSvg(fp) {
  const ls = fp.pipes || [];
  return ls.map((l, i) => `<g class="pipe ${l.id === S.pipeId ? "selected" : ""}" data-pipe="${l.id}">
      <title>${esc(l.name || `Leiding ${i + 1}`)}</title>
      <polyline class="hit" points="${ptsAttr(l.points)}" vector-effect="non-scaling-stroke"/>
      <polyline class="sup" points="${ptsAttr(l.points)}" vector-effect="non-scaling-stroke"/>
      <polyline class="ret" points="${ptsAttr(l.points)}" vector-effect="non-scaling-stroke"/>
      <polyline class="start" points="${ptsAttr([l.points[0], l.points[0]])}" vector-effect="non-scaling-stroke"/>
    </g>`).join("") +
    `<polyline class="draft" id="draft" points="${S.draw ? ptsAttr(S.draw) : ""}" vector-effect="non-scaling-stroke"/>`;
}

function updateDraft(extra) {
  const d = $("#draft");
  if (d) d.setAttribute("points", ptsAttr(extra ? [...S.draw, extra] : S.draw));
}

// Klikpunt → plattegrondcoördinaat, met Shift haaks en anders snappen op bestaande leidingen.
function pipePoint(ev) {
  const rect = $("#plan").getBoundingClientRect();
  let px = ev.clientX - rect.left, py = ev.clientY - rect.top;
  const last = S.draw[S.draw.length - 1];
  if (ev.shiftKey && last) {
    const lx = last[0] * rect.width, ly = last[1] * rect.height;
    if (Math.abs(px - lx) > Math.abs(py - ly)) py = ly; else px = lx;
  } else {
    let best = 12, snap = null;
    const lines = [...curPipes().map((l) => l.points), S.draw];
    for (const pts of lines) {
      for (let i = 0; i < pts.length; i++) {
        const a = [pts[i][0] * rect.width, pts[i][1] * rect.height];
        const d = Math.hypot(px - a[0], py - a[1]);
        if (d < best) { best = d; snap = a; }
        if (i + 1 >= pts.length) continue;
        const b = [pts[i + 1][0] * rect.width, pts[i + 1][1] * rect.height];
        const dx = b[0] - a[0], dy = b[1] - a[1], ll = dx * dx + dy * dy;
        const t = ll ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / ll)) : 0;
        const q = [a[0] + t * dx, a[1] + t * dy], dq = Math.hypot(px - q[0], py - q[1]);
        if (dq < best - 4) { best = dq; snap = q; }
      }
    }
    if (snap) [px, py] = snap;
  }
  return { pt: [clamp01(px / rect.width), clamp01(py / rect.height)], px, py, rect };
}

function bindPipes() {
  const plan = $("#plan");
  $$("[data-pipe]", plan).forEach((g) => g.addEventListener("pointerdown", (ev) => {
    if (S.draw) return;
    ev.stopPropagation();
    S.pipeId = g.dataset.pipe; S.selectedId = null;
    renderPlan();
  }));
  if (!S.draw) return;
  plan.addEventListener("pointermove", (ev) => { if (S.draw.length) updateDraft(pipePoint(ev).pt); });
  plan.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const { pt, px, py, rect } = pipePoint(ev);
    const last = S.draw[S.draw.length - 1];
    // nogmaals op hetzelfde punt (dubbelklik/dubbeltik) = leiding klaar
    if (last && Math.hypot(px - last[0] * rect.width, py - last[1] * rect.height) < 5) {
      finishPipe(false);
      return;
    }
    S.draw.push(pt);
    updateDraft();
  });
}

async function finishPipe(stop) {
  const pts = S.draw || [];
  if (pts.length >= 2) {
    S.draw = stop ? null : [];
    await mutate("POST", `floorplans/${S.fpId}/pipes`, { points: pts });
    toast("Leiding opgeslagen");
  } else {
    if (pts.length) toast("Een leiding heeft minstens twee punten", true);
    S.draw = stop ? null : [];
    renderPlan();
  }
}

document.addEventListener("keydown", (ev) => {
  if (!S.draw || S.mode !== "plan" || ev.target.closest?.("input, textarea, select, dialog")) return;
  if (ev.key === "Enter") { ev.preventDefault(); finishPipe(false); }
  else if (ev.key === "Escape") {
    ev.preventDefault();
    if (S.draw.length) { S.draw = []; updateDraft(); } else { S.draw = null; renderPlan(); }
  } else if (ev.key === "Backspace") { ev.preventDefault(); S.draw.pop(); updateDraft(); }
});

function pipePanelHtml(pipe) {
  const ls = curPipes(), i = ls.indexOf(pipe);
  return `
    <div style="display:flex;align-items:center;gap:8px">
      <button class="icon-btn" id="btn-close" title="Sluiten">←</button>
      <h2 style="margin:0;flex:1">${esc(pipe.name || `Leiding ${i + 1}`)}</h2>
    </div>
    <p class="muted small">Een leiding staat voor het aanvoer/retour-paar en loopt vanaf het
      beginpunt (de stip). De eerste leiding begint bij de aansluiting van de verdieping; een
      leiding die op een andere leiding begint is een aftakking. Elementen hangen in het schema aan
      de dichtstbijzijnde leiding, in volgorde langs de leiding.</p>
    <label>Naam<input name="name" value="${esc(pipe.name || "")}" placeholder="bijv. Groep woonkamer"></label>
    <p class="muted small">${pipe.points.length} punten</p>
    <p><button class="btn" id="btn-reverse">Richting omdraaien</button>
      <button class="btn danger" id="btn-del-pipe">Leiding verwijderen</button></p>`;
}

function bindPipePanel(side, pipe) {
  const path = `floorplans/${S.fpId}/pipes/${pipe.id}`;
  $("#btn-close", side).onclick = () => { S.pipeId = null; renderPlan(); };
  $("[name=name]", side).onchange = (ev) => mutate("PUT", path, { name: ev.target.value });
  $("#btn-reverse", side).onclick = () => mutate("PUT", path, { points: [...pipe.points].reverse() });
  $("#btn-del-pipe", side).onclick = async () => {
    if (!confirm("Leiding verwijderen?")) return;
    S.pipeId = null;
    await mutate("DELETE", path);
  };
}

// ---- zijpaneel ------------------------------------------------------------

function summaryHtml() {
  const a = S.analysis, s = a.summary, c = s.counts;
  const pills = ["ok", "open", "dicht", "ongeldig", "geen_meting"].filter((k) => c[k])
    .map((k) => `<span class="pill st-${k}"><span class="dot"></span>${c[k]} ${STATUS[k].text.toLowerCase()}</span>`).join("");
  const groups = s.groups.map((g) => `
    <dt>${esc(g.label)}</dt><dd>${g.method === "ontwerp" ? `op ontwerpdebiet (warmteverliesberekening), ontwerp-aanvoer ${fmt(g.design_supply, 0)} °C`
        : g.method === "vraag" ? "op warmtevraag" : `gelijk ΔT, doel ${fmt(g.target_dt, 1)} K`}
      ${g.method === "dt" && g.supply_temp != null ? `<br>cv ${fmt(g.supply_temp, 0)} °C → doelretour ${fmt(g.target_t_out, 1)} °C` : ""}
      ${g.dt_mean !== undefined ? `<br>gemeten gem. ΔT ${fmt(g.dt_mean, 1)} K${g.dt_weighted !== undefined ? ` (debietgewogen ${fmt(g.dt_weighted, 1)} K)` : ""}` : ""}
      ${g.flow_total !== undefined ? `<br>${fmt(g.flow_total, 0)} l/h · ${fmt(g.q_total / 1000, 1)} kW` : ""}
      <span class="muted">· ${g.measured}/${g.members} gemeten</span></dd>`).join("");
  return `
    <h3 style="margin-top:0">Overzicht</h3>
    <div class="summary">${pills || '<span class="muted">Nog geen elementen</span>'}</div>
    ${groups || s.boiler ? `<dl class="kv">${groups}${s.boiler ? `<dt>Warmtebron</dt><dd>${fmt(s.boiler.t_in, 1)} → ${fmt(s.boiler.t_out, 1)} °C
      (ΔT ${fmt(s.boiler.dt, 1)} K) <span class="muted">· ${fmtDate(s.boiler.ts)}</span></dd>` : ""}</dl>` : ""}
    ${s.boiler?.warning ? `<div class="notice warn">${esc(s.boiler.warning)}</div>` : ""}
    ${s.pump_advice.map((t) => `<div class="notice warn">${esc(t)}</div>`).join("")}
    ${s.notes.map((n) => `<div class="notice">${esc(n)}</div>`).join("")}`;
}

function renderSide() {
  const side = $("#side");
  if (!side) return;
  const pipe = S.pipeId && curPipes().find((l) => l.id === S.pipeId);
  if (pipe) {
    side.innerHTML = pipePanelHtml(pipe);
    bindPipePanel(side, pipe);
    return;
  }
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
  const supply = supplyFor(em);
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
        <dt>Gemeten</dt><dd>${fmt(r.t_in, 1)}${r.t_in_source === "cv" ? " (cv)" : ""} → ${fmt(r.t_out, 1)} °C (ΔT ${fmt(r.dt, 1)} K), ruimte ${fmt(r.t_room, 1)} °C</dd>
        ${r.ratio !== undefined ? `<dt>Debietfactor</dt><dd>× ${fmt(r.ratio, 2)}</dd>` : ""}
        ${r.flow_act ? `<dt>Debiet</dt><dd>${fmt(r.flow_act, 0)} → ${fmt(r.flow_target, 0)} l/h</dd>` : ""}
        ${r.q_act ? `<dt>Afgifte</dt><dd>${fmt(r.q_act, 0)} W${r.q_target ? ` → doel ${fmt(r.q_target, 0)} W` : ""}</dd>` : ""}
        ${r.target_t_out !== undefined ? `<dt>Doelretour</dt><dd>${fmt(r.target_t_out, 1)} °C${r.design_flow && S.analysis.summary.groups.some((g) => g.method === "ontwerp" && g.key === (isUfh ? "vloer" : "rad")) ? ` <span class="muted">bij deze aanvoer en ${fmt(r.t_room, 1)} °C ruimte</span>` : ""}</dd>` : ""}
        <dt>Gemeten op</dt><dd>${fmtDate(r.measured_at)}</dd>
      </dl>` : ""}
      ${r.warnings?.length ? `<ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      ${canApply ? `<button class="btn primary" id="btn-apply" style="margin-top:10px">Stand ${esc(r.preset_advice_label)} ingesteld</button>` : ""}
    </div>

    ${designHtml(em, r)}

    <h3>Nieuwe meting</h3>
    <form id="meas" class="grid3" autocomplete="off">
      ${supply !== null
        ? `<label>Aanvoer °C<input name="t_in" inputmode="decimal" placeholder="cv ${fmt(supply, 0)}" title="Leeg = cv-temperatuur uit de projectinstellingen"></label>`
        : `<label>Aanvoer °C<input name="t_in" inputmode="decimal" required></label>`}
      <label>Retour °C<input name="t_out" inputmode="decimal" required></label>
      <label>Ruimte °C<input name="t_room" inputmode="decimal" placeholder="${fmt(r.room_temp ?? set.room_temp, 1)}"></label>
      <div style="grid-column:1/-1"><button class="btn primary" style="width:100%">Opslaan &amp; herberekenen</button></div>
    </form>
    <p class="muted small">Huidige stand bij deze meting: <b>${esc(presetLabel(valve, em.preset))}</b>
      ${valve ? `(${esc(valve.name)})` : ""}. Meet pas als de installatie een tijdje stabiel draait.</p>

    <h3>Gegevens</h3>
    <div class="grid2">
      <label>Naam<input name="name" value="${esc(em.name)}"></label>
      <label>Ruimte<input name="room" value="${esc(em.room || "")}" placeholder="bijv. Woonkamer" list="room-names"
        title="Dezelfde naam als in het tabblad Warmteverlies koppelt het element aan die ruimte"></label>
      <datalist id="room-names">${roomNames().map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
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
      <tbody>${ms.map((m) => { const tIn = m.t_in ?? supply; return `<tr><td>${fmtDate(m.ts)}</td>
        <td>${m.t_in == null ? `<span class="muted" title="cv-temperatuur">cv</span>` : fmt(m.t_in, 1)}</td><td>${fmt(m.t_out, 1)}</td>
        <td>${tIn == null ? "–" : fmt(tIn - m.t_out, 1)}</td><td>${m.t_room === null || m.t_room === undefined ? "–" : fmt(m.t_room, 1)}</td>
        <td>${esc(presetLabel(valve, m.preset))}</td>
        <td><button class="x" data-del-m="${m.id}" title="Meting verwijderen">✕</button></td></tr>`; }).join("")}</tbody></table>`
      : `<p class="muted">Nog geen metingen.</p>`}

    <p style="margin-top:24px"><button class="btn danger" id="btn-del">Element verwijderen</button></p>`;
}

// Ontwerpwaarden uit de warmteverliesberekening voor één element.
function designHtml(em, r) {
  if (!(S.project.rooms || []).length) return "";
  const room = S.analysis.rooms.rooms.find((x) => x.id === r.room_id);
  if (!room) {
    return `<h3>Ontwerp (warmteverliesberekening)</h3>
      <p class="muted small">${em.room ? `Ruimte '${esc(em.room)}' staat niet in het tabblad Warmteverlies.`
        : "Vul bij Gegevens de ruimte in om dit element aan de warmteverliesberekening te koppelen."}</p>`;
  }
  return `<h3>Ontwerp (warmteverliesberekening)</h3>
    <dl class="kv">
      <dt>Ruimte</dt><dd>${esc(room.name)}: ${fmt(r.room_temp, 1)} °C${room.loss_w ? `, warmteverlies ${fmt(room.loss_w, 0)} W` : ""}</dd>
      ${r.design_q ? `<dt>Aandeel</dt><dd>${fmt(r.design_q, 0)} W${room.emitters.length > 1 ? ` <span class="muted">(${room.emitters.length} elementen in deze ruimte)</span>` : ""}</dd>` : ""}
      ${r.design_t_out !== undefined ? `<dt>Ontwerpretour</dt><dd><b>${fmt(r.design_t_out, 1)} °C</b> bij ${fmt(r.design_supply, 0)} °C aanvoer (ΔT ${fmt(r.design_supply - r.design_t_out, 1)} K)</dd>
        <dt>Ontwerpdebiet</dt><dd>${fmt(r.design_flow, 0)} l/h</dd>` : ""}
    </dl>
    ${room.warnings.length ? `<div class="notice warn">${room.warnings.map(esc).join("<br>")}</div>` : ""}`;
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
    if (t_out === null) return toast("Vul de retourtemperatuur in", true);
    if (t_in === null && supplyFor(em) === null) return toast("Vul de aanvoer in of stel de cv-temperatuur in bij ⚙", true);
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
  const rows = [], b = S.analysis.summary.boiler || {};
  rows.push(`<tr class="group"><td colspan="10">Warmtebron</td></tr>
    <tr data-id="boiler">
      <td><b>${esc({ ketel: "Cv-ketel", warmtepomp: "Warmtepomp" }[p.settings.heat_source] || "Warmtebron")}</b>
        <div class="muted small">aanvoer/retour bij de bron zelf (optioneel)</div></td>
      <td></td>
      <td><input name="t_in" inputmode="decimal" placeholder="${b.t_in ?? ""}"></td>
      <td><input name="t_out" inputmode="decimal" placeholder="${b.t_out ?? ""}"></td>
      <td><input name="t_room" type="hidden"></td>
      <td class="num">${b.dt !== undefined ? fmt(b.dt, 1) : "–"}</td><td></td><td></td><td></td>
      <td><div class="status ${b.warning ? "st-open" : b.dt !== undefined ? "st-ok" : "st-geen_meting"}"><span class="dot"></span>
        <span>${b.warning ? esc(b.warning) : b.dt !== undefined ? "ΔT bij de bron binnen de grens" : ""}</span></div></td>
    </tr>`);
  for (const fp of p.floorplans) {
    const ems = p.emitters.filter((e) => e.floorplan_id === fp.id);
    if (!ems.length) continue;
    rows.push(`<tr class="group"><td colspan="10">${esc(fp.name)}</td></tr>`);
    for (const e of ems) {
      const r = result(e.id), st = r.status || "geen_meting", valve = valveOf(e);
      rows.push(`<tr data-id="${e.id}">
        <td><b>${esc(e.name)}</b><div class="muted small">${esc(e.room || "")}</div></td>
        <td><input name="preset" inputmode="decimal" value="${e.preset ?? ""}" title="${valve ? esc(valve.name) : "Geen ventieltype"}"></td>
        <td><input name="t_in" inputmode="decimal" placeholder="${supplyFor(e) !== null ? `cv ${fmt(supplyFor(e), 0)}` : r.t_in ?? ""}"></td>
        <td><input name="t_out" inputmode="decimal" placeholder="${r.t_out ?? ""}"></td>
        <td><input name="t_room" inputmode="decimal" placeholder="${r.t_room ?? fmt(r.room_temp ?? p.settings.room_temp, 1)}"></td>
        <td class="num" title="${r.target_t_out === undefined && r.design_t_out !== undefined ? `Ontwerpretour bij ${fmt(r.design_supply, 0)} °C aanvoer` : "Retour waarop dit element bij deze aanvoer uit moet komen"}">${r.target_t_out !== undefined ? fmt(r.target_t_out, 1)
          : r.design_t_out !== undefined ? `<span class="muted">${fmt(r.design_t_out, 1)}</span>` : "–"}</td>
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
          grijze waarden zijn de laatste meting${p.settings.supply_temp != null ? "; lege aanvoer = cv-temperatuur" : ""}.</span>
      </div>
      <div class="side" style="width:auto;max-width:none;border:none;padding:0 0 12px;background:none">${summaryHtml()}</div>
      ${rows.length ? `<table class="round"><thead><tr>
          <th>Element</th><th>Stand</th><th>Aanvoer °C</th><th>Retour °C</th><th>Ruimte °C</th>
          <th>Doelretour</th><th>ΔT</th><th>Factor</th><th>Nieuwe stand</th><th>Advies</th></tr></thead>
        <tbody>${rows.join("")}</tbody></table>`
      : `<p class="muted">Nog geen elementen. Plaats ze eerst op de plattegrond.</p>`}
    </div>`;
  const inputs = $$(".round input:not([type=hidden])", view);
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
    let boiler;
    for (const tr of $$(".round tr[data-id]", view)) {
      if (tr.dataset.id === "boiler") {
        const t_in = numOrNull($("[name=t_in]", tr).value), t_out = numOrNull($("[name=t_out]", tr).value);
        if (t_in === null && t_out === null) continue;
        if (t_in === null || t_out === null) return toast("Vul bij de warmtebron zowel aanvoer als retour in", true);
        boiler = { t_in, t_out };
        continue;
      }
      const t_in = numOrNull($("[name=t_in]", tr).value), t_out = numOrNull($("[name=t_out]", tr).value);
      if (t_in === null && t_out === null) continue;
      const em = emitter(tr.dataset.id);
      if (t_out === null || (t_in === null && supplyFor(em) === null)) {
        toast(`Vul bij ${em.name} ${t_out === null ? "de retour" : "de aanvoer (of de cv-temperatuur bij ⚙)"} in`, true);
        return;
      }
      items.push({ emitter_id: tr.dataset.id, t_in, t_out, t_room: numOrNull($("[name=t_room]", tr).value) });
    }
    if (!items.length && !boiler) return toast("Geen nieuwe waarden ingevuld", true);
    await mutate("POST", "measurements", { items, boiler });
    toast(`${items.length + (boiler ? 1 : 0)} meting(en) opgeslagen en herberekend`);
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

// ---- warmteverlies (ruimtes) ------------------------------------------------
// Ruimtes uit de warmteverliesberekening: ontwerptemperatuur en warmteverlies per ruimte.
// Elementen horen bij een ruimte via hun ruimtenaam; de server rekent de ontwerpretour uit.

function renderRooms() {
  const p = S.project, A = S.analysis.rooms, set = p.settings, view = $("#view");
  const info = new Map(A.rooms.map((r) => [r.id, r]));
  const emRows = (ems) => ems.map((e) => {
    const r = result(e.id), nom = (e.type === "vloerverwarming" ? set.ufh_nominal : set.radiator_nominal).join("/");
    return `<tr class="sub" data-em="${e.id}">
      <td><a href="#" data-open="${e.id}" title="Openen op de plattegrond">↳ ${esc(e.name)}</a>
        <span class="muted small">${esc(TYPES[e.type]?.label || "")}</span></td>
      <td></td>
      <td class="num">${r.design_q ? fmt(r.design_q, 0) : "–"}</td>
      <td><input name="power_w" inputmode="decimal" value="${e.power_w ?? ""}" placeholder="W" title="Vermogen bij ${nom}"></td>
      <td class="num"><b>${r.design_t_out !== undefined ? fmt(r.design_t_out, 1) : r.design_sat ? "max. open" : "–"}</b></td>
      <td class="num">${r.design_t_out !== undefined ? fmt(r.design_supply - r.design_t_out, 1) : "–"}</td>
      <td class="num">${r.design_flow ? fmt(r.design_flow, 0) : "–"}</td>
      <td class="muted small">${r.design_supply != null && r.design_q ? `bij ${fmt(r.design_supply, 0)} °C aanvoer` : ""}</td><td></td></tr>`;
  }).join("");
  const roomRow = (room, ems, extra = "") => {
    const i = info.get(room.id) || { warnings: [] };
    const flow = ems.reduce((t, e) => t + (result(e.id).design_flow || 0), 0);
    return `<tr class="room" data-room="${esc(room.id || "")}" ${room.id ? "" : "data-new"}>
      <td><input name="name" value="${esc(room.name)}" placeholder="Naam van de ruimte" maxlength="100"></td>
      <td><input name="temp" inputmode="decimal" value="${room.temp ?? ""}" placeholder="${fmt(set.room_temp, 0)}"></td>
      <td><input name="loss_w" inputmode="decimal" value="${room.loss_w ?? ""}" placeholder="W"></td>
      <td></td><td></td><td></td>
      <td class="num">${flow ? fmt(flow, 0) : ""}</td>
      <td class="small">${extra}${i.warnings.map((w) => `<div class="warn-text">${esc(w)}</div>`).join("")}</td>
      <td>${room.id ? `<button class="x" data-del-room title="Ruimte verwijderen">✕</button>` : ""}</td></tr>${emRows(ems)}`;
  };
  const emsOf = (name) => p.emitters.filter((e) => normRoom(e.room) === normRoom(name));
  const body = [
    ...(p.rooms || []).map((room) => roomRow(room, emsOf(room.name))),
    ...A.unmatched.map((name) => roomRow({ name, temp: null, loss_w: null }, emsOf(name),
      `<div class="muted">Nog geen warmteverlies ingevuld</div>`)),
  ];
  const loose = p.emitters.filter((e) => !normRoom(e.room));
  const total = (p.rooms || []).reduce((t, r) => t + (r.loss_w || 0), 0);
  const flowOf = (ufh) => p.emitters.filter((e) => (e.type === "vloerverwarming") === ufh)
    .reduce((t, e) => t + (result(e.id).design_flow || 0), 0);
  const ufhFallback = set.ufh_supply_temp ?? set.design_supply_temp ?? set.supply_temp;
  view.innerHTML = `
    <div class="table-wrap">
      <div class="round-actions">
        <button class="btn primary" id="btn-hl-upload">Warmteverliesberekening uploaden</button>
        <button class="btn" id="btn-add-room">+ Ruimte</button>
        <a class="btn" href="api/projects/${p.id}/heatloss/template.xlsx" download title="Excel met de ruimtes van dit project; vul temperatuur en warmteverlies in en upload hem weer">Excel-sjabloon</a>
        <input type="file" id="hl-file" hidden accept=".csv,.tsv,.txt,.xlsx,.pdf,text/csv,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
        <label class="inline">Ontwerp-aanvoer radiatoren °C
          <input name="design_supply_temp" inputmode="decimal" value="${set.design_supply_temp ?? ""}" placeholder="${set.supply_temp != null ? `cv ${fmt(set.supply_temp, 0)}` : "bijv. 55"}"></label>
        <label class="inline">vloerverwarming °C
          <input name="ufh_design_supply_temp" inputmode="decimal" value="${set.ufh_design_supply_temp ?? ""}" placeholder="${ufhFallback != null ? fmt(ufhFallback, 0) : "bijv. 35"}"></label>
      </div>
      <p class="muted small" style="max-width:980px">Vul per ruimte de <b>ontwerptemperatuur</b> en het <b>warmteverlies</b> uit de
        warmteverliesberekening in, of upload de berekening (CSV, Excel of PDF). Een element hoort bij een ruimte als de
        ruimtenaam gelijk is. Met het vermogen van het element en de ontwerp-aanvoertemperatuur volgt de
        <b>ontwerpretour</b>: de retourtemperatuur waarbij het element precies het warmteverlies van zijn ruimte dekt.
        Een warme of krap bemeten ruimte krijgt zo een hogere retour (meer debiet) dan een koele of ruim bemeten ruimte.</p>
      ${set.loss_factor != null && Math.abs(set.loss_factor - 1) > 1e-6 ? `<div class="notice">Het warmteverlies wordt
        geschaald met <b>${fmt(set.loss_factor, 2)}</b> naar het werkelijke gasverbruik (tabblad Stooklijn). De kolom Warmteverlies
        toont de ingevoerde waarde; aandeel, ontwerpretour en debiet zijn geschaald.
        <button class="btn small" id="btn-reset-scale">Niet schalen</button></div>` : ""}
      ${A.need_supply ? `<div class="notice warn">Vul de ontwerp-aanvoertemperatuur in (hierboven) om de ontwerpretour te berekenen.</div>` : ""}
      ${total ? `<p class="small">Totaal warmteverlies <b>${fmt(total, 0)} W</b>${flowOf(false) ? ` · ontwerpdebiet radiatoren <b>${fmt(flowOf(false), 0)} l/h</b>` : ""}${flowOf(true) ? ` · vloerverwarming <b>${fmt(flowOf(true), 0)} l/h</b>` : ""}</p>` : ""}
      <table class="round rooms"><thead><tr>
        <th>Ruimte / element</th><th>Ontwerptemp. °C</th><th>Warmteverlies W</th><th>Vermogen W</th>
        <th>Ontwerpretour °C</th><th>ΔT K</th><th>Debiet l/h</th><th>Opmerking</th><th></th></tr></thead>
        <tbody id="rooms-body">${body.join("") || `<tr class="empty-row"><td colspan="9" class="muted">Nog geen ruimtes. Upload een
          warmteverliesberekening of voeg een ruimte toe.</td></tr>`}</tbody></table>
      ${loose.length ? `<h3>Elementen zonder ruimte</h3>
        <table class="round rooms"><tbody>${loose.map((e) => `<tr data-em="${e.id}">
          <td><a href="#" data-open="${e.id}">${esc(e.name)}</a> <span class="muted small">${esc(TYPES[e.type]?.label || "")}</span></td>
          <td><input name="room" placeholder="Ruimte" list="room-names" style="width:220px"></td></tr>`).join("")}</tbody></table>
        <datalist id="room-names">${roomNames().map((n) => `<option value="${esc(n)}">`).join("")}</datalist>` : ""}
    </div>`;

  const save = async () => {
    const rooms = [];
    for (const tr of $$("#rooms-body tr.room", view)) {
      const name = $("[name=name]", tr).value.trim();
      const temp = numOrNull($("[name=temp]", tr).value), loss_w = numOrNull($("[name=loss_w]", tr).value);
      for (const n of ["temp", "loss_w"]) {
        if ($(`[name=${n}]`, tr).value.trim() !== "" && numOrNull($(`[name=${n}]`, tr).value) === null) return toast("Ongeldig getal", true);
      }
      if (tr.hasAttribute("data-new") && temp === null && loss_w === null) continue;
      if (!name) return toast("Geef de ruimte een naam", true);
      rooms.push({ id: tr.dataset.room || undefined, name, temp, loss_w });
    }
    await mutate("PUT", "rooms", { rooms });
  };
  const bindRows = () => {
    $$("#rooms-body tr.room input", view).forEach((inp) => (inp.onchange = () => save().catch(() => {})));
    $$("[data-del-room]", view).forEach((b) => (b.onclick = () => {
      const tr = b.closest("tr");
      if (!confirm(`Ruimte '${$("[name=name]", tr).value}' uit de warmteverliesberekening verwijderen?`)) return;
      tr.remove();
      save().catch(() => {});
    }));
  };
  bindRows();
  $$("tr[data-em] input", view).forEach((inp) => (inp.onchange = async () => {
    const v = inp.name === "room" ? inp.value.trim() : numOrNull(inp.value);
    if (inp.name !== "room" && inp.value.trim() !== "" && v === null) return toast("Ongeldig getal", true);
    await mutate("PUT", `emitters/${inp.closest("tr").dataset.em}`, { [inp.name]: v }).catch(() => {});
  }));
  $$("[data-open]", view).forEach((a) => (a.onclick = (ev) => {
    ev.preventDefault();
    const e = emitter(a.dataset.open);
    S.mode = "plan"; S.fpId = e.floorplan_id || S.fpId; S.selectedId = e.id; S.pipeId = null;
    renderProject();
  }));
  $$(".round-actions input[name]", view).forEach((inp) => (inp.onchange = async () => {
    const v = numOrNull(inp.value);
    if (inp.value.trim() !== "" && v === null) return toast("Ongeldig getal", true);
    await mutate("PUT", "", { settings: { [inp.name]: v } }).catch(() => {});
  }));
  const reset = $("#btn-reset-scale", view);
  if (reset) reset.onclick = () => mutate("PUT", "", { settings: { loss_factor: null } }).catch(() => {});
  $("#btn-add-room").onclick = () => {
    $(".empty-row", view)?.remove();
    $("#rooms-body").insertAdjacentHTML("beforeend", roomRow({ name: "", temp: null, loss_w: null }, []));
    bindRows();
    $("#rooms-body tr.room:last-of-type [name=name]").focus();
  };
  $("#btn-hl-upload").onclick = () => $("#hl-file").click();
  $("#hl-file").onchange = (ev) => { if (ev.target.files[0]) importHeatloss(ev.target.files[0]); };
}

// Tekst uit een PDF als regels met tabs tussen de kolommen (de server herkent daarin de ruimtes).
async function pdfToText(file) {
  const pdf = await openPdf(file);
  const lines = [];
  for (let i = 1; i <= Math.min(pdf.numPages, 80); i++) {
    const page = await pdf.getPage(i);
    const items = (await page.getTextContent()).items.filter((it) => it.str && it.str.trim())
      .map((it) => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || 10 }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    let row = [];
    const flush = () => {
      if (!row.length) return;
      row.sort((a, b) => a.x - b.x);
      let line = row[0].s, end = row[0].x + row[0].w;
      for (const it of row.slice(1)) {
        const gap = it.x - end;
        line += (gap > Math.max(6, it.h * 0.9) ? "\t" : gap > it.h * 0.15 ? " " : "") + it.s;
        end = Math.max(end, it.x + it.w);
      }
      lines.push(line);
      row = [];
    };
    for (const it of items) {
      if (row.length && Math.abs(row[0].y - it.y) > Math.max(2, it.h * 0.4)) flush();
      row.push(it);
    }
    flush();
  }
  return lines.join("\n");
}

async function importHeatloss(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  let res;
  try {
    const fd = new FormData();
    if (isPdf) {
      const text = await pdfToText(file);
      if (!text.trim()) throw new Error("Deze PDF bevat geen tekst (gescande afbeelding?). Vul de ruimtes met de hand in of gebruik CSV/Excel.");
      fd.append("file", new Blob([text], { type: "text/plain" }), "pdf.txt");
      fd.append("kind", "pdf");
    } else fd.append("file", file, file.name);
    toast(`Inlezen: ${file.name}…`);
    res = await api("POST", `projects/${S.project.id}/heatloss/parse`, fd);
  } catch (e) { return toast(`${file.name}: ${e.message}`, true); }
  if (!res.rooms.length) {
    return toast("Geen ruimtes herkend. Gebruik een tabel met kolommen voor ruimte, temperatuur en warmteverlies (W), of vul de ruimtes met de hand in.", true);
  }
  const anyMatch = res.rooms.some((r) => r.match);
  const names = [...new Set([...res.app_rooms, ...(S.project.rooms || []).map((r) => r.name)])].sort((a, b) => a.localeCompare(b, "nl"));
  const body = await dialog("Warmteverliesberekening importeren", `
    <p class="muted small">${res.rooms.length} ruimte(n) herkend in <b>${esc(file.name)}</b>. Controleer de waarden en kies per regel
      bij welke ruimte in de app ze hoort. ${isPdf ? "Een PDF wordt op tekst doorzocht: haal het vinkje weg bij regels die geen ruimte zijn. " : ""}
      Twee regels op dezelfde ruimte worden opgeteld (bijv. woonkamer + open keuken).</p>
    <div style="overflow:auto;max-height:55vh"><table class="history imp"><thead><tr><th></th><th>In de berekening</th><th>°C</th><th>W</th><th>Ruimte in de app</th></tr></thead>
      <tbody>${res.rooms.map((r, i) => `<tr data-i="${i}">
        <td><input type="checkbox" name="use" ${r.match || !(isPdf && anyMatch) ? "checked" : ""}></td>
        <td>${esc(r.name)}</td>
        <td><input name="temp" inputmode="decimal" value="${r.temp ?? ""}"></td>
        <td><input name="loss_w" inputmode="decimal" value="${r.loss_w ?? ""}"></td>
        <td><select name="match"><option value="">nieuw: ${esc(r.name)}</option>
          ${names.map((n) => `<option value="${esc(n)}" ${n === r.match ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></td>
      </tr>`).join("")}</tbody></table></div>
    <p class="muted small">Bestaande ruimtes met dezelfde naam worden overschreven; de rest blijft staan.</p>`,
    { ok: "Importeren", wide: true });
  if (!body) return;
  const rooms = new Map((S.project.rooms || []).map((r) => [normRoom(r.name), { ...r }]));
  const fresh = new Set();
  let n = 0;
  for (const tr of $$("tr[data-i]", body)) {
    if (!$("[name=use]", tr).checked) continue;
    const src = res.rooms[Number(tr.dataset.i)];
    const name = $("[name=match]", tr).value || src.name, key = normRoom(name);
    const temp = numOrNull($("[name=temp]", tr).value), loss = numOrNull($("[name=loss_w]", tr).value);
    const cur = rooms.get(key);
    if (cur && fresh.has(key)) {
      cur.loss_w = (cur.loss_w || 0) + (loss || 0);
      cur.temp = cur.temp ?? temp;
    } else rooms.set(key, { id: cur?.id, name: cur?.name || name, temp, loss_w: loss });
    fresh.add(key);
    n++;
  }
  if (!n) return toast("Niets geselecteerd", true);
  await mutate("PUT", "rooms", { rooms: [...rooms.values()] });
  toast(`${n} regel(s) geïmporteerd`);
}

// ---- stooklijn ----------------------------------------------------------------
// Gasverbruik + graaddagen → warmteverliescoëfficiënt H → benodigde aanvoer per
// buitentemperatuur. De server rekent; hier alleen invoer, grafieken en tabellen.

const BASIS = {
  auto: "Automatisch",
  warmteverlies: "Warmteverliesberekening",
  gas: "Gasverbruik",
};
const BASIS_USED = {
  warmteverlies: "warmteverliesberekening (per ruimte)",
  gas_geschaald: "warmteverliesberekening, geschaald naar het werkelijke gasverbruik",
  gas: "gasverbruik, verdeeld over de elementen naar vermogen",
};

function renderHeating() {
  const p = S.project, H = S.heating, g = H.gas, set = p.settings, view = $("#view");
  const per = g.periods || [];
  const num = (v, d) => (v === null || v === undefined ? "" : String(Math.round(v * 10 ** d) / 10 ** d).replace(".", ","));
  const kv = [];
  if (g.ok) {
    kv.push(["Warmteverliescoëfficiënt H", `<b>${fmt(g.h_w_per_k, 0)} W/K</b>`]);
    kv.push([`Warmtebehoefte bij ${fmt(set.outdoor_design_temp, 0)} °C`, `<b>${fmt(g.p_design_w / 1000, 1)} kW</b>`]);
    if (H.rooms_loss_w) kv.push(["Warmteverliesberekening", `${fmt(H.rooms_loss_w / 1000, 1)} kW (× ${fmt(H.calc_vs_gas, 2)})`]);
    kv.push(["Gas per graaddag", `${fmt(g.m3_per_dd, 3)} m³`]);
    kv.push(["Verwarming", `${fmt(g.heating_m3_year, 0)} m³/jaar`]);
    kv.push(["Warm water en koken", `${fmt(g.dhw_m3_year, 0)} m³/jaar${g.method === "regressie" ? " (uit de fit)" : g.method === "warm_water" ? " (ingesteld)" : " (niet bekend)"}`]);
    if (g.r2 !== null && g.r2 !== undefined && g.method === "regressie") kv.push(["Fit (R²)", fmt(g.r2, 2)]);
  }
  const groups = H.groups.filter((x) => x.points);
  const stations = H.stations.map(([id, n]) => `<option value="${id}" ${id === set.knmi_station ? "selected" : ""}>${esc(n)} (${id})</option>`).join("");
  view.innerHTML = `
    <div class="table-wrap heating">
      <div class="round-actions">
        <button class="btn primary" id="btn-gas-paste">Gasverbruik plakken (Excel)</button>
        <button class="btn" id="btn-gas-add">+ Periode</button>
        <label class="inline">KNMI-station<select name="knmi_station">${stations}</select></label>
        <button class="btn" id="btn-knmi" ${per.length ? "" : "disabled"}>Graaddagen ophalen</button>
        ${H.knmi.fetched ? `<span class="muted small">opgehaald ${fmtDate(H.knmi.fetched)} (${esc(H.knmi.name || "")})</span>` : ""}
      </div>
      <p class="muted small" style="max-width:980px">Uit het gasverbruik over een of meer jaren en de graaddagen in dezelfde perioden volgt
        hoeveel warmte de woning echt nodig heeft per graad buitentemperatuur (H). Samen met de radiatoren en de
        ontwerptemperatuur per ruimte (tabblad Warmteverlies) volgt daaruit de <b>stooklijn</b>: de aanvoertemperatuur die bij
        elke buitentemperatuur nodig is. Neem bij voorkeur maandverbruik over minstens een jaar, inclusief de zomer (dan
        scheidt de app warm water en koken zelf van de verwarming), uit een periode zonder grote verbouwingen.</p>
      <div class="heat-grid">
        <section class="card-panel">
          <h3>Uitgangspunten</h3>
          <div class="grid2 settings-inline">
            <label>Ontwerp-buitentemperatuur (°C)<input name="outdoor_design_temp" inputmode="decimal" value="${num(set.outdoor_design_temp, 1)}"></label>
            <label title="Boven deze buitentemperatuur is geen verwarming nodig; ook de basis van de graaddagen">Stookgrens (°C)<input name="heating_limit_temp" inputmode="decimal" value="${num(set.heating_limit_temp, 1)}"></label>
            <label title="Bovenwaarde Gronings aardgas: 9,77 kWh/m³ (35,17 MJ/m³)">Verbrandingswaarde (kWh/m³)<input name="gas_kwh_per_m3" inputmode="decimal" value="${num(set.gas_kwh_per_m3, 2)}"></label>
            <label title="Rendement van de cv-ketel op bovenwaarde; HR-ketel ca. 90 %, oude VR-ketel 75–80 %">Rendement ketel (%)<input name="boiler_efficiency" inputmode="decimal" value="${num(set.boiler_efficiency * 100, 0)}"></label>
            <label title="Alleen nodig als de perioden geen zomer bevatten; anders volgt dit uit de fit">Warm water en koken (m³/jaar)<input name="dhw_gas_m3_year" inputmode="decimal" value="${num(set.dhw_gas_m3_year, 0)}" placeholder="uit de fit"></label>
            <label>Lasten per element uit<select name="curve_basis">${Object.entries(BASIS).map(([k, l]) =>
              `<option value="${k}" ${set.curve_basis === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          </div>
          <p class="muted small">Doel-ΔT bij ontwerp: radiatoren ${fmt(set.target_dt, 0)} K, vloerverwarming ${fmt(set.ufh_target_dt, 0)} K (⚙).</p>
          ${kv.length ? `<h3>Resultaat gasverbruik</h3><dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` : ""}
        </section>
        <section class="card-panel">
          <h3>Verbruik tegen graaddagen</h3>
          ${g.ok ? `<div class="chart" id="chart-gas"></div>
            <p class="muted small">Elke stip is een periode (gemiddeld per dag). De lijn is de fit: snijpunt = warm water en
              koken, helling = gas per graaddag. Stippen ver van de lijn wijzen op vakantie, een koude winter met open haard of
              een fout in de invoer.</p>`
            : `<p class="muted">Vul perioden met gasverbruik in en haal de graaddagen op.</p>`}
        </section>
      </div>
      ${H.notes.map((n) => `<div class="notice warn">${esc(n)}</div>`).join("")}
      <h3>Stooklijn</h3>
      ${!H.basis ? `<div class="notice">Voor de stooklijn is nodig: het vermogen van de elementen, en óf een warmteverliesberekening
          (tabblad Warmteverlies) óf het gasverbruik hierboven.</div>` : `<p class="small">Lasten uit de ${esc(BASIS_USED[H.basis] || H.basis)}${H.scale ? ` (factor ${fmt(H.scale, 2)})` : ""}.</p>`}
      ${groups.length ? `<div class="heat-grid">
        <section class="card-panel"><div class="chart" id="chart-curve"></div>
          <p class="muted small">Doorgetrokken: benodigde aanvoer bij ingeregelde debieten en open thermostaatkranen. Gestippeld:
            de rechte stooklijn door het ontwerppunt die nergens te laag is.</p></section>
        <section class="card-panel">${groups.map(curveCard).join("")}</section>
      </div>
      <details><summary class="small">Tabel per graad buitentemperatuur</summary>
        <table class="history"><thead><tr><th>Buiten °C</th>${groups.map((x) => `<th>${esc(x.label)} aanvoer</th><th>retour</th><th>last</th>`).join("")}</tr></thead>
        <tbody>${groups[0].points.map((pt, i) => `<tr><td>${fmt(pt.t_out, 0)}</td>${groups.map((x) => {
          const q = x.points[i];
          return `<td>${fmt(q.supply, 1)}</td><td>${fmt(q.return, 1)}</td><td>${fmt(q.load_w, 0)} W</td>`;
        }).join("")}</tr>`).join("")}</tbody></table></details>` : ""}
      ${H.groups.filter((x) => x.unreachable).map((x) => `<div class="notice warn">${esc(x.label)}: ${esc(x.unreachable.join(", "))}
        haalt de last zelfs bij ${fmt(110, 0)} °C aanvoer niet. Vergroot daar de afgifte; deze elementen tellen niet mee in de stooklijn.</div>`).join("")}
      <h3>Perioden</h3>
      <table class="round gas"><thead><tr><th>Van</th><th>Tot (niet t/m)</th><th>Gas m³</th><th>Graaddagen</th>
        <th>Dagen</th><th>m³/dag</th><th>Graaddagen/dag</th><th></th></tr></thead>
        <tbody id="gas-body">${per.map((r, i) => `<tr data-i="${i}">
          <td><input name="start" type="date" value="${r.start}"></td>
          <td><input name="end" type="date" value="${r.end}"></td>
          <td><input name="gas_m3" inputmode="decimal" value="${num(r.gas_m3, 2)}"></td>
          <td><input name="degree_days" inputmode="decimal" value="${r.dd_source === "handmatig" ? num(r.dd, 1) : ""}"
            placeholder="${r.dd_source === "knmi" ? num(r.dd, 1) : "ophalen"}" title="Leeg = berekend uit KNMI-temperaturen"></td>
          <td class="num">${r.days}</td><td class="num">${fmt(r.gas_per_day, 2)}</td>
          <td class="num">${r.dd_per_day !== null ? fmt(r.dd_per_day, 1) : "–"}</td>
          <td><button class="x" data-del-gas title="Periode verwijderen">✕</button></td></tr>`).join("")
          || `<tr><td colspan="8" class="muted">Nog geen perioden.</td></tr>`}</tbody></table>
    </div>`;

  if (g.ok) $("#chart-gas").appendChild(gasChart(g));
  if (groups.length) $("#chart-curve").appendChild(curveChart(groups));

  // instellingen: direct opslaan
  $$(".settings-inline input, .settings-inline select, .round-actions select", view).forEach((inp) => (inp.onchange = async () => {
    let v = inp.tagName === "SELECT" ? inp.value : numOrNull(inp.value);
    if (inp.tagName !== "SELECT" && inp.value.trim() !== "" && v === null) return toast("Ongeldig getal", true);
    if (inp.name === "boiler_efficiency" && v !== null) v = v / 100;
    if (inp.name === "knmi_station") v = Number(v);
    await mutate("PUT", "", { settings: { [inp.name]: v } }).catch(() => {});
  }));
  const collect = () => $$("#gas-body tr[data-i]", view).map((tr) => ({
    start: $("[name=start]", tr).value, end: $("[name=end]", tr).value,
    gas_m3: numOrNull($("[name=gas_m3]", tr).value) ?? 0,
    degree_days: numOrNull($("[name=degree_days]", tr).value),
  }));
  const save = (list) => mutate("PUT", "gas/periods", { periods: list }).catch(() => {});
  $$("#gas-body input", view).forEach((inp) => (inp.onchange = () => {
    if (inp.type !== "date" && inp.value.trim() !== "" && numOrNull(inp.value) === null) return toast("Ongeldig getal", true);
    save(collect());
  }));
  $$("[data-del-gas]", view).forEach((b) => (b.onclick = () => {
    const i = Number(b.closest("tr").dataset.i);
    save(collect().filter((_, j) => j !== i));
  }));
  $("#btn-gas-add").onclick = () => {
    const list = collect(), last = list[list.length - 1];
    const start = last ? last.end : new Date(new Date().getFullYear() - 1, 0, 2).toISOString().slice(0, 10);
    const d = new Date(start + "T12:00:00");
    d.setMonth(d.getMonth() + 1);
    save([...list, { start, end: d.toISOString().slice(0, 10), gas_m3: 0, degree_days: null }]);
  };
  $("#btn-gas-paste").onclick = pasteGas;
  $("#btn-knmi").onclick = async () => {
    toast("Graaddagen ophalen bij het KNMI…");
    await mutate("POST", "gas/knmi").then(() => toast("Graaddagen bijgewerkt")).catch(() => {});
  };
  $$("[data-use-design]", view).forEach((b) => (b.onclick = async () => {
    const settings = {};
    for (const x of groups) settings[x.key === "vloer" ? "ufh_design_supply_temp" : "design_supply_temp"] = x.line.end;
    settings.loss_factor = H.basis === "gas_geschaald" ? H.scale : null;
    await mutate("PUT", "", { settings });
    toast("Ontwerp-aanvoer ingesteld — zie het tabblad Warmteverlies");
  }));
}

function curveCard(x) {
  const L = x.line, set = S.project.settings;
  const crit = (x.critical || []).slice(0, 3);
  const cur = x.key === "vloer" ? set.ufh_design_supply_temp : set.design_supply_temp;
  return `<h3 style="margin-top:0">${esc(x.label)}</h3>
    <dl class="kv">
      <dt>Ontwerppunt</dt><dd><b>${fmt(x.design_supply, 1)} °C</b> aanvoer, retour ~${fmt(x.design_return, 1)} °C bij ${fmt(L.t_design, 0)} °C buiten</dd>
      <dt>Rechte stooklijn</dt><dd><b>${fmt(L.end, 1)} °C</b> bij ${fmt(L.t_design, 0)} °C → <b>${fmt(L.foot, 1)} °C</b> bij ${fmt(L.t_base, 0)} °C buiten
        <br><span class="muted">helling ${fmt(L.slope, 2)} K per K; bij 0 °C buiten ${fmt(L.at_0, 1)} °C</span></dd>
      <dt>Totaal debiet</dt><dd>${fmt(x.flow_total, 0)} l/h bij ontwerp</dd>
    </dl>
    ${crit.length ? `<p class="small" style="margin:8px 0 4px">Bepaald door:</p><ul class="crit small">${crit.map((c, i) => `<li>${esc(c.name)}${c.room ? ` <span class="muted">(${esc(c.room)}, ${fmt(c.theta, 0)} °C)</span>` : ""}:
      ${fmt(c.supply, 1)} °C nodig voor ${fmt(c.q, 0)} W${i === 0 && x.second_supply ? ` <span class="muted">— zonder dit element ${fmt(x.second_supply, 1)} °C</span>` : ""}</li>`).join("")}</ul>` : ""}
    <p><button class="btn small" data-use-design ${cur === L.end ? "disabled" : ""}>${cur === L.end ? `Ontwerp-aanvoer staat op ${fmt(L.end, 1)} °C` : `Gebruik ${fmt(L.end, 1)} °C als ontwerp-aanvoer`}</button></p>`;
}

async function pasteGas() {
  const body = await dialog("Gasverbruik plakken", `
    <p class="muted small">Kopieer kolommen uit Excel of een export van je energieleverancier / Home Assistant en plak ze hieronder.
      Herkend worden: <b>meterstanden</b> (datum + stand), <b>verbruik per maand</b> (maand + m³, eventueel graaddagen) en
      <b>perioden</b> (van + tot + m³, eventueel graaddagen).</p>
    <textarea name="text" style="min-height:200px;font-family:monospace" placeholder="1-1-2024&#9;10250&#10;1-2-2024&#9;10512&#10;…"></textarea>
    <label class="check"><input type="checkbox" name="replace" checked> Bestaande perioden vervangen</label>`, { ok: "Inlezen" });
  if (!body) return;
  try {
    const res = await api("POST", `projects/${S.project.id}/gas/parse`, { text: $("[name=text]", body).value });
    if (!res.periods.length) return toast("Geen perioden herkend", true);
    const keep = $("[name=replace]", body).checked ? [] : S.project.gas_periods;
    await mutate("PUT", "gas/periods", { periods: [...keep, ...res.periods] });
    toast(res.message);
  } catch (e) { toast(e.message, true); }
}

// ---- grafieken (SVG, geen bibliotheek) ----------------------------------------

function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const a = Math.floor(lo / step + 1e-9) * step, b = Math.ceil(hi / step - 1e-9) * step;
  const out = [];
  for (let v = a; v <= b + step * 1e-6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return { ticks: out, lo: a, hi: b };
}

// series: [{name, cls, pts: [[x, y]], dots?, dash?}]; hover: "x" (crosshair) of "nearest"
function chart({ series, xLabel, yLabel, hover = "x", fmtX = (v) => fmt(v, 0), fmtY = (v) => fmt(v, 1), unitY = "", yFrom }) {
  const W = 560, Hh = 300, m = { l: 48, r: 14, t: 12, b: 40 };
  const all = series.flatMap((s) => s.pts);
  const xs = niceTicks(Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0])));
  const ys = niceTicks(yFrom ?? Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1])));
  const X = (v) => m.l + (v - xs.lo) / (xs.hi - xs.lo || 1) * (W - m.l - m.r);
  const Y = (v) => Hh - m.b - (v - ys.lo) / (ys.hi - ys.lo || 1) * (Hh - m.t - m.b);
  const svgNS = "http://www.w3.org/2000/svg";
  const wrap = document.createElement("div");
  wrap.className = "chart-wrap";
  const legend = series.length > 1 ? `<div class="chart-legend">${series.map((s) =>
    `<span><i class="${s.cls}${s.dash ? " dash" : ""}${s.dots ? " dotmark" : ""}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
  wrap.innerHTML = `${legend}<svg viewBox="0 0 ${W} ${Hh}" class="chart-svg" role="img" aria-label="${esc(yLabel)} tegen ${esc(xLabel)}">
    ${ys.ticks.map((t) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}"/>
      <text class="tick" x="${m.l - 6}" y="${Y(t) + 4}" text-anchor="end">${esc(fmtY(t))}</text>`).join("")}
    ${xs.ticks.map((t) => `<text class="tick" x="${X(t)}" y="${Hh - m.b + 16}" text-anchor="middle">${esc(fmtX(t))}</text>`).join("")}
    <line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${Hh - m.b}" y2="${Hh - m.b}"/>
    <text class="tick" x="${(m.l + W - m.r) / 2}" y="${Hh - 6}" text-anchor="middle">${esc(xLabel)}</text>
    <text class="tick" x="12" y="${(m.t + Hh - m.b) / 2}" text-anchor="middle" transform="rotate(-90 12 ${(m.t + Hh - m.b) / 2})">${esc(yLabel)}</text>
    ${series.map((s) => s.dots
      ? s.pts.map((p) => `<circle class="dot ${s.cls}" cx="${X(p[0])}" cy="${Y(p[1])}" r="4.5"/>`).join("")
      : `<polyline class="ln ${s.cls}${s.dash ? " dash" : ""}" points="${s.pts.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}"/>`).join("")}
    <line class="cross" y1="${m.t}" y2="${Hh - m.b}" visibility="hidden"/>
    <rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${Hh - m.t - m.b}"/>
  </svg><div class="tip" hidden></div>`;
  const svg = $("svg", wrap), tip = $(".tip", wrap), cross = $(".cross", wrap);
  const show = (ev) => {
    const r = svg.getBoundingClientRect(), k = W / r.width;
    const px = (ev.clientX - r.left) * k, py = (ev.clientY - r.top) * k;
    tip.replaceChildren();
    const line = (txt, cls) => { const d = document.createElement("div"); if (cls) d.className = cls; d.textContent = txt; tip.appendChild(d); };
    let ax;
    if (hover === "nearest") {
      let best = null;
      for (const s of series) for (const p of s.pts) {
        if (!s.dots) continue;
        const d = Math.hypot(X(p[0]) - px, Y(p[1]) - py);
        if (!best || d < best.d) best = { d, p, s };
      }
      if (!best || best.d > 40) { tip.hidden = true; cross.setAttribute("visibility", "hidden"); return; }
      ax = X(best.p[0]);
      line(`${xLabel}: ${fmtX(best.p[0])}`, "muted");
      line(`${yLabel}: ${fmtY(best.p[1])}${unitY}`);
      if (best.p[2]) line(best.p[2], "muted");
    } else {
      const xsAll = series[0].pts.map((p) => p[0]);
      const x0 = xsAll.reduce((a, b) => (Math.abs(X(b) - px) < Math.abs(X(a) - px) ? b : a));
      ax = X(x0);
      line(`${xLabel}: ${fmtX(x0)}`, "muted");
      for (const s of series) {
        const p = s.pts.find((q) => Math.abs(q[0] - x0) < 1e-6);
        if (p) line(`${s.name}: ${fmtY(p[1])}${unitY}`);
      }
    }
    cross.setAttribute("x1", ax); cross.setAttribute("x2", ax); cross.setAttribute("visibility", "visible");
    tip.hidden = false;
    const left = ax / k;
    tip.style.left = Math.min(left + 12, r.width - tip.offsetWidth - 4) + "px";
    tip.style.top = Math.max(0, (py / k) - 20) + "px";
  };
  const hit = $(".hit", wrap);
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
  return wrap;
}

function gasChart(g) {
  const pts = g.periods.filter((r) => r.dd_per_day !== null)
    .map((r) => [r.dd_per_day, r.gas_per_day, `${fmtDay(r.start)} – ${fmtDay(r.end)}: ${fmt(r.gas_m3, 0)} m³`]);
  const xmax = Math.max(...pts.map((p) => p[0]), 1);
  return chart({
    series: [{ name: "Periode", cls: "s1", dots: true, pts },
      { name: "Fit", cls: "neutral", dash: true, pts: [[0, g.base_m3_day], [xmax, g.base_m3_day + g.m3_per_dd * xmax]] }],
    xLabel: "graaddagen per dag", yLabel: "m³ gas per dag", hover: "nearest",
    fmtX: (v) => fmt(v, 1), fmtY: (v) => fmt(v, 1), unitY: " m³", yFrom: 0,
  });
}
function fmtDay(iso) { return new Date(iso + "T12:00:00").toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric" }); }

function curveChart(groups) {
  const series = [];
  groups.forEach((x, i) => {
    const cls = i === 0 ? "s1" : "s2";
    series.push({ name: `${x.label} benodigd`, cls, pts: x.points.map((p) => [p.t_out, p.supply]) });
    series.push({ name: `${x.label} rechte lijn`, cls, dash: true,
      pts: x.points.map((p) => [p.t_out, x.line.end + (x.line.foot - x.line.end) * (p.t_out - x.line.t_design) / (x.line.t_base - x.line.t_design)]) });
  });
  return chart({ series, xLabel: "buitentemperatuur °C", yLabel: "aanvoer °C", unitY: " °C", yFrom: 15 });
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

async function openPdf(file) {
  if (!window.pdfjsLib) {
    toast("PDF-ondersteuning laden…");
    await loadScript(PDFJS + "pdf.min.js");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js";
  }
  // isEvalSupported: false sluit CVE-2024-4367 (code uitvoeren via een kwaadaardig PDF-font).
  return window.pdfjsLib.getDocument({
    data: await file.arrayBuffer(), isEvalSupported: false, enableXfa: false,
  }).promise;
}

async function pdfToImages(file) {
  const pdf = await openPdf(file);
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
      <label>Cv-temperatuur aanvoer (°C)<input name="supply_temp" inputmode="decimal" value="${s.supply_temp ?? ""}" placeholder="leeg = per element meten"></label>
      <label>Cv-temperatuur vloerverwarming (°C)<input name="ufh_supply_temp" inputmode="decimal" value="${s.ufh_supply_temp ?? ""}" placeholder="leeg = zelfde als cv"></label>
      <p class="muted small" id="supply-hint" style="grid-column:1/-1;margin:0"></p>
      <label title="Aanvoertemperatuur waarop de warmteverliesberekening is gebaseerd (bij de ontwerp-buitentemperatuur)">Ontwerp-aanvoer radiatoren (°C)<input name="design_supply_temp" inputmode="decimal" value="${s.design_supply_temp ?? ""}" placeholder="leeg = cv-temperatuur"></label>
      <label>Ontwerp-aanvoer vloerverwarming (°C)<input name="ufh_design_supply_temp" inputmode="decimal" value="${s.ufh_design_supply_temp ?? ""}" placeholder="leeg = cv-temp. vloerverwarming"></label>
      <label>Ruimtetemperatuur standaard (°C)<input name="room_temp" inputmode="decimal" value="${s.room_temp}"></label>
      <label>Tolerantie "goed" (± % debiet)<input name="tolerance_pct" inputmode="decimal" value="${s.tolerance_pct}"></label>
    </div>
    <label>Methode<select name="method">
      <option value="auto" ${s.method === "auto" ? "selected" : ""}>Automatisch: warmteverliesberekening als die compleet is, anders warmtevraag per element, anders gelijk ΔT</option>
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
      const hint = () => {
        const v = (n) => numOrNull($(`[name=${n}]`, b).value);
        const sup = v("supply_temp"), ufh = v("ufh_supply_temp") ?? sup;
        const parts = [];
        if (sup !== null && v("target_dt") !== null) parts.push(`radiatoren ${fmt(sup - v("target_dt"), 1)} °C`);
        if (ufh !== null && v("ufh_target_dt") !== null) parts.push(`vloerverwarming ${fmt(ufh - v("ufh_target_dt"), 1)} °C`);
        $("#supply-hint", b).textContent = parts.length
          ? `Beoogde retour (cv-temperatuur − doel-ΔT): ${parts.join(", ")}. Metingen zonder aanvoer gebruiken de cv-temperatuur.`
          : "Vul de cv-temperatuur in om alleen de retour per element te hoeven meten; ΔT = cv-temperatuur − retour.";
      };
      ["supply_temp", "ufh_supply_temp", "target_dt", "ufh_target_dt"].forEach((n) => $(`[name=${n}]`, b).addEventListener("input", hint));
      hint();
      $("[name=heat_source]", b).onchange = (ev) => {
        const dt = { ketel: 20, warmtepomp: 5 }[ev.target.value];
        if (dt) $("[name=target_dt]", b).value = dt;
        hint();
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
        supply_temp: numOrNull(val("supply_temp")), ufh_supply_temp: numOrNull(val("ufh_supply_temp")),
        design_supply_temp: numOrNull(val("design_supply_temp")),
        ufh_design_supply_temp: numOrNull(val("ufh_design_supply_temp")),
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

// ---- hydraulisch schema ---------------------------------------------------
// De boom (verdiepingen → leidingtakken → elementen) komt van de server; hier wordt
// hij als tweepijps-schema getekend: aanvoer rood boven, retour blauw eronder.

const COMP = {
  pomp: { label: "Secundaire pomp", attach: ["main", "fp", "ufh"] },
  mengklep: { label: "Mengklep", attach: ["main", "fp", "ufh"] },
  buffervat: { label: "Buffervat", attach: ["source"] },
  boilervat: { label: "Boilervat", attach: ["source"] },
  thermostaat: { label: "Thermostaat", attach: ["source", "fp", "ufh"] },
};
const SOURCE_LABEL = { ketel: "Cv-ketel", warmtepomp: "Warmtepomp", anders: "Warmtebron" };
const SC = { G: 14, COL: 78, EM_TOP: 36, EM_H: 26, ROW: 150, Y0: 140 };
const ST_COLOR = { ok: "#2f9e44", open: "#e8590c", dicht: "#1971c2", ongeldig: "#868e96", geen_meting: "#adb5bd" };

function attachOptions(type) {
  const p = S.project, out = [];
  for (const a of COMP[type].attach) {
    if (a === "source") out.push(["source", `${SOURCE_LABEL[p.settings.heat_source] || "Warmtebron"}`]);
    if (a === "main") out.push(["main", "Hoofdleiding (na de warmtebron)"]);
    if (a === "fp") p.floorplans.forEach((f) => out.push([`fp:${f.id}`, `Verdieping: ${f.name}`]));
    if (a === "ufh") p.floorplans.filter((f) => p.emitters.some((e) => e.floorplan_id === f.id && e.type === "vloerverwarming"))
      .forEach((f) => out.push([`ufh:${f.id}`, `Verdeler vloerverwarming: ${f.name}`]));
  }
  return out;
}
function attachLabel(c) {
  return (attachOptions(c.type).find(([k]) => k === c.attach) || [, "–"])[1];
}

function compsAt(attach, ...types) {
  return (S.project.components || []).filter((c) => (c.attach || "main") === attach && (!types.length || types.includes(c.type)));
}

const shortName = (s, n = 11) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const line = (x1, y1, x2, y2, cls) => `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
const dot = (x, y, cls) => `<circle class="dot ${cls}" cx="${x}" cy="${y}" r="2.6"/>`;

function pumpSym(c, x, y) {
  return `<g class="comp" data-comp="${c.id}"><title>${esc(c.name)}</title>
    <circle cx="${x}" cy="${y}" r="10" class="sym"/><path d="M${x - 4},${y + 6} L${x + 7},${y} L${x - 4},${y - 6} Z" class="symfill"/></g>`;
}
function mixSym(c, x, y, vertical) {
  const d = vertical ? `M${x - 8},${y - 8} L${x + 8},${y - 8} L${x - 8},${y + 8} L${x + 8},${y + 8} Z`
    : `M${x - 8},${y - 8} L${x - 8},${y + 8} L${x + 8},${y - 8} L${x + 8},${y + 8} Z`;
  return `<g class="comp" data-comp="${c.id}"><title>${esc(c.name)}</title>
    <path d="${d}" class="sym"/><path d="M${x},${y} L${x - 9},${y}" class="sym"/><text x="${x - 12}" y="${y + 3}" class="t9" text-anchor="end">M</text></g>`;
}
function thermoSym(c, x, y) {
  return `<g class="comp" data-comp="${c.id}"><title>${esc(c.name)}</title>
    <rect x="${x - 11}" y="${y - 11}" width="22" height="22" rx="4" class="sym"/>
    <text x="${x}" y="${y + 4}" class="t11 b" text-anchor="middle">T</text>
    <text x="${x}" y="${y - 15}" class="t9" text-anchor="middle">${esc(shortName(c.name, 16))}</text></g>`;
}

function emitterSym(id, x, y, out) {
  const e = emitter(id);
  if (!e) return;
  const r = result(id), st = r.status || "geen_meting";
  const cx = x + SC.COL / 2, top = y + SC.EM_TOP, w = 44, h = SC.EM_H, l = cx - w / 2;
  out.rows.push(line(cx - 10, y, cx - 10, top, "sup"), line(cx + 10, top, cx + 10, y + SC.G, "ret"));
  out.over.push(line(cx - 10, y + SC.G - 4, cx - 10, y + SC.G + 4, "gap"), line(cx - 10, y, cx - 10, top, "sup"),
    dot(cx - 10, y, "sup"), dot(cx + 10, y + SC.G, "ret"));
  let inner = "";
  if (e.type === "vloerverwarming") {
    inner = `<polyline class="coil" points="${[0, 1, 2, 3, 4, 5, 6].map((i) => `${l + 5 + i * 5.6},${i % 2 ? top + h - 5 : top + 5}`).join(" ")}"/>`;
  } else if (e.type === "convector") {
    inner = `<line class="coil" x1="${l + 4}" y1="${top + h - 4}" x2="${l + w - 4}" y2="${top + 4}"/>`;
  } else {
    inner = [1, 2, 3, 4, 5].map((i) => line(l + i * w / 6, top + 4, l + i * w / 6, top + h - 4, "coil")).join("");
  }
  const adv = r.stale ? "meten" : (st === "open" || st === "dicht") && r.preset_advice_label
    ? `${r.preset_basis_label} → ${r.preset_advice_label}` : r.dt !== undefined && st !== "ongeldig" ? `ΔT ${fmt(r.dt, 1)}` : "";
  out.over.push(`<g class="em" data-em="${id}"><title>${esc(e.name)}${e.room ? " · " + esc(e.room) : ""}: ${esc(r.advice || "")}</title>
    <rect x="${l}" y="${top}" width="${w}" height="${h}" rx="3" class="body" style="stroke:${ST_COLOR[st]}"/>${inner}
    <text x="${cx}" y="${top + h + 13}" class="t10 b" text-anchor="middle">${esc(shortName(e.name))}</text>
    ${e.room ? `<text x="${cx}" y="${top + h + 25}" class="t9 m" text-anchor="middle">${esc(shortName(e.room, 13))}</text>` : ""}
    ${adv ? `<text x="${cx}" y="${top + h + (e.room ? 37 : 25)}" class="t9 b" text-anchor="middle" style="fill:${ST_COLOR[st]}">${esc(adv)}</text>` : ""}
  </g>`);
  out.maxY = Math.max(out.maxY, top + h + 40);
}

function layChildren(children, x0, y, out) {
  let x = x0;
  for (const c of children) {
    if (c.kind === "emitter") { emitterSym(c.id, x, y, out); x += SC.COL; }
    else x += layBranch(c, x, y, out) + 8;
  }
  return Math.max(x - x0, SC.COL);
}

function layBranch(node, x, y, out) {
  const { G, ROW } = SC;
  const y2 = y + ROW, sx = x + 8, rx = sx + G, start = rx + 14;
  const attach = node.kind === "floor" ? `fp:${node.id}` : node.kind === "verdeler" ? node.id : null;
  const w = layChildren(node.children, start, y2, out);
  const end = start + w - 12;
  const bar = node.kind === "verdeler" ? " manifold" : "";
  out.rows.push(line(sx, y2, end, y2, "sup" + bar), line(rx, y2 + G, end, y2 + G, "ret" + bar),
    line(rx, y + G, rx, y2 + G, "ret"));
  out.over.push(line(sx, y + G - 4, sx, y + G + 4, "gap"), line(sx, y, sx, y2, "sup"), dot(sx, y, "sup"), dot(rx, y + G, "ret"));
  const label = node.kind === "floor" ? node.label : node.kind === "verdeler" ? "Verdeler vloerverwarming" : node.label;
  if (label) {
    out.over.push(`<text x="${start}" y="${y2 - 12}" class="${node.kind === "floor" ? "t13 b" : "t10 m"}">${esc(label)}</text>`);
  }
  if (attach) {
    let cy = y + G + 30, pumpY = null;
    for (const c of compsAt(attach, "pomp", "mengklep")) {
      out.over.push(c.type === "pomp" ? pumpSym(c, sx, cy) : mixSym(c, sx, cy, true));
      if (c.type === "pomp" && pumpY === null) pumpY = cy;
      cy += 30;
    }
    compsAt(attach, "thermostaat").forEach((c, i) => {
      const tx = start + 30 + i * 70, ty = y2 - 50;
      out.over.push(`<path class="ctrl" d="M${tx - 11},${ty} L${sx + 12},${ty} L${sx + 12},${pumpY ?? ty}"/>`, thermoSym(c, tx, ty));
    });
  }
  return end - x + 12;
}

function buildSchemaSvg() {
  const sch = S.schema, p = S.project, { G, Y0 } = SC;
  const out = { rows: [], over: [], maxY: Y0 + 80 };
  const boilers = compsAt("source", "boilervat");
  const srcW = Math.max(90, boilers.length * 80 - 10), sx0 = 30, sx1 = sx0 + srcW;
  const src = sch.source;
  const supply = cvLabel(p.settings);
  out.over.push(`<g class="src"><rect x="${sx0}" y="${Y0 - 30}" width="${srcW}" height="${G + 60}" rx="6" class="body src"/>
    <text x="${sx0 + srcW / 2}" y="${Y0 + G / 2 - 2}" class="t12 b" text-anchor="middle">${esc(SOURCE_LABEL[src] || "Warmtebron")}</text>
    ${supply ? `<text x="${sx0 + srcW / 2}" y="${Y0 + G / 2 + 12}" class="t10 m" text-anchor="middle">${esc(supply)}</text>` : ""}</g>`);
  // thermostaten op de warmtebron
  compsAt("source", "thermostaat").concat(compsAt("main", "thermostaat")).forEach((c, i) => {
    const tx = sx0 + 20 + i * 60, ty = Y0 - 70;
    out.over.push(`<path class="ctrl" d="M${tx},${ty + 11} L${tx},${Y0 - 30}"/>`, thermoSym(c, tx, ty));
  });
  // boilervaten onder de warmtebron, via een driewegklep
  boilers.forEach((c, i) => {
    const bx = sx0 + i * 80, by = Y0 + G + 75, top = Y0 + G + 30;
    out.over.push(line(bx + 22, top, bx + 22, by, "sup"), line(bx + 48, by, bx + 48, top, "ret"),
      `<g class="comp" data-comp="${c.id}"><title>${esc(c.name)}</title>
        <path d="M${bx + 14},${by - 28} L${bx + 30},${by - 28} L${bx + 22},${by - 16} Z M${bx + 14},${by - 4} L${bx + 30},${by - 4} L${bx + 22},${by - 16} Z" class="sym"/>
        <rect x="${bx + 5}" y="${by}" width="60" height="78" rx="22" class="body"/>
        <polyline class="coil" points="${[0, 1, 2, 3, 4, 5].map((k) => `${k % 2 ? bx + 48 : bx + 22},${by + 18 + k * 9}`).join(" ")}"/>
        <text x="${bx + 35}" y="${by + 94}" class="t10 b" text-anchor="middle">${esc(shortName(c.name, 14))}</text></g>`);
    out.maxY = Math.max(out.maxY, by + 100);
  });
  // in de hoofdleiding: buffervat(en), dan pompen/mengklep op de hoofdleiding
  let x = sx1 + 20;
  for (const c of compsAt("source", "buffervat")) {
    out.rows.push(line(x - 20, Y0, x, Y0, "sup"), line(x - 20, Y0 + G, x, Y0 + G, "ret"));
    out.over.push(`<g class="comp" data-comp="${c.id}"><title>${esc(c.name)}</title>
      <rect x="${x}" y="${Y0 - 40}" width="44" height="${G + 80}" rx="14" class="body"/>
      <text x="${x + 22}" y="${Y0 + G + 56}" class="t10 b" text-anchor="middle">${esc(shortName(c.name, 14))}</text></g>`);
    x += 64;
  }
  const mainStart = x - 20;
  for (const c of compsAt("main", "pomp", "mengklep")) {
    out.over.push(c.type === "pomp" ? pumpSym(c, x + 4, Y0) : mixSym(c, x + 4, Y0, false));
    x += 34;
  }
  const w = sch.floors.length ? layChildren(sch.floors, x, Y0, out) : 0;
  const end = Math.max(x + w - 12, x + 40);
  out.rows.unshift(line(mainStart, Y0, end, Y0, "sup"), line(mainStart, Y0 + G, end, Y0 + G, "ret"));
  const W = end + 40, H = out.maxY + 30;
  return { W, H, svg: `<svg xmlns="http://www.w3.org/2000/svg" class="schema-svg" id="schema-svg" viewBox="0 0 ${W} ${H}"
      width="${W * S.schemaZoom}" height="${H * S.schemaZoom}" font-family="system-ui, sans-serif">
    <style>${SCHEMA_CSS}</style>
    <rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>
    <text x="16" y="24" class="t14 b">${esc(p.name)} — hydraulisch schema</text>
    <g>${out.rows.join("")}</g><g>${out.over.join("")}</g></svg>` };
}

function cvLabel(set) {
  return set.supply_temp !== null && set.supply_temp !== undefined ? `aanvoer ${fmt(set.supply_temp, 0)} °C` : "";
}

const SCHEMA_CSS = `
  line, polyline, path { fill: none; stroke-linecap: round; }
  .sup { stroke: #e03131; stroke-width: 2.5; } .ret { stroke: #1c7ed6; stroke-width: 2.5; }
  .manifold { stroke-width: 5; } .gap { stroke: #fff; stroke-width: 7; }
  .dot.sup { fill: #e03131; stroke: none; } .dot.ret { fill: #1c7ed6; stroke: none; }
  .body { fill: #f8f9fa; stroke: #495057; stroke-width: 2; } .src { fill: #fff4e6; stroke: #e8590c; }
  .coil { stroke: #868e96; stroke-width: 1.4; }
  .sym { fill: #fff; stroke: #212529; stroke-width: 1.8; } .symfill { fill: #212529; }
  .ctrl { stroke: #7048e8; stroke-width: 1.4; stroke-dasharray: 4 3; }
  text { fill: #212529; } .m { fill: #6c757d; } .b { font-weight: 600; }
  .t9 { font-size: 9px; } .t10 { font-size: 10px; } .t11 { font-size: 11px; } .t12 { font-size: 12px; }
  .t13 { font-size: 13px; } .t14 { font-size: 14px; }
  .em, .comp { cursor: pointer; } .em:hover .body, .comp:hover .sym, .comp:hover .body { stroke-width: 3; }`;

function renderSchema() {
  const view = $("#view"), sch = S.schema;
  const built = buildSchemaSvg();
  const comps = S.project.components || [];
  view.innerHTML = `
    <div class="workspace">
      <div class="plan-area">
        <div class="toolbar">
          ${Object.entries(COMP).map(([k, c]) => `<button class="btn small" data-add-comp="${k}">+ ${c.label}</button>`).join("")}
          <span class="spacer"></span>
          <button class="icon-btn" data-szoom="-1" title="Uitzoomen">−</button>
          <button class="icon-btn" data-szoom="0" title="Passend">⤢</button>
          <button class="icon-btn" data-szoom="1" title="Inzoomen">+</button>
          <button class="btn small" id="btn-svg" title="Schema downloaden als SVG">SVG</button>
        </div>
        <div class="plan-scroll" id="schema-scroll"><div class="schema-wrap">${built.svg}</div></div>
      </div>
      <aside class="side">
        <h3 style="margin-top:0">Hydraulisch schema</h3>
        <p class="muted small">Opgebouwd uit de plattegronden: elke plattegrond is een verdieping,
          de elementen staan in de volgorde van het ingetekende leidingverloop (✎ Leiding op de
          plattegrond). Vloerverwarmingsgroepen komen samen op een verdeler. Klik op een element om
          het op de plattegrond te openen.</p>
        <div class="legend small">
          <span><i style="background:#e03131"></i>aanvoer</span><span><i style="background:#1c7ed6"></i>retour</span>
          <span><i class="dash"></i>regeling</span>
        </div>
        ${sch.notes.map((n) => `<div class="notice warn">${esc(n)}</div>`).join("")}
        ${!sch.floors.length ? `<div class="notice">Nog geen elementen: plaats eerst radiatoren of vloerverwarming op een plattegrond.</div>` : ""}
        <h3>Componenten</h3>
        ${comps.length ? `<ul class="list">${comps.map((c) => `<li data-comp="${c.id}"><div class="grow">
            <div><b>${esc(c.name)}</b> <span class="muted">${esc(COMP[c.type]?.label || c.type)}</span></div>
            <div class="muted small">${esc(attachLabel(c))}</div></div></li>`).join("")}</ul>`
          : `<p class="muted small">Voeg met de knoppen boven het schema een secundaire pomp, boilervat,
              buffervat, thermostaat of mengklep toe.</p>`}
      </aside>
    </div>`;
  $$("[data-add-comp]", view).forEach((b) => (b.onclick = () => editComponent(null, b.dataset.addComp)));
  $$("[data-comp]", view).forEach((el) => (el.onclick = () => editComponent(el.dataset.comp)));
  $$("[data-em]", view).forEach((el) => (el.onclick = () => {
    const e = emitter(el.dataset.em);
    S.mode = "plan"; S.fpId = e.floorplan_id || S.fpId; S.selectedId = e.id; S.pipeId = null;
    renderProject();
  }));
  $$("[data-szoom]", view).forEach((b) => (b.onclick = () => {
    const z = Number(b.dataset.szoom), sc = $("#schema-scroll");
    S.schemaZoom = z === 0 ? Math.min(2, (sc.clientWidth - 32) / built.W)
      : Math.min(4, Math.max(0.2, S.schemaZoom * (z > 0 ? 1.3 : 1 / 1.3)));
    renderSchema();
  }));
  $("#btn-svg").onclick = () => {
    const blob = new Blob([buildSchemaSvg().svg], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${S.project.name.replace(/[^\w\- ]+/g, "").trim() || "schema"} - schema.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
}

async function editComponent(cid, newType) {
  const c = cid ? S.project.components.find((x) => x.id === cid) : { type: newType, name: "", attach: null, notes: "" };
  const opts = attachOptions(c.type);
  const attach = c.attach || (COMP[c.type].attach.includes("source") ? "source" : "main");
  const body = await dialog(cid ? c.name : `${COMP[c.type].label} toevoegen`, `
    <label>Naam<input name="name" value="${esc(c.name)}" placeholder="${esc(COMP[c.type].label)}"></label>
    ${opts.length > 1 ? `<label>${c.type === "thermostaat" ? "Regelt" : "Plaats in het schema"}<select name="attach">
      ${opts.map(([k, l]) => `<option value="${esc(k)}" ${k === attach ? "selected" : ""}>${esc(l)}</option>`).join("")}
    </select></label>` : `<p class="muted small">Wordt bij de warmtebron getekend.</p>`}
    <label>Notities<textarea name="notes" placeholder="bijv. merk/type, instelling">${esc(c.notes || "")}</textarea></label>
    ${cid ? `<p><button type="button" class="btn danger" id="btn-del-comp">Verwijderen</button></p>` : ""}`, {
    ok: cid ? "Opslaan" : "Toevoegen",
    onOpen: (b) => {
      const del = $("#btn-del-comp", b);
      if (del) del.onclick = async () => {
        if (!confirm(`'${c.name}' verwijderen?`)) return;
        $("#dlg").close("cancel");
        await mutate("DELETE", `components/${cid}`);
      };
    },
  });
  if (!body) return;
  const data = { name: $("[name=name]", body).value || undefined, notes: $("[name=notes]", body).value,
    attach: $("[name=attach]", body)?.value || attach };
  if (cid) await mutate("PUT", `components/${cid}`, data);
  else await mutate("POST", "components", { type: c.type, ...data });
}

// ---- start ----------------------------------------------------------------

$("#btn-back").onclick = () => (location.hash = "#/");
route();
