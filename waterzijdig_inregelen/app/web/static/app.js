/* Waterzijdig Inregelen — ingress-UI (vanilla JS, geen build-stap).
 * Alle URL's zijn relatief zodat de app onder /api/hassio_ingress/<token>/ werkt. */
"use strict";

const S = {
  projects: [], project: null, analysis: null,
  fpId: null, selectedId: null, mode: "plan", zoom: 1, compact: false,
  pipeId: null, draw: null, schema: null, schemaZoom: 1,
};
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";

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

// Ingestelde cv-aanvoertemperatuur voor dit element (null = per meting invullen).
const cvSupply = (em) => {
  const set = S.project.settings;
  const ufh = em.type === "vloerverwarming" ? set.ufh_supply_temp : null;
  return ufh ?? set.supply_temp ?? null;
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

function result(id) { return S.analysis?.emitters.find((r) => r.id === id) || {}; }
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
    <button class="btn ${S.mode === "schema" ? "primary" : ""}" data-mode="schema">Schema</button>
    <a class="btn" href="api/projects/${p.id}/export.csv" download>CSV</a>
    <button class="icon-btn" id="btn-settings" title="Projectinstellingen">⚙</button>`;
  $$("[data-mode]").forEach((b) => (b.onclick = () => { S.mode = b.dataset.mode; S.draw = null; renderProject(); }));
  $("#btn-settings").onclick = editSettings;
  if (S.mode === "table") renderTable();
  else if (S.mode === "schema") renderSchema();
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
  const cv = cvSupply(em);
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
        ${r.target_t_out !== undefined ? `<dt>Doelretour</dt><dd>${fmt(r.target_t_out, 1)} °C</dd>` : ""}
        <dt>Gemeten op</dt><dd>${fmtDate(r.measured_at)}</dd>
      </dl>` : ""}
      ${r.warnings?.length ? `<ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      ${canApply ? `<button class="btn primary" id="btn-apply" style="margin-top:10px">Stand ${esc(r.preset_advice_label)} ingesteld</button>` : ""}
    </div>

    <h3>Nieuwe meting</h3>
    <form id="meas" class="grid3" autocomplete="off">
      <label>Aanvoer °C<input name="t_in" inputmode="decimal" ${cv === null ? "required" : `placeholder="cv ${fmt(cv, 1)}" title="Leeg = cv-aanvoertemperatuur uit de projectinstellingen"`}></label>
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
      <tbody>${ms.map((m) => { const tin = m.t_in ?? cv; return `<tr><td>${fmtDate(m.ts)}</td>
        <td>${m.t_in === null || m.t_in === undefined ? `<span class="muted" title="cv-aanvoertemperatuur">${fmt(cv, 1)}</span>` : fmt(m.t_in, 1)}</td><td>${fmt(m.t_out, 1)}</td>
        <td>${tin === null ? "–" : fmt(tin - m.t_out, 1)}</td><td>${m.t_room === null || m.t_room === undefined ? "–" : fmt(m.t_room, 1)}</td>
        <td>${esc(presetLabel(valve, m.preset))}</td>
        <td><button class="x" data-del-m="${m.id}" title="Meting verwijderen">✕</button></td></tr>`; }).join("")}</tbody></table>`
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
    if (t_out === null || (t_in === null && cvSupply(em) === null)) {
      return toast(cvSupply(em) === null ? "Vul aanvoer en retour in" : "Vul de retour in", true);
    }
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
        <td><input name="t_in" inputmode="decimal" placeholder="${cvSupply(e) !== null ? "cv " + fmt(cvSupply(e), 1) : r.t_in ?? ""}"></td>
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
          grijze waarden zijn de laatste meting. Met een ingestelde cv-aanvoertemperatuur (⚙)
          mag de aanvoer leeg blijven.</span>
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
      const em = emitter(tr.dataset.id);
      if (t_out === null || (t_in === null && cvSupply(em) === null)) {
        toast(cvSupply(em) === null ? `Vul bij ${em.name} zowel aanvoer als retour in`
          : `Vul bij ${em.name} de retour in`, true);
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
    s.onerror = () => reject(new Error("PDF-ondersteuning kon niet geladen worden (geen internet?). Exporteer de PDF als PNG/JPG."));
    document.head.appendChild(s);
  });
}

async function pdfToImages(file) {
  if (!window.pdfjsLib) {
    toast("PDF-ondersteuning laden…");
    await loadScript(PDFJS + "pdf.min.js");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js";
  }
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
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
      <label title="Aanvoertemperatuur van de cv; metingen zonder aanvoer rekenen hiermee (ΔT = cv-aanvoer − retour)">Cv-aanvoertemperatuur (°C)
        <input name="supply_temp" inputmode="decimal" value="${s.supply_temp ?? ""}" placeholder="leeg = per meting"></label>
      <label title="Alleen nodig als de vloerverwarming een eigen (gemengde) aanvoer heeft">Aanvoer vloerverwarming (°C)
        <input name="ufh_supply_temp" inputmode="decimal" value="${s.ufh_supply_temp ?? ""}" placeholder="leeg = cv-aanvoer"></label>
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
        room_temp: numOrNull(val("room_temp")),
        supply_temp: numOrNull(val("supply_temp")), ufh_supply_temp: numOrNull(val("ufh_supply_temp")),
        tolerance_pct: numOrNull(val("tolerance_pct")),
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
