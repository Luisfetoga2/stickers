/** A video or an animated image that the editor reads one frame at a time. */
export interface Clip {
  kind: 'video' | 'gif';
  /** Size of the frames that frameAt() and current() return. */
  width: number;
  height: number;
  /** Seconds. */
  duration: number;
  /** A frame rate that suits the source. */
  defaultFps: number;
  /** The exact frame at a time in seconds. Draw it before the next call, because the next call can change it. */
  frameAt(seconds: number): Promise<CanvasImageSource>;
  /** Starts playing from a time. Read the playing frame with current(). */
  play(fromSeconds: number): Promise<void>;
  pause(): void;
  /** The playing time in seconds. */
  time(): number;
  /** The frame at time(). */
  current(): CanvasImageSource;
  dispose(): void;
}

/** GIF frames are scaled down to this longest side. Stickers are 512 px, so this leaves room to zoom. */
const GIF_MAX_SIDE = 768;
const GIF_MAX_FRAMES = 400;

const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|webm|3gp|mkv)$/i;

/** Some pickers give no MIME type, so the file name is the fallback. */
export function isVideo(mime: string, name = ''): boolean {
  return mime.startsWith('video/') || (!mime && VIDEO_EXTENSIONS.test(name));
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
    await once(video, 'loadedmetadata', 30000);
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('This video has no length. Try another video.');
    }
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error('This video has no picture, or the phone cannot decode it.');
    }
    await seek(video, 0);
  } catch (err) {
    URL.revokeObjectURL(url);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not open this video. ${reason}`);
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
      const next = queue.then(async () => {
        video.pause();
        await seek(video, seconds);
        return video;
      });
      queue = next.catch(() => undefined);
      return next;
    },
    async play(from) {
      await queue;
      video.currentTime = clampTime(video, from);
      await video.play();
    },
    pause() {
      video.pause();
    },
    time() {
      return video.currentTime;
    },
    current() {
      return video;
    },
    dispose() {
      video.pause();
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
    let total = 0;
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
      starts.push(total);
      // Browsers show frames of 10 ms or less as 100 ms, so do the same.
      const ms = (image.duration ?? 0) / 1000;
      total += ms > 10 ? ms / 1000 : 0.1;
      image.close();
    }

    const indexAt = (seconds: number) => {
      let i = 0;
      while (i + 1 < starts.length && starts[i + 1] <= seconds + 1e-6) i++;
      return i;
    };
    let playStart = 0;
    let playFrom = 0;
    let playing = false;
    const time = () => (playing ? playFrom + (performance.now() - playStart) / 1000 : playFrom);

    return {
      kind: 'gif',
      width: frames[0].width,
      height: frames[0].height,
      duration: total,
      defaultFps: Math.max(5, Math.min(20, Math.round(count / total))),
      async frameAt(seconds) {
        return frames[indexAt(seconds)];
      },
      async play(from) {
        playFrom = from;
        playStart = performance.now();
        playing = true;
      },
      pause() {
        playFrom = time();
        playing = false;
      },
      time,
      current() {
        return frames[indexAt(time() % total)];
      },
      dispose() {
        for (const f of frames) f.close();
      },
    };
  } finally {
    decoder.close();
  }
}

function clampTime(video: HTMLVideoElement, seconds: number): number {
  return Math.max(0, Math.min(seconds, video.duration - 0.001));
}

/** Seeks to an exact time and waits until that frame is ready to draw. */
async function seek(video: HTMLVideoElement, seconds: number): Promise<void> {
  const target = clampTime(video, seconds);
  if (Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= 2) return;
  video.currentTime = target;
  await once(video, 'seeked', 10000);
  // Some phones fire "seeked" before the new frame reaches the video element. Wait for it, briefly.
  if ('requestVideoFrameCallback' in video) {
    await Promise.race([
      new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 120)),
    ]);
  }
}

function once(target: HTMLMediaElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`The video took too long to load (${event}).`));
    }, timeoutMs);
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      const code = target.error?.code;
      reject(new Error(code === 4 ? 'The phone cannot decode this video format.' : 'The video could not be read.'));
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
