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
import android.os.RemoteException;

import java.util.function.Consumer;

/**
 * Runs Magic Touch in its own process (":magic" in the manifest).
 * A native crash ends only this process, and the app tells the user instead of closing.
 * When the app unbinds, the model sessions close, which frees their native memory.
 */
public class MagicTouchService extends Service {

    static final int MSG_SEGMENT = 1;
    static final int MSG_PROGRESS = 2;
    static final int MSG_MASK = 4;
    static final int MSG_ERROR = 5;

    private MagicTouch magicTouch;
    private final Messenger messenger = new Messenger(new Handler(Looper.getMainLooper(), this::handle));

    @Override
    public void onCreate() {
        super.onCreate();
        magicTouch = new MagicTouch(new ModelStore(this));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return messenger.getBinder();
    }

    @Override
    public void onDestroy() {
        // No killProcess here: a rebind can come while the process ends, and the app would take that for a crash.
        magicTouch.close();
        super.onDestroy();
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
        float[] labels = in.getFloatArray("labels");
        Bitmap frame = jpeg == null ? null : BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
        if (frame == null || points == null || labels == null || points.length != labels.length * 2) {
            send(reply, MSG_ERROR, id, b -> b.putString("message", "Could not read the frame."));
            return true;
        }
        magicTouch.segment(frame, points, labels, in.getBoolean("largest"), new MagicTouch.Callback() {
            @Override
            public void onProgress(String message) {
                send(reply, MSG_PROGRESS, id, b -> b.putString("message", message));
            }

            @Override
            public void onMask(byte[] mask, int width, int height, long modelMs) {
                send(reply, MSG_MASK, id, b -> {
                    b.putByteArray("mask", mask);
                    b.putInt("width", width);
                    b.putInt("height", height);
                    b.putLong("ms", modelMs);
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
