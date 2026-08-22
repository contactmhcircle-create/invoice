# Captain Mode ✈️

*"Ladies and gentlemen, this is your Captain speaking…"*

Captain Mode turns every drive into a flight. When your phone connects to your
car's Bluetooth, the Captain takes the intercom and delivers a full cabin
announcement over the car speakers — with a live weather report, a
ride forecast that reacts to actual conditions (smooth ride, turbulence,
fog, rush-hour traffic), and a different randomised script every time.

Built for Android 12+ (tested target: Samsung Galaxy S25 Ultra).

## Install

1. Open this repository's **Releases** on your phone and download
   `captain-mode.apk` from **Captain Mode — latest build** (or grab the
   artifact from the latest green Actions run).
2. Open the file; allow "install unknown apps" for your browser when asked.
3. Launch Captain Mode and complete the **pre-flight checks** — grant
   Bluetooth and notifications, and set battery usage to **Unrestricted**.
   The battery step is essential on Samsung: without it One UI will kill the
   app in the background.
4. Pair your phone with your car at least once, then add the car under
   **Your fleet**.
5. Hit **Run pre-flight announcement** to hear it instantly.

Every push to this folder rebuilds the APK automatically; sideload the new
file to update (same signing key, so it installs over the old version).

## How an announcement is assembled

```
[chime] → [attention] → [welcome aboard] → [weather report]
        → [ride forecast — picked by live weather] → [traffic, at rush hour]
        → [sign-off]
```

Each part has a pool of phrases; one is picked at random (never the same one
twice in a row). **Special scripts** with day/time rules — a Monday-morning
launch, a late-night service — replace the whole announcement when they match.

## Customisation

Everything is editable in the app:

- **Phrases** — add, edit or delete every phrase in every pool, per weather
  condition (clear / clouds / rain / wind / fog / snow / storm).
- **Variables** — use `{greeting}`, `{airline}`, `{captain}`, `{car}`,
  `{time}`, `{day}`, `{date}`, `{temp}`, `{weather}`, `{battery}` anywhere.
  Sentences with unavailable data (e.g. no signal → no weather) are skipped
  gracefully.
- **Per-car profiles** — each car gets its own spoken name, airline, delay,
  volume, voice, scripts, and optionally a custom audio file (e.g. an
  AI-generated pilot recording) instead of TTS.
- **Voice** — any installed TTS voice, with pitch and speed sliders.
- **Chime** — single / classic ding-dong / triple, or your own sound.
- **Schedules** — quiet hours, rush-hour windows, arrival announcements.

## Weather

Live conditions come from the free [Open-Meteo](https://open-meteo.com) API —
no account or key. Location comes from the phone (if permitted) or a fallback
city you set. The ride forecast maps weather to airline language: rain →
"showers en route", strong wind → "light turbulence", fog → "instrument
conditions", and so on.

## Development notes

- Kotlin + Jetpack Compose (Material 3), min SDK 31.
- `./gradlew assembleRelease` builds a signed APK. The committed
  `sideload.keystore` exists only so CI builds install over each other on
  your own device — it carries no Play-Store trust and protects nothing.
- CI: `.github/workflows/captain-mode-apk.yml` builds and publishes the APK
  on every push to this folder.
