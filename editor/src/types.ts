export interface Status {
  kind: 'info' | 'ok' | 'error';
  text: string;
}

/** What App gives each editor screen. */
export interface EditorProps {
  /** True while a sticker goes to WhatsApp. */
  busy: boolean;
  setStatus(status: Status | null): void;
  onAdd(webp: Blob, animated: boolean): Promise<void>;
}
