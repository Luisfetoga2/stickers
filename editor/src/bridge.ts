import { DEFAULT_CHROMA, chromaKey, detectKeyColor } from './chroma';
import { blobToBase64 } from './encode';

export interface SharedFile {
  url: string;
  mime: string;
}

export interface AddResult {
  ok: boolean;
  message: string;
}

/** One sticker saved in the app. */
export interface SavedSticker {
  packId: string;
  file: string;
  url: string;
  animated: boolean;
}

export interface StickerLibrary {
  /** Newest first. */
  stickers: SavedSticker[];
  /** True when WhatsApp still shows an older version of a pack, for example after a delete. */
  needsUpdate: boolean;
}

interface NativeLibrary {
  packs: Array<{
    id: string;
    animated: boolean;
    needsUpdate: boolean;
    stickers: Array<{ file: string; url: string }>;
  }>;
}

export interface AppEvents {
  /** The shell started copying a shared or picked file. onSharedFile follows. */
  onOpening(): void;
  onSharedFile(file: SharedFile): void;
  onAddResult(result: AddResult): void;
  /** A link download moved on, for example "Downloading: 40%". */
  onLinkProgress(message: string): void;
  /** A link download failed or was cancelled. */
  onLinkError(message: string): void;
  /** GitHub has a newer APK, for example "0.1.13". */
  onUpdateAvailable(version: string): void;
  /** The user copied a link since the last time the app looked. */
  onClipboardLink(url: string): void;
  /** The answer to checkForUpdate. latest is null when GitHub could not be reached. */
  onUpdateCheck(result: UpdateCheck): void;
}

export interface UpdateCheck {
  ok: boolean;
  newer: boolean;
  latest: string | null;
}

interface BackgroundResult {
  id: string;
  ok: boolean;
  /** A PNG whose alpha channel is the mask. Set when ok is true. */
  url?: string;
  /** Time ML Kit itself took, in milliseconds. */
  ms?: number;
  message?: string;
}

/** Everything the shell calls with evaluateJavascript. */
interface ShellEvents extends AppEvents {
  onBackgroundResult(result: BackgroundResult): void;
  onBackgroundProgress(progress: { id: string; message: string }): void;
}

/** Methods the Android shell exposes with addJavascriptInterface. Only strings and booleans cross over. */
interface NativeBridge {
  ready(): void;
  pickFile(): void;
  listStickers(): string;
  deleteSticker(packId: string, file: string): string;
  updateWhatsApp(): void;
  openLink(url: string): void;
  cancelLink(): void;
  appVersion(): string;
  openUpdate(): void;
  checkForUpdate(): void;
  addSticker(base64: string, animated: boolean): void;
  removeBackground(id: string, jpegBase64: string): void;
}

declare global {
  interface Window {
    StickerBridge?: NativeBridge;
    __stickerBridge?: ShellEvents;
  }
}

export interface Bridge {
  /** False in a desktop browser, where stickers download instead. */
  readonly isNative: boolean;
  connect(events: AppEvents): void;
  /** Opens the Android photo and video picker. Returns false when the editor must use its own file input. */
  pickFile(): boolean;
  addSticker(webp: Blob, animated: boolean): Promise<void>;
  /** Returns a mask image for the photo. Only its alpha channel matters. */
  removeBackground(jpeg: Blob, onProgress: (message: string) => void): Promise<MaskResult>;
  listStickers(): Promise<StickerLibrary>;
  deleteSticker(sticker: SavedSticker): Promise<void>;
  /** Opens WhatsApp's Add screen for each changed pack. The result arrives through onAddResult. */
  updateWhatsApp(): void;
  /**
   * Downloads the video of a post. Progress and errors arrive through onLinkProgress and onLinkError,
   * and the file through onSharedFile. Returns false when links do not work here.
   */
  openLink(url: string): boolean;
  cancelLink(): void;
  /** The installed version, or null in a desktop browser. */
  appVersion(): string | null;
  /** Opens the latest APK download in the phone's browser. */
  openUpdate(): void;
  /** Asks GitHub now. The answer arrives through onUpdateCheck. Returns false when it cannot ask here. */
  checkForUpdate(): boolean;
}

function toLibrary(native: NativeLibrary): StickerLibrary {
  const stickers = native.packs.flatMap((p) =>
    p.stickers.map((s) => ({ packId: p.id, file: s.file, url: s.url, animated: p.animated })),
  );
  return { stickers: stickers.reverse(), needsUpdate: native.packs.some((p) => p.needsUpdate) };
}

export interface MaskResult {
  mask: Blob;
  /** Time the model itself took, or null in browser mode. */
  modelMs: number | null;
}

interface Pending {
  resolve(result: MaskResult): void;
  reject(err: Error): void;
  onProgress(message: string): void;
}

function nativeBridge(native: NativeBridge): Bridge {
  const pending = new Map<string, Pending>();
  let nextId = 1;

  return {
    isNative: true,
    connect(events) {
      window.__stickerBridge = {
        ...events,
        onBackgroundResult(result) {
          const p = pending.get(result.id);
          if (!p) return;
          pending.delete(result.id);
          if (!result.ok || !result.url) {
            p.reject(new Error(result.message ?? 'Background removal failed.'));
            return;
          }
          fetch(result.url)
            .then((res) => res.blob())
            .then(
              (mask) => p.resolve({ mask, modelMs: result.ms ?? null }),
              () => p.reject(new Error('Could not read the cutout.')),
            );
        },
        onBackgroundProgress({ id, message }) {
          pending.get(id)?.onProgress(message);
        },
      };
      native.ready();
    },
    pickFile() {
      native.pickFile();
      return true;
    },
    async addSticker(webp, animated) {
      native.addSticker(await blobToBase64(webp), animated);
    },
    async listStickers() {
      return toLibrary(JSON.parse(native.listStickers()) as NativeLibrary);
    },
    async deleteSticker(sticker) {
      const result = JSON.parse(native.deleteSticker(sticker.packId, sticker.file)) as { ok: boolean; message?: string };
      if (!result.ok) throw new Error(result.message ?? 'Could not delete the sticker.');
    },
    updateWhatsApp() {
      native.updateWhatsApp();
    },
    openLink(url) {
      native.openLink(url);
      return true;
    },
    cancelLink() {
      native.cancelLink();
    },
    appVersion() {
      return native.appVersion();
    },
    openUpdate() {
      native.openUpdate();
    },
    checkForUpdate() {
      native.checkForUpdate();
      return true;
    },
    async removeBackground(jpeg, onProgress) {
      const id = String(nextId++);
      const base64 = await blobToBase64(jpeg);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress });
        native.removeBackground(id, base64);
      });
    },
  };
}

/** Lets the editor run in a desktop browser for testing. */
function browserBridge(): Bridge {
  let events: AppEvents | null = null;
  // Stickers "added" in browser mode, so the Your stickers screen has something to show.
  const saved: SavedSticker[] = [];
  let needsUpdate = false;
  let count = 0;
  return {
    isNative: false,
    connect(e) {
      events = e;
      window.__stickerBridge = {
        ...e,
        onBackgroundResult() {},
        onBackgroundProgress() {},
      };
    },
    pickFile() {
      return false;
    },
    async addSticker(webp, animated) {
      const url = URL.createObjectURL(webp);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'sticker.webp';
      link.click();
      saved.unshift({ packId: animated ? 'animated_1' : 'static_1', file: `s${++count}.webp`, url, animated });
      needsUpdate = true;
      events?.onAddResult({ ok: true, message: 'Browser mode: the sticker was downloaded.' });
    },
    async listStickers() {
      return { stickers: [...saved], needsUpdate };
    },
    async deleteSticker(sticker) {
      const i = saved.findIndex((s) => s.packId === sticker.packId && s.file === sticker.file);
      if (i < 0) throw new Error('This sticker is already gone.');
      saved.splice(i, 1);
      needsUpdate = true;
    },
    updateWhatsApp() {
      needsUpdate = false;
      events?.onAddResult({ ok: true, message: 'Browser mode: WhatsApp is up to date.' });
    },
    openLink() {
      return false;
    },
    cancelLink() {},
    appVersion() {
      return null;
    },
    openUpdate() {},
    checkForUpdate() {
      return false;
    },
    async removeBackground(jpeg, onProgress) {
      // A fake cutout for testing: removes the frame's border color, like a green screen. The real one runs in the app.
      onProgress('Browser mode: making a fake cutout…');
      const image = await createImageBitmap(jpeg);
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(image, 0, 0);
      image.close();
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      chromaKey(pixels.data, { ...DEFAULT_CHROMA, key: detectKeyColor(pixels.data, canvas.width, canvas.height) });
      ctx.putImageData(pixels, 0, 0);
      return new Promise((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve({ mask: b, modelMs: null }) : reject(new Error('Fake cutout failed.'))),
          'image/png',
        ),
      );
    },
  };
}

export const bridge: Bridge = window.StickerBridge ? nativeBridge(window.StickerBridge) : browserBridge();
