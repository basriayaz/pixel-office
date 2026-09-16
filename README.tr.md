# Pixel Office

**Claude agent'ların için pixel-art bir ofis.** Oyun tarzı karakter oluşturucuyla AI çalışanlar işe al, her birine bir iş ver, masalarına yürüyüp çalışmalarını izle ve onlara asla unutmayacakları şeyler öğret.

[![MIT lisans](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE) [![Node 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](#hızlı-başlangıç) *English: [README.md](README.md)*

![Pixel Office — ofis görünümü](docs/office.jpg)

- **Her çalışan gerçek bir Claude Code oturumu**: kendi görev tanımı, kalıcı hafızası, yetenekleri, modeli ve izin seviyesi var. Verdiğin klasörde dosya okur ve düzenler, komut çalıştırır, web'e bakar.
- **Durum bir bakışta**: çalışıyor, iznini bekliyor, bitti, okunmamış cevap — karakterin üstünde, listede ve tarayıcı sekmesinde görürsün. Boştakiler dolaşır, kahve alır, sohbet eder.
- **Bir kez öğret, hep hatırlasın.** Çalışana söylediğin şey her oturumda yüklenen bir Markdown hafıza dosyasına yazılır; sen de düzenleyebilirsin.
- **Birden fazla şirket, tek sunucu.** Şirket ya da ekip başına ofis; her birinin kendi klasörü, çalışanları ve teması (klasik, futbol kulübü, moda atölyesi, gotik malikâne, müzik stüdyosu, seyahat acentesi).

## Hızlı başlangıç

Gereksinimler: **Node.js 20+** ve giriş yapılmış **Claude Code** (`claude` CLI — Claude Pro/Max aboneliği ya da ortamda `ANTHROPIC_API_KEY`).

```bash
npx github:basriayaz/pixel-office
```

Bu kadar. İlk çalıştırma `~/.pixel-office/` klasörünü oluşturur, üç örnek çalışan alır (asistan, geliştirici, pazarlamacı) ve http://localhost:4747 adresini kısa bir hoş geldin kartıyla açar. Bir çalışana tıkla, selam ver.

Komutu kalıcı kurmak için:

```bash
git clone https://github.com/basriayaz/pixel-office.git
cd pixel-office && npm install && npm link
pixel-office          # başlat
pixel-office stop     # kapat (ya da üst bardaki ⏻ düğmesi, ya da Ctrl+C)
```

macOS, Linux ve Windows'ta (PowerShell) çalışır. Türkçe arayüz için `~/.pixel-office/config.json` içine `"locale": "tr"` yaz; ilk açılışta `PIXEL_OFFICE_LOCALE=tr npx github:basriayaz/pixel-office` da olur.

## Tur

### Sohbet, izinler, hafıza

Çalışana tıkla, sohbeti açılır. Cevaplar Markdown olarak akar; araç çağrıları "N işlem" satırlarında katlanır; dosyalarına dokunan ya da komut çalıştıran her şey önce sorar — **İzin ver**, bu oturum için **Hep izin ver**, ya da **Reddet**. Çalışanlar sana seçenekli soru da sorabilir.

![Sohbette izin kartı](docs/chat-permission.jpg)

Kalıcı bir şey söylediğinde ("haftalık rapor cuma günleri çıkar, aklında tut") hafıza dosyasına yazar ve işine devam eder:

![Hafızaya yazıp cevaplıyor](docs/chat.jpg)

Hafıza dosyası düz Markdown. Profili aç (sohbet başlığında ☰): oku, düzenle, yetenek ekle, modeli değiştir ya da çalışanı işten çıkar:

![Profil sayfası — hafıza sekmesi](docs/memory.jpg)

### İşe alma

**+ İşe al** karakter oluşturucuyu açar: cinsiyet, vücut tipi, ten, saç, sakal, gözlük, kulaklık, şapka, üst, alt, ayakkabı. Hazır pozisyonlardan birini seç ya da görev tanımını kendin yaz, model / effort / izin modunu belirle, işe al. Yeni çalışan kapıdan konfetiyle girer ve boş bir masaya oturur (ofis başına 12 masa).

![İşe alma sayfası](docs/hire.jpg)

Hazır pozisyonlar (her birinin düzenlenebilir görev tanımı var): Kişisel Asistan, Muhasebe & Finans, Reklam & Pazarlama, Müşteri Destek, SEO & İçerik, Yazılım Geliştirici, Satış, İçerik & Sosyal Medya.

### Ofisler ve temalar

Sekmelerin yanındaki ⚙ ofisleri yönetir: şirket ya da ekip başına ofis ekle (ad, Finder'dan seçilen çalışma klasörü, tema), yeniden adlandır, tema değiştir, boşsa sil. Temalar çizilmiş önizlemelerden seçilir:

![Tema seçici](docs/themes.jpg)

## Nasıl çalışır

Her çalışan bir klasördür:

```
~/.pixel-office/
  config.json
  employees/
    _template/
    kerem/
      agent.md        # kimlik + görev tanımı (YAML frontmatter + sistem promptu)
      memory.md       # kalıcı hafıza — çalışan buraya yazar, sen de düzenleyebilirsin
      skills/
        haftalik-rapor/SKILL.md
  data/               # oturumlar ve sohbet geçmişi
```

**`agent.md`** — frontmatter'da `name`, `role`, `color`, `hired`, `model`, `effort`, `permissionMode`, `cwd`, `tools`, `refreshHours` ve `look` (JSON); gövde sistem promptu. Dosyayı elle ya da profil sayfasından düzenleyebilirsin.

**`memory.md`** — her oturumun başında sistem promptuna yüklenir. Her çalışan, her görev sonunda kalıcı dersleri (kurallar, tercihler, neyin nerede olduğu) buraya eklemesi için yönlendirilir. Boştayken ve son tazelemeden `refreshHours` (varsayılan 24) geçtiyse hafızasını ve proje dokümanlarını yeniden okuyup toparlar. Profildeki **Bilgilerini tazele** elle tetikler. Sohbeti sıfırlarsan (⟲) hafıza kalır.

**`skills/<ad>/SKILL.md`** — sadece o çalışana yüklenen Claude Code yetenekleri (bir kontrol listesi, rapor formatı, deploy adımları). Profilin Yetenekler sekmesinden yönetilir.

**Oturumlar** — her sohbet devam ettirilebilir bir Claude Agent SDK oturumu. Sunucu yeniden başlasa da kaldığı yerden sürer; ■ o turu keser; model ve oturum maliyeti sohbet başlığında görünür.

**İzinler** — `default` her dosya düzenlemesi ve komut için sorar (önerilen), `acceptEdits` dosya düzenlemelerini otomatik onaylar, `plan` salt okunur, `bypassPermissions` sormadan çalıştırır — sadece dar görevli, güvendiğin çalışanlar için. İzin kartındaki "Hep izin ver" oturum boyunca geçerli.

**Meslektaşlar** — aynı ofisteki çalışanlar `list_colleagues` ve `message_colleague` araçlarıyla birbirine yazar. Destek çalışanı bir sipariş iptalini siparişlerden sorumlu kişiye devreder, istersen cevabını bekleyip sana rapor eder. Mesaj iki sohbette de görünür.

**Bildirimler** — üst bardaki 🔔, sekme arkadayken cevaplar ve izin istekleri için masaüstü bildirimi açar. Bildirime tıklayınca o sohbet açılır.

**Terminal** — çalışanlar `<çalışma klasörü>/.claude/agents/<id>.md` olarak da yansıtılır; aynı projede açtığın `claude` onlara subagent olarak iş devredebilir. Aynı hafıza dosyalarını paylaşırlar.

## Dosyalar nerede

İki mod, otomatik seçilir:

| mod | ne zaman | dosyalar | çalışanlar nerede çalışır |
|---|---|---|---|
| **global** (varsayılan) | herhangi bir yerde `pixel-office` | `~/.pixel-office/` (ya da `$PIXEL_OFFICE_HOME`) | ofis ya da çalışan klasör seçmediyse ev dizini |
| **proje** | bulunduğun klasörde `.pixel-office/config.json` varsa (`pixel-office init` oluşturur) ya da `--dir <proje>` | `<proje>/.pixel-office/` | proje klasörü |

Proje modu ekipler için: `.pixel-office/employees/` klasörünü commit'lersen ekip arkadaşların aynı çalışanları (ve öğrendiklerini) repoyla alır. Hafızalar kişisel kalsın istersen `pixel-office init --no-memory-git`.

### `config.json`

| anahtar | varsayılan | anlamı |
|---|---|---|
| `locale` | `"en"` | arayüz + prompt dili (`en`, `tr`) |
| `port` | `4747` | HTTP portu (`PORT` ortam değişkeni geçersiz kılar) |
| `host` | `"127.0.0.1"` | dinlenen adres — localhost'ta tut, çalışanlar makinende komut çalıştırabilir |
| `employeesDir` | `employees` / `.pixel-office/employees` | çalışan klasörleri |
| `dataDir` | `data` / `.pixel-office/data` | oturumlar, sohbet geçmişi, tazeleme zamanları |
| `memoryFile` | `"memory.md"` | hafıza dosyasının adı (örn. `hafiza.md`) |
| `cwd` | ev / proje | çalışanların varsayılan çalışma klasörü |
| `syncClaudeAgents` | `true` | çalışanları `<cwd>/.claude/agents/` altına yansıt |
| `refreshHours` | `24` | boştaki çalışanların hafıza ve dokümanları ne sıklıkla gözden geçireceği |
| `offices` | – | ofis listesi (aşağıda); tek ofis için yazma |

Yollar `config.json`'ın bulunduğu klasöre (global) ya da projeye (proje modu) göredir; `~` her yerde çalışır.

```json
{
  "locale": "tr",
  "memoryFile": "hafiza.md",
  "offices": [
    { "id": "genel", "name": "Genel",   "employeesDir": "employees/genel", "theme": "default" },
    { "id": "carpe", "name": "Carpe",   "employeesDir": "employees/carpe", "cwd": "~/Projects/carpe", "theme": "fashion" },
    { "id": "muzik", "name": "Müzik",   "employeesDir": "employees/muzik", "cwd": "~/Projects/kanal",  "theme": "music",
      "employees": ["employees/genel/defne"] }
  ]
}
```

`employees`, o ofiste ek olarak gösterilecek çalışan klasörlerini listeler — aynı kişi (aynı hafıza ve yetenekler) iki ofiste, her birinde ayrı sohbetle çalışır.

### Komutlar

```
pixel-office                      ofisini başlatır ve tarayıcıyı açar
pixel-office stop                 kapatır
pixel-office init [--locale tr]   çalışanları BU projenin içinde tutar (.pixel-office/)
pixel-office --dir <proje>        belirli bir projenin ofisini açar
seçenekler: --port 4747  --no-open  --global  --no-memory-git (init ile)
ortam:      PORT, PIXEL_OFFICE_HOME, PIXEL_OFFICE_LOCALE (ilk açılış), PIXEL_OFFICE_SAMPLES=0 (örnek çalışan olmasın)
```

## Sorun giderme

- **"Claude Code'a giriş yapılmamış" / yetki hataları** — terminalde bir kez `claude` çalıştırıp giriş yap, ya da `ANTHROPIC_API_KEY` tanımla. Agent SDK Claude Code çalışma zamanını kendi içinde taşır; başka kurulum yok.
- **Port dolu** — `pixel-office --port 4848`, ya da eski bir örnek çalışıyorsa `pixel-office stop`.
- **Çalışan öylece oturuyor** — sohbete bak, büyük ihtimalle izin bekliyor. 🔔 ile bildirim aç.
- **Windows** — PowerShell ya da Windows Terminal kullan; klasör seçici Windows'un kendi penceresini açar. `~/Projects/x` gibi yollar kullanıcı profiline açılır.
- **Her şeyi sıfırla** — sunucuyu durdur, `~/.pixel-office/` (ya da projedeki `.pixel-office/`) klasörünü sil.

## Güvenlik notları

Çalışanlar, çalışma klasörüne (ve izninle makinedeki her şeye) dosya ve kabuk erişimi olan Claude Code oturumlarıdır. Sunucu bu yüzden `127.0.0.1`'e bağlanır ve kimlik doğrulaması yoktur; ağa açma. `bypassPermissions` sormadan çalıştırır; yalnızca dar görevli, güvendiğin çalışanlar için. Sohbet geçmişi ve hafızalar diskinde düz dosyadır; Claude Code üzerinden Anthropic dışında hiçbir yere gönderilmez.

## Katkı

Issue ve pull request'ler açık — bkz. [CONTRIBUTING.md](CONTRIBUTING.md). Yeni dil eklemek tek dosya: `locales/en.json`'ı `locales/<kod>.json` olarak kopyala, çevir, `"locale": "<kod>"` yaz. Yeni temalar ve eşyalar `web/office.js` içinde; `web/sprites.html` sprite'larla oynarken tüm kareleri 4× çizer.

```bash
npm run dev          # tsx, derleme adımı yok
npm run typecheck
```

## Emeği geçen

[Basri Ayaz](https://github.com/basriayaz) yaptı. [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) üzerine kurulu. MIT lisanslı — bkz. [LICENSE](LICENSE).
