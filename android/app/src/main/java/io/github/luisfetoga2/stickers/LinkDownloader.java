package io.github.luisfetoga2.stickers;

import android.content.Context;
import android.content.SharedPreferences;

import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;

import java.io.File;
import java.io.IOException;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import kotlin.Unit;

/**
 * Downloads the video of a post (TikTok, YouTube, Reddit, X, Instagram, and more) with yt-dlp.
 * yt-dlp updates itself once a day. When a download fails, it updates at once and tries again,
 * because a failure usually means that the site changed and a newer yt-dlp already handles it.
 */
final class LinkDownloader {

    interface Listener {
        void onProgress(String message);

        /** The downloaded file. Its MIME type comes from mimeOf(). */
        void onFile(File file);

        void onError(String message);
    }

    /**
     * Video only, because stickers have no sound, so no ffmpeg is needed to join video and audio.
     * H.264 first, because every phone can decode it. 720p is plenty for a 512 px sticker.
     */
    static final String FORMAT = "bv*[vcodec~='^(avc|h264)'][height<=720]"
            + "/b[vcodec~='^(avc|h264)'][height<=720]"
            + "/bv*[height<=720]/b[height<=720]/bv*/b";

    private static final String PREFS = "link_downloader";
    private static final String LAST_UPDATE = "lastUpdateCheck";
    private static final long DAILY_MS = 24L * 60 * 60 * 1000;
    /** After a failure, update again only when the last check is older than this. */
    private static final long RETRY_MS = 10L * 60 * 1000;

    private final Context context;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile String processId;
    private volatile boolean cancelled;
    private boolean ready;

    LinkDownloader(Context context) {
        this.context = context.getApplicationContext();
    }

    /** Unpacks Python the first time, then checks for a new yt-dlp once a day. Runs in the background. */
    void warmUp() {
        worker.execute(() -> {
            try {
                ensureReady();
                updateIfOlderThan(DAILY_MS);
            } catch (Exception ignored) {
                // A link download reports any real problem.
            }
        });
    }

    void download(String url, File dir, Listener listener) {
        cancelled = false;
        worker.execute(() -> run(url, dir, listener));
    }

    void cancel() {
        cancelled = true;
        String id = processId;
        if (id != null) {
            YoutubeDL.getInstance().destroyProcessById(id);
        }
    }

    void shutdown() {
        cancel();
        worker.shutdown();
    }

    private synchronized void ensureReady() throws Exception {
        if (!ready) {
            YoutubeDL.getInstance().init(context);
            ready = true;
        }
    }

    /** Returns true when a newer yt-dlp was installed. */
    private boolean updateIfOlderThan(long ageMs) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        if (now - prefs.getLong(LAST_UPDATE, 0) < ageMs) {
            return false;
        }
        prefs.edit().putLong(LAST_UPDATE, now).apply();
        try {
            return YoutubeDL.getInstance().updateYoutubeDL(context, YoutubeDL.UpdateChannel._STABLE)
                    == YoutubeDL.UpdateStatus.DONE;
        } catch (Exception e) {
            return false;
        }
    }

    private void run(String url, File dir, Listener listener) {
        try {
            listener.onProgress("Getting the downloader ready. The first time takes a few seconds…");
            ensureReady();
        } catch (Exception e) {
            listener.onError("The downloader could not start: " + e.getMessage());
            return;
        }

        String error;
        try {
            listener.onFile(attempt(url, dir, listener));
            return;
        } catch (Exception e) {
            if (cancelled) {
                listener.onError("Cancelled.");
                return;
            }
            error = errorLine(e);
        }

        String known = knownProblem(error);
        if (known != null) {
            listener.onError(known);
            return;
        }

        listener.onProgress("That did not work. Updating yt-dlp and trying again…");
        boolean updated = updateIfOlderThan(RETRY_MS);
        if (updated) {
            try {
                listener.onFile(attempt(url, dir, listener));
                return;
            } catch (Exception e) {
                if (cancelled) {
                    listener.onError("Cancelled.");
                    return;
                }
                error = errorLine(e);
            }
        }
        listener.onError(report(error, updated));
    }

    private File attempt(String url, File dir, Listener listener) throws Exception {
        clear(dir);
        YoutubeDLRequest request = new YoutubeDLRequest(url);
        request.addOption("--no-playlist");
        request.addOption("--playlist-items", "1");
        request.addOption("--no-mtime");
        request.addOption("--no-part");
        request.addOption("--max-filesize", "300M");
        request.addOption("-f", FORMAT);
        request.addOption("-o", new File(dir, "media.%(ext)s").getAbsolutePath());

        String id = UUID.randomUUID().toString();
        processId = id;
        try {
            YoutubeDL.getInstance().execute(request, id, false, (progress, eta, line) -> {
                if (progress != null && progress > 0) {
                    listener.onProgress("Downloading: " + Math.round(progress) + "%");
                }
                return Unit.INSTANCE;
            });
        } finally {
            processId = null;
        }

        File best = null;
        File[] files = dir.listFiles();
        if (files != null) {
            for (File f : files) {
                if (f.isFile() && (best == null || f.length() > best.length())) {
                    best = f;
                }
            }
        }
        if (best == null) {
            throw new IOException("yt-dlp finished but saved no file.");
        }
        return best;
    }

    private static final Pattern URL = Pattern.compile("https?://[^\\s<>\"]+");

    /** The first web link in a text, without trailing punctuation, or null. */
    static String firstUrl(String text) {
        if (text == null) {
            return null;
        }
        Matcher m = URL.matcher(text);
        return m.find() ? m.group().replaceAll("[).,!?\\]]+$", "") : null;
    }

    /** The MIME type of a downloaded file, from its extension. */
    static String mimeOf(File file) {
        String name = file.getName().toLowerCase(Locale.ROOT);
        String ext = name.substring(name.lastIndexOf('.') + 1);
        switch (ext) {
            case "mp4":
            case "m4v":
                return "video/mp4";
            case "webm":
                return "video/webm";
            case "mov":
                return "video/quicktime";
            case "mkv":
                return "video/x-matroska";
            case "gif":
                return "image/gif";
            case "jpg":
            case "jpeg":
                return "image/jpeg";
            case "png":
                return "image/png";
            case "webp":
                return "image/webp";
            default:
                return "application/octet-stream";
        }
    }

    /** yt-dlp prints its reason on a line that starts with "ERROR:". */
    static String errorLine(Exception e) {
        String text = String.valueOf(e.getMessage());
        for (String line : text.split("\n")) {
            int at = line.indexOf("ERROR:");
            if (at >= 0) {
                return line.substring(at + 6).trim();
            }
        }
        String first = text.split("\n")[0].trim();
        return first.length() > 300 ? first.substring(0, 300) + "…" : first;
    }

    /** Problems that an update cannot fix, with advice. Returns null for anything else. */
    static String knownProblem(String error) {
        String e = error.toLowerCase(Locale.ROOT);
        if (e.contains("unsupported url")) {
            return "Sticker Bridge cannot open links from this site.";
        }
        if (e.contains("no video formats") || e.contains("no video in this") || e.contains("there's no video")) {
            return "This post has no video. For a picture, take a screenshot and share it with Sticker Bridge.";
        }
        if (e.contains("max-filesize") || e.contains("larger than max-filesize")) {
            return "This video is over 300 MB. Save a shorter part in the other app and share the file here.";
        }
        if (e.contains("private") || e.contains("login") || e.contains("log in") || e.contains("sign in")
                || e.contains("rate-limit") || e.contains("rate limit")) {
            return "This site wants a login for this post, and Sticker Bridge does not log in. "
                    + "Save the video in the other app, then share the file here. (" + error + ")";
        }
        return null;
    }

    private String report(String error, boolean updated) {
        String version = YoutubeDL.getInstance().versionName(context);
        return "Could not get the video. yt-dlp " + (version != null ? version : "")
                + (updated ? " (just updated)" : " (already the newest)") + " says: " + error
                + ". The site probably changed, and yt-dlp usually catches up within a few days."
                + " Until then, save the video in the other app and share the file here.";
    }

    private static void clear(File dir) throws IOException {
        File[] old = dir.listFiles();
        if (old != null) {
            for (File f : old) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("Could not create the download folder.");
        }
    }
}
