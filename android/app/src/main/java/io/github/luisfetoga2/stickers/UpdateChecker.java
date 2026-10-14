package io.github.luisfetoga2.stickers;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Finds out if GitHub has a newer APK than the one installed.
 * Each release tag is "apk-N", where N is the build number and the app's versionCode.
 */
final class UpdateChecker {

    interface Listener {
        /** Called on a background thread, only when a newer build exists. */
        void onNewerBuild(int build);
    }

    static final String DOWNLOAD_URL =
            "https://github.com/Luisfetoga2/stickers/releases/latest/download/sticker-bridge.apk";
    private static final String LATEST_URL = "https://api.github.com/repos/Luisfetoga2/stickers/releases/latest";

    private static final String PREFS = "update_checker";
    private static final String LAST_CHECK = "lastCheck";
    private static final String LATEST_BUILD = "latestBuild";
    /** GitHub allows 60 anonymous requests per hour, and releases are rare, so a few checks a day is plenty. */
    private static final long CHECK_EVERY_MS = 6L * 60 * 60 * 1000;

    private UpdateChecker() {
    }

    /** The build number in a tag such as "apk-12", or -1. */
    static int buildFromTag(String tag) {
        if (tag == null || !tag.startsWith("apk-")) {
            return -1;
        }
        try {
            return Integer.parseInt(tag.substring(4));
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** The version name of a build, in the same form as the app's versionName. */
    static String versionName(int build) {
        return "0.1." + build;
    }

    static void check(Context context, int installedBuild, Listener listener) {
        Context app = context.getApplicationContext();
        Thread thread = new Thread(() -> {
            int latest = latestBuild(app);
            if (latest > installedBuild) {
                listener.onNewerBuild(latest);
            }
        }, "update-check");
        thread.setDaemon(true);
        thread.start();
    }

    /** Asks GitHub at most every few hours. In between, and when offline, it uses the last answer. */
    private static int latestBuild(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        int cached = prefs.getInt(LATEST_BUILD, -1);
        if (now - prefs.getLong(LAST_CHECK, 0) < CHECK_EVERY_MS) {
            return cached;
        }
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(LATEST_URL).openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("User-Agent", "StickerBridge");
            if (connection.getResponseCode() != 200) {
                return cached;
            }
            String body;
            try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                }
                body = out.toString(StandardCharsets.UTF_8.name());
            }
            int latest = buildFromTag(new JSONObject(body).optString("tag_name"));
            prefs.edit().putLong(LAST_CHECK, now).putInt(LATEST_BUILD, latest).apply();
            return latest;
        } catch (Exception e) {
            return cached;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }
}
