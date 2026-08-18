/* Paraphrasing engine: dictionary-driven rewriting with four modes.
   Runs fully client-side; every change is highlighted for review. */
window.Paraphraser = (() => {
  const { matchCase, escapeHtml } = window.TextKit;

  // General synonym swaps used by Standard mode (conservative, meaning-preserving).
  const STANDARD = {
    "rapid": "fast", "growth": "expansion", "fundamentally": "deeply",
    "changed": "reshaped", "companies": "businesses", "organizations": "companies",
    "believe": "think", "sufficient": "enough", "accomplish": "complete",
    "tasks": "work", "however": "still", "worried": "concerned",
    "regular": "frequent", "experimenting": "testing", "combine": "blend",
    "collaboration": "teamwork", "important": "significant", "significant": "notable",
    "big": "large", "small": "modest", "help": "assist", "helps": "assists",
    "show": "demonstrate", "shows": "demonstrates", "showed": "demonstrated",
    "use": "employ", "uses": "employs", "used": "employed", "using": "employing",
    "make": "create", "makes": "creates", "made": "created",
    "need": "require", "needs": "requires", "needed": "required",
    "get": "obtain", "gets": "obtains", "got": "obtained",
    "start": "begin", "starts": "begins", "started": "began",
    "end": "conclude", "ends": "concludes", "ended": "concluded",
    "buy": "purchase", "keep": "retain", "find": "discover", "found": "discovered",
    "quickly": "rapidly", "slowly": "gradually",
    "many": "numerous", "often": "frequently", "hard": "difficult",
    "easy": "simple", "improve": "enhance", "improves": "enhances",
    "improved": "enhanced", "problem": "issue", "problems": "issues",
    "idea": "concept", "ideas": "concepts", "goal": "objective", "goals": "objectives",
    "choose": "select", "chose": "selected", "answer": "response",
    "asked": "requested", "told": "informed",
    "also": "additionally", "because": "since",
    "very": "highly", "really": "genuinely", "good": "strong", "great": "excellent",
    "bad": "poor", "new": "recent", "old": "earlier", "way": "method", "ways": "methods",
    "part": "portion", "parts": "portions", "whole": "entire",
    "give": "provide", "gives": "provides", "gave": "provided", "given": "provided"
  };

  // Formal mode: casual → formal vocabulary, plus contraction expansion.
  const FORMAL = {
    "get": "obtain", "gets": "obtains", "got": "obtained", "getting": "obtaining",
    "buy": "purchase", "bought": "purchased", "kids": "children", "kid": "child",
    "a lot of": "a considerable amount of", "lots of": "many",
    "big": "substantial", "huge": "considerable", "tiny": "minimal",
    "show": "demonstrate", "shows": "demonstrates", "showed": "demonstrated",
    "think": "consider", "thinks": "considers", "thought": "considered",
    "also": "furthermore", "so": "therefore", "but": "however",
    "start": "commence", "started": "commenced", "end": "conclude", "ended": "concluded",
    "ask": "inquire", "asked": "inquired", "need": "require", "needs": "requires",
    "help": "assist", "helps": "assists", "helped": "assisted",
    "use": "utilize", "uses": "utilizes", "used": "utilized",
    "really": "genuinely", "very": "exceedingly", "maybe": "perhaps",
    "ok": "acceptable", "okay": "acceptable", "stuff": "material", "things": "matters",
    "good": "favorable", "bad": "unfavorable", "wrong": "incorrect", "right": "correct",
    "enough": "sufficient", "worried": "concerned", "believe": "maintain",
    "make sure": "ensure", "find out": "determine", "look at": "examine",
    "put off": "postpone", "set up": "establish", "go up": "increase", "go down": "decrease"
  };

  const CONTRACTIONS = {
    "can't": "cannot", "won't": "will not", "don't": "do not", "doesn't": "does not",
    "didn't": "did not", "isn't": "is not", "aren't": "are not", "wasn't": "was not",
    "weren't": "were not", "hasn't": "has not", "haven't": "have not", "hadn't": "had not",
    "shouldn't": "should not", "wouldn't": "would not", "couldn't": "could not",
    "it's": "it is", "that's": "that is", "there's": "there is", "let's": "let us",
    "i'm": "I am", "we're": "we are", "they're": "they are", "you're": "you are",
    "i've": "I have", "we've": "we have", "they've": "they have", "you've": "you have",
    "i'll": "I will", "we'll": "we will", "they'll": "they will", "you'll": "you will",
    "i'd": "I would", "we'd": "we would", "they'd": "they would", "you'd": "you would"
  };

  // Simple mode: complex → plain words.
  const SIMPLE = {
    "utilize": "use", "utilizes": "uses", "utilized": "used", "utilizing": "using",
    "approximately": "about", "sufficient": "enough", "insufficient": "not enough",
    "demonstrate": "show", "demonstrates": "shows", "demonstrated": "showed",
    "purchase": "buy", "purchased": "bought", "commence": "start", "commenced": "started",
    "conclude": "end", "concluded": "ended", "terminate": "end", "terminated": "ended",
    "endeavor": "try", "attempt": "try", "attempted": "tried",
    "assistance": "help", "assist": "help", "assists": "helps", "assisted": "helped",
    "numerous": "many", "facilitate": "help", "facilitates": "helps",
    "subsequently": "later", "previously": "before", "additionally": "also",
    "furthermore": "also", "moreover": "also", "nevertheless": "still",
    "consequently": "so", "therefore": "so", "however": "but",
    "fundamental": "basic", "fundamentally": "basically", "significant": "big",
    "significantly": "greatly", "component": "part", "components": "parts",
    "individuals": "people", "individual": "person", "obtain": "get", "obtained": "got",
    "require": "need", "requires": "needs", "required": "needed",
    "regarding": "about", "concerning": "about", "prioritize": "rank",
    "leverage": "use", "leverages": "uses", "leveraged": "used",
    "optimal": "best", "optimize": "improve", "implement": "carry out",
    "implementation": "rollout", "methodology": "method", "modification": "change",
    "modifications": "changes", "ascertain": "find out", "expedite": "speed up",
    "in order to": "to", "due to the fact that": "because", "at this point in time": "now",
    "in the event that": "if", "with regard to": "about", "a large number of": "many"
  };

  // Concise mode: filler phrases removed or shortened (empty string = delete).
  const CONCISE = {
    "in order to": "to", "due to the fact that": "because", "at this point in time": "now",
    "in the event that": "if", "with regard to": "about", "for the purpose of": "to",
    "in the near future": "soon", "at the end of the day": "ultimately",
    "each and every": "every", "first and foremost": "first",
    "it is important to note that": "", "it should be noted that": "",
    "as a matter of fact": "in fact", "in my opinion": "", "needless to say": "",
    "basically": "", "actually": "", "literally": "", "really": "", "very": "",
    "quite": "", "just": "", "simply": "", "totally": "", "absolutely": "",
    "extremely": "", "definitely": "", "certainly": "",
    "a large number of": "many", "a majority of": "most", "a number of": "several",
    "despite the fact that": "although", "in spite of the fact that": "although",
    "on a regular basis": "regularly", "in a timely manner": "promptly",
    "take into consideration": "consider", "make a decision": "decide",
    "over the course of": "during"
  };

  // Build a regex that matches any key (longest first so phrases win over words).
  function buildMatcher(dict) {
    const keys = Object.keys(dict).sort((a, b) => b.length - a.length)
      .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp("\\b(" + keys.join("|") + ")\\b", "gi");
  }

  const MODES = {
    standard: [STANDARD],
    formal: [CONTRACTIONS, FORMAL],
    simple: [SIMPLE],
    concise: [CONCISE, SIMPLE]
  };
  const MATCHERS = {};
  for (const [mode, dicts] of Object.entries(MODES)) {
    MATCHERS[mode] = dicts.map(d => ({ dict: d, re: buildMatcher(d) }));
  }

  /* Returns { html, text, changed } — html has <mark class="changed"> around edits. */
  function run(input, mode) {
    let segments = [{ text: input, changed: false }];

    for (const { dict, re } of MATCHERS[mode] || MATCHERS.standard) {
      const next = [];
      for (const seg of segments) {
        if (seg.changed) { next.push(seg); continue; }
        let last = 0;
        seg.text.replace(re, (m, _g, offset) => {
          const repl = dict[m.toLowerCase()];
          if (repl === undefined) return m;
          if (offset > last) next.push({ text: seg.text.slice(last, offset), changed: false });
          if (repl === "") {
            // Deletion: swallow one following space so we don't leave doubles.
            last = offset + m.length;
            if (seg.text[last] === " ") last++;
            next.push({ text: "", changed: true, deleted: m });
          } else {
            next.push({ text: matchCase(m, repl), changed: true });
            last = offset + m.length;
          }
          return m;
        });
        if (last < seg.text.length) next.push({ text: seg.text.slice(last), changed: false });
      }
      segments = next;
    }

    // Tidy artifacts of deletions: stranded commas/spaces at sentence starts.
    let text = segments.map(s => s.text).join("")
      .replace(/ {2,}/g, " ")
      .replace(/([.!?])\s*,\s*/g, "$1 ")
      .replace(/(^|[.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());

    const changed = segments.filter(s => s.changed && (s.text || s.deleted)).length;
    const html = segments.map(s => {
      const esc = escapeHtml(s.text);
      return s.changed && s.text ? `<mark class="changed">${esc}</mark>` : esc;
    }).join("")
      .replace(/ {2,}/g, " ");

    return { html, text, changed };
  }

  return { run };
})();
