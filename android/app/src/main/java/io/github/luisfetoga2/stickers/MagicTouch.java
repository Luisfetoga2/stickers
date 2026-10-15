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
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
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
            try {
                run(frame, points, callback);
            } catch (Exception first) {
                // Some phones accept the GPU at start but fail on the first frame. Retry once on the CPU.
                if ("GPU".equals(delegate)) {
                    closeSegmenter();
                    forceCpu = true;
                    try {
                        run(frame, points, callback);
                    } catch (Exception second) {
                        callback.onError("Magic Touch failed: " + second.getMessage());
                    }
                } else {
                    callback.onError("Magic Touch failed: " + first.getMessage());
                }
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
        ByteBuffer model = map(file);
        if (!forceCpu) {
            try {
                segmenter = create(model, Delegate.GPU);
                delegate = "GPU";
                return;
            } catch (Exception gpuFailed) {
                forceCpu = true;
            }
        }
        segmenter = create(model, Delegate.CPU);
        delegate = "CPU";
    }

    private InteractiveSegmenter create(ByteBuffer model, Delegate delegate) {
        BaseOptions base = BaseOptions.builder().setModelAssetBuffer(model).setDelegate(delegate).build();
        return InteractiveSegmenter.createFromOptions(context,
                InteractiveSegmenterOptions.builder().setBaseOptions(base).build());
    }

    private void closeSegmenter() {
        if (segmenter != null) {
            segmenter.close();
            segmenter = null;
        }
    }

    private static ByteBuffer map(File file) throws IOException {
        try (FileInputStream in = new FileInputStream(file); FileChannel channel = in.getChannel()) {
            MappedByteBuffer buffer = channel.map(FileChannel.MapMode.READ_ONLY, 0, channel.size());
            buffer.load();
            return buffer;
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
