# QuickFeed

XML besleme biçimlendirici ve okuyucu. Tek satıra sıkıştırılmış ürün beslemelerini
girintili XML'e çevirir, tarayıcıda açar ve etiket bazlı sorgularla filtreler.
Arayüz dili İngilizce.

**Dosya hiçbir sunucuya gönderilmez.** İndirme, ayrıştırma, biçimlendirme, indeksleme ve
sorgulama tamamen tarayıcıda, bir Web Worker içinde yapılır.

## Çalıştırma

```bash
npm install
```

```bash
npm run dev
```

`http://localhost:3000` adresini açın. Üretim için `npm run build && npm start`.

`samples/sample-feed.xml` denemek için hazır 24 ürünlük tek satırlık bir besleme.

## Akış

1. **Kaynak seçin** — *From my computer* ile dosyayı sürükleyin ya da *From a URL* ile
   besleme adresini yazın.
2. **Biçimlendirin** — *Indent* seçeneği (2 spaces / 4 spaces / tab).
3. **İki seçenek** — *Download formatted file* ya da *View in browser*.
4. **Sorgulayın** — `tag name` + `contains / does not contain / matches exactly` + `value`
   → **Apply**. Sonuç yeni bir belge olarak oluşur; *Download result* ile alınabilir.

*+ condition* ile koşul eklenir; koşullar arasındaki **AND / OR** bağlacına tıklayarak
değiştirilir.

## Sorgu davranışı

| Konu | Davranış |
| --- | --- |
| Büyük/küçük harf | `Aa case sensitive` kapalıyken yok sayılır. Türkçe karakterler de eşitlenir: `yesil` → `Yeşil`, `ayakkabi` → `Ayakkabı`. |
| Ön ek | `g:price` ile `price` aynı etiket sayılır. |
| Kapsayıcı etiket | `kategori` gibi alt öğe barındıran etiketler alt metinlerini kapsar; `kategori contains Gömlek`, `<alt>Gömlek</alt>` olan kaydı bulur. |
| Kayıt etiketi | Kayıt etiketinin kendisi (`product`, `item`) tüm kayıt içinde tam metin araması yapar. |
| Yanlış kayıt etiketi | Sorgu barındaki **Record** kutusundan elle seçilir; sonuç ve sayaçlar seçilen etikete göre yeniden hesaplanır. |
| Etiket yoksa | `does not contain` doğru, `contains` ve `matches exactly` yanlış kabul edilir. |

Sonuç dosyası geçerli bir XML'dir: kök etiket, XML bildirimi ve `<channel>` gibi ara
katmanlar korunur, yalnızca eşleşmeyen kayıtlar çıkarılır.

## Kayıt etiketi tespiti

Filtreleme, beslemedeki "bir kayıt"ın hangi etiket olduğunu bilmeyi gerektirir. Bu etiket
**ebeveyni başına kaç kez tekrarlandığına** göre seçilir — ham tekrar sayısına göre değil.

Fark önemli. Bir Ticimax beslemesinde `<TeknikDetay>` 27.217 kez, `<Urun>` ise 1.063 kez
geçiyor; ham sayıya bakan bir yöntem teknik detay satırını ürün zanneder. Oysa `<Urun>`
tek bir `<Urunler>` içinde 1.063 kez tekrarlanırken `<TeknikDetay>` her `<TeknikDetaylar>`
içinde yalnızca ~26 kez tekrarlanıyor. Kayıt, tek bir kapsayıcının altında binlerce kez
tekrarlanan şeydir.

Yine de bu bir tahmin. Sorgu barındaki **Record** açılır kutusu tespit edilen etiketi
gösterir ve aday etiketleri sıralar; yanlışsa oradan değiştirilir. Değiştirince kayıt
sayacı, belge haritası yoğunluğu ve sonraki sorgular seçilen etikete göre çalışır.

## Büyük dosyalar

Bellek taşmasına karşı alınan önlemler:

- Kaynak `ReadableStream` olarak parça parça okunur; tam dosya hiçbir zaman belleğe alınmaz.
- Biçimlendirilmiş çıktı **OPFS**'e (tarayıcının kendi disk alanı) `FileSystemSyncAccessHandle`
  ile yazılır. OPFS desteklenmiyorsa bellek kullanılır ve durum çubuğunda `memory mode` uyarısı çıkar.
- Satır indeksi her 64 satırda bir byte konumu tutar — 5 milyon satırlık indeks ~1 MB.
- Görüntüleyici yalnızca ekrandaki ~35 satırı DOM'a basar ve yalnızca onları worker'dan ister.
- İndirme, OPFS dosyasının `File` referansıdır; bellekte kopya oluşmaz.
- Tek bir kaydın alan sayısı 512, alan uzunluğu 64 KB ile sınırlıdır.

Ölçüm (90 MB / 400.000 kayıt / 4,8 milyon satır, Chromium): biçimlendirme **2,8 sn**,
sorgu **3,4 sn**, JS heap **~17 MB**.

## Kodlama ve sıkıştırma

Kodlama BOM'dan ya da `<?xml ... encoding="...">` bildiriminden okunur; ISO-8859-9 ve
windows-1254 beslemelerde Türkçe karakterler bozulmaz. Çıktı her zaman UTF-8 yazılır ve
bildirimdeki `encoding` değeri buna göre güncellenir. `.gz` dosyalar `DecompressionStream`
ile kendiliğinden açılır.

## Adresten çekme ve proxy

Tarayıcı önce adresi doğrudan okumayı dener. Hedef site CORS başlığı göndermiyorsa
`Fetch through proxy` seçeneği `/api/proxy` üzerinden akıtır. Proxy beslemeyi **ayrıştırmaz,
tamponlamaz ve saklamaz** — yanıt gövdesini olduğu gibi tarayıcıya aktarır. Yerel ağ ve
loopback adresleri DNS çözümlemesi sonrası engellenir.

## Vercel'e dağıtım

Repoyu Vercel'de import etmek yeterli — framework Next.js olarak algılanır, ortam
değişkeni ya da ek ayar gerekmez.

Uygulamanın tamamı tarayıcıda çalıştığından dosya seçme, biçimlendirme, görüntüleme,
sorgulama ve indirme sunucu sınırlarından etkilenmez. Tek istisna `/api/proxy`: bu bir
Vercel Function olarak çalışır ve şunlara tabidir:

- **Süre sınırı.** `maxDuration = 60` ayarlı; Hobby planının tavanı bu. Çok büyük bir
  beslemeyi proxy üzerinden çekmek 60 saniyeyi aşarsa aktarım yarıda kesilir.
- **Bant genişliği.** Proxy üzerinden geçen her bayt Vercel kotanızdan düşer.
- **Yanıt boyutu.** Yanıt tamponlanmadan akıtılır, ki büyük gövdeler için doğru yol budur;
  yine de ilk dağıtımdan sonra gerçekten büyük bir beslemeyle bir kez denemekte fayda var.

Bunların hiçbiri proxy kapalıyken geçerli değil: adres doğrudan tarayıcıdan çekildiğinde
trafik Vercel'e hiç uğramaz. Proxy yalnızca hedef site CORS başlığı göndermediğinde gerekir.

OPFS güvenli bağlam ister; Vercel HTTPS sunduğu için sorun olmaz.

## Yapı

```
app/
  page.tsx              akış yönetimi: alım → hazır → görüntüleme
  api/proxy/route.ts    CORS için akıtan proxy
components/
  Intake.tsx            dosya/adres seçimi, ilerleme
  QueryBar.tsx          koşul satırları, AND/OR, uygula/indir
  Tape.tsx              belge haritası: kayıt yoğunluğu, eşleşmeler, görünen alan
  XmlViewer.tsx         sanallaştırılmış satır görüntüleyici
  TransformDemo.tsx     giriş ekranındaki önce/sonra gösterimi
  highlight.ts          satır bazlı XML renklendirme
lib/
  worker/feed.worker.ts tüm ağır iş
  xml/tokenizer.ts      parça sınırlarını aşabilen XML tokenizer
  xml/formatter.ts      girintileme + belge şekli tespiti
  xml/pipeline.ts       biçimlendirme ve sorgu geçişleri
  xml/match.ts          koşul değerlendirme, Türkçe karakter eşitleme
  store/backing.ts      OPFS / bellek depolama
  store/document.ts     satır indeksi, yoğunluk histogramı, satır okuma
  engine.ts             worker RPC katmanı
```

## Bilinen sınırlar

- Kayıt etiketi otomatik bulunur ama bu bir tahmindir; yanlışsa sorgu barındaki **Record**
  kutusundan değiştirilir.
- Sorgu öğe metinleri üzerinde çalışır; öznitelik (`<product id="1">`) sorgulanamaz.
- Görüntüleyicide arama/atlama yoktur; konum değiştirmek için üstteki belge haritası kullanılır.
- Arayüz tek dillidir (İngilizce); dil değiştirici yoktur.
- Karma içerikte (`<p>metin <b>kalın</b> devam</p>`) metin parçaları kırpılarak ayrı
  satırlara alınır.
