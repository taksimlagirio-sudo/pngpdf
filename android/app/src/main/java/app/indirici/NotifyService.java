package app.indirici;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Takip bildirimleri: sunucunun bildirim akışını (/push/feed) dinler, gelenleri Android bildirimi
 * olarak gösterir. Sunucu aynı telefonda; uzun bekleyen istekle dinlendiği için bildirim anında gelir.
 * Android arka planda sürekli çalışan servisten kalıcı bir bildirim ister: sessiz, en düşük önemde.
 */
public class NotifyService extends Service {
    static final String PREFS = "indirici";
    static final String CH_ALERTS = "alerts";
    static final String CH_SERVICE = "service";
    private static final int ONGOING_ID = 1;

    private volatile boolean running = false;
    private Thread worker;

    /** Uygulamadan açılır/kapanır; ayar saklanır, uygulama her açılışta gerekirse yeniden başlatır. */
    static void setEnabled(Context ctx, boolean on, String server, String token) {
        SharedPreferences.Editor e = ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("notify", on);
        if (server != null && !server.isEmpty()) e.putString("notifyServer", server);
        if (token != null) e.putString("notifyToken", token);
        e.apply();
        Intent i = new Intent(ctx, NotifyService.class);
        if (on) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else ctx.startService(i);
        } else {
            ctx.stopService(i);
        }
    }

    static boolean isEnabled(Context ctx) {
        return ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("notify", false);
    }

    static void channels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        NotificationChannel alerts = new NotificationChannel(CH_ALERTS, "Takip ve indirmeler", NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("Yayın başladı, kayıt bitti, yeni video indi…");
        nm.createNotificationChannel(alerts);
        NotificationChannel svc = new NotificationChannel(CH_SERVICE, "Bildirim dinleyici", NotificationManager.IMPORTANCE_MIN);
        svc.setDescription("Takip bildirimlerinin gelmesi için arka planda bekler. Bu kanalı gizleyebilirsin.");
        svc.setShowBadge(false);
        nm.createNotificationChannel(svc);
    }

    /** Bildirime dokununca uygulama ilgili ekranla açılır (open: "#follow", "?url=…#detect" gibi). */
    static PendingIntent openIntent(Context ctx, String open, int code) {
        Intent i = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (open != null) i.putExtra("open", open);
        return PendingIntent.getActivity(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void show(Context ctx, String title, String body, String tag, String open) {
        channels(ctx);
        int id = (tag == null ? title + body : tag).hashCode();
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(ctx, CH_ALERTS) : new Notification.Builder(ctx);
        b.setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(openIntent(ctx, open, id));
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        try {
            ctx.getSystemService(NotificationManager.class).notify(id, b.build());
        } catch (SecurityException ignored) {
            // bildirim izni verilmemiş
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        channels(this);
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CH_SERVICE) : new Notification.Builder(this);
        Notification ongoing = b.setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle("Takip bildirimleri açık")
                .setContentText("Yayın başlayınca, kayıt bitince haber verilir")
                .setOngoing(true)
                .setContentIntent(openIntent(this, "#follow", 0))
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(ONGOING_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(ONGOING_ID, ongoing);
        if (!running) {
            running = true;
            worker = new Thread(this::listen, "indirici-bildirim");
            worker.start();
        }
        return START_STICKY;
    }

    private void listen() {
        long after = -1;
        int failures = 0;
        while (running) {
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            String server = p.getString("notifyServer", p.getString("server", "http://127.0.0.1:8787/"));
            if (!server.endsWith("/")) server += "/";
            String token = p.getString("notifyToken", "");
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(server + "push/feed?wait=25000&after=" + after).openConnection();
                if (!token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
                c.setConnectTimeout(10000);
                c.setReadTimeout(40000);
                if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                JSONObject r = new JSONObject(read(c.getInputStream()));
                JSONArray items = r.optJSONArray("items");
                for (int i = 0; items != null && i < items.length(); i++) {
                    JSONObject m = items.getJSONObject(i);
                    show(this, m.optString("title", "İndirici"), m.optString("body", ""), m.optString("tag", null), m.optString("url", "#follow"));
                }
                after = r.optLong("last", after);
                failures = 0;
            } catch (Exception e) {
                // Sunucu kapalı ya da yeniden başlıyor: giderek seyrekleşen aralıkla yeniden denenir.
                failures++;
                try {
                    Thread.sleep(Math.min(60000, 3000L * failures));
                } catch (InterruptedException ie) {
                    return;
                }
            } finally {
                if (c != null) c.disconnect();
            }
        }
    }

    private static String read(InputStream in) throws java.io.IOException {
        try (InputStream s = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
