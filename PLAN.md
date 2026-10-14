# Sticker Bridge build plan

## Goal

Sticker Bridge is a personal Android app with no ads. It turns a photo, GIF, or video into a WhatsApp sticker with no white border. You share a file from the gallery to the app, edit it, and tap "Add to WhatsApp".

## What the tests proved

- WhatsApp treats a WebP file from the share sheet as a photo. Only the official sticker API makes real stickers.
- The app's content provider works. WhatsApp accepted a static pack and an animated pack with transparent backgrounds.
- A new sticker in an existing pack shows up only after the app opens WhatsApp's Add screen again. The app will open that screen after each new sticker.
- A pack needs 3 to 30 stickers, and a pack is all static or all animated.

## How it works

The app has two parts.

| Part | Job |
|---|---|
| Native Android shell (Java) | Receives shared files, removes backgrounds, stores packs, and talks to WhatsApp. |
| Editor (HTML, TypeScript, React) | Crop, trim, erase, preview, and make the final WebP file. It runs in a WebView, a browser view inside the app. |

The editor files ship inside the APK. The app works offline after the first background removal, which downloads a model once.

The flow on the phone:

1. In the gallery, share a photo, GIF, or video to Sticker Bridge. Or open the app and pick a file.
2. The editor opens with the file.
3. Edit the sticker, then tap "Add to WhatsApp".
4. The app saves the sticker in your pack and opens WhatsApp's Add screen.
5. Tap "Add".

## Features

### Photos

- Move, zoom, and rotate the image inside the 512x512 square.
- Remove the background with one tap. The app uses Google ML Kit subject segmentation, which runs on the phone. Google Play services downloads its model once.
- Fix the cutout with an erase brush and a restore brush.
- Preview on a checkerboard so that you can see the transparent area.
- The app lowers the WebP quality until the file fits the 100 KB limit.

### GIFs and videos

- Trim the start and the end, up to 10 seconds.
- Move and zoom the frame inside the 512x512 square.
- Pick the frame rate. Fewer frames give a sharper sticker inside the 500 KB limit.
- The editor makes each frame with the browser's WebP encoder. A small TypeScript muxer (a tool that joins frames into one file) builds the animated WebP.
- The app lowers the quality, then the frame rate, until the file fits 500 KB.
- Version 1 has no background removal for video. Each frame takes too long on a phone. We can add it later.

### Packs

- The app keeps one open static pack and one open animated pack.
- If a new pack has fewer than 3 real stickers, the app fills it with copies of the first sticker. Real stickers replace the copies.
- When a pack reaches 30 stickers, the next sticker starts a new pack.
- The tray icon (the small pack image in WhatsApp) comes from the first sticker of the pack.
- A Packs screen lists your packs and stickers. You can delete a sticker or add a pack to WhatsApp again.

## Project layout

```
stickers/
  editor/        Vite + React + TypeScript, same setup as linkedin-practice
  android/       Java app, WebView shell, content provider, ML Kit
  .github/workflows/android.yml
```

The build copies `editor/dist` into `android/app/src/main/assets/editor`. The app loads it from `https://appassets.androidplatform.net/` with `WebViewAssetLoader` from AndroidX WebKit. A real HTTPS origin lets the editor read video frames into a canvas without a security error.

The bridge between the editor and the shell has these calls:

| Call | Direction | Job |
|---|---|---|
| `getSharedFile()` | editor to shell | Returns a URL for the file that you shared to the app. |
| `removeBackground(png)` | editor to shell | Returns the cutout as a transparent PNG. |
| `addSticker(webp, animated)` | editor to shell | Saves the sticker and opens WhatsApp's Add screen. |
| `listPacks()`, `deleteSticker(id)` | editor to shell | Feed the Packs screen. |

In a desktop browser, a mock bridge replaces the shell. The mock lets me test the editor in the browser pane on this Mac. The mock downloads the WebP instead of adding it.

## Build and release

- GitHub Actions runs `npm ci`, `npm test`, and `npm run build` for the editor.
- Then it runs `gradle test` and `gradle assembleRelease` for the app.
- Each push to `main` that changes `editor/` or `android/` publishes a new release.
- The download link stays the same: `releases/latest/download/sticker-bridge.apk`.
- The same signing key signs every build, so a new APK installs over the old one and keeps your packs.

## Tests

- Editor unit tests (Vitest): the WebP muxer, the size-fitting loop, and the crop math.
- App unit tests (JUnit): pack filling with copies, the 30-sticker limit, and the file name rules.
- Browser pane: the full editor flow with the mock bridge, at phone size.
- Your phone: one test at the end of each phase.

## Phases

Each phase ends with a new APK for you to test on your phone.

| Phase | Work | Phone test |
|---|---|---|
| 1 | WebView shell, share-to-app, bridge, pack store with copies, and a basic photo editor (move, zoom, add) | Share a photo from the gallery and add it as a sticker. |
| 2 | Background removal with ML Kit, plus erase and restore brushes | Cut out a person or a pet with no border. |
| 3 | GIF and video: trim, frame rate, animated WebP, size fitting | Make an animated sticker from a video. |
| 4 | Packs screen, delete, new pack at 30, tray icon from the first sticker | Delete a sticker and add the pack again. |
| 5 | Clean up: remove the share test page and the sample packs, and write the README | Final install over the old app. |

## Open risks

- ML Kit subject segmentation is a beta API. If it fails on your phone, the fallback is MediaPipe image segmentation, which runs offline in the app.
- Video seeking in a WebView can be slow or a little off. If it is, the shell can extract frames with Android's `MediaMetadataRetriever` instead.
- We do not know yet what WhatsApp does when the app deletes a sticker from a pack that you already added. Phase 4 tests this.
- This Mac has no Java or Android SDK. Android builds run only in GitHub Actions, so each Android fix needs a push and a short wait.
