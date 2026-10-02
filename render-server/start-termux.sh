#!/data/data/com.termux/files/usr/bin/sh
# Termux'ta render sunucusunu tek komutla başlatır: sh start-termux.sh
cd "$(dirname "$0")" || exit 1

CHROME="${CHROME_PATH:-$(command -v chromium-browser || command -v chromium)}"
if [ -z "$CHROME" ]; then
    echo "Chromium bulunamadı. Önce: pkg install x11-repo && pkg install chromium"
    exit 1
fi

if [ ! -d node_modules/playwright-core ]; then
    echo "Bağımlılıklar kuruluyor..."
    npm install --omit=dev || exit 1
fi

# Telefon ekranı kapanınca Termux'un uyutulmasını engelle (Termux:API gerekmez).
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

# OPEN_APP=1: sunucu açılınca İndirici Chrome'da kendiliğinden açılır (token gerekmez).
CHROME_PATH="$CHROME" OPEN_APP=1 exec node server.mjs
