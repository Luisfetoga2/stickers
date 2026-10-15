package io.github.luisfetoga2.stickers;

import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import com.google.mediapipe.framework.image.BitmapImageBuilder;
import com.google.mediapipe.framework.image.ByteBufferExtractor;
import com.google.mediapipe.framework.image.MPImage;
import com.google.mediapipe.tasks.components.containers.NormalizedKeypoint;
import com.google.mediapipe.tasks.core.BaseOptions;
import com.google.mediapipe.tasks.core.Delegate;
import com.google.mediapipe.tasks.vision.interactivesegmenter.InteractiveSegmenter;
import com.google.mediapipe.tasks.vision.interactivesegmenter.InteractiveSegmenterOptions;
import com.google.mediapipe.tasks.vision.interactivesegmenter.Stroke;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Magic Touch (MediaPipe interactive segmentation) on the phone: marks on an object give that object's mask.
 * It runs natively on the GPU when it can, on a worker thread, so the screen never freezes.
 * It closes after a while without use, so it does not hold memory.
 */
final class MagicTouch {

    interface Callback {
        void onProgress(String message);

        /** 0 or 255 per pixel, the same size as the frame. */
        void onMask(byte[] mask, int width, int height, long modelMs, String delegate);

        void onError(String message);
    }

    private static final long IDLE_CLOSE_MS = 2 * 60 * 1000;

    private final ModelStore models;
    private final android.content.Context context;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable closeWhenIdle = () -> worker.execute(this::closeSegmenter);

    private InteractiveSegmenter segmenter;
    private String delegate = "";
    /** How MediaPipe gets the model: 0 by file path, 1 by the file's bytes. Remembered once one works. */
    private int modelSource = -1;
    /** Set after the GPU failed once, so later starts go straight to the CPU. */
    private boolean forceCpu;

    MagicTouch(android.content.Context context, ModelStore models) {
        this.context = context.getApplicationContext();
        this.models = models;
    }

    /** points holds normalized x, y pairs. A tap needs at least 3 points, which the editor sends. */
    void segment(Bitmap frame, float[] points, Callback callback) {
        main.removeCallbacks(closeWhenIdle);
        worker.execute(() -> {
            Exception last = null;
            try {
                for (int attempt = 0; attempt < 3; attempt++) {
                    try {
                        run(frame, points, callback);
                        return;
                    } catch (Exception e) {
                        last = e;
                        closeSegmenter();
                        if (String.valueOf(e.getMessage()).contains("ExternalFile") && modelSource == 0) {
                            // The file path loaded, but the model's parts did not get it. Pass the bytes instead.
                            modelSource = 1;
                        } else if ("GPU".equals(delegate) && !forceCpu) {
                            // Some phones accept the GPU at start but fail on the first frame.
                            forceCpu = true;
                        } else {
                            break;
                        }
                    }
                }
                callback.onError("Magic Touch failed: " + (last == null ? "unknown error" : last.getMessage()));
            } finally {
                main.postDelayed(closeWhenIdle, IDLE_CLOSE_MS);
            }
        });
    }

    private void run(Bitmap frame, float[] points, Callback callback) throws IOException {
        ensureSegmenter(callback);
        long started = SystemClock.elapsedRealtime();
        MPImage image = new BitmapImageBuilder(frame).build();
        segmenter.setImage(image);
        List<NormalizedKeypoint> keypoints = new ArrayList<>();
        for (int i = 0; i + 1 < points.length; i += 2) {
            keypoints.add(NormalizedKeypoint.create(clamp(points[i]), clamp(points[i + 1])));
        }
        Stroke stroke = Stroke.builder()
                .setBrushMode(Stroke.BrushMode.POSITIVE)
                .setPoints(keypoints)
                .setCompleted(true)
                .build();
        MPImage result = segmenter.segment(Collections.singletonList(stroke));
        byte[] mask = toMask(result);
        int width = result.getWidth();
        int height = result.getHeight();
        result.close();
        image.close();
        callback.onMask(mask, width, height, SystemClock.elapsedRealtime() - started, delegate);
    }

    void close() {
        main.removeCallbacks(closeWhenIdle);
        worker.execute(this::closeSegmenter);
        worker.shutdown();
    }

    private void ensureSegmenter(Callback callback) throws IOException {
        if (segmenter != null) {
            return;
        }
        File file = models.ensureBlocking(callback::onProgress);
        callback.onProgress("Starting Magic Touch…");
        if (!forceCpu) {
            try {
                segmenter = create(file, Delegate.GPU);
                delegate = "GPU";
                return;
            } catch (Exception gpuFailed) {
                forceCpu = true;
            }
        }
        segmenter = create(file, Delegate.CPU);
        delegate = "CPU";
    }

    /**
     * Tries the ways to hand MediaPipe the model, simplest first. A direct buffer becomes a raw memory pointer,
     * which this model bundle drops, so it is not used.
     */
    private InteractiveSegmenter create(File file, Delegate delegate) throws IOException {
        RuntimeException last = null;
        for (int source = Math.max(0, modelSource); source <= 1; source++) {
            BaseOptions.Builder base = BaseOptions.builder().setDelegate(delegate);
            if (source == 0) {
                base.setModelAssetPath(file.getAbsolutePath());
            } else {
                // A heap buffer, not a direct one, so MediaPipe copies the bytes, as the web version does.
                base.setModelAssetBuffer(ByteBuffer.wrap(Files.readAllBytes(file.toPath())));
            }
            try {
                InteractiveSegmenter created = InteractiveSegmenter.createFromOptions(context,
                        InteractiveSegmenterOptions.builder().setBaseOptions(base.build()).build());
                modelSource = source;
                return created;
            } catch (RuntimeException e) {
                last = e;
            }
        }
        throw last;
    }

    private void closeSegmenter() {
        if (segmenter != null) {
            segmenter.close();
            segmenter = null;
        }
    }

    /** The model answers with a confidence per pixel, or a byte per pixel. Either becomes 0 or 255. */
    private static byte[] toMask(MPImage result) {
        int count = result.getWidth() * result.getHeight();
        int format = result.getContainedImageProperties().get(0).getImageFormat();
        ByteBuffer buffer = ByteBufferExtractor.extract(result, format);
        buffer.rewind();
        byte[] mask = new byte[count];
        if (format == MPImage.IMAGE_FORMAT_VEC32F1) {
            buffer.order(ByteOrder.nativeOrder());
            for (int i = 0; i < count; i++) {
                mask[i] = buffer.getFloat() >= 0.5f ? (byte) 255 : 0;
            }
        } else {
            for (int i = 0; i < count; i++) {
                mask[i] = (buffer.get() & 0xFF) > 0 ? (byte) 255 : 0;
            }
        }
        return mask;
    }

    private static float clamp(float v) {
        return Math.max(0.001f, Math.min(0.999f, v));
    }
}
