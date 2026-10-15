package io.github.luisfetoga2.stickers;

import android.graphics.Bitmap;
import android.os.SystemClock;

import java.nio.FloatBuffer;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;

/**
 * Magic Touch: marks or a box on an object give that object's mask. It runs EdgeSAM (a small Segment
 * Anything model) with ONNX Runtime on a worker thread, inside MagicTouchService's own process, so a native
 * crash cannot close the app.
 */
final class MagicTouch {

    interface Callback {
        void onProgress(String message);

        /** 0 or 255 per pixel, the same size as the frame. */
        void onMask(byte[] mask, int width, int height, long modelMs);

        void onError(String message);
    }

    private final ModelStore models;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private OrtEnvironment env;
    private OrtSession encoder;
    private OrtSession decoder;

    MagicTouch(ModelStore models) {
        this.models = models;
    }

    /**
     * points holds normalized x, y pairs, and labels one label per point: 1 marks the object,
     * 2 and 3 are a box's corners. largest picks the largest sure guess, for a single tap.
     */
    void segment(Bitmap frame, float[] points, float[] labels, boolean largest, Callback callback) {
        worker.execute(() -> {
            try {
                if (encoder == null) {
                    ModelStore.Files files = models.ensureBlocking(callback::onProgress);
                    callback.onProgress("Starting Magic Touch…");
                    open(files);
                }
                long started = SystemClock.elapsedRealtime();
                byte[] mask = run(frame, points, labels, largest);
                callback.onMask(mask, frame.getWidth(), frame.getHeight(), SystemClock.elapsedRealtime() - started);
            } catch (Throwable e) {
                callback.onError("Magic Touch failed: " + e.getMessage());
            }
        });
    }

    void close() {
        worker.execute(this::closeSessions);
        worker.shutdown();
    }

    private void open(ModelStore.Files files) throws OrtException {
        env = OrtEnvironment.getEnvironment();
        try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
            options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
            encoder = env.createSession(files.encoder.getAbsolutePath(), options);
            decoder = env.createSession(files.decoder.getAbsolutePath(), options);
        } catch (OrtException e) {
            closeSessions();
            throw e;
        }
    }

    private byte[] run(Bitmap frame, float[] points, float[] labels, boolean largest) throws OrtException {
        int width = frame.getWidth();
        int height = frame.getHeight();
        float scale = Sam.scale(width, height);
        int rw = Math.round(width * scale);
        int rh = Math.round(height * scale);
        Bitmap resized = Bitmap.createScaledBitmap(frame, rw, rh, true);
        int[] argb = new int[rw * rh];
        resized.getPixels(argb, 0, rw, 0, 0, rw, rh);
        if (resized != frame) {
            resized.recycle();
        }

        FloatBuffer embeddings;
        try (OnnxTensor image = OnnxTensor.createTensor(env, FloatBuffer.wrap(Sam.input(argb, rw, rh)),
                new long[] {1, 3, Sam.SIDE, Sam.SIDE});
             OrtSession.Result encoded = encoder.run(java.util.Collections.singletonMap("image", image))) {
            embeddings = ((OnnxTensor) encoded.get(0)).getFloatBuffer();
        }

        int n = labels.length;
        float[] coords = new float[n * 2];
        for (int i = 0; i < n; i++) {
            coords[2 * i] = points[2 * i] * width * scale;
            coords[2 * i + 1] = points[2 * i + 1] * height * scale;
        }
        Map<String, OnnxTensor> inputs = new HashMap<>();
        try {
            inputs.put("image_embeddings", OnnxTensor.createTensor(env, embeddings, new long[] {1, 256, 64, 64}));
            inputs.put("point_coords", OnnxTensor.createTensor(env, FloatBuffer.wrap(coords), new long[] {1, n, 2}));
            inputs.put("point_labels", OnnxTensor.createTensor(env, FloatBuffer.wrap(labels), new long[] {1, n}));
            try (OrtSession.Result decoded = decoder.run(inputs)) {
                FloatBuffer scores = ((OnnxTensor) decoded.get("scores").get()).getFloatBuffer();
                FloatBuffer masks = ((OnnxTensor) decoded.get("masks").get()).getFloatBuffer();
                if (masks.capacity() != 4 * Sam.LOW * Sam.LOW) {
                    throw new IllegalStateException("unexpected mask size " + masks.capacity());
                }
                float[] scoreArray = new float[scores.capacity()];
                scores.get(scoreArray);
                return Sam.mask(masks, Sam.pick(scoreArray, masks, largest), width, height);
            }
        } finally {
            for (OnnxTensor tensor : inputs.values()) {
                tensor.close();
            }
        }
    }

    private void closeSessions() {
        try {
            if (encoder != null) {
                encoder.close();
            }
            if (decoder != null) {
                decoder.close();
            }
        } catch (OrtException ignored) {
            // The process is ending anyway.
        }
        encoder = null;
        decoder = null;
    }
}
