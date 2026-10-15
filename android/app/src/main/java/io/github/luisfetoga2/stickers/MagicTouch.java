package io.github.luisfetoga2.stickers;

import android.content.SharedPreferences;
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
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Magic Touch (MediaPipe interactive segmentation) on the phone: marks on an object give that object's mask.
 * It runs natively, on a worker thread, so the screen never freezes.
 * The model is int8, which some phone GPUs run slower than the CPU. So the first use times both once,
 * and the app keeps the faster one.
 * It closes after a while without use, so it does not hold memory.
 */
final class MagicTouch {

    interface Callback {
        void onProgress(String message);

        /** 0 or 255 per pixel, the same size as the frame. delegate says where it ran, such as "GPU". */
        void onMask(byte[] mask, int width, int height, long modelMs, String delegate);

        void onError(String message);
    }

    private static final long IDLE_CLOSE_MS = 2 * 60 * 1000;
    private static final String PREFS = "magic_touch";
    private static final String DELEGATE = "delegate";

    private static final class Result {
        byte[] mask;
        int width;
        int height;
        long ms;
    }

    private final ModelStore models;
    private final android.content.Context context;
    private final SharedPreferences prefs;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable closeWhenIdle = () -> worker.execute(this::closeSegmenter);

    private InteractiveSegmenter segmenter;
    /** The delegate of the open segmenter. */
    private Delegate current;
    /** How MediaPipe gets the model: 0 by file path, 1 by the file's bytes. Remembered once one works. */
    private int modelSource = -1;

    MagicTouch(android.content.Context context, ModelStore models) {
        this.context = context.getApplicationContext();
        this.models = models;
        this.prefs = this.context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE);
    }

    /** points holds normalized x, y pairs. A tap needs at least 3 points, which the editor sends. */
    void segment(Bitmap frame, float[] points, Callback callback) {
        main.removeCallbacks(closeWhenIdle);
        worker.execute(() -> {
            try {
                File file = models.ensureBlocking(callback::onProgress);
                String saved = prefs.getString(DELEGATE, null);
                if (saved == null) {
                    timeBothAndPick(file, frame, points, callback);
                    return;
                }
                Delegate delegate = Delegate.valueOf(saved);
                Result result;
                try {
                    result = runWith(file, delegate, frame, points);
                } catch (Exception failed) {
                    // The saved choice stopped working, for example after a system update. Use the other one.
                    delegate = delegate == Delegate.GPU ? Delegate.CPU : Delegate.GPU;
                    result = runWith(file, delegate, frame, points);
                    prefs.edit().putString(DELEGATE, delegate.name()).apply();
                }
                callback.onMask(result.mask, result.width, result.height, result.ms, delegate.name());
            } catch (Exception e) {
                callback.onError("Magic Touch failed: " + e.getMessage());
            } finally {
                main.postDelayed(closeWhenIdle, IDLE_CLOSE_MS);
            }
        });
    }

    void close() {
        main.removeCallbacks(closeWhenIdle);
        worker.execute(this::closeSegmenter);
        worker.shutdown();
    }

    /**
     * Runs the first frame on the GPU and on the CPU, twice each, and times the second run.
     * The first run of a GPU prepares its programs, so timing it would be unfair.
     */
    private void timeBothAndPick(File file, Bitmap frame, float[] points, Callback callback) throws Exception {
        callback.onProgress("Timing Magic Touch on the GPU and the CPU of this phone. This happens once…");
        Result gpu = null;
        Result cpu = null;
        Exception error = null;
        try {
            runWith(file, Delegate.GPU, frame, points);
            gpu = runWith(file, Delegate.GPU, frame, points);
        } catch (Exception e) {
            error = e;
        }
        try {
            runWith(file, Delegate.CPU, frame, points);
            cpu = runWith(file, Delegate.CPU, frame, points);
        } catch (Exception e) {
            error = e;
        }
        if (gpu == null && cpu == null) {
            throw error;
        }
        Delegate pick = gpu == null ? Delegate.CPU : cpu == null ? Delegate.GPU : gpu.ms <= cpu.ms ? Delegate.GPU : Delegate.CPU;
        prefs.edit().putString(DELEGATE, pick.name()).apply();
        Result chosen = pick == Delegate.GPU ? gpu : cpu;
        String timing = String.format(Locale.ROOT, "%s, timed: GPU %s, CPU %s", pick.name(),
                gpu == null ? "failed" : String.format(Locale.ROOT, "%.2f s", gpu.ms / 1000.0),
                cpu == null ? "failed" : String.format(Locale.ROOT, "%.2f s", cpu.ms / 1000.0));
        callback.onMask(chosen.mask, chosen.width, chosen.height, chosen.ms, timing);
    }

    /** Runs one frame on one delegate, opening or switching the segmenter as needed. */
    private Result runWith(File file, Delegate delegate, Bitmap frame, float[] points) throws IOException {
        if (segmenter == null || current != delegate) {
            closeSegmenter();
            segmenter = create(file, delegate);
            current = delegate;
        }
        try {
            return run(frame, points);
        } catch (RuntimeException e) {
            if (String.valueOf(e.getMessage()).contains("ExternalFile") && modelSource == 0) {
                // The file path loaded, but the model's parts did not get it. Pass the bytes instead.
                modelSource = 1;
                closeSegmenter();
                segmenter = create(file, delegate);
                current = delegate;
                return run(frame, points);
            }
            closeSegmenter();
            throw e;
        }
    }

    private Result run(Bitmap frame, float[] points) {
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
        MPImage output = segmenter.segment(Collections.singletonList(stroke));
        Result result = new Result();
        result.mask = toMask(output);
        result.width = output.getWidth();
        result.height = output.getHeight();
        output.close();
        image.close();
        result.ms = SystemClock.elapsedRealtime() - started;
        return result;
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
            current = null;
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
