package io.github.luisfetoga2.stickers;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Downloads the Magic Touch model (about 30 MB) once, for Keep and Remove in videos.
 * It is too big to ship in the APK, and Google's server does not allow the editor to fetch it directly.
 */
final class ModelStore {

    interface Listener {
        void onProgress(String message);
    }

    static final String FILE_NAME = "interactive_segmentation.task";
    private static final String MODEL_URL = "https://storage.googleapis.com/mediapipe-models/"
            + "interactive_segmenter_v2/magic_touch/int8/1/interactive_segmentation.task";
    /** A real model is about 30 MB. Anything much smaller is an error page or a cut download. */
    private static final long MIN_SIZE = 10L * 1024 * 1024;

    private final File file;

    ModelStore(Context context) {
        this.file = new File(new File(context.getFilesDir(), "models"), FILE_NAME);
    }

    File file() {
        return file;
    }

    /** Returns the model file, downloading it first when needed. Blocks, so call it on a worker thread. */
    synchronized File ensureBlocking(Listener listener) throws IOException {
        if (!(file.isFile() && file.length() >= MIN_SIZE)) {
            try {
                download(listener);
            } catch (IOException e) {
                throw new IOException("Could not download the Magic Touch model: " + e.getMessage()
                        + ". Make sure that the phone is online, then try again.", e);
            }
        }
        return file;
    }

    private void download(Listener listener) throws IOException {
        File dir = file.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("could not create the model folder");
        }
        File part = new File(file.getPath() + ".part");
        HttpURLConnection connection = (HttpURLConnection) new URL(MODEL_URL).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        try {
            if (connection.getResponseCode() != 200) {
                throw new IOException("the server answered " + connection.getResponseCode());
            }
            long total = connection.getContentLengthLong();
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                byte[] buffer = new byte[64 * 1024];
                long done = 0;
                int lastPercent = -1;
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                    done += read;
                    if (total > 0) {
                        int percent = (int) (100 * done / total);
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            listener.onProgress("Downloading the Magic Touch model (30 MB, once): " + percent + "%");
                        }
                    }
                }
            }
        } finally {
            connection.disconnect();
        }
        if (part.length() < MIN_SIZE) {
            //noinspection ResultOfMethodCallIgnored
            part.delete();
            throw new IOException("the download is too small");
        }
        if (!part.renameTo(file)) {
            throw new IOException("could not save the model");
        }
    }
}
