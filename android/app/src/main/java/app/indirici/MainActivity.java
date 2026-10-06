package app.indirici;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * İndirici: uygulamanın kendisi (sayfalar) kendi sunucundan (varsayılan Termux, http://127.0.0.1:8787)
 * yüklenir. Bu kabuk yalnızca Android'in kendi işlerini yapar:
 *  - Paylaşım: başka uygulamadan paylaşılan bağlantı, uygulama açıkken de açık sayfaya iletilir.
 *  - Kaydetme: dosyalar telefonun İndirilenler klasörüne yazılır.
 *  - Tam ekran video, dosya seçme, geri tuşu.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "indirici";
    private static final String DEFAULT_SERVER = "http://127.0.0.1:8787/";
    private static final int FILE_REQUEST = 1;
    private static final int LOGIN_REQUEST = 4;
    private static final Pattern LINK = Pattern.compile("https?://\\S+");

    private WebView web;
    private FrameLayout root;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private ValueCallback<Uri[]> fileCallback;
    private boolean pageReady = false;
    private boolean offline = false;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Map<String, Pending> saving = new HashMap<>();

    /** Yazılmakta olan dosya (uygulama parça parça gönderir). */
    private static class Pending {
        OutputStream out;
        Uri uri;
        File file;
        String name;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#121110"));
        getWindow().setNavigationBarColor(Color.parseColor("#121110"));

        root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        WebView.setWebContentsDebuggingEnabled(true);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setAllowFileAccess(false);
        s.setSupportZoom(false);
        // Uygulama kabukta çalıştığını buradan anlar (paylaşım ve kaydetme kabuğa bırakılır).
        s.setUserAgentString(s.getUserAgentString() + " IndiriciAPK/" + versionName());
        CookieManager.getInstance().setAcceptCookie(true);

        web.addJavascriptInterface(new Bridge(), "IndiriciAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> download(url, userAgent, disposition, mime));

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            String link = sharedLink(getIntent());
            String open = getIntent().getStringExtra("open");
            web.loadUrl(link != null ? shareUrl(link) : open != null ? server() + open.replaceFirst("^/", "") : server());
        }
        // Takip bildirimleri açıksa dinleyici çalışsın (telefon yeniden başlamış ya da servis kapanmış olabilir).
        if (NotifyService.isEnabled(this)) NotifyService.setEnabled(this, true, null, null);
    }

    /** Bildirime dokunulunca: ilgili ekran açılır ("#follow" gibi yalnızca sekme ise sayfa yenilenmez). */
    private void openFromNotification(String open) {
        if (open.startsWith("#") && pageReady && !offline) {
            web.evaluateJavascript("location.hash=" + JSONObject.quote(open), null);
        } else {
            web.loadUrl(server() + open.replaceFirst("^/", ""));
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String link = sharedLink(intent);
        if (link != null) deliverShare(link);
        String open = intent.getStringExtra("open");
        if (link == null && open != null) openFromNotification(open);
    }

    /* ---------------- Paylaşım ---------------- */

    private static String sharedLink(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null) text = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (text == null) return null;
        Matcher m = LINK.matcher(text);
        return m.find() ? m.group() : null;
    }

    private String shareUrl(String link) {
        try {
            return server() + "?text=" + URLEncoder.encode(link, "UTF-8") + "#detect";
        } catch (IOException e) {
            return server();
        }
    }

    /** Sayfa açıksa bağlantı doğrudan sayfaya verilir; değilse sayfa bağlantıyla açılır. */
    private void deliverShare(String link) {
        if (!pageReady || offline) {
            web.loadUrl(shareUrl(link));
            return;
        }
        String js = "(function(){try{return window.__indiriciShare?window.__indiriciShare(" + JSONObject.quote(link) + "):false}catch(e){return false}})()";
        web.evaluateJavascript(js, (result) -> {
            if (!"true".equals(result)) web.loadUrl(shareUrl(link));
        });
    }

    /* ---------------- Sunucu adresi ---------------- */

    private String server() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String url = p.getString("server", DEFAULT_SERVER);
        return url.endsWith("/") ? url : url + "/";
    }

    private boolean sameServer(Uri uri) {
        Uri base = Uri.parse(server());
        return uri.getScheme() != null && uri.getScheme().equals(base.getScheme())
                && uri.getHost() != null && uri.getHost().equals(base.getHost()) && uri.getPort() == base.getPort();
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "1";
        }
    }

    /** Sunucu açılmadıysa: uygulamanın renklerinde kısa bir bilgi ekranı (yeniden dene, adres değiştir). */
    private void showOffline(String reason) {
        offline = true;
        String html = "<!doctype html><html lang='tr'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;justify-content:center;gap:16px;padding:24px;box-sizing:border-box;"
                + "background:#121110;color:#F2EFE9;font:16px/1.5 system-ui,sans-serif}h1{font-size:24px;margin:0}p{margin:0;color:#A29D93}"
                + "code{background:#23221F;padding:2px 6px;border-radius:6px;color:#F2EFE9;font-size:13px;word-break:break-all}"
                + "input{height:48px;border-radius:14px;border:1px solid #2E2C28;background:#1A1917;color:#F2EFE9;padding:0 14px;font-size:15px}"
                + "button{height:52px;border-radius:16px;border:0;font:700 15px system-ui,sans-serif}.a{background:#D4F04A;color:#15140F}"
                + ".b{background:none;border:1px solid #2E2C28;color:#F2EFE9}small{color:#7D786F}</style></head><body>"
                + "<h1>Sunucuna ulaşılamadı</h1>"
                + "<p>İndirici kendi sunucundan açılır. Termux'ta sunucuyu başlat:</p>"
                + "<code>sh ~/pngpdf/render-server/start-termux.sh</code>"
                + "<button class='a' onclick='IndiriciAndroid.retry()'>Yeniden dene</button>"
                + "<label><small>Sunucu adresi</small></label>"
                + "<input id='u' value='" + server().replace("'", "") + "' inputmode='url' autocomplete='off'>"
                + "<button class='b' onclick='IndiriciAndroid.setServer(document.getElementById(\"u\").value)'>Bu adresi kullan</button>"
                + "<small>" + android.text.Html.escapeHtml(reason == null ? "" : reason) + "</small>"
                + "</body></html>";
        web.loadDataWithBaseURL("about:blank", html, "text/html", "utf-8", null);
    }

    /* ---------------- Sayfa ---------------- */

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if ("blob".equals(scheme) || "data".equals(scheme) || "about".equals(scheme) || sameServer(uri)) return false;
            // Başka sitelerin adresleri (ör. "siteyi aç") telefonun tarayıcısında açılır.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
                // açacak uygulama yok
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            pageReady = false;
            if (url != null && !url.startsWith("about:")) offline = false;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (url != null && !url.startsWith("about:") && !offline) pageReady = true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showOffline(String.valueOf(error.getDescription()));
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (fullscreenView != null) {
                callback.onCustomViewHidden();
                return;
            }
            fullscreenView = view;
            fullscreenCallback = callback;
            root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.setVisibility(View.GONE);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }

        @Override
        public void onHideCustomView() {
            exitFullscreen();
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), FILE_REQUEST);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }
    }

    private void exitFullscreen() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        web.setVisibility(View.VISIBLE);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == LOGIN_REQUEST) {
            // Telefonda yapılan girişin çerezleri uygulamaya verilir; uygulama sunucuya aktarır.
            String cookies = resultCode == RESULT_OK && data != null ? data.getStringExtra(LoginActivity.RESULT_COOKIES) : null;
            web.evaluateJavascript("window.__indiriciPhoneLogin&&window.__indiriciPhoneLogin("
                    + JSONObject.quote(cookies == null ? "" : cookies) + ")", null);
            return;
        }
        if (requestCode == FILE_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    /** Geri tuşu: tam ekrandan çıkar; yoksa sayfa kendi geri davranışını yapar (açık pencereyi kapatır…). */
    @Override
    public void onBackPressed() {
        if (fullscreenView != null) {
            exitFullscreen();
            return;
        }
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        moveTaskToBack(true);
    }

    @Override
    protected void onDestroy() {
        for (Pending p : saving.values()) closeQuietly(p.out);
        saving.clear();
        web.destroy();
        super.onDestroy();
    }

    /* ---------------- İndirilenler'e kaydetme ---------------- */

    private static String mimeOf(String name, String fallback) {
        String ext = MimeTypeMap.getFileExtensionFromUrl(name);
        String m = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        return m != null ? m : (fallback == null || fallback.isEmpty() ? "application/octet-stream" : fallback);
    }

    /** İndirilenler klasöründe yeni bir dosya açar (Android 10+: MediaStore; öncesi: doğrudan klasör). */
    private Pending open(String name, String mime) throws IOException {
        Pending p = new Pending();
        p.name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, p.name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mimeOf(p.name, mime));
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            ContentResolver r = getContentResolver();
            p.uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (p.uri == null) throw new IOException("Dosya oluşturulamadı");
            p.out = r.openOutputStream(p.uri);
        } else {
            if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                ui.post(() -> requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 2));
                throw new IOException("Depolama izni gerekli; izin verip yeniden dene");
            }
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (!dir.exists() && !dir.mkdirs()) throw new IOException("İndirilenler klasörü yok");
            p.file = new File(dir, p.name);
            for (int i = 1; p.file.exists(); i++) p.file = new File(dir, i + "_" + p.name);
            p.out = new FileOutputStream(p.file);
        }
        if (p.out == null) throw new IOException("Dosya açılamadı");
        return p;
    }

    private void close(Pending p) throws IOException {
        p.out.close();
        if (p.uri != null) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContentResolver().update(p.uri, v, null, null);
        } else if (p.file != null) {
            sendBroadcast(new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.fromFile(p.file)));
        }
    }

    private void discard(Pending p) {
        closeQuietly(p.out);
        if (p.uri != null) getContentResolver().delete(p.uri, null, null);
        if (p.file != null) //noinspection ResultOfMethodCallIgnored
            p.file.delete();
    }

    private static void closeQuietly(OutputStream out) {
        try {
            if (out != null) out.close();
        } catch (IOException ignored) {
            // kapanmış
        }
    }

    private void toast(String text) {
        ui.post(() -> Toast.makeText(this, text, Toast.LENGTH_LONG).show());
    }

    /** Sayfanın verdiği http(s) adresinden (ör. sunucudaki kayıt) dosyayı İndirilenler'e indirir. */
    private void download(String url, String userAgent, String disposition, String mime) {
        if (url.startsWith("blob:")) {
            // Sayfanın belleğindeki dosya: sayfa kendisi parça parça gönderir.
            web.evaluateJavascript("window.__indiriciSaveBlobUrl&&window.__indiriciSaveBlobUrl(" + JSONObject.quote(url) + ")", null);
            return;
        }
        if (!url.startsWith("http")) return;
        String name = URLUtil.guessFileName(url, disposition, mime);
        toast("İndiriliyor: " + name);
        new Thread(() -> {
            Pending p = null;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setRequestProperty("User-Agent", userAgent);
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) c.setRequestProperty("Cookie", cookie);
                c.setConnectTimeout(20000);
                c.setReadTimeout(120000);
                if (c.getResponseCode() >= 400) throw new IOException("HTTP " + c.getResponseCode());
                String realName = URLUtil.guessFileName(url, c.getHeaderField("Content-Disposition"), c.getContentType());
                p = open(realName, c.getContentType());
                try (InputStream in = c.getInputStream()) {
                    byte[] buf = new byte[256 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) p.out.write(buf, 0, n);
                }
                close(p);
                toast("İndirilenler'e kaydedildi: " + p.name);
            } catch (Exception e) {
                if (p != null) discard(p);
                toast("İndirilemedi: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        }).start();
    }

    /** Sayfanın çağırdığı köprü (window.IndiriciAndroid). Yöntemler arka planda çalışır. */
    private class Bridge {
        @JavascriptInterface
        public String version() {
            return versionName();
        }

        /** Dosya kaydı başlar: kimlik döner; parçalar append ile gelir, finish ile kapanır. */
        @JavascriptInterface
        public String begin(String name, String mime) {
            try {
                Pending p = open(name, mime);
                String id = UUID.randomUUID().toString();
                synchronized (saving) {
                    saving.put(id, p);
                }
                return id;
            } catch (IOException e) {
                toast("Kaydedilemedi: " + e.getMessage());
                return "";
            }
        }

        @JavascriptInterface
        public boolean append(String id, String base64) {
            Pending p;
            synchronized (saving) {
                p = saving.get(id);
            }
            if (p == null) return false;
            try {
                p.out.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (IOException | IllegalArgumentException e) {
                return false;
            }
        }

        @JavascriptInterface
        public String finish(String id) {
            Pending p;
            synchronized (saving) {
                p = saving.remove(id);
            }
            if (p == null) return "";
            try {
                close(p);
                toast("İndirilenler'e kaydedildi: " + p.name);
                return p.name;
            } catch (IOException e) {
                discard(p);
                toast("Kaydedilemedi: " + e.getMessage());
                return "";
            }
        }

        @JavascriptInterface
        public void abort(String id) {
            Pending p;
            synchronized (saving) {
                p = saving.remove(id);
            }
            if (p != null) discard(p);
        }

        /** Uygulamadan çık (geri tuşu en başta): arka plana alınır, durum korunur. */
        @JavascriptInterface
        public void exit() {
            ui.post(() -> moveTaskToBack(true));
        }

        @JavascriptInterface
        public void retry() {
            ui.post(() -> web.loadUrl(server()));
        }

        @JavascriptInterface
        public void setServer(String url) {
            String u = url == null ? "" : url.trim();
            if (!u.matches("^https?://.+")) {
                toast("Adres http:// ya da https:// ile başlamalı");
                return;
            }
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("server", u).apply();
            ui.post(() -> web.loadUrl(server()));
        }

        @JavascriptInterface
        public String server() {
            return MainActivity.this.server();
        }

        /** Klavyeyi aç: sayfa bir kutucuğa odaklandıktan sonra (dokunuştan ayrı) çağrılır. */
        @JavascriptInterface
        public void showKeyboard() {
            ui.post(() -> {
                web.requestFocus();
                android.view.inputmethod.InputMethodManager imm = getSystemService(android.view.inputmethod.InputMethodManager.class);
                if (imm != null) imm.showSoftInput(web, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
            });
        }

        /** Telefonumda gir: giriş sayfası telefonun kendi tarayıcı motorunda açılır. */
        @JavascriptInterface
        public void loginOnPhone(String url, String domain, String name, String authJson) {
            ui.post(() -> startActivityForResult(new Intent(MainActivity.this, LoginActivity.class)
                    .putExtra(LoginActivity.EXTRA_URL, url)
                    .putExtra(LoginActivity.EXTRA_DOMAIN, domain)
                    .putExtra(LoginActivity.EXTRA_NAME, name)
                    .putExtra(LoginActivity.EXTRA_AUTH, authJson), LOGIN_REQUEST));
        }

        /** Takip bildirimlerini aç/kapat (sunucu adresi ve anahtarı uygulamadan gelir). */
        @JavascriptInterface
        public boolean notifications(boolean on, String serverUrl, String token) {
            if (on && Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ui.post(() -> requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 3));
            }
            NotifyService.setEnabled(MainActivity.this, on, serverUrl, token);
            return on;
        }

        @JavascriptInterface
        public boolean notificationsEnabled() {
            return NotifyService.isEnabled(MainActivity.this);
        }

        /** Uygulamanın kendi bildirimi (ör. indirme bitti). */
        @JavascriptInterface
        public void notify(String title, String body, String tag, String open) {
            NotifyService.show(MainActivity.this, title, body, tag, open);
        }
    }
}
