package io.github.luisfetoga2.stickers;

import android.graphics.Bitmap;
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
 * Magic Touch (MediaPipe interactive segmentation): marks on an object give that object's mask.
 * It runs natively, on a worker thread, inside MagicTouchService's own process, so a native crash
 * cannot close the app.
 * The app picks the delegate before each request, so a crash always belongs to the delegate it asked for.
 */
final class MagicTouch {

    interface Callback {
        void onProgress(String message);

        /** 0 or 255 per pixel, the same size as the frame. delegate says where it ran, such as "GPU". */
        void onMask(byte[] mask, int width, int height, long modelMs, String delegate);

        /** engineFailed is true when the delegate itself refused to start, so the other one is worth a try. */
        void onError(String message, boolean engineFailed);
    }


    private static final class Result {
        byte[] mask;
        int width;
        int height;
        long ms;
    }

    private final ModelStore models;
    private final android.content.Context context;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private InteractiveSegmenter segmenter;
    /** The delegate of the open segmenter. */
    private Delegate current;
    /** How MediaPipe gets the model: 0 by file path, 1 by the file's bytes. Remembered once one works. */
    private int modelSource = -1;

    MagicTouch(android.content.Context context, ModelStore models) {
        this.context = context.getApplicationContext();
        this.models = models;
    }

    /** points holds normalized x, y pairs. A tap needs at least 3 points, which the editor sends. */
    void segment(Bitmap frame, float[] points, Delegate delegate, Callback callback) {
        worker.execute(() -> {
            File file;
            try {
                file = models.ensureBlocking(callback::onProgress);
            } catch (Throwable e) {
                callback.onError(e.getMessage(), false);
                return;
            }
            if (segmenter == null || current != delegate) {
                callback.onProgress("Starting Magic Touch on the " + delegate.name() + "…");
                try {
                    closeSegmenter();
                    segmenter = create(file, delegate);
                    current = delegate;
                } catch (Throwable e) {
                    callback.onError("Magic Touch could not start on the " + delegate.name() + ": " + e.getMessage(),
                            true);
                    return;
                }
            }
            try {
                Result result = runWith(file, delegate, frame, points);
                callback.onMask(result.mask, result.width, result.height, result.ms, delegate.name());
            } catch (Throwable e) {
                callback.onError("Magic Touch failed: " + e.getMessage(), false);
            }
        });
    }

    void close() {
        worker.execute(this::closeSegmenter);
        worker.shutdown();
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
