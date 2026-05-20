/* continuity. — front end. Vanilla JS, no build step. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const S = {
  state: null,          // /api/state payload
  live: null,           // {id, number, title, date}
  mode: "auto",
  paused: false,
  wrapRequested: false,
  memory: {},           // current memory snapshot
  memoryBase: {},       // snapshot at start of live/selected session
  touched: {},          // path -> "recall" | "write"
  selected: null,       // selected past session number
  weekSource: "arc",
};

/* ------------------------------------------------------------ API helpers */
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}

async function stream(path, body, onEvent) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (r.status === 404) throw new Error("This session was replaced: a new session was started in another window.");
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!chunk.startsWith("data: ")) continue;
      const ev = JSON.parse(chunk.slice(6));
      if (ev.type === "error") throw new Error(ev.message);
      onEvent(ev);
    }
  }
}

/* ------------------------------------------------------------ boot */
async function refresh() {
  S.state = await api("/api/state");
  S.memory = S.state.memory;
  $("#modelName").textContent = S.state.model;
  renderTimeline();
  renderPresets();
  renderStartButton();
  if (!S.live) {
    const last = S.state.sessions.at(-1);
    S.memoryBase = last ? diffBaseFor(last.number) : {};
  }
  renderMemory();
  renderPicture();
}

function diffBaseFor(n) {
  const prev = S.state.sessions.find((s) => s.number === n - 1);
  return prev ? prev.memory_after : {};
}

/* ------------------------------------------------------------ timeline & presets */
function renderTimeline() {
  const el = $("#timeline");
  const parts = [];
  S.state.sessions.forEach((s, i) => {
    if (i) parts.push('<span class="tl-sep"></span>');
    parts.push(`<button class="tl-dot done ${S.selected === s.number ? "selected" : ""}" data-n="${s.number}" title="Session ${s.number}: ${esc(s.title)}">${s.number}</button>`);
  });
  const n = S.state.next_number;
  if (parts.length) parts.push('<span class="tl-sep"></span>');
  parts.push(`<button class="tl-dot ${S.live ? "live" : ""}" data-n="new" title="Next session">${n}</button>`);
  el.innerHTML = parts.join("");
  $$(".tl-dot", el).forEach((b) => b.onclick = () => {
    if (S.live) return;
    if (b.dataset.n === "new") { S.selected = null; showView("room"); resetChat(); }
    else openPastSession(+b.dataset.n);
  });
}

function renderPresets() {
  const used = new Set(S.state.sessions.map((s) => s.title));
  const n = S.state.next_number;
  $("#presets").innerHTML = S.state.arc.map((w, i) =>
    `<button class="preset ${used.has(w.title) ? "used" : ""}" data-i="${i}" title="${esc(w.text)}">${i + 1} · ${esc(w.title)}</button>`).join("");
  $$(".preset").forEach((b) => b.onclick = () => setWeek(S.state.arc[+b.dataset.i], "arc"));
  $("#weekHeading").textContent = `Jonas's week before session ${n}`;
  if (!$("#weekText").value.trim()) setWeek(S.state.suggested_week, S.state.suggested_week.source);
}

function setWeek(w, source) {
  $("#weekTitle").value = w.title || "";
  $("#weekText").value = w.text || "";
  S.weekSource = source;
  $$(".preset").forEach((b) => b.classList.toggle("active", S.state.arc[+b.dataset.i].title === w.title));
}

function renderStartButton() {
  const b = $("#startBtn");
  b.textContent = S.live ? `Session ${S.live.number} in progress…` : `Begin session ${S.state.next_number}`;
  b.disabled = !!S.live;
}

/* ------------------------------------------------------------ status & chat primitives */
function setStatus(text, kind = "busy") {
  $("#statusText").textContent = text;
  $("#status").className = `status ${kind}`;
}
const chat = () => $("#chat");
function scrollChat() { const c = chat(); c.scrollTop = c.scrollHeight; }
function resetChat() {
  chat().innerHTML = "";
  chat().appendChild(emptyNode);
  $("#sessTitle").textContent = "Nobody here yet";
  $("#sessEyebrow").textContent = "Session room";
  setStatus("Idle", "");
  renderTimeline();
}
let emptyNode;

function addDivider(text) {
  const d = document.createElement("div");
  d.className = "divider"; d.textContent = text;
  chat().appendChild(d); scrollChat();
}

function addWeekNote(title, text) {
  const d = document.createElement("div");
  d.className = "week-note";
  d.innerHTML = `<div class="eyebrow">Meanwhile, in Jonas's life · hidden from the therapist</div><b>${esc(title)}.</b> ${esc(text)}`;
  chat().appendChild(d); scrollChat();
}

function addMessage(speaker, text = "") {
  const isT = speaker === "therapist";
  const m = document.createElement("div");
  m.className = `msg ${speaker}`;
  m.innerHTML = `
    <div class="avatar ${speaker}">${isT ? "ML" : "J"}</div>
    <div><div class="who">${isT ? esc(S.state.therapist) : "Jonas"}</div>
      <div class="bubble">${isT ? '<details class="thinking" hidden><summary>Clinical reasoning</summary><div class="think-body"></div></details>' : ""}<div class="txt">${esc(text)}</div></div>
    </div>`;
  chat().appendChild(m); scrollChat();
  return m;
}

let sysRow = null;
function memChip(ev) {
  if (!sysRow || sysRow !== chat().lastElementChild) {
    sysRow = document.createElement("div"); sysRow.className = "sysrow"; chat().appendChild(sysRow);
  }
  const file = (ev.path || "").replace("/memories/", "").replace("/memories", "all notes") || "all notes";
  const verb = { view: "Recalled", create: "Wrote", str_replace: "Updated", insert: "Added to", delete: "Deleted", rename: "Renamed" }[ev.command] || ev.command;
  const c = document.createElement("span");
  c.className = `memchip ${ev.ok ? ev.phase : "err"}`;
  c.innerHTML = (ev.phase === "recall"
    ? '<svg class="i" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V21h16"/></svg>'
    : '<svg class="i" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>') + `${verb} ${esc(file)}`;
  sysRow.appendChild(c); scrollChat();
}

/* ------------------------------------------------------------ memory panel */
function mdLine(line) {
  const t = esc(line).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>");
  if (/^#{1,2}\s/.test(line)) return `<h4>${t.replace(/^#{1,2}\s/, "")}</h4>`;
  if (/^#{3,}\s/.test(line)) return `<h5>${t.replace(/^#{3,}\s/, "")}</h5>`;
  if (/^\s*[-*]\s/.test(line)) return `<div class="li">${t.replace(/^\s*[-*]\s/, "")}</div>`;
  if (!line.trim()) return "<div style='height:6px'></div>";
  return `<div>${t}</div>`;
}

function renderMemory() {
  const el = $("#memFiles");
  const files = Object.keys(S.memory);
  const openNow = new Set($$(".mfile[open]", el).map((d) => d.dataset.path));
  if (!files.length) {
    el.innerHTML = `<div class="mem-empty">Empty. The therapist has never met Jonas.<br>Everything she'll know next week must be written here.</div>`;
    return;
  }
  el.innerHTML = files.map((p) => {
    const text = S.memory[p];
    const base = S.memoryBase[p];
    const baseLines = new Set((base || "").split("\n"));
    const badge = base === undefined ? '<span class="badge new">new</span>' : base !== text ? '<span class="badge upd">updated</span>' : "";
    const lines = text.split("\n").map((l) => {
      const html = mdLine(l);
      return base !== undefined && !baseLines.has(l) && l.trim() ? `<div class="ln added">${html}</div>` : base === undefined && l.trim() ? `<div class="ln added">${html}</div>` : html;
    }).join("");
    const isOpen = openNow.has(p) || (!openNow.size && p === files[0]);
    return `<details class="mfile ${S.touched[p] ? "flash-" + S.touched[p] : ""}" data-path="${esc(p)}" ${isOpen ? "open" : ""}>
      <summary><span class="fname">${esc(p.replace("/memories/", ""))}</span>${badge}<span class="meta">${text.split("\n").length} lines</span></summary>
      <div class="mbody">${lines}</div></details>`;
  }).join("");
}

function touchMemory(ev) {
  const p = ev.path;
  if (ev.memory) S.memory = ev.memory;
  pingRail(ev.phase);
  if (p === "/memories") {
    $(".right").classList.add("reading");
    setTimeout(() => $(".right").classList.remove("reading"), 1400);
  } else if (p) {
    S.touched[p] = ev.phase;
    if (ev.new_path) S.touched[ev.new_path] = ev.phase;
  }
  renderMemory();
  const target = $$(".mfile").find((d) => d.dataset.path === p);
  if (target) { target.open = true; target.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  setTimeout(() => { delete S.touched[p]; $$(".mfile").forEach((d) => d.dataset.path === p && d.classList.remove("flash-recall", "flash-write")); }, 2200);
  const li = document.createElement("li");
  li.innerHTML = `<span class="op ${ev.phase}">${esc(ev.command)}</span><span>${esc((p || "").replace("/memories/", "") || "/memories")}${ev.ok ? "" : " (failed)"}</span>`;
  $("#memLog").prepend(li);
}

/* ------------------------------------------------------------ turns */
async function therapistTurn(wrap_up = false) {
  setStatus("Dr. Lindqvist is thinking…");
  let msg = null, txt, think, thinkBody;
  const ensureMsg = () => {
    if (!msg) {
      msg = addMessage("therapist");
      txt = $(".txt", msg); think = $(".thinking", msg); thinkBody = $(".think-body", msg);
    }
  };
  await stream(`/api/session/${S.live.id}/therapist`, { wrap_up }, (ev) => {
    if (ev.type === "memory") { setStatus("Reading her notes…", "recall"); memChip(ev); touchMemory(ev); }
    else if (ev.type === "thinking") { ensureMsg(); think.hidden = false; thinkBody.textContent += ev.delta; thinkBody.scrollTop = thinkBody.scrollHeight; }
    else if (ev.type === "text") { ensureMsg(); setStatus("Dr. Lindqvist is speaking…"); txt.textContent += ev.delta; scrollChat(); }
    else if (ev.type === "turn_end") { ensureMsg(); txt.textContent = ev.text; }
  });
}

async function patientTurn() {
  let text = null;
  if (S.mode === "manual") {
    setStatus("Your turn: speak as Jonas", "recall");
    text = await waitForSpeech();
  } else {
    setStatus("Jonas is talking…");
  }
  const msg = addMessage("patient");
  const txt = $(".txt", msg);
  await stream(`/api/session/${S.live.id}/patient`, { text }, (ev) => {
    if (ev.type === "text") { txt.textContent += ev.delta; scrollChat(); }
    else if (ev.type === "turn_end") txt.textContent = ev.text;
  });
}

let speechResolve = null;
function waitForSpeech() {
  const f = $("#speakForm");
  f.classList.add("waiting");
  $("#speakText").focus();
  return new Promise((res) => { speechResolve = res; });
}
$("#speakForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = $("#speakText").value.trim();
  if (!t || !speechResolve) return;
  $("#speakText").value = "";
  $("#speakForm").classList.remove("waiting");
  const r = speechResolve; speechResolve = null; r(t);
});
$("#speakText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#speakForm").requestSubmit(); }
});

async function waitIfPaused() {
  while (S.paused) await new Promise((r) => setTimeout(r, 250));
}

async function runSession() {
  const title = $("#weekTitle").value.trim();
  const experience = $("#weekText").value.trim();
  if (!experience) { $("#weekText").focus(); return; }
  try {
    S.live = await api("/api/session/start", { title, experience });
  } catch (e) { alert(e.message); return; }
  const exchanges = +$("#lenRange").value;
  S.paused = false; S.wrapRequested = false; S.selected = null;
  S.memoryBase = { ...S.memory };
  $("#memLog").innerHTML = "";
  renderStartButton(); renderTimeline(); renderMemory();
  showView("room");
  chat().innerHTML = "";
  $("#sessEyebrow").textContent = `Session ${S.live.number} · ${fmtDate(S.live.date)}`;
  $("#sessTitle").textContent = S.live.title;
  $("#runControls").hidden = false;
  $("#speakForm").hidden = S.mode !== "manual";
  $("#pauseBtn").textContent = "Pause";
  $("#weekCard").style.opacity = .55;

  addWeekNote(S.live.title, experience);
  addDivider(`Session ${S.live.number} begins`);
  try {
    await therapistTurn();
    for (let i = 1; i <= exchanges; i++) {
      await waitIfPaused();
      await patientTurn();
      await waitIfPaused();
      const wrap = S.wrapRequested || i >= exchanges - 1;
      await therapistTurn(wrap);
      if (wrap) { await patientTurn(); break; }
    }
    $("#runControls").hidden = true; $("#speakForm").hidden = true;
    addDivider("Jonas has left · Dr. Lindqvist writes her notes");
    setStatus("Updating memory…", "busy");
    let record = null;
    await stream(`/api/session/${S.live.id}/end`, {}, (ev) => {
      if (ev.type === "memory") { memChip(ev); touchMemory(ev); }
      else if (ev.type === "phase" && ev.phase === "assessing") setStatus("Supervisor is assessing…", "busy");
      else if (ev.type === "assessment") record = ev.session;
    });
    S.live = null;
    setStatus("Session complete", "done");
    await refresh();
    $("#weekText").value = ""; renderPresets();
    if (record) addEndCard(record);
  } catch (e) {
    console.error(e);
    setStatus("Something went wrong", "");
    addDivider(`Error: ${e.message}`);
    S.live = null; renderStartButton();
  } finally {
    $("#runControls").hidden = true; $("#speakForm").hidden = true;
    $("#weekCard").style.opacity = 1;
    renderTimeline();
  }
}

function addEndCard(rec) {
  const a = rec.assessment;
  const d = document.createElement("div");
  d.className = "endcard";
  d.innerHTML = `
    <div class="eyebrow">Session ${rec.number} assessment</div>
    <h3>“${esc(a.headline)}”</h3>
    <div class="mini">
      <div><b>${fmtSent(a.sentiment)}</b>mood · ${esc(a.sentiment_label)}</div>
      <div><b>${a.depression.phq9_estimate}</b>est. PHQ-9 · ${esc(a.depression.severity)}</div>
      <div><b>${esc(cap(a.safety.level))}</b>safety concern</div>
      <div><b>${rec.memory_diff.length}</b>memory files changed</div>
    </div>
    <button type="button">Open the clinical picture →</button>`;
  $("button", d).onclick = () => showView("picture");
  chat().appendChild(d); scrollChat();
}

/* ------------------------------------------------------------ past sessions */
function openPastSession(n) {
  const rec = S.state.sessions.find((s) => s.number === n);
  if (!rec) return;
  S.selected = n;
  chat().innerHTML = "";
  $("#sessEyebrow").textContent = `Session ${n} · ${fmtDate(rec.date)} · replay`;
  $("#sessTitle").textContent = rec.title;
  setStatus("Completed", "done");
  addWeekNote(rec.title, rec.experience);
  addDivider(`Session ${n}`);
  const reads = (rec.memory_ops || []).filter((o) => o.phase === "recall");
  reads.forEach((o) => memChip(o));
  rec.transcript.forEach((t) => addMessage(t.speaker, t.text));
  addDivider("Notes written after the session");
  (rec.memory_ops || []).filter((o) => o.phase === "write").forEach((o) => memChip(o));
  addEndCard(rec);
  chat().scrollTop = 0;
  $("#memLog").innerHTML = (rec.memory_ops || []).slice().reverse().map((o) =>
    `<li><span class="op ${o.phase}">${esc(o.command)}</span><span>${esc((o.path || "").replace("/memories/", "") || "/memories")}</span></li>`).join("");
  S.memory = rec.memory_after; S.memoryBase = diffBaseFor(n);
  renderMemory(); renderTimeline(); renderPicture();
  showView("room");
}

/* ------------------------------------------------------------ clinical picture */
const fmtSent = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2);
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
const fmtDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

function deltaChip(cur, prev, betterWhenLower, fmt = (x) => x) {
  if (prev === undefined || prev === null) return "";
  const d = cur - prev;
  if (Math.abs(d) < 1e-9) return `<span class="delta flat">±0</span>`;
  const good = betterWhenLower ? d < 0 : d > 0;
  return `<span class="delta ${good ? "good" : "bad"}">${d > 0 ? "▲" : "▼"} ${fmt(Math.abs(d))}</span>`;
}

function renderPicture() {
  const sessions = S.state.sessions.filter((s) => s.assessment);
  $("#pictureEmpty").hidden = sessions.length > 0;
  $("#pictureBody").hidden = sessions.length === 0;
  if (!sessions.length) return;
  const idx = S.selected ? sessions.findIndex((s) => s.number === S.selected) : sessions.length - 1;
  const rec = sessions[idx], prev = sessions[idx - 1];
  const a = rec.assessment, p = prev?.assessment;
  const upTo = sessions.slice(0, idx + 1);

  $("#heroEyebrow").textContent = `Current state · after session ${rec.number} · ${fmtDate(rec.date)}`;
  $("#heroHeadline").textContent = a.headline;
  $("#heroState").textContent = a.current_state;

  const lvl = a.safety.level;
  const icon = lvl === "none" || lvl === "low"
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';
  $("#safetyBox").className = `safety ${lvl}`;
  $("#safetyBox").innerHTML = `<div class="label">Safety</div><div class="lvl">${icon}${lvl === "none" ? "No safety concerns" : cap(lvl) + " concern"}</div>
    ${a.safety.flags.length ? `<ul>${a.safety.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
    <p>${esc(a.safety.recommended_action)}</p>`;

  requestAnimationFrame(balanceHero);
  $("#tiles").innerHTML = [
    { l: "Mood", v: fmtSent(a.sentiment), s: a.sentiment_label, d: deltaChip(a.sentiment, p?.sentiment, false, (x) => x.toFixed(2)) },
    { l: "Depression risk", v: `${a.depression.phq9_estimate}<small>/27</small>`, s: `${cap(a.depression.severity)} · ${a.depression.confidence} confidence`, d: deltaChip(a.depression.phq9_estimate, p?.depression.phq9_estimate, true) },
    { l: "Anxiety", v: `${a.anxiety_gad7_estimate}<small>/21</small>`, s: "est. GAD-7 equivalent", d: deltaChip(a.anxiety_gad7_estimate, p?.anxiety_gad7_estimate, true) },
    { l: "Sessions", v: `${rec.number}`, s: `${Object.keys(rec.memory_after || {}).length} memory files · ${rec.memory_diff.length} changed`, d: "" },
  ].map((t) => `<div class="tile"><div class="label">${t.l}</div><div class="v">${t.v}${t.d}</div><div class="sub">${esc(t.s)}</div></div>`).join("");

  lineChart($("#chartMood"), upTo.map((s) => ({ x: s.number, y: s.assessment.sentiment, tip: `<b>Session ${s.number}</b><br>${fmtSent(s.assessment.sentiment)} · ${esc(s.assessment.sentiment_label)}` })), { min: -1, max: 1, zero: 0, ticks: [-1, 0, 1], fmt: fmtSent });
  lineChart($("#chartPhq"), upTo.map((s) => ({ x: s.number, y: s.assessment.depression.phq9_estimate, tip: `<b>Session ${s.number}</b><br>PHQ-9 ≈ ${s.assessment.depression.phq9_estimate} · ${esc(s.assessment.depression.severity)}` })), {
    min: 0, max: 27, ticks: [0, 5, 10, 15, 20, 27], fmt: (v) => v,
    bands: [[0, 5, "minimal", "var(--green-soft)"], [5, 10, "mild", "var(--sunk)"], [10, 15, "moderate", "var(--amber-soft)"], [15, 20, "mod. severe", "var(--clay-soft)"], [20, 27, "severe", "var(--red-soft)"]],
  });
  turnChart($("#chartTurns"), a.turn_sentiments);

  bars($("#adhdBars"), [
    ["Inattention", a.adhd.inattention, p?.adhd.inattention],
    ["Hyperactivity / impulsivity", a.adhd.hyperactivity_impulsivity, p?.adhd.hyperactivity_impulsivity],
    ["Executive function", a.adhd.executive_dysfunction, p?.adhd.executive_dysfunction],
    ["Emotional dysregulation", a.adhd.emotional_dysregulation, p?.adhd.emotional_dysregulation],
  ], "");
  $("#adhdEvidence").innerHTML = a.adhd.evidence.map((e) => `<li>${esc(e)}</li>`).join("");
  bars($("#funcBars"), [
    ["Sleep", a.functioning.sleep, p?.functioning.sleep],
    ["Work", a.functioning.work, p?.functioning.work],
    ["Relationships", a.functioning.relationships, p?.functioning.relationships],
    ["Self-care", a.functioning.self_care, p?.functioning.self_care],
  ], "func");
  $("#themes").innerHTML = a.key_themes.map((t) => `<span>${esc(t)}</span>`).join("");
  $("#strengths").innerHTML = a.strengths.map((t) => `<span>${esc(t)}</span>`).join("");

  $("#changeSince").textContent = a.change_since_last;
  $("#callbacks").innerHTML = a.memory_callbacks.length
    ? a.memory_callbacks.map((c) => `<li>${esc(c)}</li>`).join("")
    : `<li>First session: nothing to remember yet. Everything she learned today is now in memory.</li>`;
  $("#diffList").innerHTML = rec.memory_diff.map((d) => `<span>${esc(d.path.replace("/memories/", ""))} <b>+${d.added}</b> <i>−${d.removed}</i></span>`).join("");
  $("#homework").textContent = a.homework;
  $("#nextFocus").textContent = a.next_session_focus;
  $("#depEvidence").innerHTML = a.depression.evidence.map((e) => `<li>${esc(e)}</li>`).join("");

  const order = { now: 0, next: 1, later: 2 };
  $("#interventions").innerHTML = [...a.interventions].sort((x, y) => order[x.priority] - order[y.priority]).map((iv) => `
    <div class="iv"><div class="iv-top"><span class="modality">${esc(iv.modality)}</span><span class="prio ${iv.priority}">${iv.priority}</span></div>
    <h4>${esc(iv.title)}</h4><p>${esc(iv.rationale)}</p></div>`).join("");

  $("#history").innerHTML = sessions.map((s) => `
    <button class="hcard ${s.number === rec.number ? "selected" : ""}" data-n="${s.number}">
      <div class="n">Session ${s.number} · ${fmtDate(s.date)}</div><div class="t">${esc(s.title)}</div>
      <div class="h">“${esc(s.assessment.headline)}”</div></button>`).join("");
  $$(".hcard").forEach((b) => b.onclick = () => { S.selected = +b.dataset.n; renderPicture(); renderTimeline(); });
}

/* Widen the safety column until it is no taller than the text + tiles beside it,
   so the hero has no dead space whatever the amount of safety detail. */
function balanceHero() {
  const hero = $(".hero"), box = $("#safetyBox");
  if (!hero || hero.offsetParent === null) return;
  const list = $("ul", box);
  const stacked = getComputedStyle(hero).gridTemplateAreas.split('"').filter((x) => x.trim()).length > 2;
  hero.style.setProperty("--safety-w", "30%");
  list?.classList.remove("cols");
  if (stacked) return;
  const left = () => $(".hero-text").offsetHeight + $("#tiles").offsetHeight + 18;
  for (const w of [34, 38, 42, 46, 50]) {
    if (box.offsetHeight <= left() + 8) return;
    hero.style.setProperty("--safety-w", `${w}%`);
    if (w >= 42) list?.classList.add("cols");
  }
}
addEventListener("resize", () => { clearTimeout(balanceHero.t); balanceHero.t = setTimeout(balanceHero, 120); });

/* ------------------------------------------------------------ charts (inline SVG) */
const W = 320, H = 170, PAD = { l: 30, r: 14, t: 12, b: 24 };
function lineChart(el, pts, o) {
  const xs = pts.map((p) => p.x);
  const xmin = Math.min(...xs), xmax = Math.max(...xs, xmin + 1);
  const X = (x) => pts.length === 1 ? (PAD.l + W - PAD.r) / 2 : PAD.l + (x - xmin) / (xmax - xmin) * (W - PAD.l - PAD.r);
  const Y = (y) => PAD.t + (1 - (y - o.min) / (o.max - o.min)) * (H - PAD.t - PAD.b);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  (o.bands || []).forEach(([a, b, label, fill]) => {
    s += `<rect class="band" x="${PAD.l}" y="${Y(b)}" width="${W - PAD.l - PAD.r}" height="${Y(a) - Y(b)}" fill="${fill}"/>`;
    s += `<text class="band-label" x="${PAD.l + 4}" y="${Y(b) + 11}">${label}</text>`;
  });
  o.ticks.forEach((t) => {
    if (!o.bands) s += `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(t)}" y2="${Y(t)}"/>`;
    s += `<text class="axis" x="${PAD.l - 6}" y="${Y(t) + 3.5}" text-anchor="end">${o.fmt(t)}</text>`;
  });
  if (o.zero !== undefined) s += `<line class="zero" x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(o.zero)}" y2="${Y(o.zero)}"/>`;
  pts.forEach((p) => s += `<text class="axis" x="${X(p.x)}" y="${H - 6}" text-anchor="middle">S${p.x}</text>`);
  if (pts.length > 1) s += `<path class="lineM" d="${pts.map((p, i) => `${i ? "L" : "M"}${X(p.x)},${Y(p.y)}`).join("")}"/>`;
  pts.forEach((p, i) => {
    s += `<circle class="hit" cx="${X(p.x)}" cy="${Y(p.y)}" r="14" data-tip="${esc(p.tip)}"/><circle class="pt" cx="${X(p.x)}" cy="${Y(p.y)}" r="4.5"/>`;
    if (i === pts.length - 1) s += `<text class="val" x="${X(p.x)}" y="${Y(p.y) - 10}" text-anchor="middle">${o.fmt(+p.y.toFixed(2))}</text>`;
  });
  el.innerHTML = s + "</svg>";
  wireTips(el);
}

function turnChart(el, vals) {
  const n = vals.length || 1;
  const Y = (y) => PAD.t + (1 - (y + 1) / 2) * (H - PAD.t - PAD.b);
  const bw = Math.min(28, (W - PAD.l - PAD.r) / n - 4);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  [-1, 0, 1].forEach((t) => s += `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="axis" x="${PAD.l - 6}" y="${Y(t) + 3.5}" text-anchor="end">${fmtSent(t)}</text>`);
  vals.forEach((v, i) => {
    const cx = PAD.l + (i + .5) * (W - PAD.l - PAD.r) / n;
    const y0 = Y(0), y1 = Y(v);
    const top = Math.min(y0, y1), h = Math.max(2, Math.abs(y1 - y0));
    s += `<rect class="${v >= 0 ? "barpos" : "barneg"}" x="${cx - bw / 2}" y="${top}" width="${bw}" height="${h}" rx="3"/>`;
    s += `<rect class="hit" x="${cx - bw / 2 - 4}" y="${PAD.t}" width="${bw + 8}" height="${H - PAD.t - PAD.b}" data-tip="${esc(`<b>Jonas, turn ${i + 1}</b><br>valence ${fmtSent(v)}`)}"/>`;
    s += `<text class="axis" x="${cx}" y="${H - 6}" text-anchor="middle">${i + 1}</text>`;
  });
  el.innerHTML = s + "</svg>";
  wireTips(el);
}

function bars(el, rows, cls) {
  el.innerHTML = rows.map(([label, v, prev]) => `
    <div class="bar-row"><span>${label}</span>
      <div class="bar-track"><div class="bar-fill ${cls}" style="width:0%" data-w="${v * 10}"></div>${prev !== undefined && prev !== null ? `<div class="bar-prev" style="left:calc(${prev * 10}% - 1px)" title="Previous: ${prev}"></div>` : ""}</div>
      <span class="bar-num">${v}</span></div>`).join("");
  requestAnimationFrame(() => $$(".bar-fill", el).forEach((b) => b.style.width = b.dataset.w + "%"));
}

function wireTips(el) {
  const tip = $("#tooltip");
  $$("[data-tip]", el).forEach((h) => {
    h.addEventListener("mouseenter", () => { tip.innerHTML = h.dataset.tip; tip.classList.add("show"); h.nextElementSibling?.classList?.add("hover"); });
    h.addEventListener("mousemove", (e) => { tip.style.left = Math.min(e.clientX + 12, innerWidth - 270) + "px"; tip.style.top = e.clientY + 12 + "px"; });
    h.addEventListener("mouseleave", () => { tip.classList.remove("show"); h.nextElementSibling?.classList?.remove("hover"); });
  });
}

/* ------------------------------------------------------------ collapsible sidebars */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
function setCollapsed(side, collapsed) {
  const col = side === "left" ? $("#leftCol") : $("#rightCol");
  col.classList.toggle("collapsed", collapsed);
  $("#view-room").classList.toggle(`${side}-collapsed`, collapsed);
  store.set(`continuity.collapsed.${side}`, collapsed ? "1" : "0");
}
$$(".col-toggle, .rail").forEach((b) => b.onclick = () =>
  setCollapsed(b.dataset.side, !(b.dataset.side === "left" ? $("#leftCol") : $("#rightCol")).classList.contains("collapsed")));
["left", "right"].forEach((side) => setCollapsed(side, store.get(`continuity.collapsed.${side}`) === "1"));

function pingRail(phase) {
  const rail = $("#rightCol .rail");
  if (!$("#rightCol").classList.contains("collapsed")) return;
  rail.classList.remove("ping-recall", "ping-write");
  void rail.offsetWidth;
  rail.classList.add(`ping-${phase}`);
  clearTimeout(pingRail.t);
  pingRail.t = setTimeout(() => rail.classList.remove("ping-recall", "ping-write"), 3000);
}

/* ------------------------------------------------------------ chrome */
function showView(v) {
  $$(".view-tab").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  $$(".view").forEach((s) => s.classList.toggle("active", s.id === `view-${v}`));
  if (v === "picture") requestAnimationFrame(balanceHero);
}
$$(".view-tab").forEach((b) => b.onclick = () => showView(b.dataset.view));
$$(".seg").forEach((b) => b.onclick = () => {
  if (S.live) return;
  S.mode = b.dataset.mode;
  $$(".seg").forEach((x) => x.classList.toggle("active", x === b));
});
$("#lenRange").oninput = (e) => $("#lenVal").textContent = e.target.value;
$("#startBtn").onclick = runSession;
$("#pauseBtn").onclick = () => {
  S.paused = !S.paused;
  $("#pauseBtn").textContent = S.paused ? "Resume" : "Pause";
  if (S.paused) setStatus("Paused after this turn", "");
};
$("#wrapBtn").onclick = () => { S.wrapRequested = true; $("#wrapBtn").disabled = true; setTimeout(() => $("#wrapBtn").disabled = false, 30000); };
$("#surpriseBtn").onclick = async () => {
  const b = $("#surpriseBtn"); b.disabled = true; const old = b.innerHTML; b.textContent = "Imagining Jonas's week…";
  try { setWeek(await api("/api/week/generate", {}), "generated"); } catch (e) { alert(e.message); }
  b.disabled = false; b.innerHTML = old;
};
$("#resetBtn").onclick = async () => {
  if (S.live) return;
  if (!confirm("Erase the therapist's memory and all sessions? This starts the story over.")) return;
  await api("/api/reset", {});
  S.selected = null; S.memoryBase = {}; $("#weekText").value = ""; $("#memLog").innerHTML = "";
  resetChat(); await refresh();
};

emptyNode = $("#empty");
refresh().then(() => {
  const last = S.state.sessions.at(-1);
  if (last) openPastSession(last.number);
});
