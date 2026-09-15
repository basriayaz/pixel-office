# Pixel Office

Claude agent'ların için pixel-art bir sanal ofis. Oyun tarzı karakter oluşturucuyla AI çalışanlar işe al, her birine bir iş ver, masalarına yürüyüp çalışmalarını izle ve onlara asla unutmayacakları şeyler öğret.

*English: [README.md](README.md)*

![Pixel Office](docs/office.jpg)

<details><summary>İşe alma: oyun tarzı karakter oluşturucu, hazır pozisyonlar, model / effort / izin kartları</summary>

![Hire](docs/hire.jpg)

</details>

Her çalışan kalıcı bir [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) oturumudur ve kendine ait şunları taşır:

- **görev tanımı** (sistem promptu) — kim olduğu, neyden sorumlu olduğu,
- **kalıcı hafıza** (`memory.md` / `hafiza.md`) — öğrettiklerin buraya yazılır ve her oturumda yüklenir; ayrıca kendi kendine öğrenir ve bilgilerini periyodik olarak tazeler,
- **yetenekler** (`skills/<ad>/SKILL.md`) — sadece o çalışana yüklenen Claude Code skill'leri,
- **model, effort ve izin modu** — rutin işlere Haiku, zor işlere Opus/Fable,
- **görünüm** — cinsiyet, vücut tipi, ten, saç, şapka, gözlük, kıyafet, ayakkabı.

Ofis odalardan oluşan 2D bir pixel dünya (mutfak, açık ofis, toplantı odası, lounge, arşiv). Boştaki çalışanlar dolaşır, kahve alır, kanepeye oturur, sohbet eder; birine iş verdiğinde masasına dönüp yazmaya başlar. Durum bir bakışta görünür: çalışıyor, iznini bekliyor, bitti, okunmamış cevap.

Çalışanlar **projenin klasörünün içinde** çalışır: dosya okur ve düzenler, (izninle) komut çalıştırır, `CLAUDE.md`'ni okur; ayrıca Claude Code subagent'ı olarak da (`.claude/agents/`) görünürler — aynı projede terminalden açtığın `claude` onlara iş devredebilir.

## Gereksinimler

- Node.js 20+
- Claude Code'a (`claude` CLI) giriş yapılmış bir Claude aboneliği **ya da** ortamda `ANTHROPIC_API_KEY`. Agent SDK Claude Code çalışma zamanını kendi içinde taşır; başka bir şey gerekmez.

## Kurulum

Pixel Office GitHub üzerinden dağıtılır (henüz npm'de değil).

```bash
git clone https://github.com/basriayaz/pixel-office.git
cd pixel-office
npm install          # dist/ de derlenir
npm link             # `pixel-office` komutunu global yapar
```

Global kurmadan:

```bash
npx github:basriayaz/pixel-office init
npx github:basriayaz/pixel-office
```

## Projende kullanmak

```bash
cd ~/projem
pixel-office init --locale tr   # .pixel-office/ oluşturur (config, employees/_template), data klasörünü gitignore'a ekler
pixel-office                    # http://localhost:4747 üzerinde ofisi başlatır ve tarayıcıyı açar
```

Sonra üst çubuktaki **+ İşe al**: karakteri tasarla, hazır pozisyonlardan birini seç ya da görev tanımını yaz, model / effort / izin modunu seç, işe al. Çalışanın klasörü anında `.pixel-office/employees/<id>/` altında oluşur — yeniden başlatma gerekmez.

```
.pixel-office/
  config.json
  employees/
    _template/
    kerem/
      agent.md        # kimlik + görev tanımı (frontmatter: name, role, color, model, effort, permissionMode, look, …)
      memory.md       # kalıcı hafıza — çalışan buraya yazar, sen de düzenleyebilirsin
      skills/
        haftalik-rapor/SKILL.md
  data/               # oturumlar ve sohbet geçmişi (gitignore)
```

`.pixel-office/employees/` klasörünü commit'lersen çalışanları (ve öğrendiklerini) ekibinle paylaşırsın. Hafızalar kişisel kalsın istersen `pixel-office init --no-memory-git` kullan ya da `.gitignore`'a `.pixel-office/employees/*/memory.md` ekle.

### Yapılandırma (`.pixel-office/config.json`)

| anahtar | varsayılan | anlamı |
|---|---|---|
| `locale` | `"en"` | arayüz + prompt dili (`en`, `tr`) |
| `port` | `4747` | HTTP portu (`PORT` ortam değişkeni geçersiz kılar) |
| `host` | `"127.0.0.1"` | dinlenen adres — çalışanlar makinende komut çalıştırabildiği için localhost'ta tut |
| `employeesDir` | `".pixel-office/employees"` | çalışan klasörlerinin yeri |
| `dataDir` | `".pixel-office/data"` | oturumlar, sohbet geçmişi, tazeleme zamanları |
| `memoryFile` | `"memory.md"` | her çalışan klasöründeki hafıza dosyasının adı (örn. `hafiza.md`) |
| `cwd` | `"."` | çalışanların çalıştığı dizin (`agent.md`'deki `cwd:` çalışan bazında geçersiz kılar) |
| `syncClaudeAgents` | `true` | çalışanları `<cwd>/.claude/agents/` altına Claude Code subagent'ı olarak yansıt |
| `refreshHours` | `24` | boştaki çalışanların hafıza ve proje dokümanlarını ne sıklıkla gözden geçireceği |

Yollar proje klasörüne göredir; `~` açılır.

### Birden fazla ofis

Tek sunucu birden fazla ofis barındırabilir (örn. şirket ya da ekip başına); üst bardaki sekmelerden geçilir. Her ofisin kendi çalışan klasörü, varsayılan çalışma dizini ve sohbet geçmişi olur:

```json
{
  "locale": "tr",
  "dataDir": ".pixel-office/data",
  "offices": [
    { "id": "genel",   "name": "Genel",          "employeesDir": "calisanlar/genel",   "cwd": "." },
    { "id": "carpe",   "name": "Carpe",          "employeesDir": "calisanlar/carpe",   "cwd": "~/Projects/carpe" },
    { "id": "tarsier", "name": "Tarsier Vision", "employeesDir": "calisanlar/tarsier", "cwd": "~/Projects/golsinyali",
      "employees": ["calisanlar/genel/defne"] }
  ]
}
```

Her ofisin bir de **teması** var (`"theme": "default" | "football" | "fashion" | "gothic"`, çizilmiş önizlemelerden görsel olarak seçilir) — aynı oda planı, farklı duvar/zemin/eşya/oda adları (örn. skorbordlu, taktik odalı, tribünlü bir futbol kulübü; kesim masalı, mankenli, askılıklı, prova odalı bir moda atölyesi; vitraylı, meşaleli, kazanlı, zırhlı, mahzenli bir gotik malikâne). Ofisler sekmelerin yanındaki ⚙ düğmesinden yönetilir: ekle (ad, çalışma klasörü, tema), yeniden adlandır, tema/klasör değiştir, sil (yalnızca boşken); değişiklikler `config.json`'a yazılır ve anında uygulanır.

`employees` o ofiste ek olarak gösterilecek çalışan klasörlerini listeler — aynı kişi (aynı hafıza ve yetenekler) iki ofiste çalışır, her ofiste ayrı sohbet ve oturumla. Sohbet verileri `dataDir/<ofis id>/` altında ofis başına tutulur. Sayfalar ofise bağlıdır: `/?office=carpe`, `hire.html?office=carpe`, `/api/offices/carpe/employees`.

## Parçalar

- **Sohbet** — çalışana (ya da roster çipine) tıkla. Markdown cevaplar, katlanmış araç işlemleri, izin kartları (İzin ver / Hep izin ver / Reddet) ve çalışanın sana sorduğu seçenekli sorular.
- **Profil** (sohbet başlığında ☰) — kaç gündür bizimle, istatistikler, görünüm editörü, görev tanımı, hafıza düzenleme, yetenekler (ekle/düzenle/sil), geçmiş, model/effort/izin ayarları, **Bilgilerini tazele** ve **İşten çıkar** (klasör `employees/_archive/` altına taşınır).
- **Kendi kendine öğrenme** — her çalışan, her görev sonunda kalıcı dersleri hafızasına eklemesi için yönlendirilir; boştayken ve son tazelemeden `refreshHours` geçtiyse hafızasını ve ilgili proje dokümanlarını yeniden okuyup toparlar. Profilden istediğin zaman tetikleyebilirsin.
- **Meslektaşlar** — aynı ofisteki çalışanlar birbiriyle konuşabilir. Her birinin `list_colleagues` ve `message_colleague` araçları var: destek çalışanı bir sipariş iptalini siparişlerden sorumlu kişiye devreder, istersen cevabını bekleyip sana rapor eder. Mesaj meslektaşın sohbetinde (gönderenin adıyla) ve gönderenin sohbetinde işlem satırı olarak görünür.
- **Terminal** — projeye `cd` yapıp `claude` çalıştır; çalışanlar subagent olarak (`.claude/agents/<id>.md`) görünür, aynı hafıza dosyalarını paylaşır.

## Geliştirme

```bash
npm run dev          # tsx, derleme adımı yok
npm run typecheck
```

`web/sprites.html` tüm karakter karelerini 4× boyutta çizer — `web/office.js`'deki sprite kodunu değiştirirken işe yarar.

## Güvenlik notları

Çalışanlar, yapılandırılan çalışma dizinine (ve izinle makinedeki her şeye) dosya ve kabuk erişimi olan Claude Code oturumlarıdır. Sunucu bu yüzden `127.0.0.1`'e bağlanır; kimlik doğrulama eklemeden ağa açma. `bypassPermissions` modu komutları sormadan çalıştırır — yalnızca dar görevli, güvendiğin çalışanlar için kullan.

## Lisans

MIT
