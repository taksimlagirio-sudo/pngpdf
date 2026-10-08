package app.indirici;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.util.Size;
import android.webkit.WebResourceResponse;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Telefon galerisi (izin verilirse): videolar ve fotoğraflar kitaplıkta sunucudakilerle birlikte
 * görünür. Sayfa dosyalara uygulamanın kendi adresi altından ulaşır (/__galeri/küçük|dosya/<id>);
 * kabuk bu istekleri telefonun medya deposundan karşılar (videoda ileri sarma için aralıklı okuma).
 */
final class Gallery {
    private Gallery() {
    }

    static String[] permissions() {
        if (Build.VERSION.SDK_INT >= 33) {
            return new String[]{Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_IMAGES};
        }
        return new String[]{Manifest.permission.READ_EXTERNAL_STORAGE};
    }

    /** "granted" (tamamı ya da Android 14'te seçilenler), "denied". */
    static String state(Context ctx) {
        for (String p : permissions()) {
            if (ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED) return "granted";
        }
        if (Build.VERSION.SDK_INT >= 34
                && ctx.checkSelfPermission("android.permission.READ_MEDIA_VISUAL_USER_SELECTED") == PackageManager.PERMISSION_GRANTED) {
            return "granted";
        }
        return "denied";
    }

    private static Uri collection() {
        return Build.VERSION.SDK_INT >= 29 ? MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL) : MediaStore.Files.getContentUri("external");
    }

    private static Uri itemUri(String id) {
        long n = Long.parseLong(id.substring(1));
        return ContentUris.withAppendedId(id.startsWith("v")
                ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI, n);
    }

    /** En yeniden eskiye videolar ve fotoğraflar (JSON dizi). */
    static String list(Context ctx, int offset, int limit) {
        JSONArray out = new JSONArray();
        String[] cols = {
                MediaStore.Files.FileColumns._ID, MediaStore.Files.FileColumns.MEDIA_TYPE, MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_ADDED,
                MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT, "duration"
        };
        String where = MediaStore.Files.FileColumns.MEDIA_TYPE + " IN ("
                + MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO + "," + MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE + ")";
        String order = MediaStore.MediaColumns.DATE_ADDED + " DESC";
        try (Cursor c = ctx.getContentResolver().query(collection(), cols, where, null, order)) {
            if (c == null) return out.toString();
            if (offset > 0 && !c.moveToPosition(offset - 1)) return out.toString();
            int n = 0;
            while (c.moveToNext() && n < limit) {
                boolean video = c.getInt(1) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO;
                out.put(new JSONObject()
                        .put("id", (video ? "v" : "i") + c.getLong(0))
                        .put("kind", video ? "video" : "image")
                        .put("name", c.getString(2))
                        .put("mime", c.getString(3))
                        .put("size", c.getLong(4))
                        .put("at", c.getLong(5) * 1000)
                        .put("width", c.getInt(6))
                        .put("height", c.getInt(7))
                        .put("duration", c.isNull(8) ? 0 : c.getLong(8) / 1000.0));
                n++;
            }
        } catch (Exception e) {
            return out.toString();
        }
        return out.toString();
    }

    /** /__galeri/kucuk/<id> ya da /__galeri/dosya/<id> isteğini karşılar. */
    static WebResourceResponse serve(Context ctx, Uri url, Map<String, String> requestHeaders) {
        String[] parts = url.getPath() == null ? new String[0] : url.getPath().split("/");
        if (parts.length < 4 || !parts[3].matches("[vi]\\d+")) return notFound();
        String id = parts[3];
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "private, max-age=86400");
        headers.put("Access-Control-Allow-Origin", "*");
        try {
            if ("kucuk".equals(parts[2])) return thumb(ctx, id, headers);
            if ("dosya".equals(parts[2])) return file(ctx, id, requestHeaders, headers);
        } catch (Exception e) {
            return notFound();
        }
        return notFound();
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    @SuppressWarnings("deprecation")
    private static WebResourceResponse thumb(Context ctx, String id, Map<String, String> headers) throws IOException {
        Bitmap bmp;
        ContentResolver r = ctx.getContentResolver();
        if (Build.VERSION.SDK_INT >= 29) {
            bmp = r.loadThumbnail(itemUri(id), new Size(360, 360), null);
        } else {
            long n = Long.parseLong(id.substring(1));
            bmp = id.startsWith("v")
                    ? MediaStore.Video.Thumbnails.getThumbnail(r, n, MediaStore.Video.Thumbnails.MINI_KIND, null)
                    : MediaStore.Images.Thumbnails.getThumbnail(r, n, MediaStore.Images.Thumbnails.MINI_KIND, null);
        }
        if (bmp == null) return notFound();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.JPEG, 80, out);
        return new WebResourceResponse("image/jpeg", null, 200, "OK", headers, new ByteArrayInputStream(out.toByteArray()));
    }

    /** Dosyanın kendisi; "Range" isteğine aralıkla (206) yanıt verilir (videoda ileri sarma). */
    private static WebResourceResponse file(Context ctx, String id, Map<String, String> req, Map<String, String> headers) throws IOException {
        Uri uri = itemUri(id);
        String mime = ctx.getContentResolver().getType(uri);
        ParcelFileDescriptor pfd = ctx.getContentResolver().openFileDescriptor(uri, "r");
        if (pfd == null) return notFound();
        long size = pfd.getStatSize();
        FileInputStream in = new ParcelFileDescriptor.AutoCloseInputStream(pfd);
        headers.put("Accept-Ranges", "bytes");
        String range = null;
        for (Map.Entry<String, String> e : req.entrySet()) if ("range".equalsIgnoreCase(e.getKey())) range = e.getValue();
        if (range != null && range.startsWith("bytes=") && size > 0) {
            String[] se = range.substring(6).split("-", 2);
            long start = se[0].isEmpty() ? 0 : Long.parseLong(se[0].trim());
            long end = se.length > 1 && !se[1].trim().isEmpty() ? Math.min(Long.parseLong(se[1].trim()), size - 1) : size - 1;
            if (start >= size) start = size - 1;
            in.getChannel().position(start);
            long len = end - start + 1;
            headers.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
            headers.put("Content-Length", String.valueOf(len));
            return new WebResourceResponse(mime, null, 206, "Partial Content", headers, new Limited(in, len));
        }
        if (size > 0) headers.put("Content-Length", String.valueOf(size));
        return new WebResourceResponse(mime, null, 200, "OK", headers, in);
    }

    /** En fazla n bayt okuyan akış. */
    private static final class Limited extends FilterInputStream {
        private long left;

        Limited(InputStream in, long n) {
            super(in);
            left = n;
        }

        @Override
        public int read() throws IOException {
            if (left <= 0) return -1;
            int b = super.read();
            if (b >= 0) left--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }
    }
}
