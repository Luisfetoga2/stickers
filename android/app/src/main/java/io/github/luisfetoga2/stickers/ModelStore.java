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
 * Downloads the Magic Touch model (EdgeSAM, about 38 MB in two parts) once, for Keep and Remove in videos.
 * It is too big to ship in the APK. EdgeSAM is under the S-Lab License 1.0, which allows non-commercial use.
 */
final class ModelStore {

    interface Listener {
        void onProgress(String message);
    }

    /** The two model files: the encoder reads the frame once, and the decoder turns marks into a mask. */
    static final class Files {
        final File encoder;
        final File decoder;

        Files(File encoder, File decoder) {
            this.encoder = encoder;
            this.decoder = decoder;
        }
    }

    /** Pinned to one revision, so the files never change under the app. */
    private static final String BASE_URL =
            "https://huggingface.co/chongzhou/EdgeSAM/resolve/e0564124628944e1622973d4e0f68158b46f035a/";
    private static final String ENCODER = "edge_sam_3x_encoder.onnx";
    private static final String DECODER = "edge_sam_3x_decoder.onnx";
    /** The real files are 22 MB and 16 MB. Anything much smaller is an error page or a cut download. */
    private static final long ENCODER_MIN = 18L * 1024 * 1024;
    private static final long DECODER_MIN = 12L * 1024 * 1024;
    /** The MediaPipe model that Magic Touch used before 0.1.27. */
    private static final String OLD_MODEL = "interactive_segmentation.task";

    private final File dir;

    ModelStore(Context context) {
        this.dir = new File(context.getFilesDir(), "models");
    }

    /** Returns the model files, downloading them first when needed. Blocks, so call it on a worker thread. */
    synchronized Files ensureBlocking(Listener listener) throws IOException {
        //noinspection ResultOfMethodCallIgnored
        new File(dir, OLD_MODEL).delete();
        File encoder = new File(dir, ENCODER);
        File decoder = new File(dir, DECODER);
        try {
            if (!(encoder.isFile() && encoder.length() >= ENCODER_MIN)) {
                download(ENCODER, encoder, ENCODER_MIN, "1 of 2", listener);
            }
            if (!(decoder.isFile() && decoder.length() >= DECODER_MIN)) {
                download(DECODER, decoder, DECODER_MIN, "2 of 2", listener);
            }
        } catch (IOException e) {
            throw new IOException("Could not download the Magic Touch model: " + e.getMessage()
                    + ". Make sure that the phone is online, then try again.", e);
        }
        return new Files(encoder, decoder);
    }

    private void download(String name, File file, long minSize, String part, Listener listener) throws IOException {
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("could not create the model folder");
        }
        File partial = new File(file.getPath() + ".part");
        HttpURLConnection connection = (HttpURLConnection) new URL(BASE_URL + name).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        try {
            if (connection.getResponseCode() != 200) {
                throw new IOException("the server answered " + connection.getResponseCode());
            }
            long total = connection.getContentLengthLong();
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(partial)) {
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
                            listener.onProgress("Downloading the Magic Touch model (38 MB, once), part " + part + ": "
                                    + percent + "%");
                        }
                    }
                }
            }
        } finally {
            connection.disconnect();
        }
        if (partial.length() < minSize) {
            //noinspection ResultOfMethodCallIgnored
            partial.delete();
            throw new IOException("the download is too small");
        }
        if (!partial.renameTo(file)) {
            throw new IOException("could not save the model");
        }
    }
}
