/* Writing improver: readability stats + inline issue highlighting.
   Issue types: very long sentences, long sentences, passive voice,
   filler/weak words, clichés. */
window.Improver = (() => {
  const { sentences, words, wordCount, fleschReadingEase, fkGrade, escapeHtml } = window.TextKit;

  const FILLERS = [
    "very", "really", "just", "basically", "actually", "literally", "quite",
    "totally", "absolutely", "extremely", "definitely", "certainly", "simply",
    "in order to", "at the end of the day", "needless to say", "as a matter of fact",
    "for all intents and purposes", "each and every", "sort of", "kind of"
  ];

  const CLICHES = [
    "think outside the box", "low-hanging fruit", "move the needle", "it is what it is",
    "at this point in time", "the fact of the matter", "when all is said and done",
    "tip of the iceberg", "in this day and age", "easier said than done",
    "last but not least", "the bottom line", "a level playing field", "win-win",
    "paradigm shift", "synergy", "circle back", "touch base", "boil the ocean"
  ];

  const PASSIVE_RE = /\b(?:am|is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?(\w+(?:ed|en))\b/gi;
  const PASSIVE_FALSE = new Set(["been", "concerned", "interested", "excited", "worried", "married", "tired", "surprised", "pleased", "satisfied", "supposed", "used"]);

  function buildPhraseRe(list) {
    const alts = list.slice().sort((a, b) => b.length - a.length)
      .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp("\\b(" + alts.join("|") + ")\\b", "gi");
  }
  const FILLER_RE = buildPhraseRe(FILLERS);
  const CLICHE_RE = buildPhraseRe(CLICHES);

  /* Collect [start, end, type] spans, resolve overlaps (first wins), render marked HTML. */
  function analyze(text) {
    if (wordCount(text) < 5) return { ok: false, reason: "Please provide at least a full sentence." };

    const spans = [];

    // Sentence-level issues (long / very long) — locate each sentence in the original.
    let cursor = 0;
    for (const s of sentences(text)) {
      const idx = text.indexOf(s, cursor);
      if (idx === -1) continue;
      cursor = idx + s.length;
      const n = wordCount(s);
      if (n >= 35) spans.push([idx, idx + s.length, "verylong"]);
      else if (n >= 25) spans.push([idx, idx + s.length, "long"]);
    }

    // Word/phrase-level issues.
    for (const [re, type] of [[CLICHE_RE, "cliche"], [FILLER_RE, "filler"]]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) spans.push([m.index, m.index + m[0].length, type]);
    }
    PASSIVE_RE.lastIndex = 0;
    let m;
    while ((m = PASSIVE_RE.exec(text)) !== null) {
      if (!PASSIVE_FALSE.has(m[1].toLowerCase())) spans.push([m.index, m.index + m[0].length, "passive"]);
    }

    // Counts by type.
    const counts = { verylong: 0, long: 0, passive: 0, filler: 0, cliche: 0 };
    for (const [, , t] of spans) counts[t]++;

    // Render: sentence-level spans as background layer, word-level nested on top is
    // complex — instead sort spans and skip ones that overlap an earlier different span
    // only if identical range; allow word-level inside sentence-level via two passes.
    const sentenceSpans = spans.filter(s => s[2] === "long" || s[2] === "verylong").sort((a, b) => a[0] - b[0]);
    const wordSpans = spans.filter(s => s[2] !== "long" && s[2] !== "verylong").sort((a, b) => a[0] - b[0]);

    // Drop overlapping word spans (keep the earliest).
    const cleanWord = [];
    let lastEnd = -1;
    for (const s of wordSpans) {
      if (s[0] >= lastEnd) { cleanWord.push(s); lastEnd = s[1]; }
    }

    function renderRange(from, to) {
      let html = "";
      let pos = from;
      for (const [ws, we, wt] of cleanWord) {
        if (we <= from || ws >= to) continue;
        const s = Math.max(ws, from), e = Math.min(we, to);
        html += escapeHtml(text.slice(pos, s));
        html += `<mark class="issue issue-${wt}">${escapeHtml(text.slice(s, e))}</mark>`;
        pos = e;
      }
      html += escapeHtml(text.slice(pos, to));
      return html;
    }

    let html = "";
    let pos = 0;
    for (const [ss, se, st] of sentenceSpans) {
      if (ss < pos) continue;
      html += renderRange(pos, ss);
      html += `<mark class="issue issue-${st}">` + renderRange(ss, se) + `</mark>`;
      pos = se;
    }
    html += renderRange(pos, text.length);

    const ease = fleschReadingEase(text);
    const grade = fkGrade(text);
    const sents = sentences(text);
    const avgLen = wordCount(text) / (sents.length || 1);

    return {
      ok: true,
      html,
      counts,
      totalIssues: spans.length,
      stats: {
        words: wordCount(text),
        sentences: sents.length,
        avgSentence: Math.round(avgLen * 10) / 10,
        ease: Math.round(ease),
        grade: Math.max(1, Math.round(grade))
      }
    };
  }

  function easeLabel(ease) {
    if (ease >= 70) return "Easy to read";
    if (ease >= 50) return "Fairly readable";
    if (ease >= 30) return "Difficult";
    return "Very difficult";
  }

  return { analyze, easeLabel };
})();
