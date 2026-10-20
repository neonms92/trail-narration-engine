# Trail Narration Engine

The narrator's recording booth for the trail channel. It reads an episode's script and the firefly's voiced lines from Google Drive, plays the firefly in your headphones as a cue, records your turn raw (48 kHz, 24-bit mono WAV), lets you review it, and saves it with a `trail-take/1` sidecar into the episode's `recordings/` folder for the voice notebook in [`neonms92/hiker-engine`](https://github.com/neonms92/hiker-engine) (`voice/`).

The spec lives in the **Trail Narration Engine Spec** doc. Interface changes (the Drive contract, the sidecar format) land there first, then here and in `hiker-engine/voice/`.

## Using it

1. Run the voice notebook on the episode once, so its Drive folder has `script.trail`, `manifest.json` and the firefly's clips.
2. Open the site, **Sign in with Google**, pick the episode. It opens on the first turn not yet recorded.
3. Headphones on. Press **Take** (Space): the firefly's line plays, a ding sounds, and recording starts as the ding ends. Read the turn, then press **Done** (Space).
4. Review: play it back (with the firefly's cue, if you like), then **Save** (Enter), **Discard** (Backspace), or **Retake** (R), which plays the last 3 seconds of the cue, dings, and records again. Tick "keep this one too" to save the current take before retaking.
5. The next unrecorded turn comes up. Run the notebook when you're done; its report shows in the Trail Scene Engine's Issues panel.

Arrow keys move between turns. Click a firefly line in the script to hear it on its own. The **Gain** slider is stored with each take for the mixer; it never changes the recording. A take you haven't saved survives a reload: the page offers it back.

The **Demo** button runs the whole flow with a built-in script and a chirp for the firefly; takes stay in the browser and can be downloaded as WAV. Nothing goes to Drive.

Line states in the script: green recorded, amber saved but not processed yet, orange needs review (you said it differently; see the report), grey not recorded, dashed not voiced yet (added to the script after the last notebook run; you can still record it, and the notebook matches it by text).

## Setup (once)

The site is static: `index.html`, `app.js`, `config.js`. It needs a Google OAuth client ID so it can use your Drive.

1. **Google Cloud project.** At [console.cloud.google.com](https://console.cloud.google.com), create a project (any name), then **APIs & Services → Library → Google Drive API → Enable**.
2. **Consent screen.** **APIs & Services → OAuth consent screen**: External, app name "Trail Narration Engine", your email as support and developer contact. Add the scope `https://www.googleapis.com/auth/drive`. Leave it in **Testing** and add yourself under **Test users**. Testing mode is fine for one user; Google shows an "unverified app" notice you can click through.
3. **Client ID.** **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**. Under **Authorized JavaScript origins** add `https://neonms92.github.io` (and `http://localhost:8000` if you want to run it locally). No redirect URIs needed. Copy the client ID into `config.js`.
4. **GitHub Pages.** In this repo: **Settings → Pages → Deploy from a branch → `main` / root**. The site appears at `https://neonms92.github.io/trail-narration-engine/`.

To run it locally: `python3 -m http.server 8000` in this folder, then open `http://localhost:8000`.

## Why full Drive access

The recorder reads files the voice notebook created (the script, the manifest, the firefly's clips). Google's narrower per-app scope only sees files the app itself made, so it can't. It writes only new files into an episode's `recordings/` folder and never edits or deletes anything.

## Recording notes

- Echo cancellation, noise suppression and automatic gain control are switched off, so the take is what the microphone heard.
- The firefly and the ding play only through your output device. Use headphones, or they land in the take and Whisper hears the firefly as you.
- The meter shows short-term loudness (3 s, K-weighted, LUFS) with your gain applied, against a band around the firefly's loudness, and a clip light at −1 dBFS on the raw signal. If the clip light trips, lower the microphone's input level; the slider can't fix clipping.
- A take is about 8.6 MB a minute. Uploads are resumable and show progress; the sidecar is written only after the audio has uploaded.
