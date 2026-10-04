#!/data/data/com.termux/files/usr/bin/sh
# Telefon açılınca İndirici sunucusunu arka planda başlatır (Termux:Boot uygulaması gerekir).
#   Kurmak için:    sh render-server/kur-otomatik.sh
#   Kaldırmak için: sh render-server/kur-otomatik.sh kaldir
#   Başka cihazlardan (bilgisayar, TV) erişim için: HOST=0.0.0.0 sh render-server/kur-otomatik.sh
DIR="$(cd "$(dirname "$0")" && pwd)"
BOOT="$HOME/.termux/boot"
FILE="$BOOT/indirici.sh"

if [ "$1" = "kaldir" ]; then
    rm -f "$FILE"
    echo "Açılışta başlatma kaldırıldı."
    exit 0
fi

mkdir -p "$BOOT"
cat > "$FILE" <<BOOTSCRIPT
#!/data/data/com.termux/files/usr/bin/sh
# İndirici: telefon açılınca sunucuyu başlat (kayıt: ~/indirici.log)
termux-wake-lock 2>/dev/null
cd "$DIR" || exit 1
CHROME_PATH="\$(command -v chromium-browser || command -v chromium)" HOST="${HOST:-127.0.0.1}" nohup node server.mjs >> "\$HOME/indirici.log" 2>&1 &
BOOTSCRIPT
chmod +x "$FILE"

echo "Tamam. Telefon her açıldığında sunucu arka planda başlar (kayıt: ~/indirici.log)."
if [ ! -d /data/data/com.termux.boot ] 2>/dev/null; then
    echo "Play Store ya da F-Droid'den \"Termux:Boot\" uygulamasını kurup bir kez açmayı unutma."
fi
echo "Kaldırmak istersen: sh $DIR/kur-otomatik.sh kaldir"
