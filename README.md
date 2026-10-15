# Sticker Bridge

Sticker Bridge is a personal Android app that makes WhatsApp stickers with no white border and no ads.
It turns a photo, a GIF, a video, or a post link into a sticker and adds it to WhatsApp.

## Install

1. Open https://github.com/Luisfetoga2/stickers/releases/latest/download/sticker-bridge.apk on the phone.
2. Open the downloaded file.
3. If Android blocks the install, allow installs from your browser, then go back.
4. If Play Protect warns about an unknown app, tap "More details", then "Install anyway".

A new APK installs over the old one and keeps your stickers.
When GitHub has a newer version, the start screen shows it with a Download button.
The app asks GitHub at most every 6 hours.
The app works on Android 11 or later, on phones with a 64-bit ARM processor.

## Make a sticker

1. Share a photo, GIF, video, or post to Sticker Bridge from another app.
2. Or open Sticker Bridge and tap "Pick a file", or paste a post link into the link box.
3. Edit the sticker.
4. Tap "Add to WhatsApp".
5. In WhatsApp, tap "Add".

### Photos

- Drag to move the photo. Pinch to zoom and rotate. Tap Flip to mirror it.
- Tap "Remove background" to cut out the subject.
- Use Erase and Restore to fix the edges.

### GIFs and videos

The stage and the progress stay at the top of the screen. The controls are in four tabs under the stage.

| Tab | What it has |
|---|---|
| Cutout | Green screen, AI cutout, Keep, Remove, Erase, Restore, and Follow the subject |
| Trim | Start, End, Find loop, and the frame rate |
| Cut | Zoom, Rotate, X, Y, Fit, Fill, Turn 90°, and Flip |
| File | Check size and Sharpness |

- X and Y are how far the picture's center is from the sticker's center, in sticker pixels.
- Set Start and End. A sticker is 10 seconds at most.
- Tap "Find loop" to move Start and End to two frames that match, so the sticker loops without a jump.
- Pick a frame rate. The app always keeps the frame rate you pick.
- Tap "Check size" to see the file size at each sharpness level. Move Sharpness to choose, and the size updates at once.
- If the sticker is too big at any sharpness, the app says so. Then lower the frame rate or make the clip shorter.
- Tap Play to watch the sticker loop in the editor.
- For a green screen video, tap "Green screen". If the wrong color is gone, tap "Pick color" and tap the screen in the video.
- For any other video, tap "AI cutout". Trim and frame rate lock while the cutout is on.
- After an AI cutout, use Keep and Remove to fix whole objects. Tap or scribble on something in any frame.
  The app finds that object with Magic Touch and tints it on the stage.
  If it took too much or too little, tap Smaller or Bigger. Then tap Apply.
  The app follows the object through the other frames and keeps the size you picked.
  Keep adds the object to the cutout, and Remove cuts it out.
  The first use downloads the Magic Touch model, about 38 MB, once.
- Erase and Restore change every frame at once.
- After an AI cutout, turn on "Follow the subject" to keep the subject in one place while it moves.

Animated stickers store only what changes between frames. The smaller file leaves room for higher quality.

### Post links

The app downloads the video of a post from TikTok, YouTube, Reddit, X, Instagram, and many other sites.
If you copy a link and then open the app, the start screen offers to open it.
It uses yt-dlp, which updates itself once a day.
When a download fails, the app updates yt-dlp and tries again.
If the download still fails, the app shows the yt-dlp version and its error.

Instagram often asks for a login, and the app does not log in.
Picture posts are not supported, so take a screenshot and share it instead.

### Your stickers

The start screen has a "Your stickers" link after you make a sticker.
Tap a sticker, then tap Delete.
WhatsApp keeps the old sticker until you tap "Update WhatsApp".

## How it works

The app has two parts.

| Part | Folder | Job |
|---|---|---|
| Android shell | `android/` | Receives shared files and links, removes backgrounds with ML Kit, downloads links with yt-dlp, stores the packs, and talks to WhatsApp. |
| Editor | `editor/` | Crops, trims, keys out green, paints masks, and makes the WebP file. It runs in a WebView inside the app. |

The app adds packs through the official WhatsApp sticker API, through a content provider that only WhatsApp can read.
WhatsApp needs 3 to 30 stickers in a pack, so the app fills a new pack with copies of its first sticker.
When a pack has 30 stickers, the next sticker starts a new pack.

Photos, videos, and background removal stay on the phone.
The app uses the internet only for post links, for yt-dlp updates, for the update notice, and for the one-time ML Kit and Magic Touch model downloads.

## Build

GitHub Actions builds a signed APK on each push to `main` that changes `android/` or `editor/`.
It publishes the APK as a release.

To work on the editor on a computer, run these commands:

```bash
cd editor
npm install
npm run dev
```

In a desktop browser, the editor runs without the Android shell.
To test Keep and Remove there, run `npm run dev-model` once. It downloads the Magic Touch model into `dev-models/`, which stays out of the app.
"Add to WhatsApp" downloads the WebP file, and background removal uses a fake oval cutout.

To run the tests, run `npm test` in `editor/`.
The Java tests run in GitHub Actions with `gradle test`.

## Signing key

The release signing key is not in this repository.
It is in the repository secrets `SIGNING_KEYSTORE_BASE64` and `SIGNING_PASSWORD`, and in a local backup.
Keep the backup. Without the same key, a new APK cannot install over the old one.

## Credits

Magic Touch runs [EdgeSAM](https://github.com/chongzhou96/EdgeSAM) by Chong Zhou, Xiangtai Li, Chen Change Loy, and Bo Dai, with ONNX Runtime.
EdgeSAM is under the S-Lab License 1.0, which allows non-commercial use only.
The app does not include the model. It downloads the model from the authors' Hugging Face page on first use.

## Plan

[PLAN.md](PLAN.md) has the phases and the decisions behind them.
