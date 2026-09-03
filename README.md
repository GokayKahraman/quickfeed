# QuickFeed

Ürün beslemesi biçimlendirici ve okuyucu. **XML**, **JSON** ve **ayraçlı metin**
(`.csv`, `.tsv` ve alışveriş kanallarının istediği sekme ayraçlı `.txt`) beslemelerini
açar: XML ve JSON'u girintiler, ayraçlı beslemeyi sütunlara oturmuş bir tablo olarak
çizer, hepsini alan bazlı sorgularla filtreler. Arayüz dili İngilizce.

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

## Biçim tespiti

Biçim **dosyanın baytlarından** okunur; uzantıya da `content-type` başlığına da
bakılmaz. İkisi de düzenli olarak yanlış oluyor:

- Google Merchant'ın beklediği `.txt` beslemeleri sekme ayraçlı tablolardır.
- Test edilen beslemelerden biri kendini `text/x-comma-separated-values` diye tanıtırken
  aslında sekme ayraçlıydı.

İlk 64 KB çözülür; `<` ile başlıyorsa XML, `[` ya da `{` ile başlıyorsa JSON, aksi
hâlde ayraçlı metin sayılır.

### Ayraç seçimi

Ayraç, **sütun sayısını en tutarlı kılan** karakterdir — en çok geçen değil. Fark
belirleyici: gillmans beslemesi sekme ayraçlıdır ama `description` sütunu düz yazı
dolu olduğu için virgüller sekmelerden kat kat fazladır. Ayıran şey düzenliliktir —
her satırda tam 20 sekme varken virgül sayısı 0 ile 30 arasında gezinir. Bir ayracın
*bölemediği* satırlar da puanlamaya girer, yoksa tek bir hücrede geçen virgül kusursuz
bir sicil elde eder.

## Akış

1. **Kaynak seçin** — *From my computer* ile dosyayı sürükleyin ya da *From a URL* ile
   besleme adresini yazın.
2. **Biçimlendirin** — *Indent* seçeneği (2 spaces / 4 spaces / tab).
3. **İki seçenek** — *Download formatted file* ya da *View in browser*.
4. **Sorgulayın** — alan adı + `contains / does not contain / matches exactly` + `value`
   → **Apply**. Alan kutusunun etiketi biçime göre değişir: XML'de `tag name`, JSON'da
   `key name`, tabloda `column name`. Sonuç yeni bir belge olarak oluşur; *Download
   result* ile alınabilir.

*+ condition* ile koşul eklenir; koşullar arasındaki **AND / OR** bağlacına tıklayarak
değiştirilir.

## Görüntüleme

**XML ve JSON** girintilenir ve satır satır renklendirilir. JSON'da yalnızca kısa
skalerlerden oluşan diziler tek satırda kalır — `"sizes": ["36", "37", "38"]`, her sayı
için bir satırdan çok daha okunaklıdır ve ürün beslemeleri bunlarla doludur. Karar
ileriye bakmadan verilir: skalerler ya dizi kapanana kadar (tek satır) ya da bütçe
aşılana kadar (kalanı satır satır) tamponlanır.

**Ayraçlı beslemeler tablo olarak** çizilir: üstte yapışkan sütun cetveli, sabit
genişlikli sütunlar, yatay kaydırma. Sığmayan hücre üç noktayla kesilir; üzerine
gelince tamamı görünür. Cetvel, dosyanın kendi başlık satırı ekrandayken adları
gizler — aynı kelimeleri iki kez yazmanın anlamı yok — ve o satır yukarı kayınca belirir.

Tablo, mevcut sanallaştırmanın üstünde çalışır: **saklanan bir satır, tablonun bir
satırıdır.** Biçimlendirme geçişinin hücrelerdeki satır sonlarını boşluğa çevirmesinin
sebebi tam olarak budur — tırnak içindeki bir açıklama kaydı iki satıra bölseydi
sonraki bütün satır numaraları kayardı.

### Sütun genişliği ve kesilen hücreler

Sütun genişlikleri dosyadan ölçülür ama son söz kullanıcınındır:

- **Sürükleyerek genişletin/daraltın.** Cetvelde her sütunun sağ kenarında bir tutamak
  var; sürüklendiğinde hem cetvel hem satırlar birlikte hareket eder. Alt sınır 3, üst
  sınır 400 karakter.
- **Çift tıklayınca** sütun ölçülen genişliğine döner.
- Genişlikler **görünüm tercihidir**: belgeye yazılmaz, sorgu sonucuna ya da indirilen
  dosyaya taşınmaz, başka bir belge açılınca sıfırlanır.

Sığmayan hücre yine `…` ile kesilir, ama artık **üzerine tıklanınca değerin tamamı** bir
panelde açılır: sütun adı, karakter sayısı, kopyalama düğmesi ve satır sonlarını koruyan,
seçilebilir bir metin alanı. `Esc`, panel dışına tıklama ya da kaydırma paneli kapatır.

Panel açılıyor, satır açılmıyor — çünkü buradaki her satır tam olarak bir satır
yüksekliğinde ve indeksine göre konumlanıyor; kırk milyon satırın kayabilmesinin sebebi
bu. Altı satıra saran bir açıklama o düzenin içine sığmaz.

Kesilme testi karakter sayısıyla yapılır (yazı tipi eşit aralıklı olduğu için bir karakter
bir sütun genişliğidir), hücre hücre ölçüm yapılmaz — otuz satır çarpı yirmi sütun ölçmek
her kaydırmada bir kare maliyeti demek olurdu. Hücrenin sağ dolgusu `border-box` yüzünden
metin alanından düşüldüğü için, bir karakterin piksel genişliği bir kez ölçülüp eşiğe
katılır; yoksa tam sınırdaki hücreler `…` gösterip tıklamaya cevap vermezdi.

## Belge içinde arama

**Ctrl+F** (macOS'ta **Cmd+F**) görüntüleyicinin sağ üstünde bir arama kutusu açar.

Tarayıcının kendi araması burada işe yaramaz: görüntüleyici sanallaştırılmış olduğu için
DOM'da yalnızca ekrandaki ~30 satır bulunur, geri kalan 245 bin satırı bulamaz. Bu yüzden
arama worker içinde, satır indeksi üzerinden belgenin tamamını tarar.

- `Aa` büyük/küçük harf duyarlılığı, `ab` yalnızca tam kelime, `.*` düzenli ifade.
- Kapalıyken Türkçe karakterler eşitlenir: `Yesil` yazınca `Yeşil` bulunur. Düzenli ifade
  modunda eşitleme yapılmaz — desendeki `\S` gibi ifadeleri bozardı.
- **Enter** sonraki, **Shift+Enter** önceki eşleşme; **Esc** kapatır. Aktif eşleşme dolu
  kırmızı, diğerleri soluk kırmızı gösterilir ve satır ekranın ortasına getirilir.
- Gezinme için en fazla 20.000 eşleşme tutulur; toplam sayı bunu aşarsa sayaç `+` ile
  gösterilir.
- Tabloda vurgu doğru hücrede ve hücre içinde doğru karakterde belirir. Arama ham satır
  üzerinde çalışır, tablo ise hücreyi tırnaklarından soyarak çizer; ikisi arasındaki
  kaymayı `toCellOffset` düzeltir.

Ölçüm (245.000 satır / 16,7 MB): tam belge taraması ~1,7 sn, 15.588 eşleşme.

## Sorgu davranışı

Koşullar üç biçimde de aynı motorla değerlendirilir; alanın nereden geldiği değişir.

| Konu | Davranış |
| --- | --- |
| Alan adı | XML'de etiket, JSON'da anahtar, tabloda sütun başlığı. |
| Büyük/küçük harf | `Aa case sensitive` kapalıyken yok sayılır. Türkçe karakterler de eşitlenir: `yesil` → `Yeşil`, `ayakkabi` → `Ayakkabı`. |
| Ön ek | `g:price` ile `price` aynı alan sayılır. |
| Kapsayıcı alan | Alt öğe barındıran alanlar alt metinlerini kapsar; `kategori contains Gömlek`, `<alt>Gömlek</alt>` olan kaydı bulur. JSON'da aynı kural geçerlidir: `categories contains Wkładki`, değeri `categories.pol` içinde geçen kaydı bulur. |
| Kayıt alanı | Kayıt adının kendisi (`product`, `item`, `row`) tüm kayıt içinde tam metin araması yapar. |
| JSON dizileri | `"sizes": ["36","37"]` içindeki her değer `sizes` alanına yazılır; `sizes contains 37` çalışır. |
| JSON `null` | Eşleşecek bir değer taşımadığı için alan yokmuş gibi davranır. |
| Yanlış kayıt | Sorgu barındaki **Record** kutusundan elle seçilir. Tabloda kayıt yalnızca satır olabileceği için bu kutu gösterilmez. |
| Alan yoksa | `does not contain` doğru, `contains` ve `matches exactly` yanlış kabul edilir. |

### Sonuç belgesi

Sonuç, kaynağın biçiminde ve o biçimde geçerli bir dosyadır:

- **XML** — kök etiket, XML bildirimi ve `<channel>` gibi ara katmanlar korunur;
  yalnızca eşleşmeyen kayıtlar çıkarılır.
- **Tablo** — başlık satırı korunur, eşleşen satırlar aynı ayraçla yazılır; dosya
  doğrudan bir hesap tablosunda açılır.
- **JSON** — hayatta kalan kayıtlardan **yeni bir dizi** kurulur. Kayıtları iç içe bir
  sarmalayıcıdan sökmek, bir kayıt atıldığında hangi virgülün gereksiz kaldığını
  izlemeyi gerektirir ve tek bir hata hiçbir ayrıştırıcının okuyamayacağı bir dosya
  üretir; diziyi yeniden kurmak geçersiz JSON üretemez. Bedeli sarmalayıcıdır:
  `{"meta":…,"products":[…]}` biçimindeki bir besleme yalnızca ürünlere süzülür.

## Kayıt tespiti

Filtreleme, beslemedeki "bir kayıt"ın ne olduğunu bilmeyi gerektirir. Tabloda bunun tek
bir cevabı var — satır. XML ve JSON'da tahmin etmek gerekir; bu etiket
**ebeveyni başına kaç kez tekrarlandığına** göre seçilir — ham tekrar sayısına göre değil.

Fark önemli. Bir Ticimax beslemesinde `<TeknikDetay>` 27.217 kez, `<Urun>` ise 1.063 kez
geçiyor; ham sayıya bakan bir yöntem teknik detay satırını ürün zanneder. Oysa `<Urun>`
tek bir `<Urunler>` içinde 1.063 kez tekrarlanırken `<TeknikDetay>` her `<TeknikDetaylar>`
içinde yalnızca ~26 kez tekrarlanıyor. Kayıt, tek bir kapsayıcının altında binlerce kez
tekrarlanan şeydir.

JSON aynı sıralamayı kullanır: belge, XML öğelerine çevrilerek okunur. Bir nesne
öğedir, skaler değer yapraktır, **dizi ise öğe değildir** — `"products": [ {…}, {…} ]`
tam olarak `<products>` etiketinin N kez tekrarlanması gibi okunur. Adsız bir kök
dizinin elemanları `item` adını alır. Böylece kayıt tespiti, fan-out sıralaması ve alan
listesi iki ayrı yerde birbirinden ayrı düşmek yerine tek bir uygulamayı paylaşır.

Yine de bu bir tahmin. Sorgu barındaki **Record** açılır kutusu tespit edilen adı
gösterir ve adayları sıralar; yanlışsa oradan değiştirilir. Değiştirince kayıt sayacı,
belge haritası yoğunluğu ve sonraki sorgular seçilen ada göre çalışır.

## Büyük dosyalar

Bellek taşmasına karşı alınan önlemler:

- Kaynak `ReadableStream` olarak parça parça okunur; tam dosya hiçbir zaman belleğe alınmaz.
- Biçimlendirilmiş çıktı **OPFS**'e (tarayıcının kendi disk alanı) `FileSystemSyncAccessHandle`
  ile yazılır. OPFS desteklenmiyorsa bellek kullanılır ve durum çubuğunda `memory mode` uyarısı çıkar.
- Satır indeksi her 64 satırda bir byte konumu tutar — 5 milyon satırlık indeks ~1 MB.
- Görüntüleyici yalnızca ekrandaki ~35 satırı DOM'a basar ve yalnızca onları worker'dan ister.
- İndirme, OPFS dosyasının `File` referansıdır; bellekte kopya oluşmaz.
- Tek bir kaydın alan sayısı 512, alan uzunluğu 64 KB ile sınırlıdır.

Ölçümler (Chromium):

| Besleme | Boyut | Kayıt | Biçimlendirme | Sorgu |
| --- | --- | --- | --- | --- |
| XML (Ticimax) | 90 MB / 4,8 M satır | 400.000 | 2,8 sn | 3,4 sn |
| JSON (segmentify) | 71,9 MB → 97,6 MB / 1,93 M satır | 8.141 | **2,2 sn** | 1,9 sn |
| CSV (quirumed) | 5,7 MB | 5.665 | **523 ms** | 26 ms |
| TSV (gillmans `.txt`) | 1,3 MB | 1.058 | — | 26 ms |

XML ölçümünde JS heap ~17 MB'de kalır; JSON ve tablo yolları da aynı akış modelini
kullandığı için bellek belge boyutuyla büyümez.

## Kodlama ve sıkıştırma

Kodlama BOM'dan ya da `<?xml ... encoding="...">` bildiriminden okunur; ISO-8859-9 ve
windows-1254 beslemelerde Türkçe karakterler bozulmaz. Çıktı her zaman UTF-8 yazılır ve
bildirimdeki `encoding` değeri buna göre güncellenir. `.gz` dosyalar `DecompressionStream`
ile kendiliğinden açılır.

HTTP başlığındaki `charset` **bilerek dikkate alınmaz.** Besleme sunucuları bunu yeterince
sık yanlış gönderiyor: test edilen beslemelerden biri `charset=iso-8859-1` diye sunuluyor
ama gerçekte UTF-8; o başlığa uymak her `ö` karakterini `Ã¶` yapardı. BOM ya da bildirim,
dosyanın kendisi hakkında verdiği bir beyandır; başlık ise sunucunun dosya hakkındaki
tahminidir.

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

Üç biçim tek bir makineyi paylaşır. Her birinin kendi çözümleyicisi ve yazıcısı var;
`DocWriter`'dan sonrası — satır indeksi, yoğunluk şeridi, görüntüleyici, arama ve
indirme — biçimden habersizdir, çünkü üçü de aynı depoya düz satırlar yazar.

```
app/
  page.tsx              akış yönetimi: alım → hazır → görüntüleme
  api/proxy/route.ts    CORS için akıtan proxy
components/
  Intake.tsx            dosya/adres seçimi, ilerleme
  QueryBar.tsx          koşul satırları, AND/OR, uygula/indir
  Tape.tsx              belge haritası: kayıt yoğunluğu, eşleşmeler, görünen alan
  DocViewer.tsx         sanallaştırılmış görüntüleyici — satır modu ve tablo modu
  TransformDemo.tsx     giriş ekranındaki önce/sonra gösterimi
  FindBar.tsx           belge içi arama kutusu
  highlight.ts          satır bazlı XML/JSON renklendirme + eşleşme vurgusu
lib/
  worker/feed.worker.ts tüm ağır iş; biçime göre boru hattı seçimi
  format/detect.ts      biçim ve ayraç sezimi
  format/read.ts        ortak bayt katmanı: kodlama, gzip, akış pompası
  xml/tokenizer.ts      parça sınırlarını aşabilen XML tokenizer
  xml/formatter.ts      girintileme + belge şekli tespiti
  xml/pipeline.ts       XML biçimlendirme ve sorgu geçişleri
  xml/match.ts          koşul değerlendirme, Türkçe karakter eşitleme
  json/tokenizer.ts     akış JSON sözcük çözümleyici
  json/formatter.ts     JSON yazıcı, imleç ve şekil toplayıcı
  json/pipeline.ts      JSON biçimlendirme ve sorgu geçişleri
  csv/tokenizer.ts      RFC 4180 çözümleyici, hücre bölme ve ofset eşleme
  csv/pipeline.ts       tablo biçimlendirme ve sorgu geçişleri
  store/backing.ts      OPFS / bellek depolama
  store/document.ts     satır indeksi, yoğunluk histogramı, satır okuma
  engine.ts             worker RPC katmanı
```

## Bilinen sınırlar

- Kayıt adı otomatik bulunur ama bu bir tahmindir; yanlışsa sorgu barındaki **Record**
  kutusundan değiştirilir.
- Sorgu öğe metinleri üzerinde çalışır; XML özniteliği (`<product id="1">`) sorgulanamaz.
- Arayüz tek dillidir (İngilizce); dil değiştirici yoktur.
- Karma içerikte (`<p>metin <b>kalın</b> devam</p>`) metin parçaları kırpılarak ayrı
  satırlara alınır.
- Tabloda hücre içindeki satır sonları boşluğa çevrilir — bir kaydın tek satırda kalması
  gerektiği için zorunlu, ama içeriği değiştiren tek işlem budur. (Hücrenin özgün hâli
  kesilmiş hücreye tıklanınca açılan panelde görülebilir.)
- Kesilmiş bir hücre yalnızca fareyle açılır; klavyeyle gezilebilir bir düğme yapılsaydı
  ekrandaki her satır için sekme durağı eklenirdi. Değerin tamamı `title` ipucunda da
  duruyor.
- Boş ya da tekrar eden sütun başlıkları yeniden adlandırılır (`column_21`, `price_2`);
  adsız bir sütun sorgulanamayacağı için gerekli, ama indirilen dosyaya da yansır.
- JSON sonucu her zaman bir dizidir; kayıtları saran `{"meta":…}` gibi bir kabuk korunmaz.
- Sayısal karşılaştırma yoktur; `price > 100` yazılamaz, koşullar metin üzerinde çalışır.
