/* ============================================================
   shelftrack — client-side, photo-first stock list for a shop.
   No network. No dependencies. All state in localStorage only.

   Quantities are non-negative integers. Prices are handled in
   integer minor units ("cents") to avoid floating-point drift,
   then formatted for display.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- tiny DOM helpers ---------- */
  var $  = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ============================================================
     PURE HELPERS (unit-tested)
     ============================================================ */

  // Clamp a value to a non-negative integer. Anything invalid -> 0.
  function toCount(v) {
    var n = Math.floor(Number(v));
    if (!isFinite(n) || n < 0) return 0;
    return n;
  }

  // Adjust a stock quantity by delta, never dropping below zero.
  function adjustQty(current, delta) {
    var next = toCount(current) + Math.trunc(Number(delta) || 0);
    return next < 0 ? 0 : next;
  }

  // An item is "low" when its quantity is at or below its reorder level.
  // (Reorder level 0 means "never flag as low".)
  function isLow(qty, reorder) {
    var q = toCount(qty), r = toCount(reorder);
    if (r <= 0) return false;
    return q <= r;
  }

  // Parse a price string ("1,240.50", " 99 ") to integer cents, or null.
  function parseCents(str) {
    if (str == null) return null;
    var s = String(str).replace(/[,\s]/g, "").replace(/[^0-9.]/g, "");
    if (s === "" || s === ".") return null;
    var v = parseFloat(s);
    if (isNaN(v) || v < 0) return null;
    return Math.round(v * 100);
  }
  // Format integer cents as a grouped decimal string (no symbol): 124050 -> "1,240.50".
  function fmtCents(cents) {
    var abs = Math.abs(cents);
    var whole = Math.floor(abs / 100);
    var frac = abs % 100;
    var w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return w + "." + (frac < 10 ? "0" + frac : frac);
  }

  // CSV field escaping (RFC 4180): wrap in quotes and double any inner
  // quotes when the value contains a comma, quote, CR, or LF. Leading /
  // trailing whitespace also forces quoting so it survives round-trips.
  function csvField(value) {
    var s = value == null ? "" : String(value);
    if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // Build a full CSV document (with header) from a list of items.
  function buildCsv(items, currency) {
    var header = ["Name", "Quantity", "Reorder level", "Price", "Currency", "Unit", "Low stock"];
    var rows = [header.map(csvField).join(",")];
    items.forEach(function (it) {
      var priceStr = (it.priceCents != null) ? fmtCents(it.priceCents) : "";
      rows.push([
        csvField(it.name),
        csvField(toCount(it.qty)),
        csvField(toCount(it.reorder)),
        csvField(priceStr),
        csvField(it.priceCents != null ? (currency || "") : ""),
        csvField(it.unit || ""),
        csvField(isLow(it.qty, it.reorder) ? "yes" : "no")
      ].join(","));
    });
    // RFC 4180 uses CRLF line breaks.
    return rows.join("\r\n") + "\r\n";
  }

  // Sort a COPY of the items by the chosen key. Low-stock-first keeps a
  // stable, useful ordering: flagged items on top, most-depleted first.
  function sortItems(items, key) {
    var arr = items.slice();
    if (key === "name") {
      arr.sort(function (a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
    } else if (key === "qty") {
      arr.sort(function (a, b) { return toCount(b.qty) - toCount(a.qty); });
    } else if (key === "added") {
      arr.sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
    } else { // "low" — low stock first, then by how far below reorder
      arr.sort(function (a, b) {
        var la = isLow(a.qty, a.reorder), lb = isLow(b.qty, b.reorder);
        if (la !== lb) return la ? -1 : 1;
        // within the low group, most urgent (qty - reorder smallest) first
        var da = toCount(a.qty) - toCount(a.reorder);
        var db = toCount(b.qty) - toCount(b.reorder);
        if (da !== db) return da - db;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
    }
    return arr;
  }

  // expose pures for the throwaway test harness (no effect in the browser)
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { toCount: toCount, adjustQty: adjustQty, isLow: isLow,
      parseCents: parseCents, fmtCents: fmtCents, csvField: csvField,
      buildCsv: buildCsv, sortItems: sortItems };
  }

  /* ============================================================
     STATE + PERSISTENCE (localStorage only)
     ============================================================ */
  var STORE_KEY = "shelftrack:v1";
  var storageOk = true;

  var state = {
    currency: "₹",   // rupee by default
    items: []             // [{ id, name, qty, reorder, priceCents, unit, photo, created }]
  };

  function uid() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  function save() {
    if (!storageOk) return true;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      // Most likely a quota error — surface it, don't crash.
      return false;
    }
  }

  function load() {
    try {
      localStorage.setItem("shelftrack:test", "1");
      localStorage.removeItem("shelftrack:test");
    } catch (e) { storageOk = false; }

    var raw = null;
    if (storageOk) { try { raw = localStorage.getItem(STORE_KEY); } catch (e) { raw = null; } }
    if (raw) {
      try {
        var loaded = JSON.parse(raw);
        if (loaded && Array.isArray(loaded.items)) {
          state = loaded;
          if (typeof state.currency !== "string" || !state.currency) state.currency = "₹";
          // normalise each item defensively
          state.items = state.items.map(function (it) {
            return {
              id: it.id || uid(),
              name: String(it.name || "Untitled"),
              qty: toCount(it.qty),
              reorder: toCount(it.reorder),
              priceCents: (it.priceCents == null ? null : toCount(it.priceCents)),
              unit: it.unit ? String(it.unit) : "",
              photo: (typeof it.photo === "string" && it.photo.indexOf("data:image") === 0) ? it.photo : null,
              created: it.created || Date.now()
            };
          });
        }
      } catch (e) { /* fall through to seed */ }
    }
    if (!state.items.length) seed();
  }

  // A small starter shelf so the app is never a blank slate.
  function seed() {
    var now = Date.now();
    state.items = [
      { id: uid(), name: "Masala chai · 250g", qty: 3, reorder: 6, priceCents: 9000, unit: "pack", photo: null, created: now - 5000 },
      { id: uid(), name: "Basmati rice · 5kg", qty: 12, reorder: 4, priceCents: 62000, unit: "bag", photo: null, created: now - 4000 },
      { id: uid(), name: "Toor dal · 1kg", qty: 2, reorder: 5, priceCents: 14500, unit: "pack", photo: null, created: now - 3000 },
      { id: uid(), name: "Sunflower oil · 1L", qty: 9, reorder: 3, priceCents: 15000, unit: "bottle", photo: null, created: now - 2000 }
    ];
  }

  function itemById(id) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
    return null;
  }

  function money(cents) { return state.currency + fmtCents(cents); }

  /* ============================================================
     PHOTO CAPTURE — file input -> canvas downscale -> JPEG dataURL.
     Uses <input type=file accept=image/* capture=environment>, so on
     a phone it opens the camera and on desktop a file picker. Keeps
     the CSP pristine (no getUserMedia, no blob: needed).
     ============================================================ */
  var pendingPhoto = null;   // dataURL staged for the current form, or null
  var MAX_EDGE = 320;        // px on the long edge
  var JPEG_QUALITY = 0.7;

  function photoMsg(text, warn) {
    var m = $("#photoMsg");
    m.textContent = text || "";
    m.hidden = !text;
    m.classList.toggle("is-warn", !!warn);
  }

  function handlePhotoFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      photoMsg("That file isn't an image. Try a photo instead.", true);
      return;
    }
    photoMsg("Processing photo…", false);
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          if (!w || !h) throw new Error("bad image");
          var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement("canvas");
          canvas.width = cw; canvas.height = ch;
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, cw, ch);
          var url = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
          pendingPhoto = url;
          showPhoto(url);
          photoMsg("", false);
        } catch (e) {
          photoMsg("Could not process that photo. You can save without one.", true);
        }
      };
      img.onerror = function () { photoMsg("Could not read that image. You can save without one.", true); };
      img.src = reader.result;
    };
    reader.onerror = function () { photoMsg("Could not read that file. You can save without one.", true); };
    reader.readAsDataURL(file);
  }

  function showPhoto(url) {
    var im = $("#photoImg");
    im.src = url; im.hidden = false;
    $("#photoPlaceholder").hidden = true;
    $("#clearPhotoBtn").hidden = false;
    $("#photoPickLabel").textContent = "Replace photo";
  }
  function resetPhotoUI() {
    pendingPhoto = null;
    var im = $("#photoImg");
    im.hidden = true; im.removeAttribute("src");
    $("#photoPlaceholder").hidden = false;
    $("#clearPhotoBtn").hidden = true;
    $("#photoPickLabel").textContent = "Take / choose photo";
    $("#photoInput").value = "";
    photoMsg("", false);
  }

  /* ============================================================
     STORAGE USAGE ESTIMATE
     ============================================================ */
  var STORAGE_BUDGET = 5 * 1024 * 1024;   // ~5 MB typical localStorage cap

  function usedBytes() {
    // UTF-16 in memory, but a close, cheap estimate is the JSON length.
    try { return JSON.stringify(state).length * 2; } catch (e) { return 0; }
  }
  function renderStorage() {
    var bytes = usedBytes();
    var pct = Math.min(100, Math.round((bytes / STORAGE_BUDGET) * 100));
    var fill = $("#storageFill");
    var txt = $("#storageText");
    fill.style.width = pct + "%";
    var kb = bytes / 1024;
    var human = kb < 1024 ? (Math.round(kb * 10) / 10) + " KB" : (Math.round((kb / 1024) * 100) / 100) + " MB";
    var withPhoto = state.items.filter(function (i) { return i.photo; }).length;
    var warn = pct >= 80;
    fill.classList.toggle("is-warn", warn);
    txt.classList.toggle("is-warn", warn);
    if (!state.items.length) {
      txt.textContent = "No items stored yet.";
    } else {
      txt.textContent = "About " + human + " used (~" + pct + "% of the browser budget) · " +
        withPhoto + " " + (withPhoto === 1 ? "photo" : "photos") +
        (warn ? " — storage is getting full, consider removing some photos." : ".");
    }
  }

  /* ============================================================
     FORM — add / edit an item
     ============================================================ */
  var editingId = null;

  function readForm() {
    var name = $("#itemName").value.trim();
    var qtyRaw = $("#itemQty").value.trim();
    var reorderRaw = $("#itemReorder").value.trim();
    var priceRaw = $("#itemPrice").value.trim();
    var unit = $("#itemUnit").value.trim();

    if (!name) return { error: "Give the item a name." };
    if (qtyRaw === "" || !/^\d+$/.test(qtyRaw)) return { error: "In-stock must be a whole number (0 or more)." };
    if (reorderRaw === "" || !/^\d+$/.test(reorderRaw)) return { error: "Reorder level must be a whole number (0 or more)." };

    var priceCents = null;
    if (priceRaw !== "") {
      priceCents = parseCents(priceRaw);
      if (priceCents == null) return { error: "Price must be a valid amount, or left blank." };
    }

    return { item: {
      id: editingId || uid(),
      name: name,
      qty: toCount(qtyRaw),
      reorder: toCount(reorderRaw),
      priceCents: priceCents,
      unit: unit,
      photo: pendingPhoto || null,
      created: editingId ? (itemById(editingId) || {}).created || Date.now() : Date.now()
    } };
  }

  function submitForm(e) {
    e.preventDefault();
    var res = readForm();
    var errEl = $("#formError");
    if (res.error) { errEl.textContent = res.error; return; }
    errEl.textContent = "";

    if (editingId) {
      for (var i = 0; i < state.items.length; i++) {
        if (state.items[i].id === editingId) { state.items[i] = res.item; break; }
      }
    } else {
      state.items.push(res.item);
    }

    if (!save()) {
      // roll back the just-added item if storage is full
      if (!editingId) state.items.pop();
      errEl.textContent = "Storage is full — remove some items or photos, then try again.";
      renderStorage();
      return;
    }

    var wasEditing = !!editingId;
    endEdit();
    render();
    showToast(wasEditing ? "Item updated" : "Item added");
    if (!wasEditing) $("#itemName").focus();
  }

  function startEdit(id) {
    var it = itemById(id);
    if (!it) return;
    editingId = id;
    $("#itemName").value = it.name;
    $("#itemQty").value = String(toCount(it.qty));
    $("#itemReorder").value = String(toCount(it.reorder));
    $("#itemPrice").value = it.priceCents != null ? fmtCents(it.priceCents).replace(/,/g, "") : "";
    $("#itemUnit").value = it.unit || "";
    resetPhotoUI();
    if (it.photo) { pendingPhoto = it.photo; showPhoto(it.photo); }
    $("#formHeading").textContent = "Edit item";
    $("#saveItemBtn").textContent = "Save changes";
    $("#cancelEditBtn").hidden = false;
    $("#formError").textContent = "";
    var form = $("#additem");
    if (form && form.scrollIntoView) form.scrollIntoView({ behavior: "smooth", block: "start" });
    $("#itemName").focus();
  }

  function endEdit() {
    editingId = null;
    $("#itemForm").reset();
    resetPhotoUI();
    $("#formHeading").textContent = "Add an item";
    $("#saveItemBtn").textContent = "Add item";
    $("#cancelEditBtn").hidden = true;
    $("#formError").textContent = "";
    $("#priceSym").textContent = state.currency;
  }

  function deleteItem(id) {
    var it = itemById(id);
    if (!it) return;
    if (!window.confirm("Delete “" + it.name + "”? This can't be undone.")) return;
    state.items = state.items.filter(function (x) { return x.id !== id; });
    if (editingId === id) endEdit();
    save();
    render();
    showToast("Item deleted");
  }

  // fast +/- from the list; delta is +1 or -1 (never below zero)
  function bumpQty(id, delta) {
    var it = itemById(id);
    if (!it) return;
    it.qty = adjustQty(it.qty, delta);
    save();
    render();
  }

  /* ============================================================
     LIST CONTROLS (search / sort / low-only)
     ============================================================ */
  var ui = { search: "", sort: "low", lowOnly: false };

  function visibleItems() {
    var q = ui.search.trim().toLowerCase();
    var filtered = state.items.filter(function (it) {
      if (ui.lowOnly && !isLow(it.qty, it.reorder)) return false;
      if (q && it.name.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    return sortItems(filtered, ui.sort);
  }

  /* ============================================================
     RENDER — stock list
     ============================================================ */
  var CAM_GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3l1.5-2h7L18 7h2a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"></path><circle cx="12" cy="13" r="3.5"></circle></svg>';

  function render() {
    $("#priceSym").textContent = state.currency;

    var list = $("#stockList");
    list.innerHTML = "";

    var totalLow = state.items.filter(function (it) { return isLow(it.qty, it.reorder); }).length;
    $("#itemCount").textContent = String(state.items.length);
    var lowTag = $("#lowTag");
    if (totalLow > 0) {
      lowTag.hidden = false;
      lowTag.textContent = totalLow + " low";
    } else {
      lowTag.hidden = true;
    }

    var shown = visibleItems();

    // empty states
    if (!state.items.length) {
      $("#listEmpty").hidden = false;
      $("#searchEmpty").hidden = true;
    } else if (!shown.length) {
      $("#listEmpty").hidden = true;
      $("#searchEmpty").hidden = false;
      $("#searchEmpty").textContent = ui.lowOnly
        ? "Nothing is low on stock right now. 🌿"
        : "No items match your search.";
    } else {
      $("#listEmpty").hidden = true;
      $("#searchEmpty").hidden = true;
    }

    shown.forEach(function (it) {
      var low = isLow(it.qty, it.reorder);
      var out = toCount(it.qty) === 0;
      var li = el("li", "stock__item" + (low ? " is-low" : "") + (out ? " is-out" : ""));

      // thumbnail
      if (it.photo) {
        var img = el("img", "stock__thumb");
        img.src = it.photo;
        img.alt = "Photo of " + it.name;
        li.appendChild(img);
      } else {
        var blank = el("span", "stock__thumb stock__thumb--blank");
        blank.setAttribute("aria-hidden", "true");
        blank.innerHTML = CAM_GLYPH;
        li.appendChild(blank);
      }

      // body
      var body = el("div", "stock__body");
      var nameline = el("div", "stock__nameline");
      nameline.appendChild(el("span", "stock__name", it.name));
      if (out) {
        nameline.appendChild(makeBadge("badge badge--out", "OUT"));
      } else if (low) {
        nameline.appendChild(makeBadge("badge badge--low", "LOW"));
      }
      body.appendChild(nameline);

      var meta = el("p", "stock__meta");
      meta.appendChild(document.createTextNode("Reorder at "));
      var rem = el("em", null, String(toCount(it.reorder)));
      meta.appendChild(rem);
      if (it.priceCents != null) {
        meta.appendChild(document.createTextNode(" · "));
        var pr = el("span", "stock__price", money(it.priceCents) + (it.unit ? " / " + it.unit : ""));
        meta.appendChild(pr);
      } else if (it.unit) {
        meta.appendChild(document.createTextNode(" · " + it.unit));
      }
      body.appendChild(meta);

      var editrow = el("div", "stock__editrow");
      var editBtn = el("button", "stock__link", "Edit"); editBtn.type = "button";
      editBtn.setAttribute("aria-label", "Edit " + it.name);
      editBtn.addEventListener("click", function () { startEdit(it.id); });
      var delBtn = el("button", "stock__link stock__link--del", "Delete"); delBtn.type = "button";
      delBtn.setAttribute("aria-label", "Delete " + it.name);
      delBtn.addEventListener("click", function () { deleteItem(it.id); });
      editrow.appendChild(editBtn); editrow.appendChild(delBtn);
      body.appendChild(editrow);
      li.appendChild(body);

      // quantity stepper
      var qtyWrap = el("div", "stock__qty");
      var stepper = el("div", "stepper");
      var minus = el("button", "step", "−"); minus.type = "button";
      minus.setAttribute("aria-label", "Decrease stock of " + it.name);
      minus.disabled = toCount(it.qty) === 0;
      minus.addEventListener("click", function () { bumpQty(it.id, -1); });
      var num = el("span", "stock__qtynum", String(toCount(it.qty)));
      num.setAttribute("aria-live", "polite");
      num.setAttribute("aria-label", it.name + ": " + toCount(it.qty) + " in stock" + (low ? ", low" : ""));
      var plus = el("button", "step", "+"); plus.type = "button";
      plus.setAttribute("aria-label", "Increase stock of " + it.name);
      plus.addEventListener("click", function () { bumpQty(it.id, 1); });
      stepper.appendChild(minus); stepper.appendChild(num); stepper.appendChild(plus);
      qtyWrap.appendChild(stepper);
      qtyWrap.appendChild(el("span", "stock__qtylabel", "in stock"));
      li.appendChild(qtyWrap);

      list.appendChild(li);
    });

    renderStorage();
  }

  function makeBadge(cls, text) {
    var b = el("span", cls, text);
    return b;
  }

  /* ============================================================
     CSV EXPORT — offline download via a data: URL (CSP-safe)
     ============================================================ */
  function exportCsv() {
    if (!state.items.length) { showToast("Nothing to export yet"); return; }
    var csv = buildCsv(sortItems(state.items, ui.sort), state.currency);
    // Prepend a UTF-8 BOM so spreadsheets read non-ASCII names correctly.
    var content = "﻿" + csv;
    var href = "data:text/csv;charset=utf-8," + encodeURIComponent(content);
    var a = document.createElement("a");
    a.href = href;
    a.download = "shelftrack-stock-" + dateStamp() + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast("CSV exported (" + state.items.length + " " + (state.items.length === 1 ? "item" : "items") + ")");
  }

  function dateStamp() {
    var d = new Date();
    var m = ("0" + (d.getMonth() + 1)).slice(-2);
    var day = ("0" + d.getDate()).slice(-2);
    return d.getFullYear() + "-" + m + "-" + day;
  }

  /* ---------- toast ---------- */
  var toastTimer = null;
  function showToast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2400);
  }

  /* ============================================================
     WIRE UP
     ============================================================ */
  function init() {
    load();

    $("#itemForm").addEventListener("submit", submitForm);
    $("#cancelEditBtn").addEventListener("click", function () { endEdit(); });

    $("#photoInput").addEventListener("change", function () {
      var f = this.files && this.files[0];
      handlePhotoFile(f);
    });
    $("#clearPhotoBtn").addEventListener("click", function () { resetPhotoUI(); });

    $("#searchInput").addEventListener("input", function () { ui.search = this.value; render(); });
    $("#sortSelect").addEventListener("change", function () { ui.sort = this.value; render(); });
    $("#lowOnlyBtn").addEventListener("click", function () {
      ui.lowOnly = !ui.lowOnly;
      this.setAttribute("aria-pressed", ui.lowOnly ? "true" : "false");
      this.textContent = ui.lowOnly ? "Show all" : "Low only";
      render();
    });
    $("#exportBtn").addEventListener("click", exportCsv);

    $("#currencyInput").addEventListener("input", function () {
      var v = this.value.trim();
      state.currency = v || "₹";
      $("#priceSym").textContent = state.currency;
      save();
      render();
    });

    // keep the currency control + symbol in sync on first paint
    $("#currencyInput").value = state.currency;
    $("#priceSym").textContent = state.currency;

    if (!storageOk) {
      showToast("Storage is blocked here — changes won't be saved between visits");
    }

    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
