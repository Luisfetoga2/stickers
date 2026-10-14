package io.github.luisfetoga2.stickers;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;

import org.junit.Test;

public class LinkDownloaderTest {

    @Test
    public void error_line_is_taken_from_yt_dlp_output() {
        Exception e = new Exception("WARNING: something\nERROR: [TikTok] 123: Unable to extract data\nmore");
        assertEquals("[TikTok] 123: Unable to extract data", LinkDownloader.errorLine(e));
    }

    @Test
    public void error_line_falls_back_to_the_first_line() {
        assertEquals("boom", LinkDownloader.errorLine(new Exception("boom\nstack")));
    }

    @Test
    public void unsupported_sites_are_reported_without_an_update() {
        String advice = LinkDownloader.knownProblem("Unsupported URL: https://example.com");
        assertNotNull(advice);
        assertTrue(advice.contains("cannot open links"));
    }

    @Test
    public void picture_posts_point_to_a_screenshot() {
        assertTrue(LinkDownloader.knownProblem("[Reddit] abc: No video formats found!").contains("screenshot"));
    }

    @Test
    public void login_walls_are_explained() {
        assertTrue(LinkDownloader.knownProblem("[Instagram] xyz: Requested content is not available, rate-limit reached or login required")
                .contains("login"));
    }

    @Test
    public void unknown_errors_go_to_the_update_and_retry() {
        assertNull(LinkDownloader.knownProblem("[youtube] abc: Some new extraction error"));
    }

    @Test
    public void first_url_is_found_in_shared_text() {
        assertEquals("https://vm.tiktok.com/ZMabc123/",
                LinkDownloader.firstUrl("Check out this video! https://vm.tiktok.com/ZMabc123/ #fyp"));
        assertEquals("https://youtu.be/xyz", LinkDownloader.firstUrl("(https://youtu.be/xyz)."));
        assertNull(LinkDownloader.firstUrl("no link here"));
        assertNull(LinkDownloader.firstUrl(null));
    }

    @Test
    public void mime_types_follow_the_extension() {
        assertEquals("video/mp4", LinkDownloader.mimeOf(new File("media.mp4")));
        assertEquals("video/webm", LinkDownloader.mimeOf(new File("media.WEBM")));
        assertEquals("image/jpeg", LinkDownloader.mimeOf(new File("media.jpg")));
        assertEquals("application/octet-stream", LinkDownloader.mimeOf(new File("media")));
    }
}
