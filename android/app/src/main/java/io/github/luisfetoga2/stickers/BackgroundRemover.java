package io.github.luisfetoga2.stickers;

import android.content.Context;
import android.graphics.Bitmap;

import com.google.android.gms.common.moduleinstall.InstallStatusListener;
import com.google.android.gms.common.moduleinstall.ModuleInstall;
import com.google.android.gms.common.moduleinstall.ModuleInstallClient;
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest;
import com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.segmentation.subject.SubjectSegmentation;
import com.google.mlkit.vision.segmentation.subject.SubjectSegmenter;
import com.google.mlkit.vision.segmentation.subject.SubjectSegmenterOptions;

import java.nio.FloatBuffer;
import java.util.concurrent.Executor;

/**
 * Finds the subject of a photo with ML Kit subject segmentation, on the phone.
 * Google Play services downloads the model the first time, so the first run can wait for that download.
 */
final class BackgroundRemover {

    interface Callback {
        void onProgress(String message);

        /** A white bitmap whose alpha channel is the subject confidence, the same size as the photo. */
        void onMask(Bitmap mask);

        void onError(String message);
    }

    private final SubjectSegmenter segmenter;
    private final ModuleInstallClient installer;
    private final Executor worker;
    /** True after the model was found once, so video frames skip the Play services check. */
    private volatile boolean modelReady;

    BackgroundRemover(Context context, Executor worker) {
        this.worker = worker;
        this.segmenter = SubjectSegmentation.getClient(
                new SubjectSegmenterOptions.Builder()
                        .enableForegroundConfidenceMask()
                        .build());
        this.installer = ModuleInstall.getClient(context);
    }

    void remove(Bitmap photo, Callback callback) {
        if (modelReady) {
            segment(photo, callback);
            return;
        }
        installer.areModulesAvailable(segmenter)
                .addOnSuccessListener(response -> {
                    if (response.areModulesAvailable()) {
                        modelReady = true;
                        segment(photo, callback);
                    } else {
                        install(photo, callback);
                    }
                })
                .addOnFailureListener(e -> callback.onError(
                        "Could not reach Google Play services: " + e.getMessage()));
    }

    void close() {
        segmenter.close();
    }

    private void install(Bitmap photo, Callback callback) {
        callback.onProgress("Downloading the background model. This happens only once…");
        InstallStatusListener listener = new InstallStatusListener() {
            @Override
            public void onInstallStatusUpdated(ModuleInstallStatusUpdate update) {
                int state = update.getInstallState();
                if (state == ModuleInstallStatusUpdate.InstallState.STATE_COMPLETED) {
                    installer.unregisterListener(this);
                    modelReady = true;
                    segment(photo, callback);
                } else if (state == ModuleInstallStatusUpdate.InstallState.STATE_FAILED
                        || state == ModuleInstallStatusUpdate.InstallState.STATE_CANCELED) {
                    installer.unregisterListener(this);
                    callback.onError("Could not download the background model (code "
                            + update.getErrorCode() + "). Connect to the internet and try again.");
                } else {
                    ModuleInstallStatusUpdate.ProgressInfo progress = update.getProgressInfo();
                    if (progress != null && progress.getTotalBytesToDownload() > 0) {
                        long percent = 100 * progress.getBytesDownloaded() / progress.getTotalBytesToDownload();
                        callback.onProgress("Downloading the background model: " + percent + "%");
                    }
                }
            }
        };
        ModuleInstallRequest request = ModuleInstallRequest.newBuilder()
                .addApi(segmenter)
                .setListener(listener)
                .build();
        installer.installModules(request)
                .addOnSuccessListener(response -> {
                    if (response.areModulesAlreadyInstalled()) {
                        installer.unregisterListener(listener);
                        modelReady = true;
                        segment(photo, callback);
                    }
                })
                .addOnFailureListener(e -> {
                    installer.unregisterListener(listener);
                    callback.onError("Could not download the background model: " + e.getMessage());
                });
    }

    private void segment(Bitmap photo, Callback callback) {
        segmenter.process(InputImage.fromBitmap(photo, 0))
                .addOnSuccessListener(worker, result -> {
                    FloatBuffer confidence = result.getForegroundConfidenceMask();
                    if (confidence == null) {
                        callback.onError("Background removal returned no mask.");
                        return;
                    }
                    callback.onMask(toMask(confidence, photo.getWidth(), photo.getHeight()));
                })
                .addOnFailureListener(e -> callback.onError("Background removal failed: " + e.getMessage()));
    }

    private static Bitmap toMask(FloatBuffer confidence, int width, int height) {
        int[] pixels = new int[width * height];
        confidence.rewind();
        for (int i = 0; i < pixels.length && confidence.hasRemaining(); i++) {
            int alpha = Math.round(Math.max(0f, Math.min(1f, confidence.get())) * 255f);
            pixels[i] = (alpha << 24) | 0x00FFFFFF;
        }
        return Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888);
    }
}
