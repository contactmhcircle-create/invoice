=== ClearWrite Writing Tools ===
Contributors: clearwrite
Tags: paraphrasing, plagiarism checker, ai detector, readability, writing
Requires at least: 5.0
Tested up to: 6.6
Requires PHP: 7.0
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Free writing tools — paraphraser, plagiarism checker, AI content detector and
writing improver. All processing happens in the visitor's browser.

== Description ==

ClearWrite adds four writing tools to any page via the [clearwrite] shortcode:

* Paraphrasing Tool — four modes, every edit highlighted for review
* Plagiarism Checker — compare a document against a source, matched passages highlighted
* AI Content Detector — stylometric estimate with a per-signal breakdown (clearly labeled as an estimate, not proof)
* Writing Improver — readability scores plus inline highlights for long sentences, passive voice, filler words and cliches

Privacy: everything runs client-side in JavaScript. No visitor text is ever
sent to your server or any third party.

== Installation ==

1. Upload the plugin ZIP via Plugins → Add New → Upload Plugin, then activate it.
2. Create a page and add the shortcode: [clearwrite]
3. Optional: start on a specific tool with [clearwrite tool="detector"]
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

= 1.0.0 =
* Initial release.
