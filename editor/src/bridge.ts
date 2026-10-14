import { blobToBase64 } from './encode';

export interface SharedFile {
  url: string;
  mime: string;
}

export interface AddResult {
  ok: boolean;
  message: string;
}

export interface BridgeEvents {
  onSharedFile(file: SharedFile): void;
  onAddResult(result: AddResult): void;
}

/** Methods the Android shell exposes with addJavascriptInterface. Only strings and booleans cross over. */
interface NativeBridge {
  ready(): void;
  addSticker(base64: string, animated: boolean): void;
}

declare global {
  interface Window {
    StickerBridge?: NativeBridge;
    /** The shell calls these with evaluateJavascript. */
    __stickerBridge?: BridgeEvents;
  }
}

export interface Bridge {
  /** False in a desktop browser, where stickers download instead. */
  readonly isNative: boolean;
  connect(events: BridgeEvents): void;
  addSticker(webp: Blob, animated: boolean): Promise<void>;
}

function nativeBridge(native: NativeBridge): Bridge {
  return {
    isNative: true,
    connect(events) {
      window.__stickerBridge = events;
      native.ready();
    },
    async addSticker(webp, animated) {
      native.addSticker(await blobToBase64(webp), animated);
    },
  };
}

function browserBridge(): Bridge {
  let events: BridgeEvents | null = null;
  return {
    isNative: false,
    connect(e) {
      events = e;
      window.__stickerBridge = e;
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
  };
}

export const bridge: Bridge = window.StickerBridge ? nativeBridge(window.StickerBridge) : browserBridge();
