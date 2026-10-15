package io.github.luisfetoga2.stickers;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The app's side of MagicTouchService. It starts the service on demand and stops it when idle.
 * It picks the delegate for each request: the GPU, or the CPU once the GPU crashed this phone.
 * Because the app picks it before sending, a crash always belongs to the delegate in use.
 */
final class MagicTouchClient {

    interface Callback {
        void onProgress(String message);

        void onMask(byte[] mask, int width, int height, long modelMs, String delegate);

        void onError(String message);
    }

    private static final long IDLE_STOP_MS = 2 * 60 * 1000;
    private static final String GPU_BAD = "gpuBad";
    private static final String CPU_BAD = "cpuBad";
    /** The build that wrote the marks. A new build clears them, since it can fix what crashed. */
    private static final String MARKS_BUILD = "marksBuild";
    /** Android writes the exit record a moment after the process dies. */
    private static final long EXIT_RECORD_WAIT_MS = 800;

    private final Context context;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, Callback> pending = new HashMap<>();
    private final List<Runnable> waiting = new ArrayList<>();
    private final Messenger replies = new Messenger(new Handler(Looper.getMainLooper(), this::onReply));
    private final Runnable stopWhenIdle = this::unbind;

    private Messenger service;
    private boolean bound;
    /** The delegate of the requests sent to the running service. */
    private String inUse;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            service = new Messenger(binder);
            List<Runnable> ready = new ArrayList<>(waiting);
            waiting.clear();
            for (Runnable r : ready) {
                r.run();
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            serviceDied();
        }

        @Override
        public void onBindingDied(ComponentName name) {
            serviceDied();
        }
    };

    MagicTouchClient(Context context) {
        this.context = context.getApplicationContext();
        this.prefs = this.context.getSharedPreferences("magic_touch", Context.MODE_PRIVATE);
        if (prefs.getInt(MARKS_BUILD, -1) != BuildConfig.VERSION_CODE) {
            prefs.edit().clear().putInt(MARKS_BUILD, BuildConfig.VERSION_CODE).apply();
        }
    }

    void segment(String id, byte[] jpeg, float[] points, Callback callback) {
        main.removeCallbacks(stopWhenIdle);
        pending.put(id, callback);
        if (prefs.getBoolean(GPU_BAD, false) && prefs.getBoolean(CPU_BAD, false)) {
            // Both marks leave nothing to run. Try both again rather than refuse for good.
            prefs.edit().remove(GPU_BAD).remove(CPU_BAD).apply();
        }
        String use = prefs.getBoolean(GPU_BAD, false) ? "CPU" : "GPU";
        Runnable send = () -> {
            Message message = Message.obtain(null, MagicTouchService.MSG_SEGMENT);
            Bundle bundle = new Bundle();
            bundle.putString("id", id);
            bundle.putByteArray("jpeg", jpeg);
            bundle.putFloatArray("points", points);
            bundle.putString("use", use);
            inUse = use;
            message.setData(bundle);
            message.replyTo = replies;
            try {
                service.send(message);
            } catch (RemoteException e) {
                serviceDied();
            }
        };
        if (service != null) {
            send.run();
        } else {
            waiting.add(send);
            if (!bound) {
                bound = context.bindService(new Intent(context, MagicTouchService.class), connection,
                        Context.BIND_AUTO_CREATE);
                if (!bound) {
                    fail("Magic Touch could not start.");
                }
            }
        }
    }

    void close() {
        main.removeCallbacks(stopWhenIdle);
        unbind();
    }

    private boolean onReply(Message message) {
        Bundle b = message.getData();
        String id = b.getString("id");
        switch (message.what) {
            case MagicTouchService.MSG_PROGRESS: {
                Callback callback = pending.get(id);
                if (callback != null) {
                    callback.onProgress(b.getString("message"));
                }
                return true;
            }
            case MagicTouchService.MSG_MASK: {
                Callback callback = pending.remove(id);
                if (callback != null) {
                    callback.onMask(b.getByteArray("mask"), b.getInt("width"), b.getInt("height"), b.getLong("ms"),
                            b.getString("delegate"));
                }
                stopLaterIfIdle();
                return true;
            }
            case MagicTouchService.MSG_ERROR: {
                String text = b.getString("message");
                if (b.getBoolean("engineFailed") && inUse != null) {
                    String other = markBad(inUse);
                    text += ". Mark the object again to use the " + other + ".";
                }
                Callback callback = pending.remove(id);
                if (callback != null) {
                    callback.onError(text);
                }
                stopLaterIfIdle();
                return true;
            }
            default:
                return false;
        }
    }

    /**
     * The service process died. Android's exit record says why. Only a native crash while a delegate ran
     * marks that delegate as crashing this phone. Other causes, such as low memory, mark nothing.
     */
    private void serviceDied() {
        String delegate = inUse;
        inUse = null;
        unbind();
        // Fail only the requests that were running, not ones that start while Android writes the record.
        List<Callback> lost = new ArrayList<>(pending.values());
        pending.clear();
        waiting.clear();
        main.postDelayed(() -> {
            ExitReasons.Exit exit = ExitReasons.lastExit(context, ":magic");
            String why = exit == null ? "Android gave no reason" : exit.summary;
            String message;
            if (exit != null && exit.nativeCrash && delegate != null) {
                String other = markBad(delegate);
                message = "Magic Touch crashed on this phone's " + delegate + " (" + why + "). From now on it uses the "
                        + other + ". Mark the object again.";
            } else {
                message = "Magic Touch stopped (" + why + "). Mark the object again.";
            }
            for (Callback callback : lost) {
                callback.onError(message);
            }
        }, EXIT_RECORD_WAIT_MS);
    }

    /** Marks the delegate as failing on this phone and returns the one the next request uses. */
    private String markBad(String delegate) {
        boolean gpu = "GPU".equals(delegate);
        prefs.edit().putBoolean(gpu ? GPU_BAD : CPU_BAD, true).apply();
        return gpu ? "CPU" : "GPU";
    }

    private void fail(String message) {
        List<Callback> callbacks = new ArrayList<>(pending.values());
        pending.clear();
        waiting.clear();
        for (Callback callback : callbacks) {
            callback.onError(message);
        }
    }

    private void stopLaterIfIdle() {
        if (pending.isEmpty()) {
            main.postDelayed(stopWhenIdle, IDLE_STOP_MS);
        }
    }

    private void unbind() {
        if (bound) {
            try {
                context.unbindService(connection);
            } catch (IllegalArgumentException ignored) {
                // Already unbound.
            }
        }
        bound = false;
        service = null;
    }
}
