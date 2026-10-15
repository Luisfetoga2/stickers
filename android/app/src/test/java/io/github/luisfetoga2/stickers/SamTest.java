package io.github.luisfetoga2.stickers;

import static org.junit.Assert.assertEquals;

import java.nio.FloatBuffer;
import java.util.Arrays;

import org.junit.Test;

public class SamTest {

    /** 4 low-resolution guesses: each is positive inside a square of the given size at the top left. */
    private static FloatBuffer guesses(int... sizes) {
        float[] out = new float[4 * Sam.LOW * Sam.LOW];
        Arrays.fill(out, -5);
        for (int i = 0; i < sizes.length; i++) {
            for (int y = 0; y < sizes[i]; y++) {
                for (int x = 0; x < sizes[i]; x++) {
                    out[i * Sam.LOW * Sam.LOW + y * Sam.LOW + x] = 5;
                }
            }
        }
        return FloatBuffer.wrap(out);
    }

    @Test
    public void scaleMakesTheLongestSide1024() {
        assertEquals(1.6f, Sam.scale(640, 360), 1e-6);
        assertEquals(1.6f, Sam.scale(360, 640), 1e-6);
    }

    @Test
    public void inputNormalizesEachChannelAndPads() {
        float[] input = Sam.input(new int[] {0xFF7C7468, 0xFF000000}, 2, 1);
        assertEquals(0.0056, input[0], 1e-3);
        assertEquals(-0.0049, input[Sam.SIDE * Sam.SIDE], 1e-3);
        assertEquals(-123.675 / 58.395, input[1], 1e-4);
        assertEquals(0, input[2], 0);
        assertEquals(0, input[Sam.SIDE], 0);
    }

    @Test
    public void pickTakesTheLargestSureGuessForATap() {
        assertEquals(3, Sam.pick(new float[] {0.97f, 0.95f, 0.6f, 0.85f}, guesses(10, 20, 100, 40), true));
    }

    @Test
    public void pickTakesTheBestScoreWhenNoGuessIsSure() {
        assertEquals(1, Sam.pick(new float[] {0.5f, 0.7f, 0.6f, 0.2f}, guesses(10, 20, 30, 40), true));
    }

    @Test
    public void pickTakesTheFirstGuessForAStrokeOrABox() {
        assertEquals(0, Sam.pick(new float[] {0.5f, 0.99f, 0.99f, 0.99f}, guesses(10, 20, 30, 40), false));
    }

    @Test
    public void packPutsEightPixelsInAByte() {
        byte[] packed = Sam.pack(new byte[][] {
                {(byte) 255, 0, 0, 0, 0, 0, 0, 0, 0, (byte) 255},
                {0, (byte) 255, 0, 0, 0, 0, 0, 0, 0, 0},
        });
        assertEquals(3, packed.length);
        assertEquals(1, packed[0]);
        assertEquals(2 | 8, packed[1]);
        assertEquals(0, packed[2]);
    }

    @Test
    public void maskScalesTheGuessBackToTheFrame() {
        byte[] mask = Sam.mask(guesses(64, 0, 0, 0), 0, 512, 256);
        assertEquals((byte) 255, mask[10 * 512 + 10]);
        assertEquals((byte) 255, mask[120 * 512 + 120]);
        assertEquals(0, mask[136 * 512 + 136]);
        assertEquals(0, mask[10 * 512 + 300]);
    }
}
