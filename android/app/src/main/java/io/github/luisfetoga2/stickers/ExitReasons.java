package io.github.luisfetoga2.stickers;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Finds out why one of the app's own processes ended, from the record Android keeps (Android 11 and newer). */
final class ExitReasons {

    /** How the Magic Touch process ended, in words, with whether it was a native crash. */
    static final class Exit {
        final boolean nativeCrash;
        final String summary;

        Exit(boolean nativeCrash, String summary) {
            this.nativeCrash = nativeCrash;
            this.summary = summary;
        }
    }

    /** Only exits this recent count, so an old crash is not blamed for a new problem. */
    private static final long RECENT_MS = 2 * 60 * 1000;
    private static final int TRACE_LIMIT = 512 * 1024;

    private ExitReasons() {
    }

    /** The last exit of the process whose name ends with the suffix, or null when Android has no record of it. */
    static Exit lastExit(Context context, String processSuffix) {
        ActivityManager am = context.getSystemService(ActivityManager.class);
        if (am == null) {
            return null;
        }
        List<ApplicationExitInfo> exits = am.getHistoricalProcessExitReasons(context.getPackageName(), 0, 10);
        long now = System.currentTimeMillis();
        for (ApplicationExitInfo info : exits) {
            if (info.getProcessName() == null || !info.getProcessName().endsWith(processSuffix)) {
                continue;
            }
            if (now - info.getTimestamp() > RECENT_MS) {
                return null;
            }
            boolean nativeCrash = info.getReason() == ApplicationExitInfo.REASON_CRASH_NATIVE;
            StringBuilder summary = new StringBuilder(reasonName(info.getReason()));
            if (info.getStatus() != 0) {
                summary.append(String.format(Locale.ROOT, ", status %d", info.getStatus()));
            }
            if (info.getDescription() != null) {
                summary.append(": ").append(info.getDescription());
            }
            String details = traceText(info);
            if (!details.isEmpty()) {
                summary.append(". Details: ").append(details);
            }
            return new Exit(nativeCrash, summary.toString());
        }
        return null;
    }

    private static String reasonName(int reason) {
        switch (reason) {
            case ApplicationExitInfo.REASON_CRASH_NATIVE:
                return "native crash";
            case ApplicationExitInfo.REASON_CRASH:
                return "Java crash";
            case ApplicationExitInfo.REASON_LOW_MEMORY:
                return "stopped by Android for low memory";
            case ApplicationExitInfo.REASON_SIGNALED:
                return "stopped by a signal";
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE:
                return "stopped for using too much CPU or memory";
            case ApplicationExitInfo.REASON_ANR:
                return "stopped for not responding";
            case ApplicationExitInfo.REASON_EXIT_SELF:
                return "exited on its own";
            default:
                return "ended, reason " + reason;
        }
    }

    /**
     * Readable lines from the crash record. For a native crash it is a binary tombstone, so this keeps
     * the text runs that name the cause, such as an abort message or a MediaPipe check that failed.
     */
    private static String traceText(ApplicationExitInfo info) {
        try (InputStream in = info.getTraceInputStream()) {
            if (in == null) {
                return "";
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1 && out.size() < TRACE_LIMIT) {
                out.write(buffer, 0, read);
            }
            List<String> found = new ArrayList<>();
            StringBuilder run = new StringBuilder();
            for (byte b : out.toByteArray()) {
                if (b >= 32 && b < 127) {
                    run.append((char) b);
                    continue;
                }
                keepIfUseful(run.toString(), found);
                run.setLength(0);
            }
            keepIfUseful(run.toString(), found);
            String text = String.join(" | ", found);
            return text.length() > 600 ? text.substring(0, 600) + "…" : text;
        } catch (IOException | RuntimeException e) {
            return "";
        }
    }

    private static void keepIfUseful(String s, List<String> found) {
        if (s.length() < 12 || found.size() >= 4) {
            return;
        }
        String lower = s.toLowerCase(Locale.ROOT);
        if (lower.contains("check failed") || lower.contains("abort") || lower.contains("error")
                || lower.contains("exception") || lower.contains("fatal") || lower.contains("signal")) {
            if (!found.contains(s)) {
                found.add(s);
            }
        }
    }
}
