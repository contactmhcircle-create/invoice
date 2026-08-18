#!/usr/bin/env node
/* Builds the PlaigBot WordPress plugin from the static site in ../plaigbot.
   - Scopes all CSS under .plaigbot-app so it can't clash with theme styles
   - Adapts app.js to run inside a page (theme state on the wrapper element)
   - Generates plaigbot.php (shortcode + asset enqueues) and readme.txt
   Usage: node plaigbot-wp/build.cjs [demo-output.html]                    */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "plaigbot");
const OUT = path.join(__dirname, "plaigbot");
const VERSION = "1.0.0";

/* ---------------- CSS scoping ---------------- */
function prefixSelector(list) {
  return list.split(",").map(s => {
    s = s.trim();
    if (!s) return s;
    if (s === ":root" || s === "body" || s === "html") return ".plaigbot-app";
    if (s.startsWith("[data-theme")) return ".plaigbot-app" + s;
    if (s === "*") return ".plaigbot-app, .plaigbot-app *";
    if (s.startsWith("*")) return ".plaigbot-app " + s;
    return ".plaigbot-app " + s;
  }).join(", ");
}

function scopeCss(css) {
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    const brace = css.indexOf("{", i);
    if (brace === -1) { out += css.slice(i); break; }
    const head = css.slice(i, brace);

    if (/@media/.test(head)) {
      const end = matchBrace(css, brace);
      out += head + "{" + scopeCss(css.slice(brace + 1, end)) + "}";
      i = end + 1;
    } else if (/@keyframes|@font-face/.test(head)) {
      const end = matchBrace(css, brace);
      out += css.slice(i, end + 1);
      i = end + 1;
    } else {
      const end = matchBrace(css, brace);
      // Preserve comments/whitespace before the selector.
      const m = head.match(/^([\s\S]*?)([^\s\/][^{]*)$/);
      const lead = m ? m[1] : "";
      const sel = m ? m[2] : head;
      out += lead + prefixSelector(sel) + " " + css.slice(brace, end + 1);
      i = end + 1;
    }
  }
  return out;
}

function matchBrace(css, openIdx) {
  let depth = 0;
  for (let j = openIdx; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}") { depth--; if (depth === 0) return j; }
  }
  throw new Error("Unbalanced braces in CSS");
}

const WP_EXTRA = `
/* ---- WordPress embed adjustments ---- */
.plaigbot-app { min-height: 0; }
.plaigbot-app .site-header {
  position: sticky;
  top: var(--wp-admin--admin-bar--height, 0px);
  border-radius: var(--radius) var(--radius) 0 0;
}
.plaigbot-app .site-footer { border-radius: 0 0 var(--radius) var(--radius); }
.plaigbot-app a { text-decoration: none; }
/* Defensive reset: themes commonly style the generic .container class. */
.plaigbot-app .container {
  width: min(1180px, 100% - 2rem);
  max-width: none;
  padding: 0;
  border: 0;
  background: none;
  box-shadow: none;
}
.plaigbot-app .header-inner { padding: .65rem 0; }
`;

/* ---------------- app.js adaptation ---------------- */
function adaptAppJs(js) {
  let out = js.replace(
    "const root = document.documentElement;",
    'const root = document.querySelector(".plaigbot-app") || document.documentElement;'
  );
  out = out.replace(
    "const initial = location.hash.slice(1);",
    "const initial = (root.dataset && root.dataset.initialTool) || location.hash.slice(1);"
  );
  // Don't rewrite the page URL hash when embedded in a WP page.
  out = out.replace(
    'history.replaceState(null, "", "#" + tool);',
    "/* URL hash untouched when embedded */"
  );
  for (const marker of ['document.querySelector(".plaigbot-app")', "root.dataset.initialTool", "URL hash untouched"]) {
    if (!out.includes(marker)) throw new Error("app.js adaptation failed: " + marker);
  }
  return out;
}

/* ---------------- Shared app markup (single source for PHP + demo) ---------------- */
const MARKUP = `
  <header class="site-header">
    <div class="container header-inner">
      <span class="brand" aria-label="PlaigBot">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 19l7-7 3 3-7 7-3-3z"></path>
            <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path>
            <path d="M2 2l7.586 7.586"></path>
            <circle cx="11" cy="11" r="2"></circle>
          </svg>
        </span>
        <span class="brand-name">PlaigBot</span>
      </span>

      <nav class="tool-nav" aria-label="Tools">
        <button type="button" class="tool-tab active" data-tool="paraphrase" aria-current="page">
          <span class="tab-icon" aria-hidden="true">🔁</span><span class="tab-label">Paraphraser</span>
        </button>
        <button type="button" class="tool-tab" data-tool="plagiarism">
          <span class="tab-icon" aria-hidden="true">🔎</span><span class="tab-label">Plagiarism</span>
        </button>
        <button type="button" class="tool-tab" data-tool="detector">
          <span class="tab-icon" aria-hidden="true">🤖</span><span class="tab-label">AI Detector</span>
        </button>
        <button type="button" class="tool-tab" data-tool="improver">
          <span class="tab-icon" aria-hidden="true">✨</span><span class="tab-label">Improver</span>
        </button>
      </nav>

      <button type="button" id="theme-toggle" class="icon-btn" aria-label="Toggle dark mode" title="Toggle theme">
        <svg class="icon-sun" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4"/></svg>
        <svg class="icon-moon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      </button>
    </div>
  </header>

  <main class="container">
__PANELS__
  </main>

  <footer class="site-footer">
    <div class="container footer-inner">
      <p><strong>PlaigBot</strong> — free writing tools that run entirely in your browser. Nothing you type ever leaves your device.</p>
      <p class="muted">The paraphraser is a writing aid: always review its output, and follow your school's or employer's rules on tool use and attribution.</p>
    </div>
  </footer>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>
`;

/* Extract the tool panels straight from the static index.html so they never drift. */
function extractPanels(html) {
  const start = html.indexOf('<section class="tool-panel');
  const end = html.lastIndexOf("</section>") + "</section>".length;
  if (start === -1 || end < start) throw new Error("Could not extract panels from index.html");
  return html.slice(start, end)
    // The static page uses h1 per panel; inside a WP page h2 is better hierarchy.
    .replace(/<h1 /g, "<h2 ").replace(/<\/h1>/g, "</h2>");
}

/* ---------------- PHP plugin file ---------------- */
function phpFile(markup) {
  return `<?php
/**
 * Plugin Name:       PlaigBot Writing Tools
 * Plugin URI:        https://github.com/contactmhcircle-create/invoice
 * Description:       Free writing tools — paraphrasing tool, plagiarism checker, AI content detector and writing improver. All processing happens in the visitor's browser; no text is sent to any server. Add the [plaigbot] shortcode to any page.
 * Version:           ${VERSION}
 * Requires at least: 5.0
 * Requires PHP:      7.0
 * Author:            PlaigBot
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       plaigbot
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'PLAIGBOT_VERSION', '${VERSION}' );
define( 'PLAIGBOT_URL', plugin_dir_url( __FILE__ ) );

/**
 * Register assets (loaded only on pages that use the shortcode).
 */
function plaigbot_register_assets() {
	wp_register_style(
		'plaigbot-fonts',
		'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Source+Serif+4:ital@0;1&display=swap',
		array(),
		null
	);
	wp_register_style( 'plaigbot', PLAIGBOT_URL . 'assets/css/plaigbot.css', array( 'plaigbot-fonts' ), PLAIGBOT_VERSION );

	$scripts = array( 'samples', 'textkit', 'paraphrase', 'plagiarism', 'detector', 'improver', 'app' );
	$deps    = array();
	foreach ( $scripts as $script ) {
		$handle = 'plaigbot-' . $script;
		wp_register_script( $handle, PLAIGBOT_URL . 'assets/js/' . $script . '.js', $deps, PLAIGBOT_VERSION, true );
		$deps = array( $handle );
	}
}
add_action( 'wp_enqueue_scripts', 'plaigbot_register_assets' );

/**
 * [plaigbot] shortcode.
 *
 * Attributes:
 *   tool — starting tab: paraphrase | plagiarism | detector | improver
 */
function plaigbot_shortcode( $atts ) {
	$atts  = shortcode_atts( array( 'tool' => 'paraphrase' ), $atts, 'plaigbot' );
	$valid = array( 'paraphrase', 'plagiarism', 'detector', 'improver' );
	$tool  = in_array( $atts['tool'], $valid, true ) ? $atts['tool'] : 'paraphrase';

	wp_enqueue_style( 'plaigbot' );
	wp_enqueue_script( 'plaigbot-app' );

	$markup = <<<'PLAIGBOT_HTML'
${markup}
PLAIGBOT_HTML;

	return '<div class="plaigbot-app" data-initial-tool="' . esc_attr( $tool ) . '">' . $markup . '</div>';
}
add_shortcode( 'plaigbot', 'plaigbot_shortcode' );
`;
}

const README_TXT = `=== PlaigBot Writing Tools ===
Contributors: plaigbot
Tags: paraphrasing, plagiarism checker, ai detector, readability, writing
Requires at least: 5.0
Tested up to: 6.6
Requires PHP: 7.0
Stable tag: ${VERSION}
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Free writing tools — paraphraser, plagiarism checker, AI content detector and
writing improver. All processing happens in the visitor's browser.

== Description ==

PlaigBot adds four writing tools to any page via the [plaigbot] shortcode:

* Paraphrasing Tool — four modes, every edit highlighted for review
* Plagiarism Checker — compare a document against a source, matched passages highlighted
* AI Content Detector — stylometric estimate with a per-signal breakdown (clearly labeled as an estimate, not proof)
* Writing Improver — readability scores plus inline highlights for long sentences, passive voice, filler words and cliches

Privacy: everything runs client-side in JavaScript. No visitor text is ever
sent to your server or any third party.

== Installation ==

1. Upload the plugin ZIP via Plugins → Add New → Upload Plugin, then activate it.
2. Create a page and add the shortcode: [plaigbot]
3. Optional: start on a specific tool with [plaigbot tool="detector"]
   (valid values: paraphrase, plagiarism, detector, improver)

Tip: use a full-width page template if your theme has one. Use the shortcode
on one page at a time (one app instance per page).

== Frequently Asked Questions ==

= Does it work with my theme and other plugins? =
Yes. It is a standard shortcode plugin — styles are scoped to the app container
so they do not affect your theme, and assets load only on pages that use the
shortcode.

= Is visitor text stored anywhere? =
No. All analysis happens in the visitor's browser.

== Changelog ==

= ${VERSION} =
* Initial release.
`;

/* ---------------- Build ---------------- */
function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "assets/css"), { recursive: true });
  fs.mkdirSync(path.join(OUT, "assets/js"), { recursive: true });

  // Strip comments first — the selector scoper must only ever see selector text.
  const css = fs.readFileSync(path.join(SRC, "css/styles.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  fs.writeFileSync(path.join(OUT, "assets/css/plaigbot.css"), scopeCss(css) + WP_EXTRA);

  for (const f of ["samples", "textkit", "paraphrase", "plagiarism", "detector", "improver"]) {
    fs.copyFileSync(path.join(SRC, "js", f + ".js"), path.join(OUT, "assets/js", f + ".js"));
  }
  const appJs = fs.readFileSync(path.join(SRC, "js/app.js"), "utf8");
  fs.writeFileSync(path.join(OUT, "assets/js/app.js"), adaptAppJs(appJs));

  const indexHtml = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
  const markup = MARKUP.replace("__PANELS__", extractPanels(indexHtml));
  fs.writeFileSync(path.join(OUT, "plaigbot.php"), phpFile(markup));
  fs.writeFileSync(path.join(OUT, "readme.txt"), README_TXT);

  // Optional demo page that fakes a theme wrapper, for browser testing.
  const demoOut = process.argv[2];
  if (demoOut) {
    fs.writeFileSync(demoOut, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WP embed demo</title>
<style>
  body { margin:0; font-family: Arial, sans-serif; background:#e9e2d8; color:#222; }
  .theme-header { background:#3b2f2f; color:#fff; padding:1rem 2rem; font-size:1.3rem; }
  .theme-content { max-width: 1280px; margin: 0 auto; padding: 2rem 1rem; }
  .container { border: 3px dashed red; } /* deliberately hostile theme rule */
</style>
<link rel="stylesheet" href="assets/css/plaigbot.css"></head>
<body>
<div class="theme-header">My WordPress Theme Header</div>
<div class="theme-content">
<p>Theme paragraph before the shortcode output.</p>
<div class="plaigbot-app" data-initial-tool="detector">${markup}</div>
<p>Theme paragraph after the shortcode output.</p>
</div>
<script src="assets/js/samples.js"></script>
<script src="assets/js/textkit.js"></script>
<script src="assets/js/paraphrase.js"></script>
<script src="assets/js/plagiarism.js"></script>
<script src="assets/js/detector.js"></script>
<script src="assets/js/improver.js"></script>
<script src="assets/js/app.js"></script>
</body></html>`);
  }
  console.log("Built plugin into", OUT, demoOut ? "(+ demo " + demoOut + ")" : "");
}

build();
