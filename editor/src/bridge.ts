import { blobToBase64 } from './encode';

export interface SharedFile {
  url: string;
  mime: string;
}

export interface AddResult {
  ok: boolean;
  message: string;
}

export interface AppEvents {
  /** The shell started copying a shared or picked file. onSharedFile follows. */
  onOpening(): void;
  onSharedFile(file: SharedFile): void;
  onAddResult(result: AddResult): void;
}

interface BackgroundResult {
  id: string;
  ok: boolean;
  /** A PNG whose alpha channel is the mask. Set when ok is true. */
  url?: string;
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
  removeBackground(jpeg: Blob, onProgress: (message: string) => void): Promise<Blob>;
}

interface Pending {
  resolve(mask: Blob): void;
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
            .then(p.resolve, () => p.reject(new Error('Could not read the cutout.')));
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
    async addSticker(webp) {
      const url = URL.createObjectURL(webp);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'sticker.webp';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      events?.onAddResult({ ok: true, message: 'Browser mode: the sticker was downloaded.' });
    },
    async removeBackground(jpeg, onProgress) {
      // A fake cutout: keeps an ellipse in the middle. The real one runs in the Android app.
      onProgress('Browser mode: making a fake cutout…');
      const image = await createImageBitmap(jpeg);
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      image.close();
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(canvas.width / 2, canvas.height / 2, canvas.width * 0.3, canvas.height * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      await new Promise((r) => setTimeout(r, 400));
      return new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Fake cutout failed.'))), 'image/png'),
      );
    },
  };
}

export const bridge: Bridge = window.StickerBridge ? nativeBridge(window.StickerBridge) : browserBridge();
