/* App shell: tabs, theme, toolbars, and per-tool wiring. */
(() => {
  const { wordCount, escapeHtml } = window.TextKit;
  const $ = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];

  /* ---------- Theme ---------- */
  const root = document.documentElement;
  const storedTheme = localStorage.getItem("cw-theme");
  if (storedTheme) root.dataset.theme = storedTheme;
  else if (matchMedia("(prefers-color-scheme: dark)").matches) root.dataset.theme = "dark";
  $("#theme-toggle").addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    localStorage.setItem("cw-theme", next);
  });

  /* ---------- Tabs ---------- */
  const tabs = $$(".tool-tab");
  const panels = $$(".tool-panel");
  function activate(tool) {
    tabs.forEach(t => {
      const on = t.dataset.tool === tool;
      t.classList.toggle("active", on);
      if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    });
    panels.forEach(p => {
      const on = p.id === "panel-" + tool;
      p.classList.toggle("active", on);
      p.hidden = !on;
    });
    history.replaceState(null, "", "#" + tool);
  }
  tabs.forEach(t => t.addEventListener("click", () => activate(t.dataset.tool)));
  const initial = location.hash.slice(1);
  if (["paraphrase", "plagiarism", "detector", "improver"].includes(initial)) activate(initial);

  /* ---------- Toast ---------- */
  const toastEl = $("#toast");
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  /* ---------- Word counters ---------- */
  $$("[data-count-for]").forEach(el => {
    const input = document.getElementById(el.dataset.countFor);
    const update = () => {
      const n = wordCount(input.value);
      el.textContent = `${n} word${n === 1 ? "" : "s"}`;
    };
    input.addEventListener("input", update);
    input._countUpdate = update;
  });

  /* ---------- Toolbar actions (sample / paste / clear / copy) ---------- */
  document.addEventListener("click", async e => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const target = document.getElementById(btn.dataset.target);
    const action = btn.dataset.action;

    if (action === "sample") {
      const sample = window.Samples[btn.dataset.target];
      if (sample) {
        target.value = sample;
        target.dispatchEvent(new Event("input"));
        // Plagiarism sample fills both panes for a one-click demo.
        if (btn.dataset.target === "pl-doc") {
          const src = document.getElementById("pl-src");
          src.value = window.Samples["pl-src"];
          src.dispatchEvent(new Event("input"));
        }
        toast("Sample loaded — hit the button below to run it");
      }
    } else if (action === "paste") {
      try {
        const text = await navigator.clipboard.readText();
        target.value = text;
        target.dispatchEvent(new Event("input"));
      } catch {
        toast("Clipboard blocked — paste with Ctrl+V instead");
        target.focus();
      }
    } else if (action === "clear") {
      target.value = "";
      target.dispatchEvent(new Event("input"));
      target.focus();
    } else if (action === "copy") {
      const text = target.innerText.trim();
      if (!text || target.querySelector(".empty-state")) { toast("Nothing to copy yet"); return; }
      try {
        await navigator.clipboard.writeText(text);
        toast("Copied to clipboard ✓");
      } catch { toast("Copy failed — select the text manually"); }
    }
  });

  /* ---------- Ctrl+Enter runs the active tool ---------- */
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      const active = $(".tool-panel.active");
      const btn = active && active.querySelector(".primary-btn");
      if (btn) { e.preventDefault(); btn.click(); }
    }
  });

  /* ================= Paraphraser ================= */
  let ppMode = "standard";
  $$("#panel-paraphrase .mode-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      $$("#panel-paraphrase .mode-chip").forEach(c => {
        c.classList.toggle("active", c === chip);
        c.setAttribute("aria-checked", c === chip ? "true" : "false");
      });
      ppMode = chip.dataset.mode;
      if ($("#pp-input").value.trim()) runParaphrase();
    });
  });

  function runParaphrase() {
    const input = $("#pp-input").value;
    const out = $("#pp-output");
    if (wordCount(input) < 3) { toast("Add some text first (at least a few words)"); return; }
    const { html, changed } = window.Paraphraser.run(input, ppMode);
    out.innerHTML = `<div>${html.replace(/\n/g, "<br>")}</div>`;
    const n = wordCount(out.innerText);
    $("#pp-out-count").textContent = `${n} words`;
    $("#pp-changed-note").textContent = changed
      ? `${changed} edit${changed === 1 ? "" : "s"} — highlighted for review`
      : "No changes suggested for this mode — try another mode.";
  }
  $("#pp-run").addEventListener("click", runParaphrase);
  $("#pp-show-changes").addEventListener("change", e => {
    $("#pp-output").classList.toggle("hide-changes", !e.target.checked);
  });

  /* ================= Plagiarism ================= */
  $("#pl-run").addEventListener("click", () => {
    const doc = $("#pl-doc").value;
    const src = $("#pl-src").value;
    if (wordCount(doc) < 10 || wordCount(src) < 10) {
      toast("Both texts need at least ~10 words");
      return;
    }
    const r = window.Plagiarism.run(doc, src);
    const v = window.Plagiarism.verdict(r.score);

    $("#pl-results").hidden = false;
    $("#pl-score").textContent = r.score + "%";
    $("#pl-verdict").textContent = v.label;
    $("#pl-detail").textContent = `${r.docMatchedWords} of ${r.docWords} words in your document appear in matching runs of 5+ words (${r.runs} matched passage${r.runs === 1 ? "" : "s"}). ${v.detail}`;
    $("#pl-doc-marked").innerHTML = r.docHtml;
    $("#pl-src-marked").innerHTML = r.srcHtml;

    const C = 2 * Math.PI * 52; // dial circumference
    const fill = $("#pl-dial-fill");
    fill.style.strokeDashoffset = C * (1 - r.score / 100);
    fill.style.stroke = r.score >= 50 ? "var(--red)" : r.score >= 20 ? "var(--amber)" : "var(--green)";
    $("#pl-results").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  /* ================= AI Detector ================= */
  $("#ai-run").addEventListener("click", () => {
    const text = $("#ai-input").value;
    const box = $("#ai-results");
    const r = window.Detector.analyze(text);
    if (!r.ok) {
      box.innerHTML = `<div class="empty-state"><div class="empty-icon">📏</div><p>${escapeHtml(r.reason)}</p></div>`;
      return;
    }
    const bandIcon = r.band === "v-low" ? "🙂" : r.band === "v-mid" ? "🤔" : "🤖";
    box.innerHTML = `
      <div class="verdict-banner ${r.band}">
        <span style="font-size:1.6rem">${bandIcon}</span>
        <div>
          <span class="big">${r.overall}%</span> AI-likelihood estimate<br>
          <span>${escapeHtml(r.label)}</span>
        </div>
      </div>
      ${r.signals.map(s => `
        <div class="signal">
          <div class="signal-head">
            <span class="signal-name">${escapeHtml(s.name)}</span>
            <span class="signal-val">${Math.round(s.score)}/100 · weight ${Math.round(s.weight * 100)}%</span>
          </div>
          <div class="signal-bar"><i style="width:0%"></i></div>
          <div class="signal-note">${escapeHtml(s.note)}</div>
        </div>`).join("")}
      <p class="report-note">Analyzed ${r.wordCount} words across ${r.sentenceCount} sentences. Higher bars = more AI-typical. Short or technical texts skew unreliable.</p>`;
    // Animate the bars in after paint.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      box.querySelectorAll(".signal-bar i").forEach((bar, i) => {
        bar.style.width = Math.round(r.signals[i].score) + "%";
      });
    }));
  });

  /* ================= Improver ================= */
  const ISSUE_META = {
    verylong: { label: "Very long sentences (35+ words)", color: "var(--red)" },
    long: { label: "Long sentences (25+ words)", color: "var(--amber)" },
    passive: { label: "Passive voice", color: "var(--green)" },
    filler: { label: "Filler & weak words", color: "var(--accent)" },
    cliche: { label: "Clichés", color: "var(--red)" }
  };

  $("#im-run").addEventListener("click", () => {
    const text = $("#im-input").value;
    const box = $("#im-results");
    const r = window.Improver.analyze(text);
    if (!r.ok) {
      box.innerHTML = `<div class="empty-state"><div class="empty-icon">📏</div><p>${escapeHtml(r.reason)}</p></div>`;
      return;
    }
    const s = r.stats;
    const summaryRows = Object.entries(r.counts)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `<li><span class="dot" style="background:${ISSUE_META[t].color}"></span>${ISSUE_META[t].label}<span class="n">${n}</span></li>`)
      .join("");

    box.innerHTML = `
      <div class="stats-grid">
        <div class="stat-tile"><b>${s.ease}</b><span>Reading ease<br>${window.Improver.easeLabel(s.ease)}</span></div>
        <div class="stat-tile"><b>${s.grade}</b><span>Grade level</span></div>
        <div class="stat-tile"><b>${s.avgSentence}</b><span>Avg words / sentence</span></div>
        <div class="stat-tile"><b>${r.totalIssues}</b><span>Issues found</span></div>
      </div>
      ${r.totalIssues === 0
        ? `<div class="all-clear">✅ Clean draft — no common issues found. Nice work.</div>`
        : `<ul class="issue-summary">${summaryRows}</ul>`}
      <div class="marked-inline">${r.html.replace(/\n/g, "<br>")}</div>
      <p class="report-note">Aim for reading ease above 60 for general audiences. Break up highlighted sentences, swap passive voice for active, and cut filler words.</p>`;
  });
})();
