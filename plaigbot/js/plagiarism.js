/* Plagiarism checker: n-gram overlap between a document and a source text.
   Finds runs of 5+ shared words and reports coverage of the document. */
window.Plagiarism = (() => {
  const { escapeHtml } = window.TextKit;
  const N = 5; // minimum matching run, in words

  // Tokenize keeping positions so we can highlight the original string.
  function tokenize(text) {
    const tokens = [];
    const re = /[A-Za-zÀ-ɏ0-9'’-]+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      tokens.push({ word: m[0].toLowerCase().replace(/[’']/g, "'"), start: m.index, end: m.index + m[0].length });
    }
    return tokens;
  }

  function gramKey(tokens, i) {
    return tokens.slice(i, i + N).map(t => t.word).join(" ");
  }

  /* Returns { score, docHtml, srcHtml, docMatchedWords, docWords, runs } */
  function run(docText, srcText) {
    const doc = tokenize(docText);
    const src = tokenize(srcText);

    const srcGrams = new Map();
    for (let i = 0; i + N <= src.length; i++) {
      const key = gramKey(src, i);
      if (!srcGrams.has(key)) srcGrams.set(key, []);
      srcGrams.get(key).push(i);
    }

    const docMatched = new Array(doc.length).fill(false);
    const srcMatched = new Array(src.length).fill(false);
    let runs = 0;

    let i = 0;
    while (i + N <= doc.length) {
      const key = gramKey(doc, i);
      const starts = srcGrams.get(key);
      if (!starts) { i++; continue; }
      // Extend the match as far as it goes against the best source start.
      let best = N, bestStart = starts[0];
      for (const s of starts) {
        let len = N;
        while (i + len < doc.length && s + len < src.length && doc[i + len].word === src[s + len].word) len++;
        if (len > best) { best = len; bestStart = s; }
      }
      for (let k = 0; k < best; k++) {
        docMatched[i + k] = true;
        srcMatched[bestStart + k] = true;
      }
      runs++;
      i += best;
    }

    const matchedCount = docMatched.filter(Boolean).length;
    const score = doc.length ? Math.round((matchedCount / doc.length) * 100) : 0;

    return {
      score,
      runs,
      docWords: doc.length,
      docMatchedWords: matchedCount,
      docHtml: highlight(docText, doc, docMatched),
      srcHtml: highlight(srcText, src, srcMatched)
    };
  }

  function highlight(text, tokens, matched) {
    let out = "";
    let pos = 0;
    let j = 0;
    while (j < tokens.length) {
      if (!matched[j]) { j++; continue; }
      let k = j;
      while (k + 1 < tokens.length && matched[k + 1]) k++;
      out += escapeHtml(text.slice(pos, tokens[j].start));
      out += `<mark class="match">${escapeHtml(text.slice(tokens[j].start, tokens[k].end))}</mark>`;
      pos = tokens[k].end;
      j = k + 1;
    }
    out += escapeHtml(text.slice(pos));
    return out;
  }

  function verdict(score) {
    if (score >= 50) return { label: "High similarity", detail: "Large portions of this document match the source. If the source isn't yours, this needs rewriting and citation." };
    if (score >= 20) return { label: "Moderate similarity", detail: "Several passages match the source. Check whether they are quoted and cited properly." };
    if (score >= 5) return { label: "Low similarity", detail: "A few short passages match. This can happen with common phrases and titles — review the highlights." };
    return { label: "Minimal similarity", detail: "Almost nothing matches the source verbatim. Remember this only compares against the text you pasted, not the whole web." };
  }

  return { run, verdict };
})();
