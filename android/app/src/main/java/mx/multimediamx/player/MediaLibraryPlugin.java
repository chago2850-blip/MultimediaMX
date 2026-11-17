/*
 * MultimediaMX — biblioteca de medios y servidor local para Android
 * Copyright (C) 2026 Santiago Miguel <chago2850@gmail.com>
 *
 * Este programa es software libre: puede redistribuirlo y/o modificarlo bajo los
 * términos de la Licencia Pública General GNU, versión 3 o (a su elección)
 * cualquier versión posterior. Se distribuye SIN NINGUNA GARANTÍA.
 */
package mx.multimediamx.player;

import android.Manifest;
import android.app.UiModeManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Environment;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import androidx.core.content.ContextCompat;
import android.content.res.Configuration;
import android.view.WindowManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "MediaLibrary",
    permissions = {
        @Permission(alias = "audio", strings = { "android.permission.READ_MEDIA_AUDIO" }),
        @Permission(alias = "video", strings = { "android.permission.READ_MEDIA_VIDEO" }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class MediaLibraryPlugin extends Plugin {

    private ServerSocket server;
    private String token;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    // ------------------------------------------------------------------ permisos
    private String[] aliases() {
        return Build.VERSION.SDK_INT >= 33 ? new String[] { "audio", "video" } : new String[] { "storage" };
    }

    private JSObject permissionStatus() {
        JSObject r = new JSObject();
        if (Build.VERSION.SDK_INT >= 33) {
            r.put("audio", getPermissionState("audio").toString());
            r.put("video", getPermissionState("video").toString());
        } else {
            String s = getPermissionState("storage").toString();
            r.put("audio", s);
            r.put("video", s);
        }
        return r;
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        boolean all = true;
        for (String a : aliases()) if (getPermissionState(a) != PermissionState.GRANTED) all = false;
        if (all) { call.resolve(permissionStatus()); return; }
        requestPermissionForAliases(aliases(), call, "accessCallback");
    }

    @PermissionCallback
    private void accessCallback(PluginCall call) {
        call.resolve(permissionStatus());
    }

    // ------------------------------------------------------------------ biblioteca
    @PluginMethod
    public void scan(PluginCall call) {
        pool.execute(() -> {
            JSArray items = new JSArray();
            try {
                query(items, MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, false);
                query(items, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true);
                JSObject ret = new JSObject();
                ret.put("items", items);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("No se pudo leer la biblioteca: " + e.getMessage());
            }
        });
    }

    @SuppressWarnings("deprecation")
    private void query(JSArray out, Uri uri, boolean video) {
        String[] projection = video
            ? new String[] { MediaStore.MediaColumns.DATA, MediaStore.MediaColumns.TITLE, MediaStore.Video.VideoColumns.DURATION, MediaStore.MediaColumns.MIME_TYPE }
            : new String[] { MediaStore.MediaColumns.DATA, MediaStore.MediaColumns.TITLE, MediaStore.Audio.AudioColumns.ARTIST, MediaStore.Audio.AudioColumns.ALBUM, MediaStore.Audio.AudioColumns.DURATION, MediaStore.MediaColumns.MIME_TYPE };
        String selection = video ? null : MediaStore.Audio.AudioColumns.IS_MUSIC + " != 0";
        try (Cursor c = getContext().getContentResolver().query(uri, projection, selection, null, MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
            if (c == null) return;
            while (c.moveToNext()) {
                String path = c.getString(0);
                if (path == null || !new File(path).exists()) continue;
                JSObject o = new JSObject();
                o.put("path", path);
                o.put("title", c.getString(1));
                if (video) {
                    o.put("duration", c.getLong(2));
                    o.put("mime", c.getString(3));
                } else {
                    o.put("artist", c.getString(2));
                    o.put("album", c.getString(3));
                    o.put("duration", c.getLong(4));
                    o.put("mime", c.getString(5));
                }
                o.put("isVideo", video);
                out.put(o);
            }
        }
    }

    // ------------------------------------------------------------------ unidades (memoria interna, microSD, USB)
    private static final String[] AUDIO_EXT = { "mp3", "flac", "ogg", "oga", "opus", "m4a", "m4b", "aac", "wav", "wma", "ape", "aif", "aiff", "alac", "mka", "ac3", "dts", "wv", "amr", "mp2", "mid", "midi", "weba" };
    private static final String[] VIDEO_EXT = { "mp4", "m4v", "mkv", "webm", "avi", "mov", "wmv", "asf", "flv", "mpg", "mpeg", "ts", "m2ts", "mts", "vob", "3gp", "ogv", "rmvb", "divx" };
    private BroadcastReceiver mountReceiver;

    @Override
    public void load() {
        mountReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                JSObject o = new JSObject();
                o.put("action", intent.getAction());
                Uri d = intent.getData();
                if (d != null && d.getPath() != null) o.put("path", d.getPath());
                notifyListeners("volumesChanged", o);
            }
        };
        IntentFilter f = new IntentFilter();
        f.addAction(Intent.ACTION_MEDIA_MOUNTED);
        f.addAction(Intent.ACTION_MEDIA_UNMOUNTED);
        f.addAction(Intent.ACTION_MEDIA_REMOVED);
        f.addDataScheme("file");
        try { ContextCompat.registerReceiver(getContext(), mountReceiver, f, ContextCompat.RECEIVER_EXPORTED); } catch (Exception ignored) { }
    }

    private static String volumePath(Context ctx, StorageVolume v) {
        if (Build.VERSION.SDK_INT >= 30) {
            File d = v.getDirectory();
            return d != null ? d.getAbsolutePath() : null;
        }
        try {
            Object p = StorageVolume.class.getMethod("getPath").invoke(v);
            return p != null ? p.toString() : null;
        } catch (Exception e) {
            return null;
        }
    }

    @PluginMethod
    public void volumes(PluginCall call) {
        Context ctx = getContext();
        JSArray arr = new JSArray();
        java.util.HashSet<String> seen = new java.util.HashSet<>();
        try {
            StorageManager sm = (StorageManager) ctx.getSystemService(Context.STORAGE_SERVICE);
            if (sm != null) {
                for (StorageVolume v : sm.getStorageVolumes()) {
                    if (!Environment.MEDIA_MOUNTED.equals(v.getState()) && !Environment.MEDIA_MOUNTED_READ_ONLY.equals(v.getState())) continue;
                    String p = volumePath(ctx, v);
                    if (p == null || !seen.add(p)) continue;
                    JSObject o = new JSObject();
                    o.put("path", p);
                    o.put("label", v.getDescription(ctx));
                    o.put("removable", v.isRemovable());
                    o.put("primary", v.isPrimary());
                    arr.put(o);
                }
            }
        } catch (Exception ignored) { }
        // Respaldo: raíces deducidas de las carpetas privadas de la app en cada volumen
        File[] dirs = ctx.getExternalFilesDirs(null);
        if (dirs != null) {
            for (File d : dirs) {
                if (d == null) continue;
                String p = d.getAbsolutePath();
                int i = p.indexOf("/Android/data/");
                if (i <= 0) continue;
                p = p.substring(0, i);
                if (!seen.add(p)) continue;
                JSObject o = new JSObject();
                o.put("path", p);
                o.put("label", p.equals(Environment.getExternalStorageDirectory().getAbsolutePath()) ? "Almacenamiento interno" : new File(p).getName());
                o.put("removable", !p.equals(Environment.getExternalStorageDirectory().getAbsolutePath()));
                o.put("primary", p.equals(Environment.getExternalStorageDirectory().getAbsolutePath()));
                arr.put(o);
            }
        }
        JSObject ret = new JSObject();
        ret.put("volumes", arr);
        call.resolve(ret);
    }

    private static String extension(String name) {
        int i = name.lastIndexOf('.');
        return i < 0 ? "" : name.substring(i + 1).toLowerCase(Locale.ROOT);
    }

    private static boolean in(String[] list, String e) {
        for (String x : list) if (x.equals(e)) return true;
        return false;
    }

    private void walk(File dir, int depth, JSArray out, java.util.HashSet<String> seen, int[] count) {
        if (depth > 20 || count[0] > 50000) return;
        String key;
        try { key = dir.getCanonicalPath(); } catch (IOException e) { key = dir.getAbsolutePath(); }
        if (!seen.add(key)) return;
        File[] list = dir.listFiles();
        if (list == null) return;
        for (File f : list) {
            String name = f.getName();
            if (name.startsWith(".")) continue;
            if (f.isDirectory()) {
                if (depth == 0 && (name.equals("Android") || name.equals("LOST.DIR"))) continue;
                walk(f, depth + 1, out, seen, count);
            } else {
                String e = extension(name);
                boolean video = in(VIDEO_EXT, e);
                boolean audio = !video && in(AUDIO_EXT, e);
                if (!video && !audio) continue;
                if (audio && f.length() < 48 * 1024) continue; // sonidos del sistema
                JSObject o = new JSObject();
                o.put("path", f.getAbsolutePath());
                o.put("isVideo", video);
                out.put(o);
                count[0]++;
                if (count[0] % 200 == 0) {
                    JSObject p = new JSObject();
                    p.put("found", count[0]);
                    notifyListeners("scanProgress", p);
                }
            }
        }
    }

    @PluginMethod
    public void scanFolders(PluginCall call) {
        final JSArray paths = call.getArray("paths", new JSArray());
        pool.execute(() -> {
            JSArray items = new JSArray();
            java.util.HashSet<String> seen = new java.util.HashSet<>();
            int[] count = { 0 };
            try {
                for (int i = 0; i < paths.length(); i++) {
                    File root = new File(paths.getString(i));
                    if (root.isDirectory()) walk(root, 0, items, seen, count);
                }
            } catch (Exception ignored) { }
            JSObject ret = new JSObject();
            ret.put("items", items);
            call.resolve(ret);
        });
    }

    // ------------------------------------------------------------------ dispositivo
    @PluginMethod
    public void deviceInfo(PluginCall call) {
        Context ctx = getContext();
        boolean tv = false;
        UiModeManager ui = (UiModeManager) ctx.getSystemService(Context.UI_MODE_SERVICE);
        if (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) tv = true;
        PackageManager pm = ctx.getPackageManager();
        if (pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) || pm.hasSystemFeature("android.software.leanback_only")) tv = true;
        boolean tvBuild = ctx.getPackageName().endsWith(".tv");
        JSObject r = new JSObject();
        r.put("tv", tv || tvBuild);
        r.put("tvBuild", tvBuild);
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        call.resolve(r);
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    // ------------------------------------------------------------------ red: redirecciones, listas en línea y proxy
    private static final String UA = "VLC/3.0.21 LibVLC/3.0.21";

    /** Abre una conexión siguiendo redirecciones, incluso de http a https (bit.ly, etc.). */
    private static HttpURLConnection open(String url, String range) throws IOException {
        String current = url;
        for (int hop = 0; hop < 8; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(current).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept", "*/*");
            if (range != null) c.setRequestProperty("Range", range);
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                current = new URL(new URL(current), c.getHeaderField("Location")).toString();
                c.disconnect();
                continue;
            }
            return c;
        }
        throw new IOException("Demasiadas redirecciones");
    }

    private static byte[] readAll(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
            bo.write(buf, 0, n);
            if (bo.size() > limit) break;
        }
        return bo.toByteArray();
    }

    private static String decode(byte[] b) {
        String t = new String(b, StandardCharsets.UTF_8);
        if (t.indexOf('�') >= 0) t = new String(b, StandardCharsets.ISO_8859_1);
        return t;
    }

    /** Revisa qué hay en una URL: lista M3U (devuelve el texto), HLS o transmisión binaria. */
    @PluginMethod
    public void peek(PluginCall call) {
        final String url = call.getString("url");
        if (url == null) { call.reject("url"); return; }
        pool.execute(() -> {
            JSObject r = new JSObject();
            HttpURLConnection c = null;
            try {
                c = open(url, null);
                int code = c.getResponseCode();
                String ct = c.getContentType() == null ? "" : c.getContentType();
                r.put("ok", code >= 200 && code < 300);
                r.put("status", code);
                r.put("contentType", ct);
                r.put("finalUrl", c.getURL().toString());
                r.put("binary", false);
                if (code < 200 || code >= 300) { call.resolve(r); return; }
                String low = ct.toLowerCase(Locale.ROOT);
                if ((low.startsWith("audio/") || low.startsWith("video/")) && !low.contains("mpegurl")) {
                    r.put("binary", true); call.resolve(r); return;
                }
                InputStream in = c.getInputStream();
                byte[] head = new byte[4096];
                int got = 0, n;
                while (got < head.length && (n = in.read(head, got, head.length - got)) > 0) got += n;
                boolean bin = got > 0 && head[0] == 0x47;
                for (int i = 0; i < got && !bin; i++) if (head[i] == 0) bin = true;
                if (bin) { r.put("binary", true); call.resolve(r); return; }
                byte[] rest = readAll(in, 40 * 1024 * 1024);
                byte[] all = new byte[got + rest.length];
                System.arraycopy(head, 0, all, 0, got);
                System.arraycopy(rest, 0, all, got, rest.length);
                r.put("text", decode(all));
                call.resolve(r);
            } catch (Exception e) {
                r.put("ok", false);
                r.put("status", 0);
                r.put("error", String.valueOf(e.getMessage()));
                call.resolve(r);
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    private String proxied(String absolute) {
        try {
            return "http://127.0.0.1:" + server.getLocalPort() + "/p?k=" + token + "&u=" + URLEncoder.encode(absolute, "UTF-8");
        } catch (Exception e) {
            return absolute;
        }
    }

    private static final Pattern URI_ATTR = Pattern.compile("URI=\"([^\"]+)\"");

    /** Reescribe una lista HLS para que segmentos y claves también pasen por el proxy. */
    private String rewriteHls(String text, String base) {
        StringBuilder sb = new StringBuilder();
        for (String line : text.split("\r?\n")) {
            String tl = line.trim();
            if (tl.isEmpty()) { sb.append('\n'); continue; }
            try {
                if (tl.startsWith("#")) {
                    Matcher m = URI_ATTR.matcher(line);
                    StringBuffer out = new StringBuffer();
                    while (m.find()) m.appendReplacement(out, Matcher.quoteReplacement("URI=\"" + proxied(new URL(new URL(base), m.group(1)).toString()) + "\""));
                    m.appendTail(out);
                    sb.append(out).append('\n');
                } else {
                    sb.append(proxied(new URL(new URL(base), tl).toString())).append('\n');
                }
            } catch (Exception e) {
                sb.append(line).append('\n');
            }
        }
        return sb.toString();
    }

    private void proxy(String url, String method, String range, OutputStream out) throws IOException {
        HttpURLConnection c = null;
        try {
            c = open(url, range);
            int code = c.getResponseCode();
            String ct = c.getContentType();
            String finalUrl = c.getURL().toString();
            String low = ct == null ? "" : ct.toLowerCase(Locale.ROOT);
            boolean hlsList = code == 200 && (low.contains("mpegurl") || finalUrl.toLowerCase(Locale.ROOT).split("\\?")[0].endsWith(".m3u8"));
            if (hlsList) {
                String text = decode(readAll(c.getInputStream(), 8 * 1024 * 1024));
                if (text.contains("#EXT-X-") || text.contains("#EXTINF")) {
                    byte[] body = rewriteHls(text, finalUrl).getBytes(StandardCharsets.UTF_8);
                    head(out, 200, "OK", "application/vnd.apple.mpegurl", body.length, null);
                    if (!method.equals("HEAD")) out.write(body);
                    out.flush();
                    return;
                }
                byte[] body = text.getBytes(StandardCharsets.UTF_8);
                head(out, 200, "OK", ct, body.length, null);
                if (!method.equals("HEAD")) out.write(body);
                return;
            }
            long len = c.getContentLengthLong();
            head(out, code, code == 206 ? "Partial Content" : code < 400 ? "OK" : "Error", ct, len, c.getHeaderField("Content-Range"));
            if (method.equals("HEAD") || code >= 400) return;
            InputStream in = c.getInputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ------------------------------------------------------------------ servidor local con soporte de Range
    @PluginMethod
    public void server(PluginCall call) {
        try {
            ensureServer();
            JSObject r = new JSObject();
            r.put("port", server.getLocalPort());
            r.put("token", token);
            call.resolve(r);
        } catch (IOException e) {
            call.reject("No se pudo iniciar el servidor local: " + e.getMessage());
        }
    }

    private synchronized void ensureServer() throws IOException {
        if (server != null && !server.isClosed()) return;
        byte[] b = new byte[16];
        new SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        token = sb.toString();
        server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        Thread t = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    Socket s = server.accept();
                    pool.execute(() -> handle(s));
                } catch (IOException ignored) {
                    // servidor cerrado
                }
            }
        }, "mmx-media-server");
        t.setDaemon(true);
        t.start();
    }

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("mp3", "audio/mpeg"); MIME.put("flac", "audio/flac"); MIME.put("ogg", "audio/ogg"); MIME.put("oga", "audio/ogg");
        MIME.put("opus", "audio/ogg"); MIME.put("m4a", "audio/mp4"); MIME.put("aac", "audio/aac"); MIME.put("wav", "audio/wav");
        MIME.put("amr", "audio/amr"); MIME.put("mid", "audio/midi"); MIME.put("mp4", "video/mp4"); MIME.put("m4v", "video/mp4");
        MIME.put("mkv", "video/x-matroska"); MIME.put("webm", "video/webm"); MIME.put("3gp", "video/3gpp"); MIME.put("mov", "video/mp4");
        MIME.put("ts", "video/mp2t"); MIME.put("lrc", "text/plain; charset=utf-8"); MIME.put("srt", "text/plain; charset=utf-8");
        MIME.put("vtt", "text/vtt; charset=utf-8"); MIME.put("m3u", "audio/x-mpegurl"); MIME.put("m3u8", "audio/x-mpegurl");
    }

    private void handle(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(20000);
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.ISO_8859_1));
            String line = in.readLine();
            if (line == null) return;
            String[] parts = line.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String target = parts[1];
            String range = null;
            String h;
            while ((h = in.readLine()) != null && !h.isEmpty()) {
                int i = h.indexOf(':');
                if (i > 0 && h.substring(0, i).trim().equalsIgnoreCase("range")) range = h.substring(i + 1).trim();
            }
            OutputStream out = s.getOutputStream();
            if (method.equals("OPTIONS")) { head(out, 204, "No Content", null, -1, null); return; }

            Map<String, String> q = new HashMap<>();
            int qi = target.indexOf('?');
            if (qi >= 0) {
                for (String kv : target.substring(qi + 1).split("&")) {
                    int e = kv.indexOf('=');
                    if (e > 0) q.put(kv.substring(0, e), URLDecoder.decode(kv.substring(e + 1), "UTF-8"));
                }
            }
            if (!token.equals(q.get("k"))) { head(out, 403, "Forbidden", null, 0, null); return; }
            if (target.startsWith("/p?") && q.get("u") != null) {
                try { proxy(q.get("u"), method, range, out); }
                catch (IOException e) { try { head(out, 502, "Bad Gateway", null, 0, null); } catch (IOException ignored) { } }
                return;
            }
            if (q.get("p") == null) { head(out, 400, "Bad Request", null, 0, null); return; }
            File f = new File(q.get("p"));
            if (!f.isFile() || !f.canRead()) { head(out, 404, "Not Found", null, 0, null); return; }

            String name = f.getName();
            String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
            String type = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
            long size = f.length();
            long start = 0, end = size - 1;
            boolean partial = false;
            if (range != null && range.startsWith("bytes=")) {
                String[] r = range.substring(6).split(",")[0].split("-", -1);
                try {
                    if (r[0].isEmpty()) { start = Math.max(0, size - Long.parseLong(r[1])); }
                    else { start = Long.parseLong(r[0]); if (r.length > 1 && !r[1].isEmpty()) end = Math.min(Long.parseLong(r[1]), size - 1); }
                    partial = true;
                } catch (NumberFormatException ignored) { start = 0; end = size - 1; }
                if (start >= size) { head(out, 416, "Range Not Satisfiable", type, 0, "bytes */" + size); return; }
            }
            long len = end - start + 1;
            head(out, partial ? 206 : 200, partial ? "Partial Content" : "OK", type, len, partial ? "bytes " + start + "-" + end + "/" + size : null);
            if (method.equals("HEAD")) return;
            try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
                raf.seek(start);
                byte[] buf = new byte[64 * 1024];
                long left = len;
                while (left > 0) {
                    int n = raf.read(buf, 0, (int) Math.min(buf.length, left));
                    if (n < 0) break;
                    out.write(buf, 0, n);
                    left -= n;
                }
                out.flush();
            }
        } catch (IOException ignored) {
            // el reproductor cerró la conexión (búsqueda o cambio de pista)
        }
    }

    private static void head(OutputStream out, int code, String reason, String type, long len, String contentRange) throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n");
        sb.append("Access-Control-Allow-Origin: *\r\n");
        sb.append("Access-Control-Allow-Headers: Range\r\n");
        sb.append("Accept-Ranges: bytes\r\n");
        sb.append("Cache-Control: no-store\r\n");
        sb.append("Connection: close\r\n");
        if (type != null) sb.append("Content-Type: ").append(type).append("\r\n");
        if (len >= 0) sb.append("Content-Length: ").append(len).append("\r\n");
        if (contentRange != null) sb.append("Content-Range: ").append(contentRange).append("\r\n");
        sb.append("\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1));
    }

    @Override
    protected void handleOnDestroy() {
        try { if (server != null) server.close(); } catch (IOException ignored) { }
        try { if (mountReceiver != null) getContext().unregisterReceiver(mountReceiver); } catch (Exception ignored) { }
        pool.shutdownNow();
        super.handleOnDestroy();
    }
}
