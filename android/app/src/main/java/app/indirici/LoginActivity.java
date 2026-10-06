package app.indirici;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/**
 * "Telefonumda gir": sitenin giriş sayfası telefonun kendi tarayıcı motorunda açılır (gerçek cihaz,
 * gerçek dokunuş; sunucudaki tarayıcı gibi robot sayılmaz). Giriş bitince sitenin çerezleri okunur ve
 * uygulamaya verilir; uygulama onları kendi sunucuna aktarır.
 */
public class LoginActivity extends Activity {
    static final String EXTRA_URL = "url";
    static final String EXTRA_DOMAIN = "domain";
    static final String EXTRA_NAME = "name";
    static final String EXTRA_AUTH = "auth";
    static final String RESULT_COOKIES = "cookies";

    private WebView web;
    private FrameLayout stack;
    private String domain;
    private final Set<String> authNames = new HashSet<>();
    private boolean finished = false;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent in = getIntent();
        domain = in.getStringExtra(EXTRA_DOMAIN);
        String name = in.getStringExtra(EXTRA_NAME);
        try {
            JSONArray a = new JSONArray(in.getStringExtra(EXTRA_AUTH) == null ? "[]" : in.getStringExtra(EXTRA_AUTH));
            for (int i = 0; i < a.length(); i++) authNames.add(a.getString(i));
        } catch (JSONException ignored) {
            // bilinmeyen site: "Bitti" ile tamamlanır
        }
        getWindow().setStatusBarColor(Color.parseColor("#121110"));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#121110"));

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(8), dp(6), dp(10), dp(6));
        Button close = new Button(this);
        close.setText("✕");
        close.setTextColor(Color.parseColor("#F2EFE9"));
        close.setBackgroundColor(Color.TRANSPARENT);
        close.setContentDescription("Kapat");
        close.setOnClickListener((v) -> done(false));
        bar.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));

        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(this);
        title.setText((name == null ? domain : name) + " hesabına giriş");
        title.setTextColor(Color.parseColor("#F2EFE9"));
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextSize(15);
        title.setSingleLine(true);
        TextView sub = new TextView(this);
        sub.setText("Telefonunda · bitince sunucuna aktarılır");
        sub.setTextColor(Color.parseColor("#A29D93"));
        sub.setTextSize(12);
        titles.addView(title);
        titles.addView(sub);
        bar.addView(titles, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        Button ok = new Button(this);
        ok.setText("Bitti");
        ok.setAllCaps(false);
        ok.setTextColor(Color.parseColor("#15140F"));
        ok.setTypeface(Typeface.DEFAULT_BOLD);
        ok.setBackgroundColor(Color.parseColor("#D4F04A"));
        ok.setOnClickListener((v) -> done(true));
        bar.addView(ok, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(42)));
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        stack = new FrameLayout(this);
        web = makeWebView();
        stack.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(stack, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);

        web.loadUrl(in.getStringExtra(EXTRA_URL));
    }

    /** Normal bir telefon tarayıcısı gibi davranan sayfa (açılır pencereler, üçüncü taraf çerezleri). */
    private WebView makeWebView() {
        WebView w = new WebView(this);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        // Uygulama içi tarayıcı izi ("; wv", "Version/4.0") atılır: Google bu izi görünce girişi reddediyor.
        s.setUserAgentString(s.getUserAgentString().replace("; wv", "").replaceAll("Version/\\d+\\.\\d+ ", ""));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
        w.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                checkLoggedIn();
            }
        });
        w.setWebChromeClient(new WebChromeClient() {
            // "Google ile giriş" gibi açılır pencereler aynı ekranda, üstte açılır; kapanınca kaldırılır.
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                WebView popup = makeWebView();
                stack.addView(popup, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public void onCloseWindow(WebView window) {
                stack.removeView(window);
                window.destroy();
                checkLoggedIn();
            }
        });
        return w;
    }

    /** Bilinen sitede girişi taşıyan çerez geldiyse giriş kendiliğinden tamamlanır. */
    private void checkLoggedIn() {
        if (finished || authNames.isEmpty()) return;
        for (String c : cookieList()) {
            String n = c.contains("=") ? c.substring(0, c.indexOf('=')).trim() : c.trim();
            if (authNames.contains(n)) {
                Toast.makeText(this, "Giriş algılandı", Toast.LENGTH_SHORT).show();
                ui.postDelayed(() -> done(true), 1200);
                finished = true;
                return;
            }
        }
    }

    /** Sitenin (ve www/m alt alan adlarının) çerezleri: "ad=değer" listesi. */
    private Set<String> cookieList() {
        Set<String> out = new HashSet<>();
        CookieManager cm = CookieManager.getInstance();
        cm.flush();
        for (String host : new String[]{domain, "www." + domain, "m." + domain}) {
            String c = cm.getCookie("https://" + host + "/");
            if (c == null) continue;
            for (String part : c.split(";")) if (part.contains("=")) out.add(part.trim());
        }
        return out;
    }

    private void done(boolean collect) {
        Intent result = new Intent();
        if (collect) {
            JSONArray cookies = new JSONArray();
            long year = System.currentTimeMillis() / 1000 + 365L * 24 * 3600;
            Set<String> seen = new HashSet<>();
            for (String c : cookieList()) {
                int eq = c.indexOf('=');
                String n = c.substring(0, eq).trim();
                if (!seen.add(n)) continue;
                try {
                    cookies.put(new JSONObject()
                            .put("name", n)
                            .put("value", c.substring(eq + 1).trim())
                            .put("domain", "." + domain)
                            .put("path", "/")
                            .put("expires", year)
                            .put("secure", true)
                            .put("sameSite", "lax"));
                } catch (JSONException ignored) {
                    // atla
                }
            }
            result.putExtra(RESULT_COOKIES, cookies.toString());
        }
        setResult(collect ? RESULT_OK : RESULT_CANCELED, result);
        finish();
    }

    @Override
    public void onBackPressed() {
        // Açılır pencere varsa önce o kapanır; sayfada geri gidilebiliyorsa geri gidilir.
        int n = stack.getChildCount();
        if (n > 1) {
            View top = stack.getChildAt(n - 1);
            if (top instanceof WebView && ((WebView) top).canGoBack()) ((WebView) top).goBack();
            else {
                stack.removeView(top);
                if (top instanceof WebView) ((WebView) top).destroy();
            }
            return;
        }
        if (web.canGoBack()) web.goBack();
        else done(false);
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
