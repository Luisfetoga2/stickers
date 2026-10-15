package io.github.luisfetoga2.stickers;

import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.Process;
import android.os.RemoteException;

import java.util.function.Consumer;

/**
 * Runs Magic Touch in its own process (":magic" in the manifest).
 * A native crash in MediaPipe ends only this process, and the app tells the user instead of closing.
 * When the app unbinds, the process ends, which frees all of the model's memory at once.
 */
public class MagicTouchService extends Service {

    static final int MSG_SEGMENT = 1;
    static final int MSG_PROGRESS = 2;
    static final int MSG_PROBE = 3;
    static final int MSG_MASK = 4;
    static final int MSG_ERROR = 5;

    private MagicTouch magicTouch;
    private final Messenger messenger = new Messenger(new Handler(Looper.getMainLooper(), this::handle));

    @Override
    public void onCreate() {
        super.onCreate();
        magicTouch = new MagicTouch(this, new ModelStore(this));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return messenger.getBinder();
    }

    @Override
    public void onDestroy() {
        magicTouch.close();
        super.onDestroy();
        // This process only runs Magic Touch. Ending it frees the model's native memory right away.
        Process.killProcess(Process.myPid());
    }

    private boolean handle(Message msg) {
        if (msg.what != MSG_SEGMENT) {
            return false;
        }
        Messenger reply = msg.replyTo;
        Bundle in = msg.getData();
        String id = in.getString("id");
        byte[] jpeg = in.getByteArray("jpeg");
        float[] points = in.getFloatArray("points");
        Bitmap frame = jpeg == null ? null : BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
        if (frame == null || points == null) {
            send(reply, MSG_ERROR, id, b -> b.putString("message", "Could not read the frame."));
            return true;
        }
        magicTouch.segment(frame, points, in.getString("use"), in.getBoolean("gpuBad"), in.getBoolean("cpuBad"),
                new MagicTouch.Callback() {
                    @Override
                    public void onProgress(String message) {
                        send(reply, MSG_PROGRESS, id, b -> b.putString("message", message));
                    }

                    @Override
                    public void onProbe(String delegate) {
                        send(reply, MSG_PROBE, id, b -> b.putString("delegate", delegate));
                    }

                    @Override
                    public void onMask(byte[] mask, int width, int height, long modelMs, String delegate,
                                       String timing) {
                        send(reply, MSG_MASK, id, b -> {
                            b.putByteArray("mask", mask);
                            b.putInt("width", width);
                            b.putInt("height", height);
                            b.putLong("ms", modelMs);
                            b.putString("delegate", delegate);
                            b.putString("timing", timing);
                        });
                    }

                    @Override
                    public void onError(String message) {
                        send(reply, MSG_ERROR, id, b -> b.putString("message", message));
                    }
                });
        return true;
    }

    private static void send(Messenger to, int what, String id, Consumer<Bundle> fill) {
        Message message = Message.obtain(null, what);
        Bundle bundle = new Bundle();
        bundle.putString("id", id);
        fill.accept(bundle);
        message.setData(bundle);
        try {
            to.send(message);
        } catch (RemoteException ignored) {
            // The app is gone, so nobody waits for this answer.
        }
    }
}
