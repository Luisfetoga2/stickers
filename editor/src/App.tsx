import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from './bridge';
import { ClipEditor } from './ClipEditor';
import { isVideo, mayBeAnimated, openAnimatedImage, openVideo, type Clip } from './clip';
import { Cutout } from './cutout';
import { kb } from './encode';
import { firstUrl, shortUrl } from './links';
import { PhotoEditor } from './PhotoEditor';
import { StickersScreen } from './StickersScreen';
import type { Status } from './types';

type Media = { kind: 'photo'; cutout: Cutout; id: number } | { kind: 'clip'; clip: Clip; id: number };

let nextMediaId = 1;

function dispose(media: Media | null) {
  if (media?.kind === 'photo') media.cutout.dispose();
  if (media?.kind === 'clip') media.clip.dispose();
}

/**
 * Screens are browser history entries, so the phone's Back button returns to the start screen:
 * the start screen has no entry, and the editor or Your stickers adds one.
 */
function enterScreen(screen: 'edit' | 'stickers') {
  if (history.state?.screen) history.replaceState({ screen }, '');
  else history.pushState({ screen }, '');
}

export function App() {
  const [media, setMedia] = useState<Media | null>(null);
  const [showStickers, setShowStickers] = useState(false);
  const [stickerCount, setStickerCount] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (blob: Blob, mime: string, name = '') => {
    setStatus({ kind: 'info', text: 'Opening…' });
    try {
      let next: Media;
      const clip = isVideo(mime, name)
        ? await openVideo(blob)
        : mayBeAnimated(mime)
          ? await openAnimatedImage(blob, mime)
          : null;
      if (clip) {
        next = { kind: 'clip', clip, id: nextMediaId++ };
      } else {
        const bitmap = await createImageBitmap(blob);
        next = { kind: 'photo', cutout: Cutout.fromImage(bitmap), id: nextMediaId++ };
        bitmap.close();
      }
      setMedia((prev) => {
        dispose(prev);
        return next;
      });
      setShowStickers(false);
      enterScreen('edit');
      setStatus(null);
    } catch (err) {
      const text = err instanceof Error && err.message ? err.message : 'Could not open this file.';
      setStatus({ kind: 'error', text });
    }
  }, []);

  useEffect(() => {
    bridge.connect({
      onOpening() {
        setStatus({ kind: 'info', text: 'Opening…' });
      },
      async onSharedFile(file) {
        setLinkBusy(false);
        setLink('');
        const res = await fetch(file.url);
        const blob = await res.blob();
        await load(blob, file.mime || blob.type);
      },
      onAddResult(result) {
        setBusy(false);
        setRefreshKey((k) => k + 1);
        setStatus({ kind: result.ok ? 'ok' : 'error', text: result.message });
      },
      onLinkProgress(message) {
        setLinkBusy(true);
        setStatus({ kind: 'info', text: message });
      },
      onLinkError(message) {
        setLinkBusy(false);
        setStatus({ kind: message === 'Cancelled.' ? 'info' : 'error', text: message });
      },
      onUpdateAvailable(version) {
        setNewVersion(version);
      },
      onClipboardLink(url) {
        setCopiedLink(url);
      },
      onUpdateCheck(result) {
        if (!result.ok) {
          setStatus({ kind: 'error', text: 'Could not reach GitHub. Make sure that the phone is online, then try again.' });
        } else if (result.newer && result.latest) {
          setNewVersion(result.latest);
          setStatus({ kind: 'ok', text: `Version ${result.latest} is out. Tap Download to get it.` });
        } else {
          setStatus({ kind: 'ok', text: `You have the newest version, ${bridge.appVersion() ?? result.latest}.` });
        }
      },
    });
  }, [load]);

  // Back from the editor or Your stickers lands on the start screen.
  useEffect(() => {
    const onPop = () => {
      setShowStickers(false);
      setMedia((prev) => {
        dispose(prev);
        return null;
      });
      setStatus(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The start screen shows how many stickers exist, as the way into Your stickers.
  const onStart = !media && !showStickers;
  useEffect(() => {
    if (!onStart) return;
    bridge
      .listStickers()
      .then((library) => setStickerCount(library.stickers.length))
      .catch(() => setStickerCount(0));
  }, [onStart, refreshKey]);

  const pick = () => {
    if (!bridge.pickFile()) fileInput.current?.click();
  };

  const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void load(file, file.type, file.name);
  };

  const onAdd = async (webp: Blob, animated: boolean) => {
    setBusy(true);
    setStatus({ kind: 'info', text: `The sticker is ${kb(webp.size)}. Opening WhatsApp…` });
    try {
      await bridge.addSticker(webp, animated);
    } catch (err) {
      setBusy(false);
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const startLink = (url: string) => {
    setCopiedLink(null);
    if (!bridge.openLink(url)) {
      setStatus({ kind: 'error', text: 'Links work only in the Android app.' });
      return;
    }
    setLinkBusy(true);
    setStatus({ kind: 'info', text: 'Opening the link…' });
  };

  const openLink = (e: React.FormEvent) => {
    e.preventDefault();
    const url = firstUrl(link);
    if (!url) {
      setStatus({ kind: 'error', text: 'There is no link in that text. A link starts with https://' });
      return;
    }
    startLink(url);
  };

  const openStickers = () => {
    setStatus(null);
    enterScreen('stickers');
    setShowStickers(true);
  };

  const editorProps = { busy, status, setStatus, onAdd };

  return (
    <main className="app">
      <input ref={fileInput} type="file" accept="image/*,video/*" hidden onChange={onPicked} />

      {showStickers ? (
        <StickersScreen onClose={() => history.back()} setStatus={setStatus} refreshKey={refreshKey} />
      ) : (
        <>
          <header className="top">
            <h1>Sticker Bridge</h1>
            {media && (
              <button className="ghost" onClick={pick} disabled={busy}>
                Pick another
              </button>
            )}
          </header>

          {!media && (
            <section className="empty">
              <p>Share a photo, GIF, video, or post to Sticker Bridge, or pick one here.</p>
              <button className="primary" onClick={pick} disabled={linkBusy}>
                Pick a file
              </button>
              {copiedLink && !linkBusy && (
                <div className="copied">
                  <p>
                    Open the link you copied?
                    <span className="hint">{shortUrl(copiedLink)}</span>
                  </p>
                  <div className="row">
                    <button className="primary" onClick={() => startLink(copiedLink)}>
                      Open
                    </button>
                    <button className="ghost" onClick={() => setCopiedLink(null)}>
                      Not now
                    </button>
                  </div>
                </div>
              )}
              <form className="link-form" onSubmit={openLink}>
                <input
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="Or paste a TikTok, YouTube, Reddit… link"
                  value={link}
                  disabled={linkBusy}
                  onChange={(e) => setLink(e.target.value)}
                />
                {linkBusy ? (
                  <button type="button" className="ghost" onClick={() => bridge.cancelLink()}>
                    Cancel
                  </button>
                ) : (
                  <button type="submit" className="secondary" disabled={!link.trim()}>
                    Open
                  </button>
                )}
              </form>
              {stickerCount > 0 && (
                <button className="link" onClick={openStickers}>
                  Your stickers ({stickerCount})
                </button>
              )}
            </section>
          )}
          {!media && (
            <footer className="version">
              {newVersion && (
                <div className="update">
                  <span>Version {newVersion} is out.</span>
                  <button className="secondary" onClick={() => bridge.openUpdate()}>
                    Download
                  </button>
                </div>
              )}
              {bridge.appVersion() && (
                <button
                  className="version-check"
                  onClick={() => {
                    if (bridge.checkForUpdate()) setStatus({ kind: 'info', text: 'Checking for updates…' });
                  }}
                >
                  Version {bridge.appVersion()}
                </button>
              )}
            </footer>
          )}
          {media?.kind === 'photo' && <PhotoEditor key={media.id} cutout={media.cutout} {...editorProps} />}
          {media?.kind === 'clip' && <ClipEditor key={media.id} clip={media.clip} {...editorProps} />}
        </>
      )}

      {status && (showStickers || !media) && <p className={`status ${status.kind}`}>{status.text}</p>}
    </main>
  );
}
