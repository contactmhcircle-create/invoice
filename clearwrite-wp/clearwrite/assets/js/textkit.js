/* Shared text utilities for all tools. */
window.TextKit = (() => {
  const WORD_RE = /[A-Za-zÀ-ɏ'’-]+/g;

  function words(text) {
    return (text.match(WORD_RE) || []);
  }

  function wordCount(text) {
    return words(text).length;
  }

  function sentences(text) {
    // Split on sentence-ending punctuation followed by whitespace + capital/quote, or line breaks.
    const parts = text
      .split(/(?<=[.!?…])\s+(?=["'“‘(]?[A-Z0-9])|\n+/)
      .map(s => s.trim())
      .filter(s => wordCount(s) > 0);
    return parts;
  }

  function syllables(word) {
    let w = word.toLowerCase().replace(/[^a-z]/g, "");
    if (!w) return 0;
    if (w.length <= 3) return 1;
    w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
    const m = w.match(/[aeiouy]{1,2}/g);
    return Math.max(1, m ? m.length : 1);
  }

  function fleschReadingEase(text) {
    const s = sentences(text).length || 1;
    const ws = words(text);
    const w = ws.length || 1;
    const syl = ws.reduce((a, x) => a + syllables(x), 0);
    return 206.835 - 1.015 * (w / s) - 84.6 * (syl / w);
  }

  function fkGrade(text) {
    const s = sentences(text).length || 1;
    const ws = words(text);
    const w = ws.length || 1;
    const syl = ws.reduce((a, x) => a + syllables(x), 0);
    return 0.39 * (w / s) + 11.8 * (syl / w) - 15.59;
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  // Preserve the capitalization pattern of `orig` when swapping in `repl`.
  function matchCase(orig, repl) {
    if (orig === orig.toUpperCase() && orig.length > 1) return repl.toUpperCase();
    if (orig[0] === orig[0].toUpperCase()) return repl[0].toUpperCase() + repl.slice(1);
    return repl;
  }

  return { words, wordCount, sentences, syllables, fleschReadingEase, fkGrade, escapeHtml, clamp, matchCase };
})();
