package io.github.luisfetoga2.stickers;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

import org.junit.Test;

public class TombstoneTest {

    /** A tiny protobuf writer, enough to build a tombstone for the test. */
    private static final class Writer {
        final ByteArrayOutputStream out = new ByteArrayOutputStream();

        Writer number(int field, long value) {
            varint((long) field << 3);
            varint(value);
            return this;
        }

        Writer bytes(int field, byte[] value) {
            varint(((long) field << 3) | 2);
            varint(value.length);
            out.write(value, 0, value.length);
            return this;
        }

        Writer text(int field, String value) {
            return bytes(field, value.getBytes(StandardCharsets.UTF_8));
        }

        Writer message(int field, Writer value) {
            return bytes(field, value.out.toByteArray());
        }

        private void varint(long v) {
            while ((v & ~0x7FL) != 0) {
                out.write((int) ((v & 0x7F) | 0x80));
                v >>>= 7;
            }
            out.write((int) v);
        }
    }

    private static Writer thread(int id, String name, String file, String function) {
        Writer frame = new Writer().number(1, 0x1234).text(4, function).text(6, file);
        return new Writer().number(1, id).text(2, name).message(4, frame);
    }

    @Test
    public void namesTheSignalAndTheCrashingThread() {
        Writer tombstone = new Writer()
                .number(5, 100)
                .number(6, 102)
                .message(10, new Writer().number(1, 11).text(2, "SIGSEGV").text(4, "SEGV_MAPERR")
                        .number(8, 1).number(9, 0x10))
                .message(16, new Writer().number(1, 101).message(2,
                        thread(101, "Signal Catcher", "/apex/com.android.art/lib64/libart.so", "WaitForSignal")))
                .message(16, new Writer().number(1, 102).message(2,
                        thread(102, "pool-1-thread-1", "/data/app/x/lib/arm64/libmediapipe_tasks_vision_jni.so",
                                "tflite::Interpreter::Invoke()")));

        String text = Tombstone.summarize(tombstone.out.toByteArray());

        assertTrue(text, text.startsWith("SIGSEGV SEGV_MAPERR at 0x10"));
        assertTrue(text, text.contains("thread pool-1-thread-1: #0 libmediapipe_tasks_vision_jni.so tflite::Interpreter::Invoke()"));
        assertTrue(text, !text.contains("Signal Catcher"));
    }

    @Test
    public void includesTheAbortMessage() {
        Writer tombstone = new Writer().number(6, 1).text(14, "Check failed: x == y");
        assertEquals("abort: Check failed: x == y", Tombstone.summarize(tombstone.out.toByteArray()));
    }

    @Test
    public void returnsEmptyForOtherBytes() {
        assertEquals("", Tombstone.summarize("not a tombstone at all".getBytes(StandardCharsets.UTF_8)));
    }
}
