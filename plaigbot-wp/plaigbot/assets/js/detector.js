/* AI content detector: stylometric heuristics combined into an estimate.
   Signals: sentence-length burstiness, lexical diversity, stock AI phrasing,
   repetitive sentence openers, and punctuation/character variety. */
window.Detector = (() => {
  const { words, sentences, clamp } = window.TextKit;

  const AI_PHRASES = [
    "it is important to note", "it's important to note", "it is worth noting",
    "in conclusion", "in summary", "to summarize", "furthermore", "moreover",
    "additionally", "delve into", "delves into", "delving into",
    "in today's fast-paced world", "in the ever-evolving", "ever-evolving landscape",
    "navigating the", "unlock", "unlocking", "leverage", "leveraging",
    "seamless", "seamlessly", "robust", "holistic", "comprehensive overview",
    "plays a crucial role", "plays a vital role", "plays a pivotal role",
    "significant benefits", "wide range of", "a myriad of", "myriad of",
    "tapestry", "testament to", "underscores", "underscore the",
    "it is essential to", "is essential for", "when it comes to",
    "in the realm of", "the realm of", "landscape of", "harness the power",
    "embark on", "embarking on", "streamline", "streamlining",
    "cutting-edge", "state-of-the-art", "game-changer", "transformative",
    "profound ways", "digital landscape", "valuable insights", "actionable insights",
    "best practices", "key takeaways", "dive deep", "deep dive",
    "elevate your", "empower", "empowering", "fostering", "foster a"
  ];

  function analyze(text) {
    const sents = sentences(text);
    const ws = words(text).map(w => w.toLowerCase());
    if (ws.length < 30 || sents.length < 2) {
      return { ok: false, reason: "Please provide at least ~30 words and two sentences for a meaningful analysis." };
    }

    // --- Signal 1: Burstiness (variance of sentence lengths). Humans vary a lot. ---
    const lens = sents.map(s => words(s).length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
    const cv = Math.sqrt(variance) / (mean || 1); // coefficient of variation
    // cv >= 0.55 → very human rhythm (0), cv <= 0.15 → very uniform (100)
    const uniformity = clamp((0.55 - cv) / 0.40, 0, 1) * 100;

    // --- Signal 2: Lexical diversity (type-token ratio, window-adjusted). ---
    const window = ws.slice(0, 200);
    const ttr = new Set(window).size / window.length;
    // ttr >= 0.72 rich vocab (0) … ttr <= 0.42 repetitive (100)
    const monotony = clamp((0.72 - ttr) / 0.30, 0, 1) * 100;

    // --- Signal 3: Stock AI phrasing frequency. ---
    const lower = text.toLowerCase();
    let phraseHits = 0;
    const found = [];
    for (const p of AI_PHRASES) {
      let idx = lower.indexOf(p);
      while (idx !== -1) {
        phraseHits++;
        if (found.length < 6 && !found.includes(p)) found.push(p);
        idx = lower.indexOf(p, idx + p.length);
      }
    }
    const per100 = (phraseHits / ws.length) * 100;
    // 2.5+ stock phrases per 100 words → saturated
    const stockiness = clamp(per100 / 2.5, 0, 1) * 100;

    // --- Signal 4: Repeated sentence openers. ---
    const openers = sents.map(s => words(s).slice(0, 2).join(" ").toLowerCase()).filter(Boolean);
    const openerRepeat = 1 - new Set(openers).size / (openers.length || 1);
    const openerScore = clamp(openerRepeat / 0.5, 0, 1) * 100;

    // --- Signal 5: Character variety (contractions, questions, digits, dashes). ---
    let variety = 0;
    if (/[’']\w/.test(text)) variety++;          // contractions
    if (/\?/.test(text)) variety++;               // questions
    if (/\d/.test(text)) variety++;               // concrete numbers
    if (/[—–;:()]/.test(text)) variety++;         // varied punctuation
    if (/\b(I|we|my|our)\b/i.test(text)) variety++; // first person
    const blandness = ((5 - variety) / 5) * 100;

    const signals = [
      { name: "Sentence rhythm", score: uniformity, weight: 0.28,
        note: uniformity > 60 ? "Sentences are unusually uniform in length — a common AI trait."
            : uniformity > 30 ? "Moderate variation in sentence length."
            : "Strong natural variation in sentence length (very human)." },
      { name: "Vocabulary variety", score: monotony, weight: 0.20,
        note: monotony > 60 ? "Word choice is repetitive across the text."
            : monotony > 30 ? "Average vocabulary range."
            : "Rich, varied vocabulary." },
      { name: "Stock AI phrasing", score: stockiness, weight: 0.30,
        note: found.length ? `Found: ${found.map(f => `“${f}”`).join(", ")}` : "No stock AI phrases detected." },
      { name: "Sentence openers", score: openerScore, weight: 0.10,
        note: openerScore > 50 ? "Many sentences begin the same way." : "Sentence openings are varied." },
      { name: "Texture & voice", score: blandness, weight: 0.12,
        note: blandness > 60 ? "No contractions, questions, numbers or first-person voice — reads flat."
            : "Contains personal voice or concrete texture." }
    ];

    const overall = Math.round(signals.reduce((a, s) => a + s.score * s.weight, 0));

    let band, label;
    if (overall < 35) { band = "v-low"; label = "Likely human-written"; }
    else if (overall < 65) { band = "v-mid"; label = "Mixed signals — could be either"; }
    else { band = "v-high"; label = "Shows strong AI-typical patterns"; }

    return { ok: true, overall, band, label, signals, wordCount: ws.length, sentenceCount: sents.length };
  }

  return { analyze };
})();
