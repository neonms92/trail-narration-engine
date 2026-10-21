# Trail Narration Engine

The narrator's recording booth for the trail channel. It reads an episode's script and the firefly's voiced lines from Google Drive, plays the episode through your headphones, records the narrator lines flagged for a take (captured raw at 48 kHz, saved as mono Opus at 160 kbps; 24-bit WAV if the browser can't encode Opus), and saves each with a `trail-take/1` sidecar into the episode's `recordings/` folder for the voice notebook in [`neonms92/hiker-engine`](https://github.com/neonms92/hiker-engine) (`voice/`). Flags you set go to the episode's `flags.json`, where the notebook picks up the firefly's.

The spec lives in the **Trail Narration Engine Spec** doc. Interface changes (the Drive contract, the sidecar format) land there first, then here and in `hiker-engine/voice/`.

## Using it

1. Run the voice notebook on the episode once, so its Drive folder has `script.trail`, `manifest.json` and the clips.
2. Open the site, **Sign in with Google**, pick the episode. It opens on the first line flagged for a take.
3. Headphones on. The three buttons at the bottom:
   - **▶ Play** plays from the selected line on, line after line: the firefly's clips, and your newest take of each narrator line (the placeholder voice where there's none yet).
   - **● Record** starts from the selected line when it's a flagged narrator line (or ocarina song): the last 3 seconds of the line before, a ding, and recording. While recording it shows **⤓ Done**: the take is saved to Drive straight away, its flag cleared, and playback runs on through the lines in between to the next flagged narrator line, which dings and records. When none are left the run ends with a jingle.
   - **■ Stop** ends playing or recording; a take in progress is discarded.
4. Run the notebook when you're done; its report shows in the Trail Scene Engine's Issues panel.

Keys: Space is Done while recording, otherwise Record (or Play where there's nothing to record); Escape stops; F flags the selected line; the arrow keys move the selection.

**Flags.** Every line has a flag. A narrator line is flagged on its own when it has no take yet, or the notebook couldn't use its last one (not heard in the take, or a silent take); you can flag any other line to take it again, or clear a flag to skip a line. Tapping a firefly line's flag opens its direction, the mood's to start with, for editing: **Flag** asks the notebook to voice it again on a fresh seed with that direction, which then stays with the line; **Unflag** cancels the request, and on a line already voiced with your own direction, restores the mood's direction and its original take on the next run. Describe how it should sound rather than what not to do; pronunciation and wording are better fixed in the script.

Line states in the script: blue recorded, green saved but not processed yet, orange needs review (you said it differently; see the report), red the notebook couldn't use the last take, grey not recorded, dashed not voiced yet (added to the script after the last notebook run; you can still record it, and the notebook matches it by text).

The **Gain** slider (under the gear) is stored with each take for the mixer; it never changes the recording. Takes waiting to upload survive a reload.

The **Demo** button runs the whole flow with a built-in script and a chirp for the firefly; takes stay in the page. Nothing goes to Drive.

## Setup (once)

The site is static: `index.html`, `app.js`, `config.js`. It needs a Google OAuth client ID so it can use your Drive.

1. **Google Cloud project.** At [console.cloud.google.com](https://console.cloud.google.com), create a project (any name), then **APIs & Services → Library → Google Drive API → Enable**.
2. **Consent screen.** **APIs & Services → OAuth consent screen**: External, app name "Trail Narration Engine", your email as support and developer contact. Add the scope `https://www.googleapis.com/auth/drive`. Leave it in **Testing** and add yourself under **Test users**. Testing mode is fine for one user; Google shows an "unverified app" notice you can click through.
3. **Client ID.** **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**. Under **Authorized JavaScript origins** add `https://neonms92.github.io` (and `http://localhost:8000` if you want to run it locally). No redirect URIs needed. Copy the client ID into `config.js`.
4. **GitHub Pages.** In this repo: **Settings → Pages → Deploy from a branch → `main` / root**. The site appears at `https://neonms92.github.io/trail-narration-engine/`.

To run it locally: `python3 -m http.server 8000` in this folder, then open `http://localhost:8000`.

## Why full Drive access

The recorder reads files the voice notebook created (the script, the manifest, the firefly's clips). Google's narrower per-app scope only sees files the app itself made, so it can't. It writes only new takes into an episode's `recordings/` folder and its `flags.json` (one entry at a time, re-reading the file first), and never deletes anything.

## Recording notes

- Echo cancellation, noise suppression and automatic gain control are switched off, so the take is what the microphone heard.
- The firefly and the ding play only through your output device. Use headphones, or they land in the take and Whisper hears the firefly as you.
- The meter shows short-term loudness (3 s, K-weighted, LUFS) with your gain applied, against a band around the firefly's loudness, and a clip light at −1 dBFS on the raw signal. If the clip light trips, lower the microphone's input level; the slider can't fix clipping.
- A take is about 1.2 MB a minute as Opus. Opus at 160 kbps is transparent for voice; it's encoded once, from the raw capture, when you save. Uploads are resumable and show progress; the sidecar is written only after the audio has uploaded.
