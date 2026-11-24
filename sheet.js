/* BPF Sheet: the Lead Hub CRM's own spreadsheet, built from scratch (Tue 10 Nov 2026).
   Kyle: "We're absolutely going to want a lot of spreadsheet functionality ... Build it all."
   One grid used everywhere in the CRM (upload check, All leads, Do not contact, Lists).

   Sheet.create(hostEl, cfg) -> api
   cfg = {
     id,                      // name for saved views and remembered layout
     columns: [{ key, label, type, options, width, editable, get, text, html, cls, pill, wrap, long, validate, hint }],
        type: text | long | number | money | date | datetime | select | multi | check | url | email
        options: [value] or [{value,label}] or () => [...]   (select)
        editable: bool or (row) => bool
        get(row) -> raw value; text(row) -> text used for search/filter/copy; html(row) -> cell HTML
     rows, rowKey(row),
     onEdit: async changes => {}   // [{row, rk, key, old, value}]. Throw to refuse. Host then calls setRows.
     rowClass(row), cellClass(row, col),
     defaults: { hidden:[], frozen, sort:[], rowH, group, sums:{} },
     views: { list(), save(view), remove(id), me },   // saved views (Supabase); optional
     remember: true,          // keep this person's layout in this browser
     onOpen(row), openLabel,  // "Open full record"
     drawer(row, el),         // add more to the expanded-row panel (notes, history …)
     bulk: [{ label, run(rows) }],
     toolbar(el),             // add host controls to the toolbar
     toast(msg), empty, height, rowNumber(row),
     // v6.17 (Thu 19 Nov 2026), all optional:
     compactBar: true,        // one-line toolbar: Search, Filter, Sort, Columns, View; the rest under "…"
     fill: true,              // the sheet grows to the bottom of the window (no fixed small height)
     dock: true,              // the expanded row opens as a right-hand pane (no shade; the table stays usable)
     openKey,                 // with dock: double-clicking the row number or this column's cell opens the pane
     drawerHead(row, el),     // with dock: the pane's headline and next-step buttons
     drawerBody(row, el, api), // v6.24, with dock: the host draws the whole pane body (the lead record's tabs); api.fields(host, keys)
                              // draws the row's field editors there; api.fresh is true when a row was just opened (not a redraw)
     freshFilters: true,      // v6.18: open with no filter, group or saved view (layout, widths and sort are still remembered)
     allLabel, onView(label)  // the name shown for the current view ("To vet · 8 of 597"); onView gets it when it changes
     viewTabs: true,          // v6.21: saved views as a row of tabs above the grid, with "+ view"; bulk may be (view) => [...]
   }
   Column option bare: true = a filter on it is named by its values alone ("To vet", not "Status: To vet").
   api: setRows, setColumns, getState, setState, addFilter, selectedRows, visibleRows, refresh, focus, status, el, destroy */
(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const MOD = isMac ? "⌘" : "Ctrl";
  const HEIGHTS = { short: 34, medium: 58, tall: 96 };
  const COLORS = ["green","yellow","red","blue","purple","grey"];
  const COLOR_NAMES = { green:"Green", yellow:"Yellow", red:"Red", blue:"Blue", purple:"Purple", grey:"Grey" };
  const G = 78;            // the row-number gutter
  const HEAD = 36, SUM = 30;
  const NUMERIC = t => t === "number" || t === "money" || t === "percent";
  const DATEY = t => t === "date" || t === "datetime";
  const W = { text:180, long:260, number:110, money:120, date:130, datetime:170, select:160, multi:210, check:84, url:230, email:230 };
  const OPS = {
    text: [["contains","contains"],["not_contains","doesn't contain"],["is","is"],["is_not","is not"],["starts","starts with"],["empty","is empty"],["not_empty","is not empty"]],
    select: [["any","is any of"],["none","is none of"],["empty","is empty"],["not_empty","is not empty"]],
    number: [["eq","="],["neq","≠"],["gt",">"],["lt","<"],["gte","≥"],["lte","≤"],["empty","is empty"],["not_empty","is not empty"]],
    date: [["on","is on"],["before","is before"],["after","is after"],["last","is within the last … days"],["next","is within the next … days"],["empty","is empty"],["not_empty","is not empty"]],
    check: [["yes","is checked"],["no","is not checked"]],
  };
  const opKind = t => t === "select" ? "select" : NUMERIC(t) ? "number" : DATEY(t) ? "date" : t === "check" ? "check" : "text";
  const noValue = op => ["empty","not_empty","yes","no"].includes(op);
  const SUMS = { none:"None", filled:"Filled", empty:"Empty", unique:"Unique", pct:"Percent filled", sum:"Sum", avg:"Average", min:"Smallest", max:"Largest", checked:"Checked", earliest:"Earliest", latest:"Latest" };
  const sumsFor = t => ["none","filled","empty","unique","pct", ...(NUMERIC(t) ? ["sum","avg","min","max"] : []), ...(t === "check" ? ["checked"] : []), ...(DATEY(t) ? ["earliest","latest"] : [])];
  const fmtDate = v => { if (!v) return ""; const d = new Date(/^\d{4}-\d\d-\d\d$/.test(v) ? v + "T12:00" : v); return isNaN(d) ? String(v) : d.toLocaleDateString(undefined, { weekday:"short", day:"numeric", month:"short", year:"numeric" }); };
  const fmtTime = v => { if (!v) return ""; const d = new Date(v); return isNaN(d) ? String(v) : d.toLocaleString(undefined, { weekday:"short", day:"numeric", month:"short", year:"numeric", hour:"numeric", minute:"2-digit" }); };
  const isoDay = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const coll = new Intl.Collator(undefined, { numeric:true, sensitivity:"base" });
  const clone = o => JSON.parse(JSON.stringify(o));

  function parseTSV(t){
    const rows = []; let row = [], cell = "", q = false;
    t = String(t).replace(/\r\n?/g, "\n");
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (q) { if (ch === '"') { if (t[i+1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"' && cell === "") q = true;
      else if (ch === "\t") { row.push(cell); cell = ""; }
      else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  const tsvCell = v => /[\t\n"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  const csvCell = v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;

  function create(host, cfg){
    const ac = new AbortController(), sig = { signal: ac.signal };
    const say = cfg.toast || (m => console.log(m));
    let cols = [], byKey = {}, data = [], vis = [], items = [], itemOf = [], vc = [], xs = [], ws = [], totalW = 0, fz = 0, autoW = {};
    // Row heights: wrapped columns make a row as tall as its longest wrapped text (Kyle, Thu 12 Nov 2026: "Wrap text did
    // not wrap the text"). ih = each item's height, iy = where it starts.
    let ih = [], iy = [], bodyH = 0;
    function layout(){
      const base = RH(), wrapCols = vc.map((c, i) => [c, i]).filter(([c]) => st.wrap.includes(c.key) || c.wrap);
      const cv = wrapCols.length ? document.createElement("canvas").getContext("2d") : null;
      if (cv) cv.font = "15px " + getComputedStyle(root).fontFamily;
      ih = items.map(it => { if (it.type !== "r" || !cv) return base; const row = vis[it.i]; let lines = 1;
        for (const [c, i] of wrapCols) { const t = text(c, row); if (!t) continue; const avail = Math.max(30, ws[i] - 18);
          let n = 0; for (const para of String(t).split("\n")) { let line = 0; n++;
            for (const w of para.split(/\s+/)) { const ww = cv.measureText(w + " ").width; if (line && line + ww > avail) { n++; line = ww; } else line += ww; } }
          lines = Math.max(lines, n); }
        return Math.min(600, Math.max(base, lines * 21 + 14)); });
      iy = []; let y = 0; ih.forEach(h => { iy.push(y); y += h; }); bodyH = y;
    }
    const itemAt = top => { let lo = 0, hi = iy.length - 1, ans = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (iy[m] <= top) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
    // Columns start no wider than what's in them (Kyle, Thu 12 Nov 2026: "I want the column width to not start out wider
    // than the widest field within that column … squeeze things tighter so I can see more on one page"). Widths someone
    // dragged or double-clicked (st.widths) still win. Long headings shorten with "…" (hover shows them) rather than
    // widen a column of short values.
    function measureAuto(){
      const cv = document.createElement("canvas").getContext("2d"), fam = getComputedStyle(root).fontFamily, sample = data.slice(0, 800);
      const m = (t, font) => { cv.font = font; return cv.measureText(t).width; };
      autoW = {};
      for (const c of cols) {
        let body = 0;
        if (c.type === "check") body = 22;
        else { const ws = [];
          for (const r of sample) { let t = text(c, r); if (!t) continue; if (c.type === "url") t = String(t).replace(/^https?:\/\/(www\.)?/i, "");
            if (t.length > 80) t = t.slice(0, 80); ws.push(m(t, "15px " + fam)); }
          // Fit 98% of the values, not the single longest (Kyle, Tue 24 Nov 2026: one 161-character junk name made Name 300px wide).
          // The odd long one is cut with "…" and shows in full on hover, as before.
          ws.sort((a, b) => a - b); body = ws.length ? (ws.length >= 20 ? ws[Math.floor(ws.length * 0.98)] : ws[ws.length - 1]) : 0; }
        const head = m(String(c.label).toUpperCase(), "600 13px " + fam) + 44;
        const cap = c.type === "long" ? 320 : c.type === "url" ? 260 : 300;
        const w = Math.max(body + 24, Math.min(head, Math.max(body + 24, 110)));
        autoW[c.key] = Math.round(Math.max(52, Math.min(cap, w)));
      }
    }
    let st = baseState(), viewId = "", views = [], editing = null, undo = [], redo = [], chg = { ...(cfg.changes || {}) }, rowSel = new Set(), lastTick = null;
    let sel = null;            // { a:{r,c}, f:{r,c} } indexes into vis / vc
    let selKeys = null;        // the same by keys, kept across re-sorts
    let fill = null, drag = null, found = null, busy = 0, statusMsg = "", statusErr = false, raf = 0, board = null;
    const rk = r => cfg.rowKey ? cfg.rowKey(r) : (r.id ?? data.indexOf(r));
    const RH = () => HEIGHTS[st.rowH] || 34;

    function baseState(){ const d = cfg.defaults || {}; return { order:[], hidden:[...(d.hidden||[])], widths:{}, frozen: d.frozen ?? 1, sort: clone(d.sort||[]), filters: clone(d.filters||[]), conj:"and", group: d.group || "", collapsed:[], rowH: d.rowH || "short", wrap:[...(d.wrap||[])], colors: clone(d.colors||[]), sums: { ...(d.sums||{}) }, mode:"grid", boardKey: d.boardKey || "", q:"" }; }

    // ---------- Columns and values ----------
    function setColumns(list){
      cols = list.map(c => ({ type:"text", ...c, width: c.width || W[c.type || "text"] || 180 }));
      byKey = Object.fromEntries(cols.map(c => [c.key, c]));
      const known = st.order.filter(k => byKey[k]); cols.forEach(c => { if (!known.includes(c.key)) known.push(c.key); }); st.order = known;
    }
    const opts = c => (typeof c.options === "function" ? c.options() : c.options || []).map(o => o && typeof o === "object" ? { v:o.value, l:String(o.label ?? o.value) } : { v:o, l:String(o) });
    const val = (c, row) => c.get ? c.get(row) : row[c.key];
    const label = (c, v) => { if (c.type !== "select") return v; const o = opts(c).find(o => o.v === v); return o ? o.l : v; };
    function text(c, row){
      if (c.text) return String(c.text(row) ?? "");
      const v = val(c, row); if (v === null || v === undefined || v === "") return "";
      if (Array.isArray(v)) return v.join(", ");
      if (c.type === "check") return v ? "Yes" : "No";
      if (c.type === "select") return String(label(c, v) ?? "");
      return String(v);
    }
    const canEditCell = (c, row) => typeof c.editable === "function" ? !!c.editable(row) : !!c.editable;
    const empty = (c, row) => { const v = val(c, row); return v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) || (c.type === "check" && !v) || (c.text && !text(c, row)); };
    function sortVal(c, row){ const v = val(c, row); if (NUMERIC(c.type)) return v === null || v === undefined || v === "" ? null : +v; if (c.type === "check") return v ? 1 : 0;
      if (c.type === "select" && !c.text) { const i = opts(c).findIndex(o => o.v === v); return i < 0 ? (v ? 9999 : null) : i; } const t = text(c, row); return t === "" ? null : t; }

    // ---------- Filter, sort, group ----------
    function test(f, row){
      const c = byKey[f.key]; if (!c) return true;
      const t = text(c, row).toLowerCase(), v = val(c, row), x = f.value;
      switch (f.op) {
        case "contains": return t.includes(String(x||"").toLowerCase());
        case "not_contains": return !t.includes(String(x||"").toLowerCase());
        case "is": return t === String(x||"").toLowerCase();
        case "is_not": return t !== String(x||"").toLowerCase();
        case "starts": return t.startsWith(String(x||"").toLowerCase());
        case "empty": return empty(c, row);
        case "not_empty": return !empty(c, row);
        case "any": return (x||[]).some(o => Array.isArray(v) ? v.includes(o) : o === "" ? empty(c,row) : v === o);
        case "none": return !(x||[]).some(o => Array.isArray(v) ? v.includes(o) : o === "" ? empty(c,row) : v === o);
        case "yes": return !!v; case "no": return !v;
      }
      if (NUMERIC(c.type)) { if (v === null || v === undefined || v === "" || x === "" || x === undefined) return false; const a = +v, b = +x;
        return { eq:a===b, neq:a!==b, gt:a>b, lt:a<b, gte:a>=b, lte:a<=b }[f.op] ?? true; }
      if (DATEY(c.type)) { if (!v) return false; const d = String(v).slice(0,10), today = isoDay(new Date());
        if (f.op === "last" || f.op === "next") { const n = +x || 0, e = new Date(); e.setDate(e.getDate() + (f.op === "last" ? -n : n)); const lim = isoDay(e); return f.op === "last" ? d >= lim && d <= today : d <= lim && d >= today; }
        if (!x) return true; return { on:d===x, before:d<x, after:d>x }[f.op] ?? true; }
      return true;
    }
    function compute(){
      vc = st.order.map(k => byKey[k]).filter(c => c && !st.hidden.includes(c.key));
      fz = Math.min(st.frozen || 0, vc.length);
      ws = vc.map(c => st.widths[c.key] || autoW[c.key] || c.width); xs = []; let x = G; ws.forEach(w => { xs.push(x); x += w; }); totalW = x;
      const q = st.q.trim().toLowerCase();
      const fl = st.filters.filter(ready);
      let rows = data.filter(row => (!q || vc.some(c => text(c, row).toLowerCase().includes(q))) &&
        (!fl.length || (st.conj === "or" ? fl.some(f => test(f, row)) : fl.every(f => test(f, row)))));
      const sorts = [...(st.group && byKey[st.group] ? [{ key: st.group, dir: "asc" }] : []), ...st.sort.filter(s => byKey[s.key])];
      if (sorts.length) rows = rows.map((r, i) => [r, i]).sort((A, B) => { for (const s of sorts) { const c = byKey[s.key], a = sortVal(c, A[0]), b = sortVal(c, B[0]);
          if (a === null && b === null) continue; if (a === null) return 1; if (b === null) return -1;
          const d = typeof a === "number" && typeof b === "number" ? a - b : coll.compare(String(a), String(b)); if (d) return s.dir === "desc" ? -d : d; } return A[1] - B[1]; }).map(p => p[0]);
      vis = []; items = []; itemOf = [];
      if (st.group && byKey[st.group]) {
        const c = byKey[st.group]; let cur = null, gi = null;
        rows.forEach(row => { const g = text(c, row) || "(empty)";
          if (g !== cur) { cur = g; gi = { type:"g", label:g, n:0, col:c }; items.push(gi); }
          gi.n++; if (!st.collapsed.includes(g)) { itemOf.push(items.length); items.push({ type:"r", i: vis.length }); vis.push(row); } });
      } else rows.forEach(row => { itemOf.push(items.length); items.push({ type:"r", i: vis.length }); vis.push(row); });
      layout();
      // Keep the selection on the same rows and columns after a re-sort.
      if (selKeys) { const ri = k => vis.findIndex(r => rk(r) === k), ci = k => vc.findIndex(c => c.key === k);
        const a = { r: ri(selKeys.a.r), c: ci(selKeys.a.c) }, f = { r: ri(selKeys.f.r), c: ci(selKeys.f.c) };
        sel = a.r >= 0 && a.c >= 0 ? { a, f: f.r >= 0 && f.c >= 0 ? f : { ...a } } : null; }
      clampSel();
    }
    function clampSel(){ if (!sel) return; if (!vis.length || !vc.length) { sel = null; return; }
      const cl = p => ({ r: Math.max(0, Math.min(vis.length-1, p.r)), c: Math.max(0, Math.min(vc.length-1, p.c)) }); sel = { a: cl(sel.a), f: cl(sel.f) }; }
    function remember(){ if (sel && vis[sel.a.r] && vc[sel.a.c] && vis[sel.f.r] && vc[sel.f.c]) selKeys = { a:{ r: rk(vis[sel.a.r]), c: vc[sel.a.c].key }, f:{ r: rk(vis[sel.f.r]), c: vc[sel.f.c].key } }; else selKeys = null; }
    const box = () => sel && { r0: Math.min(sel.a.r, sel.f.r), r1: Math.max(sel.a.r, sel.f.r), c0: Math.min(sel.a.c, sel.f.c), c1: Math.max(sel.a.c, sel.f.c) };

    // ---------- Layout ----------
    host.innerHTML = "";
    const root = document.createElement("div"); root.className = "sh"; host.appendChild(root);
    root.innerHTML = `<div class="sh-vtabs" hidden role="tablist" aria-label="Views"></div><div class="sh-bar"></div><div class="sh-bulk" hidden></div>
      <div class="sh-topbar" hidden title="Scroll sideways"><div></div></div>
      <div class="sh-scroll" tabindex="0" role="grid" aria-label="${esc(cfg.label || "Spreadsheet")}"><div class="sh-head"></div><div class="sh-body"></div><div class="sh-sum"></div></div>
      <div class="sh-board" hidden></div><div class="sh-status" aria-live="polite"></div>`;
    const $vt = root.querySelector(".sh-vtabs"), $bar = root.querySelector(".sh-bar"), $bulk = root.querySelector(".sh-bulk"), $sc = root.querySelector(".sh-scroll"), $head = root.querySelector(".sh-head"),
      $body = root.querySelector(".sh-body"), $sum = root.querySelector(".sh-sum"), $board = root.querySelector(".sh-board"), $status = root.querySelector(".sh-status");
    // A second sideways scrollbar above the sheet, kept in step with the real one (Kyle, Mon 23 Nov 2026: "We need a scrollbar
    // at the top of this, in addition to the one at the bottom").
    // v6.93 (Kyle, Tue 24 Nov 2026: "it jitters and hesitates as it nears the end"): the two bars must have the SAME scroll range
    // (the sheet's own bar is narrower by its vertical scrollbar, so the top bar ran out first and snapped the sheet back), and
    // only the bar being moved leads; the other just follows until it has been still for a moment.
    { const $tb = root.querySelector(".sh-topbar"); let lead = null, t = 0;
      const size = () => { const range = $sc.scrollWidth - $sc.clientWidth, need = range > 1; $tb.hidden = !need;
        if (need) $tb.firstElementChild.style.width = (range + $tb.clientWidth) + "px"; };
      const sync = (src, dst) => () => { if (lead && lead !== src) return; lead = src;
        if (Math.abs(dst.scrollLeft - src.scrollLeft) > 0.5) dst.scrollLeft = src.scrollLeft;
        clearTimeout(t); t = setTimeout(() => lead = null, 120); };
      $sc.addEventListener("scroll", sync($sc, $tb), { passive: true }); $tb.addEventListener("scroll", sync($tb, $sc), { passive: true });
      const ro = new ResizeObserver(size); ro.observe($sc); ro.observe($body); ro.observe($head); }
    // Fill the window (v6.17, Kyle Thu 19 Nov 2026: "this spreadsheet is impossible to work in" at half-screen width).
    function fit(){ if (!cfg.fill || !root.isConnected) return; const top = root.getBoundingClientRect().top + scrollY;
      root.style.height = Math.max(320, Math.floor(innerHeight - top - (cfg.fillGap ?? 14))) + "px"; }
    if (cfg.fill) { root.classList.add("sh-fill"); addEventListener("resize", fit, sig); requestAnimationFrame(fit); setTimeout(fit, 250); }
    else $sc.style.maxHeight = cfg.height || "calc(100vh - 150px)";

    function toolbar(){
      const n = st.filters.length, s = st.sort.length, h = st.hidden.length, k = st.colors.length;
      const cur = views.find(v => v.id === viewId);
      if (cfg.compactBar) {
        // One line (v6.17): the everyday five stay; Group, Colors, Rows, Board, Find & replace, Download, undo/redo and "?" sit under "…".
        $bar.classList.add("compact");
        $bar.innerHTML = `<input class="sh-search" type="search" placeholder="Search" value="${esc(st.q)}" aria-label="Search this sheet">
        <button class="sh-tb ${n?"on":""}" data-t="filter" title="Filter rows">⏷ <span class="lbl">Filter</span>${n?` (${n})`:""}</button>
        <button class="sh-tb ${s?"on":""}" data-t="sort" title="Sort rows">⇅ <span class="lbl">Sort</span>${s?` (${s})`:""}</button>
        <button class="sh-tb ${h?"on":""}" data-t="fields" title="Show, hide and reorder columns${h?` (${h} hidden)`:""}">☰ <span class="lbl">Columns</span></button>
        ${cfg.views ? `<button class="sh-tb sh-vbtn ${viewId?"on":""}" data-t="views" title="Saved views">★ <span class="lbl">View: ${esc(cur ? cur.name : "Default")}</span> ▾</button>` : ""}
        <button class="sh-tb ${st.group || k || st.mode === "board" ? "on" : ""}" data-t="more" title="More: group, colors, row height, board, find and replace, download, undo, shortcuts" aria-haspopup="menu" aria-label="More tools">…</button><span class="sh-host"></span>`;
      } else
      $bar.innerHTML = `<input class="sh-search" type="search" placeholder="Search this sheet" value="${esc(st.q)}" aria-label="Search this sheet">
        <button class="sh-tb ${n?"on":""}" data-t="filter" title="Filter rows">⏷ <span class="lbl">Filter</span>${n?` (${n})`:""}</button>
        <button class="sh-tb ${s?"on":""}" data-t="sort" title="Sort rows">⇅ <span class="lbl">Sort</span>${s?` (${s})`:""}</button>
        <button class="sh-tb ${st.group?"on":""}" data-t="group" title="Group rows">▤ <span class="lbl">Group</span>${st.group&&byKey[st.group]?`: ${esc(byKey[st.group].label)}`:""}</button>
        <button class="sh-tb ${h?"on":""}" data-t="fields" title="Show, hide and reorder columns">☰ <span class="lbl">Columns</span>${h?` (${h} hidden)`:""}</button>
        <button class="sh-tb ${k?"on":""}" data-t="colors" title="Color rows or cells by a rule">◐ <span class="lbl">Colors</span>${k?` (${k})`:""}</button>
        <button class="sh-tb" data-t="height" title="Row height">↕ <span class="lbl">Rows: ${({short:"short",medium:"medium",tall:"tall"})[st.rowH]}</span></button>
        <span class="sh-sep"></span>
        ${cfg.views ? `<button class="sh-tb ${viewId?"on":""}" data-t="views" title="Saved views">★ <span class="lbl">View: ${esc(cur ? cur.name : "Default")}</span> ▾</button>` : ""}
        ${boardCols().length ? `<button class="sh-tb ${st.mode==="board"?"on":""}" data-t="mode" title="Switch between the sheet and a board of cards">${st.mode==="board"?"▦ <span class='lbl'>Sheet</span>":"▥ <span class='lbl'>Board</span>"}</button>` : ""}
        <button class="sh-tb" data-t="find" title="Find and replace (${MOD}+Shift+F)">⌕ <span class="lbl">Find &amp; replace</span></button>
        <button class="sh-tb" data-t="export" title="Download">⤓ <span class="lbl">Download</span></button>
        <span class="sh-sep"></span>
        <button class="sh-tb" data-t="undo" title="Undo (${MOD}+Z)" ${undo.length?"":"disabled"} aria-label="Undo"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg></button>
        <button class="sh-tb" data-t="redo" title="Redo (${MOD}+Shift+Z)" ${redo.length?"":"disabled"} aria-label="Redo"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg></button>
        <button class="sh-tb" data-t="help" title="Keyboard shortcuts (?)">?</button><span class="sh-host"></span>`;
      const q = $bar.querySelector(".sh-search");
      q.oninput = () => { st.q = q.value; compute(); paint(); save(); };
      q.onkeydown = e => { if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); if (vis.length) { sel = { a:{r:0,c:0}, f:{r:0,c:0} }; remember(); paint(); $sc.focus(); } } if (e.key === "Escape") { q.value = ""; q.oninput(); } };
      $bar.querySelectorAll("[data-t]").forEach(b => b.onclick = () => ACT[b.dataset.t](b));
      if (cfg.toolbar) cfg.toolbar($bar.querySelector(".sh-host"));
      vtabs();
    }
    // View tabs (v6.21, Phase 2): a row of saved views above the grid. The first tab is the sheet's own layout (allLabel); then
    // the team's stage views (seed_key, in their set order), then every other view this person can see. "+ view" saves the
    // current filters and layout as a new view, shared with the team unless unticked.
    function vtabs(){
      if (!cfg.viewTabs || !cfg.views) return;
      $vt.hidden = false;
      const list = [...views].sort((a, b) => (a.seed_key ? 0 : 1) - (b.seed_key ? 0 : 1) || (a.position ?? 999) - (b.position ?? 999) || a.name.localeCompare(b.name));
      $vt.innerHTML = [`<button class="sh-vt" role="tab" data-vt="" aria-selected="${!viewId}">${esc(cfg.allLabel || "Default")}</button>`,
        ...list.map(v => `<button class="sh-vt" role="tab" data-vt="${esc(v.id)}" aria-selected="${v.id === viewId}" title="${esc(v.name)}${v.shared ? (v.seed_key ? " (team view)" : " (shared" + (v.mine ? "" : " by " + (v.ownerName || "a teammate")) + ")") : " (only you)"}">${esc(v.name)}</button>`),
        `<button class="sh-vt add" data-vadd title="Save the current filters and columns as a new view">+ view</button>`].join("");
      $vt.querySelectorAll("[data-vt]").forEach(b => b.onclick = () => useView(b.dataset.vt));
      $vt.querySelector("[data-vadd]").onclick = e => pop(e.target, `<h4>Save as a new view</h4><div class="pane"><input type="text" data-n placeholder="Name, e.g. Agency to vet"><label class="chk"><input type="checkbox" data-sh checked> Share it with the team</label><button class="btn sm primary" data-a="new">Save view</button><p class="hint">Keeps the filters, sorting, columns and widths showing now. Never changes any data.</p></div>`, p => {
        const go = async () => { const name = p.querySelector("[data-n]").value.trim(); if (!name) return p.querySelector("[data-n]").focus();
          try { const v = await cfg.views.save({ name, shared: p.querySelector("[data-sh]").checked, state: snap() }); closePop(); if (!viewId) defSt = snap(); viewId = v.id; await loadViews(); save(); say(`Saved the "${name}" view.`); } catch (err) { say("Couldn't save the view: " + err.message); } };
        p.querySelector('[data-a="new"]').onclick = go; p.querySelector("[data-n]").onkeydown = ev => { if (ev.key === "Enter") { ev.preventDefault(); go(); } }; setTimeout(() => p.querySelector("[data-n]").focus(), 0); });
      $vt.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    // Switching views keeps the person's own layout for the first tab: it's put aside when they pick a view and comes back after.
    let defSt = null;
    function useView(id){
      if (id === viewId) return;
      if (!viewId) defSt = snap();
      viewId = id; const v = views.find(x => x.id === id);
      if (v) apply(v.state); else { apply(defSt || {}); defSt = null; }
      rowSel.clear(); save(); paint();
    }
    const ACT = { filter: filterPop, sort: sortPop, group: groupPop, fields: fieldsPop, colors: colorsPop, height: heightPop, views: viewsPop,
      mode: () => { st.mode = st.mode === "board" ? "grid" : "board"; if (!st.boardKey) st.boardKey = boardCols()[0]?.key || ""; full(); save(); }, find: findPop, export: exportPop, undo: doUndo, redo: doRedo, help: helpPop, more: morePop };
    // A toolbar button to anchor a pop-up on; in the one-line toolbar the tools under "…" anchor on "…".
    const anchor = t => $bar.querySelector(`[data-t="${t}"]`) || $bar.querySelector('[data-t="more"]') || $bar;
    function morePop(b){
      const k = st.colors.length;
      const items = [["group", `▤ Group${st.group && byKey[st.group] ? `: ${esc(byKey[st.group].label)}` : ""}`], ["colors", `◐ Colors${k ? ` (${k})` : ""}`],
        ["height", `↕ Row height: ${({ short:"short", medium:"medium", tall:"tall" })[st.rowH]}`],
        boardCols().length && ["mode", st.mode === "board" ? "▦ Back to the sheet" : "▥ Board (cards in lanes)"],
        ["find", `⌕ Find &amp; replace <kbd>${MOD}+Shift+F</kbd>`], ["export", "⤓ Download"],
        ["undo", `↶ Undo <kbd>${MOD}+Z</kbd>`, !undo.length], ["redo", `↷ Redo <kbd>${MOD}+Shift+Z</kbd>`, !redo.length],
        ["help", "? Keyboard shortcuts <kbd>?</kbd>"]].filter(Boolean);
      pop(b, items.map(([t, l, off]) => `<button class="mi" data-mt="${t}" ${off ? "disabled" : ""}>${l}</button>`).join(""), p => {
        p.querySelectorAll("[data-mt]").forEach(x => x.onclick = () => { const t = x.dataset.mt; closePop(); ACT[t](b); }); });
    }
    // cfg.bulk may be a function of the current saved view (v6.21): each stage view shows that stage's actions.
    const bulkList = () => (typeof cfg.bulk === "function" ? cfg.bulk(views.find(v => v.id === viewId) || null) : cfg.bulk) || [];
    function bulkBar(){
      const n = [...rowSel].filter(k => data.some(r => rk(r) === k)).length;
      $bulk.hidden = !n; if (!n) return;
      $bulk.innerHTML = `<b>${n.toLocaleString()} row${n>1?"s":""} selected</b>
        ${bulkList().map((b,i) => `<button class="btn sm ${i===0?"primary":""}" data-bh="${i}">${esc(b.label)}</button>`).join("")}
        ${cols.some(c => c.editable) ? `<button class="btn sm" data-b="set">Change a field for all ${n}</button>` : ""}
        <button class="btn sm" data-b="copy">Copy rows</button><button class="btn sm" data-b="export">Download these rows</button>
        <button class="btn sm" data-b="clear">Clear selection</button>`;
      $bulk.querySelector('[data-b="set"]')?.addEventListener("click", e => setFieldPop(e.target));
      $bulk.querySelector('[data-b="copy"]').onclick = () => { const rows = selectedRows(); copyText(rowsToTSV(rows, vc)); say(`Copied ${rows.length} rows. Paste them into Google Sheets or Excel.`); };
      $bulk.querySelector('[data-b="export"]').onclick = e => exportPop(e.target, true);
      $bulk.querySelector('[data-b="clear"]').onclick = () => { rowSel.clear(); paint(); };
      $bulk.querySelectorAll("[data-bh]").forEach(b => b.onclick = () => bulkList()[+b.dataset.bh].run(selectedRows()));
    }
    function header(){
      const sortOf = k => st.sort.findIndex(s => s.key === k), filtered = k => st.filters.some(f => f.key === k);
      const bx = box(), all = vis.length && vis.every(r => rowSel.has(rk(r)));
      $head.innerHTML = `<div class="sh-hrow" style="width:${totalW}px"><div class="sh-g" style="width:${G}px;height:${HEAD}px"><input type="checkbox" data-all ${all?"checked":""} title="Select every row shown" aria-label="Select every row shown"></div>${vc.map((c, i) => {
        const si = sortOf(c.key), s = si >= 0 ? st.sort[si] : null;
        return `<div class="sh-h ${i<fz?"sh-fz":""} ${i===fz-1?"sh-fzlast":""} ${bx && bx.r0===0 && bx.r1===vis.length-1 && i>=bx.c0 && i<=bx.c1?"csel":""}" data-hc="${i}" style="width:${ws[i]}px;${i<fz?`left:${xs[i]}px;`:""}" title="${esc(c.hint || c.label)}${c.editable?"":" (read-only)"}">
          <span class="sh-hl" title="${esc(c.label)}">${esc(c.label)}</span>${s?`<span class="sh-hi">${s.dir==="asc"?"▲":"▼"}${st.sort.length>1?si+1:""}</span>`:""}${filtered(c.key)?`<span class="sh-hi" title="Filtered">⏷</span>`:""}
          <button class="sh-hm" data-hm="${i}" title="More for this column" aria-label="More for ${esc(c.label)}">▾</button><span class="sh-rz" data-rz="${i}" title="Drag to resize. Double-click to fit."></span></div>`; }).join("")}</div>`;
    }
    function summary(){
      // Off unless a sheet asks for it (Kyle, Thu 12 Nov 2026: not wanted on Vetting, then "We do not need this in all leads").
      if (!cfg.summary) { $sum.hidden = true; $sum.style.display = "none"; return; }
      $sum.style.width = totalW + "px";
      $sum.innerHTML = `<div class="sh-g" style="width:${G}px">${vis.length.toLocaleString()}</div>` + vc.map((c, i) => {
        const k = st.sums[c.key] || (NUMERIC(c.type) ? "sum" : "filled");
        return `<div class="sh-s ${i<fz?"sh-fz":""}" data-sc="${i}" style="width:${ws[i]}px;${i<fz?`left:${xs[i]}px;`:""}" title="Click to change what this shows">${k==="none"?"":esc(sumText(c, k))}</div>`; }).join("");
    }
    function sumText(c, k){
      const rows = vis, n = rows.length, f = rows.filter(r => !empty(c, r)).length;
      const nums = () => rows.map(r => val(c, r)).filter(v => v !== null && v !== undefined && v !== "" && !isNaN(+v)).map(Number);
      const fmtN = x => (Math.round(x * 100) / 100).toLocaleString();
      switch (k) {
        case "filled": return `${f.toLocaleString()} filled`;
        case "empty": return `${(n - f).toLocaleString()} empty`;
        case "unique": return `${new Set(rows.map(r => text(c, r).toLowerCase()).filter(Boolean)).size.toLocaleString()} unique`;
        case "pct": return n ? `${Math.round(f / n * 100)}% filled` : "";
        case "sum": { const a = nums(); return a.length ? `Sum ${fmtN(a.reduce((x,y)=>x+y,0))}` : ""; }
        case "avg": { const a = nums(); return a.length ? `Average ${fmtN(a.reduce((x,y)=>x+y,0) / a.length)}` : ""; }
        case "min": { const a = nums(); return a.length ? `Smallest ${fmtN(Math.min(...a))}` : ""; }
        case "max": { const a = nums(); return a.length ? `Largest ${fmtN(Math.max(...a))}` : ""; }
        case "checked": return `${rows.filter(r => val(c, r)).length.toLocaleString()} checked`;
        case "earliest": case "latest": { const d = rows.map(r => val(c, r)).filter(Boolean).map(String).sort(); return d.length ? (k === "earliest" ? "Earliest " : "Latest ") + fmtDate(k === "earliest" ? d[0] : d[d.length-1]) : ""; }
      }
      return "";
    }

    function display(c, row, q){
      if (c.html) return c.html(row);
      const v = val(c, row);
      const hl = s => { s = esc(s); if (!q) return s; const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"); return s.replace(re, m => `<mark>${m}</mark>`); };
      if (v === null || v === undefined || v === "") return "";
      switch (c.type) {
        case "check": return `<span class="sh-chk ${v?"on":""}">${v?"✓":""}</span>`;
        case "url": { const s = String(v); return /^https?:\/\//i.test(s) ? `<a href="${esc(s)}" target="_blank" rel="noopener" title="${esc(s)}">${hl(s.replace(/^https?:\/\/(www\.)?/i, ""))}</a>` : hl(s); }
        case "email": return hl(String(v));
        case "select": { const l = text(c, row); return c.pill ? `<span class="pill ${esc(c.pill(v))}">${hl(l)}</span>` : hl(l); }
        case "multi": return (Array.isArray(v) ? v : [v]).map(x => `<span class="sh-chip">${hl(x)}</span>`).join("");
        case "date": return esc(fmtDate(v));
        case "datetime": return esc(fmtTime(v));
        case "money": return isNaN(+v) ? hl(v) : "$" + (+v).toLocaleString();
        case "number": return isNaN(+v) ? hl(v) : (+v).toLocaleString();
        case "percent": return isNaN(+v) ? hl(v) : (+v).toLocaleString() + "%";
      }
      const s = text(c, row);
      if (/^https?:\/\/\S+$/i.test(s)) return `<a href="${esc(s)}" target="_blank" rel="noopener" title="${esc(s)}">${hl(s.replace(/^https?:\/\/(www\.)?/i, ""))}</a>`;
      return hl(s);
    }
    const ready = f => byKey[f.key] && (noValue(f.op) || (Array.isArray(f.value) ? f.value.length : f.value !== "" && f.value !== undefined && f.value !== null));
    function colorOf(row, where){ for (const k of st.colors) { if (!ready(k)) continue; if ((k.where || "row") !== where.w || (where.w === "cell" && k.key !== where.key)) continue; if (test(k, row)) return "k-" + k.color; } return ""; }

    function paint(){ cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }
    function draw(){
      if (!root.isConnected) return destroy();
      if (st.mode === "board") return;
      const rh = RH(), top = Math.max(0, $sc.scrollTop - HEAD), h = $sc.clientHeight || 600;
      const i0 = Math.max(0, itemAt(top) - 6), i1 = Math.min(items.length, itemAt(top + h) + 7);
      $body.style.height = bodyH + "px"; $body.style.width = totalW + "px";
      const bx = box(), q = st.q.trim(), fb = fill && fillBox(), out = [];
      for (let ii = i0; ii < i1; ii++) {
        const it = items[ii], y = iy[ii], rh = ih[ii];
        if (it.type === "g") { out.push(`<div class="sh-grp" data-g="${esc(it.label)}" style="top:${y}px;height:${rh}px;width:${totalW}px"><span>${st.collapsed.includes(it.label)?"▸":"▾"} ${esc(it.col.label)}: ${esc(it.label)} <small>${it.n.toLocaleString()}</small></span></div>`); continue; }
        const r = it.i, row = vis[r], key = rk(row), rs = rowSel.has(key);
        const rc = [cfg.rowClass?.(row) || "", colorOf(row, { w:"row" }), rs ? "rsel" : "", drawerRow !== null && key === drawerRow ? "sh-open" : ""].join(" ");
        let cells = `<div class="sh-g" style="width:${G}px;height:${rh}px"><input type="checkbox" data-rs="${r}" ${rs?"checked":""} aria-label="Select row"><span class="sh-n">${esc(cfg.rowNumber ? cfg.rowNumber(row) : r + 1)}</span><button class="sh-x" data-x="${r}" title="Expand this row (Space)" aria-label="Expand row">⤢</button></div>`;
        vc.forEach((c, i) => {
          const inSel = bx && r >= bx.r0 && r <= bx.r1 && i >= bx.c0 && i <= bx.c1, act = sel && sel.a.r === r && sel.a.c === i;
          const inFill = fb && r >= fb.r0 && r <= fb.r1 && i >= fb.c0 && i <= fb.c1 && !inSel;
          const ed = canEditCell(c, row), was = chg[key + "\u0001" + c.key];
          const cls = ["sh-c", i < fz ? "sh-fz" : "", i === fz-1 ? "sh-fzlast" : "", ed ? "" : "ro", NUMERIC(c.type) ? "num" : "", c.mono ? "mono" : "", (st.wrap.includes(c.key) || c.wrap) ? "wrap" : "",
            cfg.cellClass?.(row, c) || "", colorOf(row, { w:"cell", key:c.key }), was !== undefined ? "chg" : "", inSel ? "sel" : "", act ? "act" : "", inFill ? "fillx" : "",
            found && found.r === r && found.c === i ? "found" : ""].filter(Boolean).join(" ");
          const note = cfg.cellTip?.(row, c) || "";
          const tip = [note, was !== undefined ? `Was: ${was === "" || was === null || was === undefined ? "(empty)" : Array.isArray(was) ? was.join(", ") : was}` : text(c, row)].filter(Boolean).join("\n");
          const handle = bx && r === bx.r1 && i === bx.c1 && !editing ? `<i class="sh-fh" data-fh title="Drag to fill"></i>` : "";
          cells += `<div class="${cls}" data-r="${r}" data-c="${i}" role="gridcell" style="width:${ws[i]}px;height:${rh}px;${i<fz?`left:${xs[i]}px;`:""}" title="${esc(String(tip).slice(0, 400))}"><span class="sh-t">${display(c, row, q)}</span>${handle}</div>`;
        });
        out.push(`<div class="sh-row ${r % 2 ? "z" : ""} ${rc}" data-ri="${r}" style="top:${y}px;height:${rh}px;width:${totalW}px">${cells}</div>`);
      }
      $body.innerHTML = out.join("") || (data.length ? `<div class="sh-empty">No rows match. <button class="btn sm" data-clearall>Clear the search and filters</button></div>` : `<div class="sh-empty">${esc(cfg.empty || "Nothing here yet.")}</div>`);
      $body.querySelector("[data-clearall]")?.addEventListener("click", () => { st.q = ""; st.filters = []; full(); save(); });
      header(); summary(); bulkBar(); statusBar();
      root.classList.toggle("h-medium", st.rowH === "medium"); root.classList.toggle("h-tall", st.rowH === "tall");
      if (editing) placeEditor();
    }
    function statusBar(){
      const bx = box(); let selTxt = "";
      if (bx && (bx.r1 > bx.r0 || bx.c1 > bx.c0)) {
        const nums = []; let n = 0;
        for (let r = bx.r0; r <= bx.r1; r++) for (let c = bx.c0; c <= bx.c1; c++) { n++; const v = val(vc[c], vis[r]); if (NUMERIC(vc[c].type) && v !== null && v !== "" && !isNaN(+v)) nums.push(+v); }
        selTxt = `${n.toLocaleString()} cells selected` + (nums.length ? ` · Sum ${nums.reduce((a,b)=>a+b,0).toLocaleString()} · Average ${(Math.round(nums.reduce((a,b)=>a+b,0)/nums.length*100)/100).toLocaleString()}` : "");
      } else if (sel && vc[sel.a.c] && vis[sel.a.r]) selTxt = `${esc(vc[sel.a.c].label)}${canEditCell(vc[sel.a.c], vis[sel.a.r]) ? "" : " (read-only)"}`;
      const vl = viewLabel(); if (vl !== lastLabel) { lastLabel = vl; cfg.onView?.(vl); }
      $status.innerHTML = `<span class="sh-vname" title="The view you're looking at, and how many rows it shows">${esc(vl)}</span>${selTxt ? `<span>${selTxt}</span>` : ""}<span class="sh-saving ${statusErr?"err":""}">${busy ? "Saving…" : esc(statusMsg)}</span>`;
    }
    // The name of what's showing (v6.17): the saved view's name, or a short description of the filters and search.
    let lastLabel = null;
    function describeView(){
      const cur = views.find(v => v.id === viewId);
      const one = f => { const c = byKey[f.key], L = c.label, vals = Array.isArray(f.value) ? f.value.map(v => v === "" ? "(empty)" : String(label(c, v) ?? v)) : [];
        switch (f.op) {
          case "any": return c.bare ? vals.join(" or ") : `${L}: ${vals.join(" or ")}`;
          case "none": return `${L}: not ${vals.join(" or ")}`;
          case "empty": return `${L} empty`; case "not_empty": return `${L} filled`;
          case "yes": return L; case "no": return `Not ${L.toLowerCase()}`;
        }
        const opl = ((OPS[opKind(c.type)] || []).find(o => o[0] === f.op) || [, f.op])[1];
        return `${L} ${opl.replace(" … ", ` ${f.value} `)}${/…/.test(opl) ? "" : " " + f.value}`; };
      const fl = st.filters.filter(ready), q = st.q.trim();
      let s = cur ? cur.name : fl.map(one).join(st.conj === "or" ? " or " : " · ");
      if (q) s = (s ? s + " · " : "") + `“${q}”`;
      if (!s) s = cfg.allLabel || cfg.label || "All rows";
      return s.length > 70 ? s.slice(0, 68) + "…" : s;
    }
    function viewLabel(){ const shown = vis.length, total = data.length; return `${describeView()} · ${shown !== total ? `${shown.toLocaleString()} of ${total.toLocaleString()}` : total.toLocaleString()}`; }
    function full(){ compute(); toolbar(); if (st.mode === "board") { $sc.hidden = true; $board.hidden = false; drawBoard(); statusBar(); } else { $sc.hidden = false; $board.hidden = true; draw(); } }

    // ---------- Edits ----------
    function parse(c, s){
      if (s === null || s === undefined) s = "";
      if (typeof s !== "string") return { v: s };
      const t = s.trim();
      switch (c.type) {
        case "number": case "money": { if (!t) return { v:null }; const n = +t.replace(/[$,\s]/g, ""); return isNaN(n) ? { err:`"${t}" isn't a number` } : { v:n }; }
        case "check": return { v: /^(y|yes|true|1|x|✓|✔|on|checked)$/i.test(t) };
        case "select": { if (!t) return { v:null }; const o = opts(c).find(o => String(o.l).toLowerCase() === t.toLowerCase() || String(o.v).toLowerCase() === t.toLowerCase());
          return o ? { v:o.v } : c.allowNew ? { v:t } : { err:`"${t}" isn't one of the choices for ${c.label}` }; }
        case "multi": return { v: t ? t.split(/[,\n;]+/).map(x => x.trim()).filter(Boolean) : [] };
        case "date": { if (!t) return { v:null }; let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return { v:`${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}` };
          m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return { v:`${y}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}` }; }
          const d = new Date(t); return isNaN(d) ? { err:`"${t}" isn't a date` } : { v: isoDay(d) }; }
        case "email": { if (!t) return { v:null }; const e = t.replace(/^mailto:/i, ""); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || c.loose ? { v: c.loose ? t : e.toLowerCase() } : { err:`"${t}" isn't an email address` }; }
        default: return { v: t === "" ? (c.blank ?? null) : (c.type === "long" ? s : t) };
      }
    }
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || ((a ?? "") === "" && (b ?? "") === "");
    async function commit(list, { raw = false, quiet = false, tag = "" } = {}){
      const out = [], errs = [];
      list.forEach(({ row, key, value, raw: rawOne }) => {
        const c = byKey[key]; if (!c || !row || !canEditCell(c, row)) return;
        const p = raw || rawOne ? { v: value } : parse(c, value);
        if (p.err) return errs.push(p.err);
        if (!p.err && c.validate) { const e = c.validate(p.v, row); if (e) return errs.push(e); }
        const old = val(c, row); if (same(old, p.v)) return;
        out.push({ row, rk: rk(row), key, old, value: p.v });
      });
      if (errs.length) { say(errs.length > 1 ? `${errs[0]} (and ${errs.length - 1} more). Those cells weren't changed.` : `${errs[0]}. Not changed.`); }
      if (!out.length) return false;
      return run(out, tag);
    }
    // Saves run one after another, so a second edit to a row never races the first.
    let queue = Promise.resolve();
    function run(changes, tag){ busy++; statusBar(); const p = queue.then(() => run1(changes, tag)); queue = p.catch(() => {}); return p; }
    async function run1(changes, tag){
      changes.forEach(ch => { const fresh = data.find(r => rk(r) === ch.rk); if (fresh) ch.row = fresh; }); statusErr = false; statusBar();
      try { await cfg.onEdit(changes);
        changes.forEach(ch => { const k = ch.rk + "\u0001" + ch.key; if (!(k in chg)) chg[k] = ch.old; else if (same(chg[k], ch.value)) delete chg[k]; });
        if (tag !== "undo" && tag !== "redo") { undo.push(changes); if (undo.length > 200) undo.shift(); redo = []; }
        statusMsg = `Saved ${changes.length === 1 ? "1 change" : changes.length.toLocaleString() + " changes"} · ${new Date().toLocaleTimeString([], { hour:"numeric", minute:"2-digit" })}`; return true;
      } catch (e) { statusErr = true; statusMsg = "Not saved: " + (e.message || e); say("Not saved: " + (e.message || e)); return false; }
      finally { busy--; toolbar(); paint(); }
    }
    async function doUndo(){ const b = undo.pop(); if (!b) return; const back = b.map(ch => ({ ...ch, row: data.find(r => rk(r) === ch.rk), old: ch.value, value: ch.old })).filter(ch => ch.row);
      if (await run(back, "undo")) { redo.push(b); say(`Undone (${b.length === 1 ? "1 change" : b.length + " changes"}).`); } else undo.push(b); toolbar(); }
    async function doRedo(){ const b = redo.pop(); if (!b) return; const fwd = b.map(ch => ({ ...ch, row: data.find(r => rk(r) === ch.rk) })).filter(ch => ch.row);
      if (await run(fwd, "redo")) { undo.push(b); say("Redone."); } else redo.push(b); toolbar(); }

    // ---------- Cell editor ----------
    function cellBox(r, c){ const ii = itemOf[r], y = HEAD + iy[ii], left = c < fz ? xs[c] + $sc.scrollLeft : xs[c]; return { x:left, y, w:ws[c], h:ih[ii] }; }
    function placeEditor(){ if (!editing) return; const b = cellBox(editing.r, editing.c), el = editing.el;
      el.style.left = b.x + "px"; el.style.top = b.y + "px"; el.style.minWidth = b.w + "px"; if (el.tagName !== "DIV") el.style.width = Math.max(b.w, editing.wide || 0) + "px"; }
    function startEdit(seed){
      if (!sel || editing) return; const r = sel.a.r, c = sel.a.c, col = vc[c], row = vis[r];
      if (!canEditCell(col, row)) { say(`${col.label} can't be changed here.`); return; }
      if (col.type === "check") { commit([{ row, key: col.key, value: !val(col, row) }], { raw:true }); return; }
      scrollTo(r, c);
      if (col.type === "select") return pickEditor(r, c, seed);
      const long = col.type === "long" || col.long || col.type === "multi" || st.rowH !== "short";
      const el = document.createElement(long ? "textarea" : "input"); el.className = "sh-ed";
      if (!long) el.type = col.type === "date" ? "date" : NUMERIC(col.type) ? "text" : "text";
      const cur = col.type === "multi" ? (val(col, row) || []).join(", ") : col.type === "date" ? (val(col, row) || "") : text(col, row);
      el.value = seed !== undefined ? seed : cur; if (long) el.rows = Math.max(2, Math.min(8, String(el.value).split("\n").length + 1));
      editing = { r, c, el, wide: long ? Math.max(ws[c], 320) : Math.max(ws[c], 200) }; $sc.appendChild(el); placeEditor(); el.focus();
      if (col.type !== "date") { try { el.setSelectionRange(el.value.length, el.value.length); } catch {} }
      const done = (move) => { if (!editing || editing.el !== el) return; const v = el.value; editing = null; el.remove(); $sc.focus({ preventScroll:true });
        if (move !== "cancel") commit([{ row, key: col.key, value: v }]); if (move && move !== "cancel") moveBy(move === "down" ? 1 : move === "up" ? -1 : 0, move === "right" ? 1 : move === "left" ? -1 : 0, false); else paint(); };
      el.onkeydown = e => { e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); done("cancel"); }
        else if (e.key === "Enter" && !(long && (e.altKey || e.shiftKey))) { e.preventDefault(); done(e.shiftKey ? "up" : "down"); }
        else if (e.key === "Tab") { e.preventDefault(); done(e.shiftKey ? "left" : "right"); } };
      el.onblur = () => setTimeout(() => done(), 0);
    }
    function pickEditor(r, c, seed){
      const col = vc[c], row = vis[r], o = opts(col), cur = val(col, row);
      const el = document.createElement("div"); el.className = "sh-pick";
      el.innerHTML = `<input placeholder="Type to find a choice" value="${esc(seed || "")}"><ul role="listbox"></ul>`;
      editing = { r, c, el }; $sc.appendChild(el); placeEditor();
      const inp = el.querySelector("input"), ul = el.querySelector("ul"); let hi = 0, list = [];
      const drawL = () => { const t = inp.value.trim().toLowerCase(); list = [{ v:null, l:"(empty)" }, ...o].filter(x => !t || x.l.toLowerCase().includes(t));
        hi = Math.min(hi, Math.max(0, list.length-1));
        ul.innerHTML = list.map((x, i) => `<li data-i="${i}" class="${i===hi?"on":""} ${same(x.v, cur)?"cur":""}">${esc(x.l)}</li>`).join("") || `<li class="muted">No match</li>`;
        ul.children[hi]?.scrollIntoView({ block:"nearest" }); };
      const done = (pick, move) => { if (!editing || editing.el !== el) return; editing = null; el.remove(); $sc.focus({ preventScroll:true });
        if (pick) commit([{ row, key: col.key, value: pick.v }], { raw:true }); if (move) moveBy(move, 0, false); else paint(); };
      inp.oninput = () => { hi = 0; drawL(); if (inp.value.trim() && list.length > 1 && list[0].v === null) { hi = 1; drawL(); } };
      inp.onkeydown = e => { e.stopPropagation();
        if (e.key === "ArrowDown") { e.preventDefault(); hi = Math.min(list.length-1, hi+1); drawL(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); hi = Math.max(0, hi-1); drawL(); }
        else if (e.key === "Enter") { e.preventDefault(); done(list[hi], 1); }
        else if (e.key === "Tab") { e.preventDefault(); done(list[hi]); moveBy(0, e.shiftKey ? -1 : 1, false); }
        else if (e.key === "Escape") { e.preventDefault(); done(null); } };
      ul.onmousedown = e => { const li = e.target.closest("li[data-i]"); if (!li) return; e.preventDefault(); done(list[+li.dataset.i]); };
      inp.onblur = () => setTimeout(() => done(null), 0);
      drawL(); if (seed) inp.oninput(); else { hi = Math.max(0, list.findIndex(x => same(x.v, cur))); drawL(); } inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
    }

    // ---------- Selection and moving ----------
    function scrollTo(r, c){
      const ii = itemOf[r]; if (ii === undefined) return; const rh = ih[ii], y = iy[ii], vh = $sc.clientHeight - HEAD - SUM;
      if (y < $sc.scrollTop) $sc.scrollTop = y; else if (y + rh > $sc.scrollTop + vh) $sc.scrollTop = y + rh - vh;
      if (c !== undefined && c >= fz) { const fzW = fz ? xs[fz-1] + ws[fz-1] : G, x = xs[c], w = ws[c];
        if (x - fzW < $sc.scrollLeft) $sc.scrollLeft = x - fzW; else if (x + w > $sc.scrollLeft + $sc.clientWidth) $sc.scrollLeft = x + w - $sc.clientWidth; }
    }
    function select(r, c, extend){ if (!vis.length || !vc.length) return; r = Math.max(0, Math.min(vis.length-1, r)); c = Math.max(0, Math.min(vc.length-1, c));
      if (extend && sel) sel.f = { r, c }; else sel = { a:{ r, c }, f:{ r, c } }; found = null; remember(); scrollTo(extend ? r : r, c); paint(); }
    function moveBy(dr, dc, extend){ if (!sel) return select(0, 0); const p = extend ? sel.f : sel.a; select(p.r + dr, p.c + dc, extend); }

    function rangeText(bx){ const lines = []; for (let r = bx.r0; r <= bx.r1; r++) { const a = []; for (let c = bx.c0; c <= bx.c1; c++) a.push(tsvCell(text(vc[c], vis[r]))); lines.push(a.join("\t")); } return lines.join("\n"); }
    const rowsToTSV = (rows, cs) => [cs.map(c => tsvCell(c.label)).join("\t"), ...rows.map(r => cs.map(c => tsvCell(text(c, r))).join("\t"))].join("\n");
    async function copyText(t){ try { await navigator.clipboard.writeText(t); } catch { const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); } }
    function clearRange(){ const bx = box(); if (!bx) return; const list = [];
      for (let r = bx.r0; r <= bx.r1; r++) for (let c = bx.c0; c <= bx.c1; c++) { const col = vc[c]; list.push({ row: vis[r], key: col.key, value: col.type === "check" ? false : col.type === "multi" ? [] : null }); }
      commit(list, { raw:true }); }
    function pasteText(t){
      if (!sel) return; const grid = parseTSV(t).filter((r, i, a) => !(i === a.length - 1 && r.length === 1 && r[0] === "")); if (!grid.length) return;
      const bx = box(), list = [];
      if (grid.length === 1 && grid[0].length === 1 && (bx.r1 > bx.r0 || bx.c1 > bx.c0)) {   // one value into a range: fill it
        for (let r = bx.r0; r <= bx.r1; r++) for (let c = bx.c0; c <= bx.c1; c++) list.push({ row: vis[r], key: vc[c].key, value: grid[0][0] });
      } else {
        grid.forEach((line, dr) => line.forEach((v, dc) => { const r = bx.r0 + dr, c = bx.c0 + dc; if (vis[r] && vc[c]) list.push({ row: vis[r], key: vc[c].key, value: v }); }));
        const r1 = Math.min(vis.length-1, bx.r0 + grid.length - 1), c1 = Math.min(vc.length-1, bx.c0 + Math.max(...grid.map(l => l.length)) - 1);
        sel = { a:{ r:bx.r0, c:bx.c0 }, f:{ r:r1, c:c1 } }; remember();
        if (bx.r0 + grid.length > vis.length) say(`Only ${vis.length - bx.r0} of the ${grid.length} pasted rows fit; the rest were left off.`);
      }
      commit(list);
    }
    function fillDown(){ const bx = box(); if (!bx) return; const list = [];
      if (bx.r1 === bx.r0) { if (bx.r0 === 0) return; for (let c = bx.c0; c <= bx.c1; c++) list.push({ row: vis[bx.r0], key: vc[c].key, value: val(vc[c], vis[bx.r0 - 1]) }); }
      else for (let r = bx.r0 + 1; r <= bx.r1; r++) for (let c = bx.c0; c <= bx.c1; c++) list.push({ row: vis[r], key: vc[c].key, value: val(vc[c], vis[bx.r0]) });
      commit(list, { raw:true }); }
    function fillBox(){ const bx = box(); if (!fill || !bx) return null; const t = fill.to;
      if (t.r > bx.r1) return { r0: bx.r1 + 1, r1: t.r, c0: bx.c0, c1: bx.c1, dir:"down" };
      if (t.r < bx.r0) return { r0: t.r, r1: bx.r0 - 1, c0: bx.c0, c1: bx.c1, dir:"up" };
      if (t.c > bx.c1) return { r0: bx.r0, r1: bx.r1, c0: bx.c1 + 1, c1: t.c, dir:"right" };
      if (t.c < bx.c0) return { r0: bx.r0, r1: bx.r1, c0: t.c, c1: bx.c0 - 1, dir:"left" };
      return null; }
    function applyFill(){ const bx = box(), fb = fillBox(); fill = null; if (!fb) return paint(); const list = [], h = bx.r1 - bx.r0 + 1, w = bx.c1 - bx.c0 + 1;
      for (let r = fb.r0; r <= fb.r1; r++) for (let c = fb.c0; c <= fb.c1; c++) {
        const sr = fb.dir === "down" ? bx.r0 + (r - fb.r0) % h : fb.dir === "up" ? bx.r1 - (fb.r1 - r) % h : r;
        const sc = fb.dir === "right" ? bx.c0 + (c - fb.c0) % w : fb.dir === "left" ? bx.c1 - (fb.c1 - c) % w : c;
        const from = vc[sc], to = vc[c]; list.push({ row: vis[r], key: to.key, value: from === to ? val(from, vis[sr]) : text(from, vis[sr]), raw: from === to });
      }
      sel = { a:{ r: Math.min(bx.r0, fb.r0), c: Math.min(bx.c0, fb.c0) }, f:{ r: Math.max(bx.r1, fb.r1), c: Math.max(bx.c1, fb.c1) } }; remember();
      commit(list); paint(); }

    // ---------- Mouse ----------
    const cellAt = (x, y) => { const el = document.elementFromPoint(x, y)?.closest?.(".sh-c[data-r]"); return el && root.contains(el) ? { r: +el.dataset.r, c: +el.dataset.c } : null; };
    $sc.addEventListener("mousedown", e => {
      if (e.button !== 0) return;
      const t = e.target;
      if (t.closest(".sh-ed,.sh-pick")) return;
      if (t.closest(".sh-rz")) return startResize(e, +t.closest(".sh-rz").dataset.rz);
      if (t.closest(".sh-hm")) { e.preventDefault(); return colMenu(t.closest(".sh-hm"), +t.closest(".sh-hm").dataset.hm); }
      const h = t.closest(".sh-h[data-hc]"); if (h) return startHeaderDrag(e, +h.dataset.hc);
      if (t.closest(".sh-s[data-sc]")) return sumMenu(t.closest(".sh-s"), +t.closest(".sh-s").dataset.sc);
      if (t.closest("[data-fh]")) { e.preventDefault(); const bx = box(); fill = { to:{ r: bx.r1, c: bx.c1 } }; drag = "fill"; return; }
      const g = t.closest(".sh-grp"); if (g) { const k = g.dataset.g; st.collapsed = st.collapsed.includes(k) ? st.collapsed.filter(x => x !== k) : [...st.collapsed, k]; compute(); paint(); save(); return; }
      if (t.closest("a,button,input,select,textarea,label")) return;   // links and the host's buttons in cells work as normal
      const c = t.closest(".sh-c[data-r]"); if (!c) return;
      e.preventDefault(); $sc.focus({ preventScroll:true });
      const r = +c.dataset.r, ci = +c.dataset.c;
      select(r, ci, e.shiftKey); drag = "sel";
    }, sig);
    // Double-click (v6.17): with a docked pane, the row number or the name cell opens the row in the pane; every other cell
    // edits as before (the name still edits with Enter, F2 or typing, or in the pane).
    $sc.addEventListener("dblclick", e => { const z = e.target.closest(".sh-rz"); if (z) { fitWidth(+z.dataset.rz); return; }
      if (cfg.dock && !e.target.closest("a,button,input")) { const g = e.target.closest(".sh-row .sh-g"), oc = e.target.closest(".sh-c[data-r]");
        if (g || (oc && vc[+oc.dataset.c]?.key === (cfg.openKey || vc[0]?.key))) { const r = g ? +g.closest(".sh-row").dataset.ri : +oc.dataset.r;
          window.getSelection?.()?.removeAllRanges(); select(r, oc ? +oc.dataset.c : 0); openDrawer(vis[r]); return; } }
      const c = e.target.closest(".sh-c[data-r]"); if (!c || e.target.closest("a,button")) return; select(+c.dataset.r, +c.dataset.c); startEdit(); }, sig);
    window.addEventListener("mousemove", e => {
      if (!drag) return; const p = cellAt(e.clientX, e.clientY);
      const rc = $sc.getBoundingClientRect(); if (e.clientY > rc.bottom - 24) $sc.scrollTop += 18; else if (e.clientY < rc.top + HEAD + 10) $sc.scrollTop -= 18;
      if (e.clientX > rc.right - 24) $sc.scrollLeft += 18; else if (e.clientX < rc.left + 30) $sc.scrollLeft -= 18;
      if (!p) return;
      if (drag === "sel") { if (sel.f.r !== p.r || sel.f.c !== p.c) { sel.f = p; remember(); paint(); } }
      else if (drag === "fill") { const bx = box(); const dr = p.r > bx.r1 ? p.r - bx.r1 : p.r < bx.r0 ? bx.r0 - p.r : 0, dcol = p.c > bx.c1 ? p.c - bx.c1 : p.c < bx.c0 ? bx.c0 - p.c : 0;
        fill.to = dr >= dcol ? { r: p.r, c: bx.c1 } : { r: bx.r1, c: p.c }; paint(); }
    }, sig);
    window.addEventListener("mouseup", () => { if (drag === "fill") applyFill(); drag = null; }, sig);
    $sc.addEventListener("click", e => {
      const cb = e.target.closest("[data-rs]"); if (cb) { const r = +cb.dataset.rs, k = rk(vis[r]);
        if (e.shiftKey && lastTick !== null && typeof lastTick === "number") { const [a, b] = [Math.min(lastTick, r), Math.max(lastTick, r)]; for (let i = a; i <= b; i++) rowSel.add(rk(vis[i])); }
        else cb.checked ? rowSel.add(k) : rowSel.delete(k); lastTick = r; paint(); return; }
      if (e.target.closest("[data-all]")) { const on = e.target.checked; vis.forEach(r => on ? rowSel.add(rk(r)) : rowSel.delete(rk(r))); paint(); return; }
      const x = e.target.closest("[data-x]"); if (x) { openDrawer(vis[+x.dataset.x]); return; }
    }, sig);
    $sc.addEventListener("contextmenu", e => {
      const h = e.target.closest(".sh-h[data-hc]");   // right-click a heading: the column menu (wrap text, fit width, sort…)
      if (h) { e.preventDefault(); return colMenu(h.querySelector(".sh-hm") || h, +h.dataset.hc); }
      const c = e.target.closest(".sh-c[data-r]"); if (!c) return; e.preventDefault();
      const r = +c.dataset.r, ci = +c.dataset.c, bx = box(); if (!bx || r < bx.r0 || r > bx.r1 || ci < bx.c0 || ci > bx.c1) select(r, ci); cellMenu(e.clientX, e.clientY); }, sig);
    $sc.addEventListener("scroll", () => { paint(); }, { ...sig, passive:true });
    new ResizeObserver(() => paint()).observe($sc);

    function startResize(e, i){ e.preventDefault(); e.stopPropagation(); const x0 = e.clientX, w0 = ws[i], key = vc[i].key, h = e.target; h.classList.add("on");
      const mv = ev => { st.widths[key] = Math.max(50, Math.round(w0 + ev.clientX - x0)); compute(); draw(); };
      const up = () => { h.classList.remove("on"); removeEventListener("mousemove", mv); removeEventListener("mouseup", up); save(); };
      addEventListener("mousemove", mv); addEventListener("mouseup", up); }
    function fitWidth(i){ const c = vc[i], cv = document.createElement("canvas").getContext("2d"); cv.font = "15px " + getComputedStyle(root).fontFamily;
      let w = cv.measureText(c.label.toUpperCase()).width + 60; vis.slice(0, 400).forEach(r => { w = Math.max(w, cv.measureText(text(c, r)).width + 30); });
      st.widths[c.key] = Math.min(560, Math.max(60, Math.round(w))); compute(); paint(); save(); }
    function startHeaderDrag(e, i){
      e.preventDefault(); const x0 = e.clientX, shift = e.shiftKey; let moving = false, to = i;
      const hs = () => [...$head.querySelectorAll(".sh-h[data-hc]")];
      const mv = ev => { if (!moving && Math.abs(ev.clientX - x0) < 6) return; moving = true; hs()[i]?.classList.add("drag");
        hs().forEach(h => h.classList.remove("dropL","dropR")); const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".sh-h[data-hc]");
        if (el) { const j = +el.dataset.hc, rc = el.getBoundingClientRect(), right = ev.clientX > rc.left + rc.width / 2; to = right ? j + 1 : j; el.classList.add(right ? "dropR" : "dropL"); } };
      const up = () => { removeEventListener("mousemove", mv); removeEventListener("mouseup", up);
        if (!moving) { toggleSort(vc[i].key, shift); return; }
        const key = vc[i].key, target = vc[to]?.key; const o = st.order.filter(k => k !== key); const at = target ? o.indexOf(target) : o.length;
        if (to !== i && to !== i + 1) { o.splice(at < 0 ? o.length : at, 0, key); st.order = o; }
        full(); save(); };
      addEventListener("mousemove", mv); addEventListener("mouseup", up);
    }
    function toggleSort(key, add){ const cur = st.sort.find(s => s.key === key);
      if (!add) st.sort = !cur ? [{ key, dir:"asc" }] : cur.dir === "asc" ? [{ key, dir:"desc" }] : [];
      else { if (!cur) st.sort.push({ key, dir:"asc" }); else if (cur.dir === "asc") cur.dir = "desc"; else st.sort = st.sort.filter(s => s !== cur); }
      full(); save();
      const s = st.sort.find(x => x.key === key); say(s ? `Sorted by ${byKey[key].label}, ${s.dir === "asc" ? "A to Z (smallest first)" : "Z to A (largest first)"}.` : `${byKey[key].label} no longer sorts.`); }

    // ---------- Keyboard ----------
    $sc.addEventListener("keydown", e => {
      if (editing || e.target !== $sc) return;
      const m = e.metaKey || e.ctrlKey, k = e.key;
      if (m && (k === "z" || k === "Z")) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
      if (m && k === "y") { e.preventDefault(); doRedo(); return; }
      if (m && k === "a") { e.preventDefault(); if (vis.length) { sel = { a:{ r:0, c:0 }, f:{ r: vis.length-1, c: vc.length-1 } }; remember(); paint(); } return; }
      if (m && k === "d") { e.preventDefault(); fillDown(); return; }
      if (m && e.shiftKey && (k === "f" || k === "F")) { e.preventDefault(); findPop(anchor("find")); return; }
      if (m && k === "f") { e.preventDefault(); $bar.querySelector(".sh-search").focus(); return; }
      if (m && (k === "c" || k === "x" || k === "v")) return;   // handled by the copy, cut and paste events
      if (!sel) { if (/^Arrow|Tab|Enter/.test(k)) { e.preventDefault(); select(0, 0); } return; }
      const page = Math.max(1, Math.floor(($sc.clientHeight - HEAD - SUM) / RH()) - 1);
      const moves = { ArrowUp:[-1,0], ArrowDown:[1,0], ArrowLeft:[0,-1], ArrowRight:[0,1] };
      if (moves[k]) { e.preventDefault(); const [dr, dc] = moves[k], p = e.shiftKey ? sel.f : sel.a;
        if (m) select(dr ? (dr > 0 ? vis.length-1 : 0) : p.r, dc ? (dc > 0 ? vc.length-1 : 0) : p.c, e.shiftKey); else moveBy(dr, dc, e.shiftKey); return; }
      if (k === "Tab") { e.preventDefault(); moveBy(0, e.shiftKey ? -1 : 1); return; }
      if (k === "PageDown" || k === "PageUp") { e.preventDefault(); moveBy(k === "PageDown" ? page : -page, 0, e.shiftKey); return; }
      if (k === "Home") { e.preventDefault(); m ? select(0, 0, e.shiftKey) : select(sel.a.r, 0, e.shiftKey); return; }
      if (k === "End") { e.preventDefault(); m ? select(vis.length-1, vc.length-1, e.shiftKey) : select(sel.a.r, vc.length-1, e.shiftKey); return; }
      if (k === "Enter" || k === "F2") { e.preventDefault(); if (e.shiftKey && k === "Enter") return moveBy(-1, 0); startEdit(); return; }
      if (k === "Escape") { e.preventDefault(); if (box().r1 !== box().r0 || box().c1 !== box().c0) { sel = { a: sel.a, f: { ...sel.a } }; remember(); paint(); } else if (rowSel.size) { rowSel.clear(); paint(); } return; }
      if (k === "Delete" || k === "Backspace") { e.preventDefault(); clearRange(); return; }
      if (k === " ") { e.preventDefault(); const col = vc[sel.a.c]; if (col.type === "check") startEdit(); else openDrawer(vis[sel.a.r]); return; }
      if (k === "?" ) { e.preventDefault(); helpPop(anchor("help")); return; }
      if (k.length === 1 && !m && !e.altKey) { e.preventDefault(); startEdit(k); }
    }, sig);
    const ours = () => root.isConnected && (document.activeElement === $sc) && !editing;
    document.addEventListener("copy", e => { if (!ours() || !sel) return; e.preventDefault(); const bx = box(); e.clipboardData.setData("text/plain", rangeText(bx));
      const n = (bx.r1-bx.r0+1)*(bx.c1-bx.c0+1); if (n > 1) say(`Copied ${n.toLocaleString()} cells.`); }, sig);
    document.addEventListener("cut", e => { if (!ours() || !sel) return; e.preventDefault(); e.clipboardData.setData("text/plain", rangeText(box())); clearRange(); }, sig);
    document.addEventListener("paste", e => { if (!ours() || !sel) return; e.preventDefault(); pasteText(e.clipboardData.getData("text/plain")); }, sig);

    // ---------- Pop-ups ----------
    let popEl = null;
    function pop(anchor, html, mount, at){
      closePop(); const p = document.createElement("div"); p.className = "sh-pop"; p.innerHTML = html; document.body.appendChild(p); popEl = p;
      const place = () => { const r = at ? { left: at.x, bottom: at.y, top: at.y } : anchor.getBoundingClientRect(), pw = p.offsetWidth, ph = p.offsetHeight;
        let x = Math.min(r.left, innerWidth - pw - 12), y = r.bottom + 4; if (y + ph > innerHeight - 8) y = Math.max(8, (at ? at.y : r.top) - ph - 4); p.style.left = Math.max(8, x) + "px"; p.style.top = y + "px"; };
      p.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); closePop(); $sc.focus({ preventScroll:true }); } });
      mount?.(p, place); place(); setTimeout(() => p.querySelector("input:not([type=checkbox]),select,button.mi")?.focus(), 0); return p;
    }
    function closePop(){ popEl?.remove(); popEl = null; }
    document.addEventListener("mousedown", e => { if (popEl && !popEl.contains(e.target) && !e.target.closest(".sh-tb,.sh-hm,[data-b]")) closePop(); }, sig);
    const colOpts = (cur, filter = () => true) => cols.filter(filter).map(c => `<option value="${esc(c.key)}" ${c.key===cur?"selected":""}>${esc(c.label)}</option>`).join("");

    function condEditor(list, onChange, { colors = false } = {}){
      return (p, place) => {
        const draw = () => {
          const pane = p.querySelector(".conds");
          pane.innerHTML = list.map((f, i) => { const c = byKey[f.key] || cols[0], kind = opKind(c.type);
            const ops = OPS[kind].map(([v, l]) => `<option value="${v}" ${v===f.op?"selected":""}>${esc(l)}</option>`).join("");
            let input = "";
            if (!noValue(f.op)) {
              if (kind === "select") { const chosen = f.value || []; input = `<div class="opts">${[{ v:"", l:"(empty)" }, ...opts(c)].map(o => `<label class="chk"><input type="checkbox" data-ov="${esc(o.v ?? "")}" ${chosen.includes(o.v ?? "")?"checked":""}> ${esc(o.l)}</label>`).join("")}</div>`; }
              else if (kind === "date" && (f.op === "last" || f.op === "next")) input = `<input type="number" min="0" data-v value="${esc(f.value ?? 7)}" style="width:80px"> days`;
              else input = `<input ${kind==="date"?'type="date"':kind==="number"?'type="number"':'type="text"'} data-v value="${esc(f.value ?? "")}" placeholder="Value">`;
            }
            return `<div class="cond" data-i="${i}">${i ? (colors ? `<span class="hint">then</span>` : `<select data-conj ${i>1?"disabled":""}><option value="and" ${st.conj==="and"?"selected":""}>and</option><option value="or" ${st.conj==="or"?"selected":""}>or</option></select>`) : `<span class="hint">${colors ? "If" : "Where"}</span>`}
              <select data-k>${colOpts(c.key)}</select><select data-op>${ops}</select>${input}
              ${colors ? `<span class="row">${COLORS.map(k => `<button class="sw k-${k} ${f.color===k?"on":""}" data-sw="${k}" title="${COLOR_NAMES[k]}" aria-label="${COLOR_NAMES[k]}"></button>`).join("")}</span><select data-where><option value="row" ${(f.where||"row")==="row"?"selected":""}>the row</option><option value="cell" ${f.where==="cell"?"selected":""}>just that cell</option></select>` : ""}
              <button class="x" data-del title="Remove">×</button></div>`; }).join("") || `<p class="hint">${colors ? "No color rules yet." : "No filters yet. Every row shows."}</p>`;
          pane.querySelectorAll(".cond").forEach(el => { const f = list[+el.dataset.i];
            el.querySelector("[data-k]").onchange = e => { f.key = e.target.value; const c = byKey[f.key]; f.op = OPS[opKind(c.type)][0][0]; f.value = opKind(c.type) === "select" ? [] : ""; draw(); onChange(); };
            el.querySelector("[data-op]").onchange = e => { f.op = e.target.value; if ((f.op === "last" || f.op === "next") && !f.value) f.value = 7; draw(); onChange(); };
            el.querySelector("[data-v]")?.addEventListener("input", e => { f.value = e.target.value; onChange(); });
            el.querySelectorAll("[data-ov]").forEach(b => b.onchange = () => { f.value = [...el.querySelectorAll("[data-ov]:checked")].map(x => { const v = x.dataset.ov; const o = opts(byKey[f.key]).find(o => String(o.v ?? "") === v); return o ? o.v : v; }); onChange(); });
            el.querySelector("[data-conj]")?.addEventListener("change", e => { st.conj = e.target.value; draw(); onChange(); });
            el.querySelectorAll("[data-sw]").forEach(b => b.onclick = () => { f.color = b.dataset.sw; draw(); onChange(); });
            el.querySelector("[data-where]")?.addEventListener("change", e => { f.where = e.target.value; onChange(); });
            el.querySelector("[data-del]").onclick = () => { list.splice(+el.dataset.i, 1); draw(); onChange(); };
          });
          place();
        };
        p.querySelector("[data-add]").onclick = () => { const c = (sel && vc[sel.a.c]) || vc[0] || cols[0]; list.push({ key: c.key, op: OPS[opKind(c.type)][0][0], value: opKind(c.type) === "select" ? [] : "", ...(colors ? { color: COLORS[list.length % COLORS.length], where:"row" } : {}) }); draw(); onChange(); };
        p.querySelector("[data-clear]")?.addEventListener("click", () => { list.splice(0); draw(); onChange(); });
        draw();
      };
    }
    function filterPop(b){ pop(b, `<h4>Filter rows</h4><div class="pane"><div class="conds"></div><div class="row"><button class="btn sm" data-add>+ Add a filter</button><button class="btn sm" data-clear>Clear all</button></div><p class="hint">Rows that don't match are hidden, not deleted.</p></div>`,
      condEditor(st.filters, () => { compute(); paint(); toolbar(); save(); })); }
    function colorsPop(b){ pop(b, `<h4>Color rows or cells</h4><div class="pane"><div class="conds"></div><div class="row"><button class="btn sm" data-add>+ Add a color rule</button><button class="btn sm" data-clear>Clear all</button></div><p class="hint">The first rule that matches wins. Colors are only for this view.</p></div>`,
      condEditor(st.colors, () => { paint(); toolbar(); save(); }, { colors:true })); }
    function sortPop(b){
      pop(b, `<h4>Sort rows</h4><div class="pane"><div class="srt"></div><div class="row"><button class="btn sm" data-add>+ Add a sort</button><button class="btn sm" data-clear>Clear</button></div><p class="hint">Tip: click a column heading to sort by it. Shift-click adds a second sort.</p></div>`, (p, place) => {
        const draw = () => { const el = p.querySelector(".srt");
          el.innerHTML = st.sort.map((s, i) => `<div class="cond" data-i="${i}"><span class="hint">${i ? "then by" : "Sort by"}</span><select data-k>${colOpts(s.key)}</select><select data-d><option value="asc" ${s.dir==="asc"?"selected":""}>A → Z, 1 → 9</option><option value="desc" ${s.dir==="desc"?"selected":""}>Z → A, 9 → 1</option></select>${i?`<button class="x" data-up title="Move up">↑</button>`:""}<button class="x" data-del title="Remove">×</button></div>`).join("") || `<p class="hint">Not sorted. Rows are in their original order.</p>`;
          el.querySelectorAll(".cond").forEach(c => { const s = st.sort[+c.dataset.i];
            c.querySelector("[data-k]").onchange = e => { s.key = e.target.value; go(); }; c.querySelector("[data-d]").onchange = e => { s.dir = e.target.value; go(); };
            c.querySelector("[data-up]")?.addEventListener("click", () => { const i = +c.dataset.i; [st.sort[i-1], st.sort[i]] = [st.sort[i], st.sort[i-1]]; go(); });
            c.querySelector("[data-del]").onclick = () => { st.sort.splice(+c.dataset.i, 1); go(); }; }); place(); };
        const go = () => { draw(); compute(); paint(); toolbar(); save(); };
        p.querySelector("[data-add]").onclick = () => { const used = st.sort.map(s => s.key); const c = vc.find(c => !used.includes(c.key)) || cols[0]; st.sort.push({ key:c.key, dir:"asc" }); go(); };
        p.querySelector("[data-clear]").onclick = () => { st.sort = []; go(); };
        draw(); });
    }
    function groupPop(b){
      pop(b, `<h4>Group rows</h4><div class="pane"><select data-g><option value="">Don't group</option>${colOpts(st.group, c => c.type !== "long")}</select>${st.group?`<div class="row"><button class="btn sm" data-all="0">Expand all</button><button class="btn sm" data-all="1">Collapse all</button></div>`:""}<p class="hint">Rows with the same value sit together under a heading with a count. Click a heading to fold it.</p></div>`, p => {
        p.querySelector("[data-g]").onchange = e => { st.group = e.target.value; st.collapsed = []; full(); save(); groupPop(b); };
        p.querySelectorAll("[data-all]").forEach(x => x.onclick = () => { st.collapsed = x.dataset.all === "1" ? [...new Set(data.map(r => text(byKey[st.group], r) || "(empty)"))] : []; compute(); paint(); save(); });
      });
    }
    function fieldsPop(b){
      pop(b, `<h4>Columns</h4><div class="pane"><input type="text" data-q placeholder="Find a column"><div class="row"><button class="btn sm" data-show>Show all</button><button class="btn sm" data-hide>Hide all</button></div><div class="opts fl" style="max-height:340px"></div><p class="hint">Tick to show. Drag a name to reorder, or drag a column heading in the sheet.</p></div>`, (p, place) => {
        const draw = () => { const q = p.querySelector("[data-q]").value.toLowerCase(); const el = p.querySelector(".fl");
          el.innerHTML = st.order.map(k => byKey[k]).filter(c => c && c.label.toLowerCase().includes(q)).map(c => `<label class="chk" draggable="true" data-k="${esc(c.key)}"><span style="cursor:grab;color:var(--muted)">⠿</span><input type="checkbox" ${st.hidden.includes(c.key)?"":"checked"}> ${esc(c.label)}${c.editable?"":` <span class="hint">read-only</span>`}</label>`).join("");
          el.querySelectorAll("label[data-k]").forEach(l => { const k = l.dataset.k;
            l.querySelector("input").onchange = e => { st.hidden = e.target.checked ? st.hidden.filter(x => x !== k) : [...st.hidden, k]; full(); save(); };
            l.ondragstart = e => e.dataTransfer.setData("text/x-col", k); l.ondragover = e => e.preventDefault();
            l.ondrop = e => { e.preventDefault(); const from = e.dataTransfer.getData("text/x-col"); if (!from || from === k) return; const o = st.order.filter(x => x !== from); o.splice(o.indexOf(k), 0, from); st.order = o; full(); save(); draw(); }; });
          place(); };
        p.querySelector("[data-q]").oninput = draw;
        p.querySelector("[data-show]").onclick = () => { st.hidden = []; full(); save(); draw(); };
        p.querySelector("[data-hide]").onclick = () => { st.hidden = cols.slice(1).map(c => c.key); full(); save(); draw(); };
        draw(); });
    }
    function heightPop(b){
      pop(b, `<h4>Row height</h4>${["short","medium","tall"].map(h => `<button class="mi" data-h="${h}">${st.rowH===h?"✓":"<span style='width:1ch'></span>"} ${h[0].toUpperCase()+h.slice(1)}${h==="short"?" (one line)":h==="medium"?" (two lines in wrapped columns)":" (four lines)"}</button>`).join("")}<hr><p class="hint" style="padding:0 10px 6px">Turn on "Wrap text" in a column's ▾ menu to see more of long cells.</p>`, p => {
        p.querySelectorAll("[data-h]").forEach(x => x.onclick = () => { st.rowH = x.dataset.h; closePop(); compute(); paint(); toolbar(); save(); }); });
    }
    function colMenu(b, i){
      const c = vc[i], fzd = i < fz;
      pop(b, `<h4>${esc(c.label)}</h4>
        <button class="mi" data-a="asc">Sort A → Z (1 → 9)</button><button class="mi" data-a="desc">Sort Z → A (9 → 1)</button><button class="mi" data-a="addsort">Add as a second sort</button><hr>
        <button class="mi" data-a="filter">Filter by this column…</button><button class="mi" data-a="group">${st.group===c.key?"Stop grouping":"Group by this column"}</button><button class="mi" data-a="color">Color by this column…</button><hr>
        <button class="mi" data-a="selcol">Select the whole column</button><button class="mi" data-a="wrap">${st.wrap.includes(c.key)?"✓ ":""}Wrap text</button><button class="mi" data-a="fit">Fit width to contents</button>
        <button class="mi" data-a="freeze">${fzd && i === fz-1 ? "Unfreeze columns" : "Freeze columns up to here"}</button>
        <button class="mi" data-a="left" ${i?"":"disabled"}>Move left</button><button class="mi" data-a="right" ${i<vc.length-1?"":"disabled"}>Move right</button><button class="mi" data-a="hide">Hide this column</button>
        ${c.hint?`<hr><p class="hint" style="padding:0 10px 6px;max-width:320px">${esc(c.hint)}</p>`:""}${c.editable?"":`<p class="hint" style="padding:0 10px 6px">Read-only here.</p>`}`, p => {
        p.querySelectorAll("[data-a]").forEach(x => x.onclick = () => { const a = x.dataset.a; closePop();
          if (a === "asc" || a === "desc") { st.sort = [{ key:c.key, dir:a }]; full(); save(); }
          if (a === "addsort") { st.sort = st.sort.filter(s => s.key !== c.key); st.sort.push({ key:c.key, dir:"asc" }); full(); save(); }
          if (a === "filter") { st.filters.push({ key:c.key, op: OPS[opKind(c.type)][0][0], value: opKind(c.type) === "select" ? [] : "" }); filterPop($bar.querySelector('[data-t="filter"]')); }
          if (a === "group") { st.group = st.group === c.key ? "" : c.key; st.collapsed = []; full(); save(); }
          if (a === "color") { st.colors.push({ key:c.key, op: OPS[opKind(c.type)][0][0], value: opKind(c.type) === "select" ? [] : "", color:"green", where:"row" }); colorsPop($bar.querySelector('[data-t="colors"]')); }
          if (a === "selcol") { sel = { a:{ r:0, c:i }, f:{ r: vis.length-1, c:i } }; remember(); paint(); $sc.focus(); }
          if (a === "wrap") { st.wrap = st.wrap.includes(c.key) ? st.wrap.filter(k => k !== c.key) : [...st.wrap, c.key]; full(); save(); }
          if (a === "fit") fitWidth(i);
          if (a === "freeze") { st.frozen = fzd && i === fz-1 ? 0 : i + 1; full(); save(); }
          if (a === "left" || a === "right") { const o = st.order, k1 = c.key, k2 = vc[i + (a === "left" ? -1 : 1)].key, p1 = o.indexOf(k1), p2 = o.indexOf(k2); [o[p1], o[p2]] = [o[p2], o[p1]]; full(); save(); }
          if (a === "hide") { st.hidden.push(c.key); full(); save(); say(`${c.label} is hidden. Show it again from Columns.`); }
        }); });
    }
    function sumMenu(b, i){ const c = vc[i], cur = st.sums[c.key] || (NUMERIC(c.type) ? "sum" : "filled");
      pop(b, `<h4>Bottom row: ${esc(c.label)}</h4>${sumsFor(c.type).map(k => `<button class="mi" data-k="${k}">${k===cur?"✓ ":""}${SUMS[k]}</button>`).join("")}`, p => {
        p.querySelectorAll("[data-k]").forEach(x => x.onclick = () => { st.sums[c.key] = x.dataset.k; closePop(); summary(); save(); }); }); }
    function cellMenu(x, y){
      const bx = box(), r = sel.a.r, row = vis[r], c = vc[sel.a.c], one = bx.r0 === bx.r1 && bx.c0 === bx.c1;
      pop(null, `<button class="mi" data-a="copy">Copy <kbd>${MOD}+C</kbd></button><button class="mi" data-a="cut">Cut <kbd>${MOD}+X</kbd></button><button class="mi" data-a="paste">Paste <kbd>${MOD}+V</kbd></button><hr>
        <button class="mi" data-a="edit" ${canEditCell(c,row)?"":"disabled"}>Edit this cell <kbd>Enter</kbd></button><button class="mi" data-a="filldown">Fill down <kbd>${MOD}+D</kbd></button><button class="mi" data-a="clear">Clear ${one?"this cell":"these cells"} <kbd>Delete</kbd></button><hr>
        <button class="mi" data-a="only">Show only rows where ${esc(c.label)} is "${esc(text(c,row).slice(0,30) || "(empty)")}"</button><button class="mi" data-a="hide">Hide rows where it's this</button><hr>
        <button class="mi" data-a="showall">Show all the text in this cell</button><button class="mi" data-a="wrapcol">${st.wrap.includes(c.key)?"✓ ":""}Wrap text in this column</button><hr>
        <button class="mi" data-a="open">Expand this row <kbd>Space</kbd></button><button class="mi" data-a="pick">${rowSel.has(rk(row))?"Unselect":"Select"} ${one?"this row":"these rows"}</button>
        ${cfg.onOpen?`<button class="mi" data-a="full">${esc(cfg.openLabel || "Open the full record")}</button>`:""}`, p => {
        p.querySelectorAll("[data-a]").forEach(b => b.onclick = async () => { const a = b.dataset.a; closePop(); $sc.focus({ preventScroll:true });
          if (a === "copy") { await copyText(rangeText(bx)); say("Copied."); }
          if (a === "cut") { await copyText(rangeText(bx)); clearRange(); }
          if (a === "paste") { try { pasteText(await navigator.clipboard.readText()); } catch { say(`Press ${MOD}+V to paste.`); } }
          if (a === "edit") startEdit(); if (a === "filldown") fillDown(); if (a === "clear") clearRange();
          // Kyle, Thu 12 Nov 2026: right-click to see all the text in a cell.
          if (a === "showall") { const t = text(c, row) || "(empty)";
            pop(null, `<h4>${esc(c.label)}</h4><div style="max-width:520px;max-height:60vh;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:15px;line-height:1.5;padding:2px 2px 6px">${esc(t)}</div><button class="btn sm" data-x>Close</button>`,
              p2 => { p2.querySelector("[data-x]").onclick = () => { closePop(); $sc.focus({ preventScroll:true }); }; }, { x, y }); return; }
          if (a === "wrapcol") { st.wrap = st.wrap.includes(c.key) ? st.wrap.filter(k => k !== c.key) : [...st.wrap, c.key]; full(); save(); }
          if (a === "only" || a === "hide") { const v = val(c, row), kind = opKind(c.type);
            st.filters.push(kind === "select" ? { key:c.key, op: a === "only" ? "any" : "none", value:[v ?? ""] } : empty(c, row) ? { key:c.key, op: a === "only" ? "empty" : "not_empty" } : kind === "check" ? { key:c.key, op: (!!v) === (a === "only") ? "yes" : "no" } : { key:c.key, op: a === "only" ? "is" : "is_not", value: kind === "date" ? String(v).slice(0,10) : text(c, row) });
            if (kind === "date" && !empty(c,row)) st.filters[st.filters.length-1].op = a === "only" ? "on" : "not_empty";
            full(); save(); }
          if (a === "open") openDrawer(row);
          if (a === "pick") { const add = !rowSel.has(rk(row)); for (let i = bx.r0; i <= bx.r1; i++) add ? rowSel.add(rk(vis[i])) : rowSel.delete(rk(vis[i])); paint(); }
          if (a === "full") cfg.onOpen(row);
        }); }, { x, y });
    }
    function findPop(b){
      pop(b, `<h4>Find and replace</h4><div class="pane">
        <input type="text" data-f placeholder="Find"><input type="text" data-r placeholder="Replace with (leave empty to just find)">
        <select data-in><option value="">In every column you can change</option>${vc.filter(c => c.editable).map(c => `<option value="${esc(c.key)}">In ${esc(c.label)}</option>`).join("")}</select>
        <label class="chk"><input type="checkbox" data-case> Match upper and lower case</label><label class="chk"><input type="checkbox" data-whole> Whole cell only</label>
        <div class="row"><button class="btn sm" data-next>Find next</button><button class="btn sm" data-one>Replace</button><button class="btn sm primary" data-all>Replace all</button></div><p class="hint" data-msg>Only rows that are showing are searched.</p></div>`, p => {
        const g = s => p.querySelector(s), msg = m => g("[data-msg]").textContent = m;
        const matcher = () => { const f = g("[data-f]").value; if (!f) return null; const flags = g("[data-case]").checked ? "g" : "gi", e = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); return new RegExp(g("[data-whole]").checked ? `^${e}$` : e, flags); };
        const inCols = () => { const k = g("[data-in]").value; return vc.map((c, i) => [c, i]).filter(([c]) => k ? c.key === k : true); };
        const hits = () => { const re = matcher(); if (!re) return []; const out = []; vis.forEach((row, r) => inCols().forEach(([c, i]) => { re.lastIndex = 0; if (re.test(text(c, row))) out.push({ r, c: i }); })); return out; };
        let at = -1;
        g("[data-next]").onclick = () => { const h = hits(); if (!h.length) { found = null; paint(); return msg("Not found."); } at = (at + 1) % h.length; found = h[at]; sel = { a:{ ...found }, f:{ ...found } }; remember(); scrollTo(found.r, found.c); paint(); msg(`${at + 1} of ${h.length}`); };
        g("[data-one]").onclick = () => { if (!found) return g("[data-next]").onclick(); const re = matcher(), c = vc[found.c], row = vis[found.r]; if (!re || !canEditCell(c, row)) return msg("That cell can't be changed.");
          commit([{ row, key: c.key, value: text(c, row).replace(re, g("[data-r]").value) }]).then(() => g("[data-next]").onclick()); };
        g("[data-all]").onclick = async () => { const re = matcher(); if (!re) return msg("Type something to find."); const list = hits().filter(h => canEditCell(vc[h.c], vis[h.r])).map(h => ({ row: vis[h.r], key: vc[h.c].key, value: text(vc[h.c], vis[h.r]).replace(re, g("[data-r]").value) }));
          if (!list.length) return msg("Nothing to replace in cells you can change.");
          const ok = await commit(list); msg(ok ? `Replaced in ${list.length} cells. ${MOD}+Z undoes it.` : "Nothing was replaced."); };
        g("[data-f]").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); g("[data-next]").onclick(); } };
      });
    }
    function exportPop(b, onlySel){
      const rows = onlySel || rowSel.size ? selectedRows() : vis, n = rows.length, name = (cfg.fileName || cfg.id || "sheet").replace(/[^\w\- ]+/g, "");
      pop(b, `<h4>Download ${n.toLocaleString()} ${onlySel || rowSel.size ? "selected" : "showing"} rows</h4><button class="mi" data-x="xlsx">Excel file (.xlsx)</button><button class="mi" data-x="csv">CSV file (.csv)</button><button class="mi" data-x="copy">Copy to paste into Google Sheets</button><p class="hint" style="padding:4px 10px">Only the columns showing, in this order.</p>`, p => {
        p.querySelectorAll("[data-x]").forEach(x => x.onclick = () => { closePop(); const aoa = [vc.map(c => c.label), ...rows.map(r => vc.map(c => text(c, r)))];
          if (x.dataset.x === "copy") { copyText(rowsToTSV(rows, vc)); say(`Copied ${n} rows with headings.`); return; }
          if (x.dataset.x === "xlsx" && window.XLSX) { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sheet1"); XLSX.writeFile(wb, name + ".xlsx"); return; }
          const blob = new Blob(["﻿" + aoa.map(l => l.map(v => csvCell(String(v))).join(",")).join("\r\n")], { type:"text/csv" });
          const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name + ".csv"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }); });
    }
    function setFieldPop(b){
      const rows = selectedRows(), ed = cols.filter(c => c.editable && c.type !== "long");
      pop(b, `<h4>Change a field for ${rows.length} rows</h4><div class="pane"><select data-k>${ed.map(c => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join("")}</select><div data-v></div><div class="row"><button class="btn sm primary" data-go>Change ${rows.length} rows</button></div><p class="hint">${MOD}+Z undoes it.</p></div>`, (p, place) => {
        const vEl = p.querySelector("[data-v]"), kEl = p.querySelector("[data-k]");
        const drawV = () => { const c = byKey[kEl.value];
          vEl.innerHTML = c.type === "select" ? `<select data-in><option value="">(empty)</option>${opts(c).map(o => `<option value="${esc(o.v)}">${esc(o.l)}</option>`).join("")}</select>`
            : c.type === "check" ? `<label class="chk"><input type="checkbox" data-in> Checked</label>` : `<input ${c.type==="date"?'type="date"':'type="text"'} data-in placeholder="New value${c.type==="multi"?" (separate with commas)":""}">`; place(); };
        kEl.onchange = drawV; drawV();
        p.querySelector("[data-go]").onclick = async () => { const c = byKey[kEl.value], inp = vEl.querySelector("[data-in]");
          const value = c.type === "check" ? inp.checked : c.type === "select" ? (opts(c).find(o => String(o.v) === inp.value)?.v ?? null) : inp.value;
          closePop(); const ok = await commit(rows.map(row => ({ row, key: c.key, value })), { raw: c.type === "check" || c.type === "select" });
          if (ok) say(`Changed ${c.label} for ${rows.length} rows.`); };
      });
    }
    function helpPop(b){
      const K = [["Arrow keys","Move"],["Shift + arrows","Select more cells"],[`${MOD} + arrows`,"Jump to the edge"],["Enter or F2","Edit the cell (Enter again saves and moves down)"],["Type anything","Replace the cell with what you type"],["Tab / Shift+Tab","Save and move right / left"],["Escape","Cancel the edit"],["Delete","Clear the selected cells"],
        [`${MOD} + C / X / V`,"Copy, cut, paste (works with Google Sheets and Excel)"],[`${MOD} + D`,"Fill down"],["Drag the blue square","Fill down or across"],[`${MOD} + Z`,"Undo"],[`${MOD} + Shift + Z`,"Redo"],[`${MOD} + A`,"Select every cell"],["Space","Expand the row"],[`${MOD} + F`,"Search"],[`${MOD} + Shift + F`,"Find and replace"],
        ["Click a heading","Sort (again to reverse); Shift-click for a second sort"],["Drag a heading","Move the column"],["Drag a heading's edge","Resize (double-click to fit)"],["Right-click a cell","More actions"],["Click the bottom row","Choose a count, sum or average"]];
      pop(b, `<h4>Shortcuts</h4><div class="sh-help">${K.map(([k, d]) => `<kbd>${esc(k)}</kbd><span>${esc(d)}</span>`).join("")}</div>`);
    }

    // ---------- Saved views ----------
    const LS = "bpf-sheet:" + (cfg.id || "x");
    const snap = () => { const { q, ...s } = st; return clone(s); };
    function save(){ if (!cfg.remember) return; try { localStorage.setItem(LS, JSON.stringify({ viewId, st: snap(), def: viewId ? (defSt || null) : null })); } catch {} }
    // A view's state may name its columns with show: [keys] (v6.21, the team's stage views): those show, in that order, and the
    // rest are hidden, so a view doesn't have to list every column the sheet has.
    function apply(s){ s = clone(s || {}); if (Array.isArray(s.show)) { const keys = cfg.columns.map(c => c.key), sh = s.show.filter(k => keys.includes(k));
        s.order = [...sh, ...keys.filter(k => !sh.includes(k))]; s.hidden = keys.filter(k => !sh.includes(k)); delete s.show; }
      st = { ...baseState(), ...s, q: st.q }; setColumns(cfg.columns); full(); }
    async function loadViews(){ if (!cfg.views) return; try { views = await cfg.views.list(); } catch { views = []; } toolbar(); statusBar(); }
    function viewsPop(b){
      const cur = views.find(v => v.id === viewId), mine = v => v.mine;
      pop(b, `<h4>Saved views</h4>
        <button class="mi" data-v="">${viewId?"":"✓ "}${esc(cfg.allLabel || "Default")}</button>
        ${views.map(v => `<button class="mi" data-v="${esc(v.id)}">${v.id===viewId?"✓ ":""}${esc(v.name)}${v.shared?` <span class="hint">shared${v.mine?"":" by " + esc(v.ownerName || "a teammate")}</span>`:""}</button>`).join("")}<hr>
        ${cur && mine(cur) ? `<button class="mi" data-a="update">Save changes to "${esc(cur.name)}"</button><button class="mi" data-a="share">${cur.shared?"Stop sharing it with the team":"Share it with the team"}</button><button class="mi danger" data-a="del">Delete "${esc(cur.name)}"…</button><hr>` : ""}
        <div class="pane"><input type="text" data-n placeholder="Name for a new view, e.g. My leads to vet"><label class="chk"><input type="checkbox" data-sh> Share it with the team</label><button class="btn sm primary" data-a="new">Save this layout as a new view</button>
        <p class="hint">A view keeps the filters, sorting, grouping, colors, column order and widths. Changing a view never changes any data.</p></div>`, p => {
        p.querySelectorAll("[data-v]").forEach(x => x.onclick = () => { closePop(); useView(x.dataset.v); const v = views.find(v => v.id === viewId); say(v ? `Showing the "${v.name}" view.` : "Showing the default view."); });
        p.querySelector('[data-a="new"]').onclick = async () => { const name = p.querySelector("[data-n]").value.trim(); if (!name) return p.querySelector("[data-n]").focus();
          try { const v = await cfg.views.save({ name, shared: p.querySelector("[data-sh]").checked, state: snap() }); closePop(); viewId = v.id; await loadViews(); save(); say(`Saved the "${name}" view.`); } catch (e) { say("Couldn't save the view: " + e.message); } };
        p.querySelector('[data-a="update"]')?.addEventListener("click", async () => { try { await cfg.views.save({ ...cur, state: snap() }); closePop(); await loadViews(); say(`Saved "${cur.name}".`); } catch (e) { say("Couldn't save: " + e.message); } });
        p.querySelector('[data-a="share"]')?.addEventListener("click", async () => { try { await cfg.views.save({ ...cur, shared: !cur.shared }); closePop(); await loadViews(); say(cur.shared ? "Only you can see it now." : "The team can see it now."); } catch (e) { say("Couldn't change it: " + e.message); } });
        p.querySelector('[data-a="del"]')?.addEventListener("click", e => { const box = e.target; box.outerHTML = `<div class="pane"><p>Delete the "${esc(cur.name)}" view? This can't be undone. No data is touched.</p><div class="row"><button class="btn sm" data-yes style="color:var(--bad)">Delete the view</button><button class="btn sm" data-no>Keep it</button></div></div>`;
          p.querySelector("[data-no]").onclick = closePop;
          p.querySelector("[data-yes]").onclick = async () => { try { await cfg.views.remove(cur.id); closePop(); viewId = ""; await loadViews(); apply({}); save(); say("Deleted the view."); } catch (err) { say("Couldn't delete it: " + err.message); } }; });
      });
    }

    // ---------- Board ----------
    const boardCols = () => cols.filter(c => c.type === "select" && c.board !== false && opts(c).length && opts(c).length <= 30);
    function drawBoard(){
      const c = byKey[st.boardKey] || boardCols()[0]; if (!c) return;
      const lanes = [...opts(c), { v:null, l:"(empty)" }], show = vc.filter(x => x.key !== c.key).slice(0, 5), title = show[0];
      $board.innerHTML = `<div style="flex:0 0 auto;align-self:flex-start;display:flex;flex-direction:column;gap:6px;min-width:150px"><label class="hint" style="font-size:13px;color:var(--muted)">Cards in lanes by</label><select data-bk style="padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg)">${boardCols().map(x => `<option value="${esc(x.key)}" ${x.key===c.key?"selected":""}>${esc(x.label)}</option>`).join("")}</select><span class="hint" style="font-size:13px;color:var(--muted)">Drag a card to another lane to change it.</span></div>` +
        lanes.map(l => { const rows = vis.filter(r => same(val(c, r), l.v)); if (l.v === null && !rows.length) return "";
          return `<div class="sh-lane" data-lane="${esc(JSON.stringify(l.v))}"><h5>${esc(l.l)} <small>${rows.length}</small></h5>${rows.slice(0, 300).map(r => `<div class="sh-card" draggable="${canEditCell(c, r)}" data-k="${esc(String(rk(r)))}"><b>${esc(title ? text(title, r) : "")}</b>${show.slice(1).map(x => text(x, r) ? `<span title="${esc(x.label)}">${esc(text(x, r))}</span>` : "").join("")}</div>`).join("")}${rows.length > 300 ? `<span class="hint">+${rows.length - 300} more</span>` : ""}</div>`; }).join("");
      $board.querySelector("[data-bk]").onchange = e => { st.boardKey = e.target.value; drawBoard(); save(); };
      $board.querySelectorAll(".sh-card").forEach(el => { el.ondragstart = e => e.dataTransfer.setData("text/x-row", el.dataset.k); el.onclick = () => openDrawer(data.find(r => String(rk(r)) === el.dataset.k)); });
      $board.querySelectorAll(".sh-lane").forEach(el => { el.ondragover = e => { e.preventDefault(); el.classList.add("over"); }; el.ondragleave = () => el.classList.remove("over");
        el.ondrop = async e => { e.preventDefault(); el.classList.remove("over"); const k = e.dataTransfer.getData("text/x-row"), row = data.find(r => String(rk(r)) === k); if (!row) return;
          const v = JSON.parse(el.dataset.lane); if (await commit([{ row, key: c.key, value: v }], { raw:true })) say(`Moved to ${v === null ? "(empty)" : label(c, v)}.`); drawBoard(); }; });
    }

    // ---------- Expanded row ----------
    let drawerRow = null, drawerFresh = false;   // drawerFresh: the next draw is a newly opened row (not a redraw of the same one)
    function openDrawer(row){
      if (!row) return; closeDrawer(); drawerRow = rk(row); drawerFresh = true;
      const dock = !!cfg.dock, d = document.createElement("aside"); d.className = "sh-drawer" + (dock ? " sh-dock" : ""); d.setAttribute("role", dock ? "complementary" : "dialog"); d.tabIndex = -1;
      // Docked (v6.17): a right-hand pane with no shade, so the table stays usable; Escape or ✕ closes it.
      if (dock) { document.body.append(d); document.body.classList.add("sh-docked"); root.classList.add("sh-dockhost"); paint(); }
      else { const shade = document.createElement("div"); shade.className = "sh-shade"; document.body.append(shade, d); shade.onclick = closeDrawer; }
      const drawD = () => {
        const row = data.find(r => rk(r) === drawerRow); if (!row) return closeDrawer();
        const i = vis.indexOf(row), all = st.order.map(k => byKey[k]).filter(Boolean);
        d.innerHTML = `<header><button class="btn sm" data-p ${i>0?"":"disabled"} title="Previous row (↑)">↑</button><button class="btn sm" data-n ${i>=0&&i<vis.length-1?"":"disabled"} title="Next row (↓)">↓</button><h3>${esc(text(all[0], row) || "Row")}</h3>${cfg.onOpen?`<button class="btn sm" data-o>${esc(dock ? cfg.dockOpenLabel || "Full page" : cfg.openLabel || "Open the full record")}</button>`:""}<button class="btn sm" data-c title="Close (Escape)">✕</button></header>
          <div class="body">${dock && cfg.drawerBody ? `<div data-rec></div>` : `${dock && cfg.drawerHead ? `<div data-head></div>` : ""}<div data-fields></div><div data-extra></div>`}</div>`;
        // The row's fields as editors (one per column, the sheet's own commit, undo and change marks). v6.24: drawerBody gets this
        // as api.fields(host, keys) so the host can place the fields inside its own record layout (the lead record's tabs).
        const fieldsInto = (host, keys) => { if (!host) return;
          const list = keys ? keys.map(k => byKey[k]).filter(Boolean) : all;
          host.innerHTML = `${list.map(c => { const ed = canEditCell(c, row), v = val(c, row), was = chg[rk(row) + "\u0001" + c.key];
            let input;
            if (!ed) input = `<div class="ro">${display(c, row, "") || `<span class="muted">—</span>`}</div>`;
            else if (c.type === "select") input = `<select data-k="${esc(c.key)}"><option value="">—</option>${opts(c).map(o => `<option value="${esc(o.v)}" ${same(o.v, v)?"selected":""}>${esc(o.l)}</option>`).join("")}</select>`;
            else if (c.type === "check") input = `<label class="chk"><input type="checkbox" data-k="${esc(c.key)}" ${v?"checked":""}> Yes</label>`;
            else if (c.type === "long" || c.long || c.type === "multi") input = `<textarea data-k="${esc(c.key)}" rows="${c.type==="multi"?2:4}">${esc(c.type === "multi" ? (v||[]).join(", ") : text(c, row))}</textarea>`;
            else input = `<input data-k="${esc(c.key)}" ${c.type==="date"?'type="date"':'type="text"'} value="${esc(c.type==="date" ? (v||"") : text(c, row))}">`;
            return `<div class="df ${was!==undefined?"chg":""}" data-key="${esc(c.key)}"><label>${esc(c.label)}${st.hidden.includes(c.key)?" <i>hidden in the sheet</i>":""}</label>${input}${was!==undefined?`<span class="was">Changed. Was: ${esc(Array.isArray(was)?was.join(", "):was ?? "(empty)") || "(empty)"}</span>`:""}${cfg.cellTip?.(row, c)?`<span class="aiw">${esc(cfg.cellTip(row, c))}</span>`:""}</div>`; }).join("")}`;
          host.querySelectorAll("[data-k]").forEach(el => { const c = byKey[el.dataset.k];
            const go = async () => { const value = c.type === "check" ? el.checked : c.type === "select" ? (opts(c).find(o => String(o.v) === el.value)?.v ?? null) : el.value;
              if (await commit([{ row, key: c.key, value }], { raw: c.type === "check" || c.type === "select" })) setTimeout(drawD, 50); };
            el.onchange = go; if (el.tagName === "INPUT" && el.type === "text") el.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } }; }); };

        d.querySelector("[data-c]").onclick = closeDrawer;
        d.querySelector("[data-o]")?.addEventListener("click", () => { closeDrawer(); cfg.onOpen(row); });
        d.querySelector("[data-p]").onclick = () => { drawerRow = rk(vis[i-1]); drawerFresh = true; drawD(); select(i-1, sel ? sel.a.c : 0); d.focus({ preventScroll:true }); };
        d.querySelector("[data-n]").onclick = () => { drawerRow = rk(vis[i+1]); drawerFresh = true; drawD(); select(i+1, sel ? sel.a.c : 0); d.focus({ preventScroll:true }); };
        if (dock && cfg.drawerBody) { cfg.drawerBody(row, d.querySelector("[data-rec]"), { fields: fieldsInto, fresh: drawerFresh }); drawerFresh = false; return; }
        fieldsInto(d.querySelector("[data-fields]"));
        if (dock && cfg.drawerHead) cfg.drawerHead(row, d.querySelector("[data-head]"));
        if (cfg.drawer) cfg.drawer(row, d.querySelector("[data-extra]"));
      };
      d.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); closeDrawer(); return; }
        // Up and down arrows move to the previous or next row of the current view (not while typing).
        if (dock && (e.key === "ArrowUp" || e.key === "ArrowDown") && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { e.preventDefault(); d.querySelector(e.key === "ArrowUp" ? "[data-p]" : "[data-n]")?.click(); } });
      drawD(); (dock ? d : d.querySelector("[data-c]")).focus({ preventScroll:true }); openDrawer.redraw = drawD;
    }
    function closeDrawer(){ document.querySelectorAll(".sh-drawer,.sh-shade").forEach(e => e.remove()); document.body.classList.remove("sh-docked"); root.classList.remove("sh-dockhost");
      if (drawerRow !== null) { drawerRow = null; $sc.focus({ preventScroll:true }); paint(); } openDrawer.redraw = null; }
    document.addEventListener("keydown", e => { if (e.key === "Escape" && drawerRow !== null && !popEl) closeDrawer(); }, sig);

    // ---------- API ----------
    function selectedRows(){ return data.filter(r => rowSel.has(rk(r))); }
    function setRows(rows){ data = rows || []; measureAuto(); compute(); if (st.mode === "board") drawBoard(); else paint(); if (openDrawer.redraw && document.activeElement?.closest?.(".sh-drawer") == null) openDrawer.redraw(); statusBar(); }
    function destroy(){ ac.abort(); closePop(); closeDrawer(); }
    // Leaving the screen closes a docked pane (it lives on the page body, not inside the sheet).
    addEventListener("hashchange", () => setTimeout(() => { if (!root.isConnected) destroy(); }, 0), sig);
    setColumns(cfg.columns);
    if (cfg.remember) { try { const s = JSON.parse(localStorage.getItem(LS) || "null"); if (s) { viewId = s.viewId || ""; st = { ...baseState(), ...s.st, q:"" }; if (cfg.freshFilters) { const b = baseState(); if (s.viewId && s.def) st = { ...baseState(), ...s.def, q:"" }; viewId = ""; st.filters = b.filters; st.conj = b.conj; st.group = b.group; st.collapsed = []; } setColumns(cfg.columns); } } catch {} }
    data = cfg.rows || []; measureAuto(); full(); loadViews();
    return {
      el: root, setRows, selectedRows, destroy,
      setColumns(list){ cfg.columns = list; setColumns(list); full(); },
      visibleRows: () => vis.slice(), getState: snap, setState: s => { apply(s); save(); },
      addFilter(f){ st.filters = st.filters.filter(x => x.key !== f.key); st.filters.push(f); full(); save(); },
      setFilters(list){ st.filters = clone(list); full(); save(); },
      refresh: () => full(), fit, viewLabel, focus: () => $sc.focus(), status(m){ statusMsg = m; statusErr = false; statusBar(); },
      clearChanges(){ chg = {}; paint(); }, edit: (list, o) => commit(list, o), changes: () => ({ ...chg }), openRow: row => openDrawer(row), redrawDrawer: () => openDrawer.redraw?.(),
      currentView: () => views.find(v => v.id === viewId) || null,
    };
  }
  window.Sheet = { create, parseTSV };
})();
