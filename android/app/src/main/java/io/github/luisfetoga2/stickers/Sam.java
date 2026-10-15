package io.github.luisfetoga2.stickers;

import java.nio.FloatBuffer;

/**
 * The steps around EdgeSAM (a small Segment Anything model): the frame goes in as a 1024 px square,
 * and 4 low-resolution guesses come out. The editor does the same steps in samMath.ts for browser tests.
 */
final class Sam {

    static final int SIDE = 1024;
    static final int LOW = 256;
    private static final float[] MEAN = {123.675f, 116.28f, 103.53f};
    private static final float[] STD = {58.395f, 57.12f, 57.375f};
    /** A tap takes the largest guess that the model is at least this sure of. */
    private static final float SURE = 0.8f;

    private Sam() {
    }

    /** Frame pixels times this give model pixels: the longest side becomes 1024. */
    static float scale(int width, int height) {
        return SIDE / (float) Math.max(width, height);
    }

    /**
     * The model's input from ARGB pixels already resized by scale: channels first, normalized,
     * and padded with zeros on the right and bottom to 1024 x 1024.
     */
    static float[] input(int[] argb, int width, int height) {
        int plane = SIDE * SIDE;
        float[] out = new float[3 * plane];
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                int p = argb[y * width + x];
                int o = y * SIDE + x;
                out[o] = (((p >> 16) & 0xFF) - MEAN[0]) / STD[0];
                out[plane + o] = (((p >> 8) & 0xFF) - MEAN[1]) / STD[1];
                out[2 * plane + o] = ((p & 0xFF) - MEAN[2]) / STD[2];
            }
        }
        return out;
    }

    /** Which of the 4 guesses to use. masks holds 4 low-resolution masks, one after another. */
    static int pick(float[] scores, FloatBuffer masks, boolean largest) {
        if (!largest) {
            return 0;
        }
        int best = 0;
        for (int i = 1; i < scores.length; i++) {
            if (scores[i] > scores[best]) {
                best = i;
            }
        }
        int chosen = -1;
        int chosenArea = -1;
        for (int i = 0; i < scores.length; i++) {
            if (scores[i] < SURE) {
                continue;
            }
            int area = 0;
            for (int k = i * LOW * LOW; k < (i + 1) * LOW * LOW; k++) {
                if (masks.get(k) > 0) {
                    area++;
                }
            }
            if (area > chosenArea) {
                chosen = i;
                chosenArea = area;
            }
        }
        return chosen < 0 ? best : chosen;
    }

    /**
     * Masks as bits, 1 inside the object: pixel i of all the masks in a row is bit i % 8 of byte i / 8.
     * 8 times smaller than bytes, so 4 guesses fit in one message between the app's processes.
     */
    static byte[] pack(byte[][] masks) {
        int size = masks[0].length;
        byte[] out = new byte[(masks.length * size + 7) / 8];
        for (int m = 0; m < masks.length; m++) {
            for (int i = 0; i < size; i++) {
                if (masks[m][i] != 0) {
                    int bit = m * size + i;
                    out[bit >> 3] |= (byte) (1 << (bit & 7));
                }
            }
        }
        return out;
    }

    /** One low-resolution guess, scaled back to the frame: 255 inside the object, 0 outside. */
    static byte[] mask(FloatBuffer masks, int index, int width, int height) {
        byte[] out = new byte[width * height];
        float step = scale(width, height) / (SIDE / (float) LOW);
        int base = index * LOW * LOW;
        for (int y = 0; y < height; y++) {
            float fy = Math.min(LOW - 1, Math.max(0, (y + 0.5f) * step - 0.5f));
            int y0 = (int) fy;
            int y1 = Math.min(LOW - 1, y0 + 1);
            float wy = fy - y0;
            for (int x = 0; x < width; x++) {
                float fx = Math.min(LOW - 1, Math.max(0, (x + 0.5f) * step - 0.5f));
                int x0 = (int) fx;
                int x1 = Math.min(LOW - 1, x0 + 1);
                float wx = fx - x0;
                float top = masks.get(base + y0 * LOW + x0) * (1 - wx) + masks.get(base + y0 * LOW + x1) * wx;
                float bottom = masks.get(base + y1 * LOW + x0) * (1 - wx) + masks.get(base + y1 * LOW + x1) * wx;
                out[y * width + x] = top * (1 - wy) + bottom * wy > 0 ? (byte) 255 : 0;
            }
        }
        return out;
    }
}
