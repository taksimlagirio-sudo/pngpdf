# Medya Algılayıcı — tarayıcı uzantısı (geliştirici aracı)

Ana `pngpdf` sitesinin çözemediği iki durumu hedefler:

1. **Canlı yayının "şu anını" yakalamak.** Site tarafı bir URL'i tek seferlik çekmek yerine,
   bu uzantı oynadığınız sekmenin **gerçek ağ isteklerini** izler; canlı bir HLS playlist'i
   bulunca "Şu andan itibaren kaydet" ile o andan başlayıp yeni parçaları topluyor.
2. **Medya adresi sayfa kaynağında hiç yazmayan siteler.** JavaScript çalışma anında bir video
   elemanı kuruyorsa statik HTML taraması bunu göremez; ama tarayıcı o adrese gerçekten istek
   attığı an bu uzantı onu yakalar — tıpkı DevTools'un Ağ sekmesinin gösterdiği gibi.

## Kapsamı ve sınırı

- Yalnızca **açık olduğunuz tarayıcı sekmesinin** ağ isteklerini gözlemler (`webRequest` API).
  Başka uygulamaları (Instagram, Netflix, WhatsApp vb. native uygulamalar), ekranı veya sayfanın
  DOM/içeriğini **okumaz** — sadece hangi adreslere istek atıldığını ve yanıt başlıklarını görür.
  Bu, kullanıcının zaten DevTools → Ağ sekmesinde manuel görebileceği bilginin otomasyonu.
- Gerçek DRM (Widevine/FairPlay/SAMPLE-AES) korumalı HLS akışları ana siteyle aynı mantıkla
  **reddedilir** — anahtar açık verilmeyen şemalarda indirme sunulmaz.
- Bu bir mağaza ürünü değil; yalnızca "paketlenmemiş uzantı" (Geliştirici Modu) olarak kendi
  tarayıcınıza yüklediğiniz bir test/geliştirme aracıdır.

## Kurulum

1. Chrome/Edge'de `chrome://extensions` adresine gidin.
2. Sağ üstten **Geliştirici modu**'nu açın.
3. **Paketlenmemiş öğe yükle**'ye basıp bu `extension/` klasörünü seçin.
4. Araç çubuğundaki simgeye tıklayıp gezindiğiniz sekmede bulunan medyayı görün.

## Kullanım

- Simgeye tıklayınca küçük bir pencere açılır; bulunan video/ses/resim/HLS adresleri listelenir.
- Bir öğeye dokunursa önizleme + indirme seçenekleri gelir:
  - **Resim:** orijinali indir, veya format (JPG/PNG/WEBP) + kalite seçip dönüştürerek indir.
  - **Video/ses (doğrudan dosya):** tek dokunuşla indir (tarayıcının kendi indirme yöneticisiyle).
  - **HLS:** master playlist ise kalite seçtirir; VOD ise doğrudan indirir; **canlıysa** "Şu andan
    itibaren kaydet" ile kayda başlar, "Kaydı bitir ve indir" ile o ana kadar toplananı kaydeder.
- **Önemli:** küçük açılır pencere odağı kaybedince kapanır ve devam eden indirmeyi keser.
  HLS/canlı yakalama gibi uzun işlemlerden önce üstteki **🗗 Pencerede aç** düğmesine basın —
  bu, kapanana kadar açık kalan ayrı bir pencere oluşturur.
- **🗑️** o sekme için bulunanları temizler, **⟳** listeyi yeniler.

## Neden CORS'a takılmıyor?

`host_permissions` ile verilen izin sayesinde uzantının kendi `fetch()` çağrıları (popup/arka
plan bağlamından) hedef sitenin CORS politikasına tabi değildir — bu yüzden ana siteye eklenen
`/api/proxy` Netlify fonksiyonuna burada ihtiyaç yok.

## Dosyalar

```
manifest.json     # MV3 tanımı: webRequest + webNavigation + downloads izinleri
background.js     # Servis çalışanı: sekme başına görülen medya adreslerini tutar
popup.html/.css/.js  # Liste, önizleme, format/kalite seçimi, indirme, canlı yakalama
lib/playlist.js   # HLS m3u8 ayrıştırıcı (ana sitedeki hls.js ile aynı mantık)
lib/util.js       # DOM-bağımsız küçük yardımcılar (ana sitedeki util.js'in uzantı-içi kopyası)
icons/            # Araç çubuğu ikonları
```
