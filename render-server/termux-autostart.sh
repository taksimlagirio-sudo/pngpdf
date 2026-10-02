#!/data/data/com.termux/files/usr/bin/sh
# Termux her açıldığında İndirici sunucusunu başlatır ve uygulamayı Chrome'da açar.
#   Kurmak için:    sh termux-autostart.sh
#   Kaldırmak için: sh termux-autostart.sh kaldir
DIR="$(cd "$(dirname "$0")" && pwd)"
RC="$HOME/.bashrc"
BEGIN="# >>> indirici >>>"
END="# <<< indirici <<<"

touch "$RC"
# Önceki kaydı (varsa) temizle; tekrar çalıştırınca çift satır oluşmasın.
TMP="$RC.indirici.tmp"
awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$RC" > "$TMP" && mv "$TMP" "$RC"

if [ "$1" = "kaldir" ]; then
    echo "Otomatik başlatma kaldırıldı."
    exit 0
fi

cat >> "$RC" <<BLOCK
$BEGIN
# Termux açılınca sunucuyu başlat. Durdurmak için Ctrl+C (alttaki CTRL tuşu + c).
# Sunucu başka bir oturumda zaten çalışıyorsa bu satır sadece bunu bildirip çıkar.
sh "$DIR/start-termux.sh"
$END
BLOCK

echo "Tamam. Bundan sonra Termux'u açman yeterli: sunucu başlar ve İndirici Chrome'da açılır."
echo "Kaldırmak istersen: sh $DIR/termux-autostart.sh kaldir"
