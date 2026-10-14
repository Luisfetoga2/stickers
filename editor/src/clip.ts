/** A video or an animated image that the editor reads one frame at a time. */
export interface Clip {
  kind: 'video' | 'gif';
  /** Size of the frames that frameAt() returns. */
  width: number;
  height: number;
  /** Seconds. */
  duration: number;
  /** A frame rate that suits the source. */
  defaultFps: number;
  /** The frame shown at a time in seconds. Draw it before the next call, because the next call can change it. */
  frameAt(seconds: number): Promise<CanvasImageSource>;
  dispose(): void;
}

/** GIF frames are scaled down to this longest side. Stickers are 512 px, so this leaves room to zoom. */
const GIF_MAX_SIDE = 768;
const GIF_MAX_FRAMES = 400;

export function isVideo(mime: string): boolean {
  return mime.startsWith('video/');
}

/** Types that can hold more than one frame. */
export function mayBeAnimated(mime: string): boolean {
  return mime === 'image/gif' || mime === 'image/webp' || mime === 'image/png' || mime === 'image/apng';
}

export async function openVideo(blob: Blob): Promise<Clip> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await once(video, 'loadeddata', 15000);
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('Could not open this video. Try an MP4 file.');
  }
  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    URL.revokeObjectURL(url);
    throw new Error('This video has no length. Try another video.');
  }

  // Seeks run one at a time, in order.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    kind: 'video',
    width: video.videoWidth,
    height: video.videoHeight,
    duration: video.duration,
    defaultFps: 12,
    frameAt(seconds) {
      const target = Math.max(0, Math.min(seconds, video.duration - 0.001));
      const next = queue.then(async () => {
        if (Math.abs(video.currentTime - target) > 0.0005 || video.readyState < 2) {
          video.currentTime = target;
          await once(video, 'seeked', 5000);
        }
        return video;
      });
      queue = next.catch(() => undefined);
      return next;
    },
    dispose() {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    },
  };
}

/** Reads every frame of a GIF or animated WebP. Returns null for a single-frame image. */
export async function openAnimatedImage(blob: Blob, mime: string): Promise<Clip | null> {
  if (typeof ImageDecoder === 'undefined') return null;
  const supported = await ImageDecoder.isTypeSupported(mime).catch(() => false);
  if (!supported) return null;

  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: mime });
  try {
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (!track || !track.animated || track.frameCount <= 1) return null;
    await decoder.completed;

    const count = Math.min(track.frameCount, GIF_MAX_FRAMES);
    const frames: ImageBitmap[] = [];
    const starts: number[] = [];
    let time = 0;
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      const scale = Math.min(1, GIF_MAX_SIDE / Math.max(image.displayWidth, image.displayHeight));
      frames.push(
        await createImageBitmap(image, {
          resizeWidth: Math.max(1, Math.round(image.displayWidth * scale)),
          resizeHeight: Math.max(1, Math.round(image.displayHeight * scale)),
          resizeQuality: 'high',
        }),
      );
      starts.push(time);
      // Browsers show frames of 10 ms or less as 100 ms, so do the same.
      const ms = (image.duration ?? 0) / 1000;
      time += ms > 10 ? ms / 1000 : 0.1;
      image.close();
    }

    const fps = Math.round(count / time);
    return {
      kind: 'gif',
      width: frames[0].width,
      height: frames[0].height,
      duration: time,
      defaultFps: Math.max(5, Math.min(20, fps)),
      async frameAt(seconds) {
        let i = 0;
        while (i + 1 < starts.length && starts[i + 1] <= seconds + 1e-6) i++;
        return frames[i];
      },
      dispose() {
        for (const f of frames) f.close();
      },
    };
  } finally {
    decoder.close();
  }
}

function once(target: HTMLMediaElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}.`));
    }, timeoutMs);
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('The video could not be read.'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      target.removeEventListener('error', onError);
    };
    target.addEventListener(event, onEvent);
    target.addEventListener('error', onError);
  });
}
