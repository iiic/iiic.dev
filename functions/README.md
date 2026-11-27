# API přihlašování přístupovými klíči (Cloudflare Pages Functions + D1)

Přihlašování bez hesla přes přístupové klíče (WebAuthn, passkeys) pro widget „Přihlášení přístupovým klíčem (i na
statickém webu)“ šablony domdocument-template. **Jeden účet všude:** účty a přístupové klíče jsou jen v databázi
Cloudflare D1. Na statickém webu je widget volá z prohlížeče. Do WordPressu se propojený účet přihlásí přes přihlašovací
stránku statického webu a podepsaný token (viz „Přihlášení do WordPressu“ níže).

| Soubor | Co dělá |
|---|---|
| `functions/api/auth/[[route]].js` | API na adrese `/api/auth/*` – registrace, přihlášení, odhlášení, profil, přístupové klíče, token pro WordPress (seznam adres je na začátku souboru) |
| `functions/_lib/webauthn.js` | ověření odpovědí WebAuthn bez knihoven (CBOR, klíče COSE, podpisy EdDSA / ES256 / RS256 přes Web Crypto) |
| `functions/_lib/sso-token.js` | token pro WordPress: JWT s podpisem EdDSA (Ed25519), klíč z tajné proměnné `SSO_PRIVATE_KEY` |
| `migrations/0001_ddt_auth.sql` | schéma databáze D1: `users`, `credentials`, `challenges`, `sessions` |
| `prihlaseni-pristupovym-klicem/index.html` | přihlašovací stránka a stránka účtu – sem WordPress posílá přihlášení (vytváří ji export) |
| `wrangler.toml` | projekt Cloudflare Pages a databáze D1 – **vytváří ho export** z nastavení WordPressu |
| `.site-checks/webauthn.test.mjs`, `sso-token.test.mjs` | testy API (spouští je `check-site.php`, tedy hook před commitem i workflow) |
| `.site-checks/sso-keygen.mjs` | vytvoří klíč pro tokeny WordPressu (soukromý pro Cloudflare, veřejný pro WordPress) |
| `functions/api/dashboard.js`, `functions/_lib/dashboard.js` | [2026-11-27] `GET /api/dashboard` – údaje z Cloudflare pro widget „Cloudflare“ na nástěnce WordPressu (sekce „Údaje pro nástěnku WordPressu“ níže) |
| `.site-checks/dashboard-api.test.mjs` | [2026-11-27] testy `/api/dashboard` (token WordPressu, CORS, odpověď s podvrženým API Cloudflare) |
| `functions/api/dashboard/traffic.js`, `functions/_lib/dashboard-traffic.js` | [2026-11-27] `GET /api/dashboard/traffic` – HTTP provoz zóny vlastní domény pro widget „Cloudflare – provoz zóny“ (sekce „Údaje pro nástěnku WordPressu“ níže) |
| `.site-checks/dashboard-traffic.test.mjs` | [2026-11-27] testy `/api/dashboard/traffic` (zóny podle domén, rozsahy podle tarifu, součty, bezpečnostní události) |
| `functions/api/dashboard/referrers.js`, `functions/_lib/dashboard-referrers.js` | [2026-11-27] `GET /api/dashboard/referrers` – odkazující weby (HTTP požadavky zóny a Web Analytics) pro stránku Analytická data ve WordPressu |
| `functions/api/dashboard/github.js`, `functions/_lib/dashboard-github.js` | [2026-11-27] `GET /api/dashboard/github` – provoz repozitáře na GitHubu (tajná proměnná `DASHBOARD_GITHUB_TOKEN`) pro stránku Analytická data |
| `.site-checks/dashboard-referrers.test.mjs`, `.site-checks/dashboard-github.test.mjs` | [2026-11-27] testy obou tras (podvržené API Cloudflare a GitHubu) |
| `functions/api/zone-settings.js`, `functions/_lib/zone-settings.js` | [2026-11-27] `GET` a `POST /api/zone-settings` – stav a změny voleb zóny Cloudflare pro nástroj „Nastavení Cloudflare“ ve WordPressu (sekce „Nastavení zóny z WordPressu“ níže) |
| `.site-checks/zone-settings.test.mjs` | [2026-11-27] testy `/api/zone-settings` (token, povolené volby, zóna projektu, pravidla WAF, bot management, podvržené API Cloudflare) |

Složky `functions/` a `migrations/` i soubory `.gitignore` a `wrangler.toml` pochází ze šablony
(`static-export/repository/`, `wrangler.toml` z nastavení), každý export je přepíše – měnit je ve WordPressu.

## Jednorázové nastavení

Potřeba je účet na Cloudflare (stačí bezplatný tarif) a Node.js 22+. Příkazy v kořeni tohoto repozitáře:

1. Přihlášení nástroje wrangler k účtu: `npx wrangler@4.168.0 login` (otevře prohlížeč).
2. Databáze: `npx wrangler@4.168.0 d1 create ddt-auth` – vypíše `database_id` (UUID).
3. Projekt Pages: `npx wrangler@4.168.0 pages project create <název> --production-branch main` (název = malá
   písmena, číslice a pomlčky; web pak běží i na `https://<název>.pages.dev`). Produkční větev musí být výchozí větev
   tohoto repozitáře.
4. Ve WordPressu: Nastavení → Standalone template parts & options → sekce „Statický export – hosting“:
   **Hosting statického webu** = jedna z možností „GitHub + Cloudflare“ ([2026-11-25]; s „Jen GitHub“ export složky
   `functions/` a `migrations/` do repozitáře vůbec nedá), **Cloudflare Pages: název projektu** a **Cloudflare D1: ID
   databáze**, uložit a spustit export („Vygenerovat statické soubory“). Export vytvoří `wrangler.toml`
   a `.github/hosting.env` a workflow začne nasazovat na Cloudflare.
5. Na GitHubu v tomto repozitáři: Settings → Secrets and variables → Actions → **Secrets**:
   - `CLOUDFLARE_ACCOUNT_ID` – ID účtu (dash.cloudflare.com, pravý panel přehledu účtu, nebo `npx wrangler whoami`),
   - `CLOUDFLARE_API_TOKEN` – token z My Profile → API Tokens → Create Token → Custom token s oprávněními
     **Account → Cloudflare Pages → Edit** a **Account → D1 → Edit**.
6. Vlastní doména: v projektu Pages → Custom domains přidat doménu webu (DNS záznam vytvoří Cloudflare, je-li doména
   u něj, jinak CNAME na `<název>.pages.dev`).
7. Když web poběží celý na Cloudflare Pages (hosting „web i API na Cloudflare Pages“), workflow na GitHub Pages
   nenasazuje ([2026-11-25] dříve to vypínala proměnná repozitáře `DDT_GITHUB_PAGES`, už se nečte). V Settings → Pages
   repozitáře GitHub Pages zrušit, jinak tam zůstane poslední zveřejněná verze.
8. Přihlášení do WordPressu – viz další sekce.

Workflow (`.github/workflows/site-checks.yml`) po úspěšných kontrolách na výchozí větvi spustí migrace databáze
(`wrangler d1 migrations apply DB --remote`, hotové přeskočí) a nasadí web: soubory z commitu bez nástrojů repozitáře
a funkce ze složky `functions/`. Bez tajných hodnot nebo bez ID databáze skončí úloha chybou s popisem.

**API jinde než web:** web může zůstat na GitHub Pages a API běžet jen na Cloudflare, např. na `auth.example.cz` (vlastní
doména projektu Pages, stejná doména jako web – jinak prohlížeč cookie relace nepošle). Pak ve WordPressu zvolit hosting
„GitHub + Cloudflare – web na GitHub Pages, API na Cloudflare Pages“ ([2026-11-25]; workflow pak nasazuje na obojí),
vyplnit „Přihlášení přístupovým klíčem: adresa API“ (`https://auth.example.cz/api/auth/` – s tímto hostingem povinně
celou adresou) a v projektu Pages nastavit proměnné `RP_ID=example.cz` a `ALLOWED_ORIGINS=https://example.cz` (viz níže).

## Přihlášení do WordPressu (jeden účet všude)

Přístupové klíče patří doméně statického webu. WordPress (např. na `http://localhost`) je sám ověřit nemůže, proto se
přihlašuje přes statický web:

1. Ve WordPressu tlačítko **Přihlásit se přístupovým klíčem** (přihlašovací stránka, widget, profil) přesměruje na
   `<statický web>/prihlaseni-pristupovym-klicem/?return=…&state=…`.
2. Tam se uživatel přihlásí přístupovým klíčem (nebo pokračuje, když už přihlášený je). Stránka si vyžádá token
   (`POST /api/auth/sso/token`) a vrátí se s ním do WordPressu.
3. WordPress ověří podpis tokenu veřejným klíčem (bez spojení s API), příjemce, platnost (2 minuty) a jednorázový
   `state` z cookie a přihlásí účet WordPressu propojený s tímto účtem z D1.

Účet WordPressu se s účtem z D1 propojí v profilu WordPressu (tlačítko **Propojit s účtem z …**). Nepropojený účet
z D1 dostane ve WordPressu nový účet s výchozí rolí jen se zapnutou registrací (Nastavení → Obecné → Kdokoli se může
zaregistrovat), jinak hlášku. Hesla WordPressu fungují dál.

Nastavení (jednou):

1. Klíč: `node .site-checks/sso-keygen.mjs` – vypíše soukromý a veřejný klíč.
2. Soukromý klíč na Cloudflare: `npx wrangler@4.168.0 pages secret put SSO_PRIVATE_KEY --project-name <název>` a vložit
   vypsaný řádek `{"kty":"OKP",…,"d":…}`. Nikam jinam ho neukládat.
3. Adresu WordPressu povolit v proměnné `ALLOWED_ORIGINS` projektu Pages (Settings → Variables and Secrets), např.
   `http://localhost` – jen z těchto adres smí API vydat token.
4. Ve WordPressu (Nastavení → Standalone template parts & options):
   - **Přihlášení přístupovým klíčem: veřejný klíč API (JWK)** – vypsaný veřejný klíč, nebo obsah adresy
     `<statický web>/api/auth/sso/public-key`,
   - **Přihlášení přístupovým klíčem: web pro přihlášení do WordPressu** – prázdné = Adresa statického webu.
5. Ve WordPressu v profilu **Propojit s účtem z …**.

## Lokální vývoj

```sh
npx wrangler@4.168.0 d1 migrations apply DB --local      # lokální databáze ve složce .wrangler/ (git ji ignoruje)
npx wrangler@4.168.0 pages dev .                          # web s API na http://localhost:8788/
```

Soubor `.dev.vars` v kořeni repozitáře (git ho ignoruje) s proměnnými pro `pages dev`:

```
SSO_PRIVATE_KEY='{"kty":"OKP","crv":"Ed25519","d":"…","x":"…"}'
ALLOWED_ORIGINS=http://localhost
```

Přístupové klíče fungují na `http://localhost:8788/`, ne na `http://127.0.0.1:8788/` (IP adresa nemůže být RP ID).
Pro přihlášení do lokálního WordPressu (`http://localhost/wordpress/`) vyplnit ve WordPressu „web pro přihlášení
do WordPressu“ = `http://localhost:8788/` a veřejný klíč z `.dev.vars` (výstup `sso-keygen.mjs`).

Databáze: `npx wrangler@4.168.0 d1 execute DB --local --command "SELECT id, display_name FROM users"` (s `--remote`
na Cloudflare).

## Nastavení API (proměnné prostředí)

V projektu Pages (Settings → Variables and Secrets), v sekci `[vars]` souboru `wrangler.toml` (tu vytváří export, ruční
změny přepíše) nebo lokálně v `.dev.vars`:

| Proměnná | Výchozí | Význam |
|---|---|---|
| `RP_ID` | doména, na které API běží | doména, ke které patří přístupové klíče (musí být doménou stránky nebo její nadřazenou doménou). Změna = staré klíče přestanou fungovat |
| `RP_NAME` | `RP_ID` | název webu v dialogu přístupových klíčů (export ho vyplní názvem webu z WordPressu) |
| `ALLOWED_ORIGINS` | – | další adresy (origin, oddělené čárkou), které smí API volat s cookie relace a do kterých smí API vydat token pro přihlášení (web WordPressu). Adresa, na které API běží, je povolená vždy |
| `SSO_PRIVATE_KEY` | – | **tajná** proměnná: soukromý klíč Ed25519 (JWK) pro tokeny WordPressu. Bez něj přihlášení do WordPressu nejde, zbytek API funguje |
| `DASHBOARD_API_TOKEN` | – | [2026-11-27] **tajná** proměnná: API token Cloudflare jen pro čtení pro `/api/dashboard` a `/api/dashboard/traffic` (sekce níže). Bez něj vrací `/api/dashboard` jen nastavení a databázi, `/api/dashboard/traffic` jen chybu |
| `WORDPRESS_PUBLIC_KEY` | – | [2026-11-27] veřejný klíč Ed25519 WordPressu (base64url), kterým `/api/dashboard` ověřuje tokeny. **Zapisuje ho export** do `[vars]` ve `wrangler.toml` |
| `ZONE_SETTINGS_API_TOKEN` | – | [2026-11-27] **tajná** proměnná: API token Cloudflare **s právem zápisu** pro `/api/zone-settings` (sekce „Nastavení zóny z WordPressu“). Bez něj nástroj ve WordPressu nic neukáže ani nezmění |

## Údaje pro nástěnku WordPressu – [2026-11-27]

`GET /api/dashboard` (`functions/api/dashboard.js`, logika `functions/_lib/dashboard.js`) dává widgetu **Cloudflare** na
nástěnce WordPressu souhrn: nastavení na Cloudflare (bez tajných hodnot), databázi D1 přes vazbu `DB` (velikost, počty
účtů, klíčů a relací, poslední migrace), projekt Pages s posledními nasazeními a jejich commity, čerpání limitů
bezplatného tarifu od půlnoci UTC (požadavky Pages Functions a Workers, řádky D1, úložiště) a chyby za posledních 7 dní
(Pages Functions podle stavu, D1 podle textu chyby – počet a poslední výskyt).

- API Cloudflare (`api.cloudflare.com`) z prohlížeče volat nejde (nemá CORS) a WordPress během požadavku nic nestahuje.
  API token proto zná jen tato funkce a prohlížeč administrátora jí posílá token podepsaný WordPressem (JWT EdDSA,
  platnost 5 minut, `aud` = adresa funkce, `scope` = `ddt-dashboard`, v údajích účet, projekt a databáze z nastavení
  WordPressu). Soukromý klíč WordPress odvozuje ze solí ve `wp-config.php`, veřejný zapisuje export do `wrangler.toml`.
- Odpověď má `Access-Control-Allow-Origin: *` – bez cookies, bez platného tokenu vrátí jen chybu.
- Část, která selže (chybí oprávnění, projekt neexistuje, datová sada není na tarifu), má místo dat
  `{ error: { code, message } }`, ostatní části se vrátí. Údaje z API Cloudflare si instance funkce pamatuje 1 minutu.
- Rozsah dotazů GraphQL Analytics API bere funkce z uzlu `settings` (co tarif účtu dovolí).

`GET /api/dashboard/traffic` (`functions/api/dashboard/traffic.js`, logika `functions/_lib/dashboard-traffic.js`) dává
widgetu **Cloudflare – provoz zóny** HTTP provoz zóny vlastní domény projektu: požadavky, přenesená data a podíl z cache
za posledních 24 hodin a po dnech (7 dní podle UTC, `httpRequests1hGroups` a `httpRequests1dGroups` – přesné součty)
a zablokované hrozby za 7 dní podle akce a ochrany s počtem a posledním výskytem (`firewallEventsAdaptive`; na
bezplatném tarifu vzorky, nejvýš 1 000 nejnovějších událostí na zónu, bez IP adres a cest). Stejný token WordPressu,
stejný `DASHBOARD_API_TOKEN`, stejné CORS. Zónu najde podle vlastních domén projektu (pole `zone_tag`) – provoz na
`.pages.dev` Cloudflare jako provoz zóny nepočítá; víc zón sečte (nejvýš 5). Údaje platí pro celou zónu.
[2026-11-27] Parametr `?days=` (1–31) změní počet dní tabulky po dnech – stránka Analytická data ve WordPressu chce 30.

[2026-11-27] Pro stránku **Analytická data** ve WordPressu (ta údaje ukládá a skládá z nich historii po dnech; widgety
nástěnky je berou od ní) jsou ještě dvě trasy se stejným tokenem WordPressu a CORS:

- `GET /api/dashboard/referrers` (`functions/api/dashboard/referrers.js`, logika `functions/_lib/dashboard-referrers.js`)
  – odkazující weby za posledních 30 dní (celé dny podle UTC, nebo kolik dovolí tarif): z HTTP požadavků zóny
  (`httpRequestsAdaptiveGroups` – jen stránky od návštěvníků s hlavičkou Referer z jiného webu než vlastní domény
  projektu; pole, která tarif nedovolí, podle `settings.availableFields` vynechá) a z Cloudflare Web Analytics
  (`rumPageloadEventsAdaptiveGroups`, bez robotů; web najde v seznamu webů Web Analytics podle zóny nebo hostitele).
  Po dnech a webech, k tomu celé adresy odkazů a cílové stránky. Odpověď si instance pamatuje 5 minut.
- `GET /api/dashboard/github` (`functions/api/dashboard/github.js`, logika `functions/_lib/dashboard-github.js`) –
  provoz repozitáře statického webu na github.com (ne webu na GitHub Pages – ten GitHub nepočítá): zobrazení
  a klonování po dnech za 14 dní, odkud lidé na repozitář přišli, nejnavštěvovanější stránky, hvězdy, forky, sledující.
  Repozitář („uživatel/název“) je v tokenu WordPressu (údaj `repository`), token GitHubu jen v tajné proměnné
  `DASHBOARD_GITHUB_TOKEN`. Odpověď si instance pamatuje 5 minut.

**Nastavení (jednou):**

1. ID účtu do WordPressu: Nastavení → Standalone template parts & options → „Cloudflare: ID účtu“ (`npx
   wrangler@4.168.0 whoami` ho vypíše).
2. API token: My Profile → API Tokens → Create Token → Create Custom Token, oprávnění **Account → Account Analytics →
   Read** a **Account → Cloudflare Pages → Read**, Account Resources = tento účet. (Ne token z GitHubu – ten smí měnit.)
   Pro provoz zóny navíc **Zone → Analytics → Read** (a nepovinně **Zone → Zone → Read** – název a tarif zóny),
   Zone Resources = zóna vlastní domény. Už vytvořený token jde upravit (Edit), jeho hodnota zůstane stejná.
3. Tajná proměnná v projektu Pages: `npx wrangler@4.168.0 pages secret put DASHBOARD_API_TOKEN --project-name <projekt>`
   (nebo Settings → Variables and Secrets → Add → Secret).
4. Export z WordPressu (zapíše `WORDPRESS_PUBLIC_KEY`) a nasazení. Proměnné se projeví až v novém nasazení.
5. [2026-11-27] Nepovinně pro Web Analytics na stránce Analytická data: zapnout Web Analytics pro doménu (Analytics &
   Logs → Web Analytics) a tokenu z bodu 2 přidat **Account → Account Settings → Read** (seznam webů Web Analytics).
6. [2026-11-27] Pro GitHub na stránce Analytická data: na GitHubu Settings → Developer settings → Fine-grained tokens →
   Generate new token, Repository access = jen tento repozitář, Repository permissions → **Administration: Read-only**
   (provoz repozitáře; Metadata: Read-only se přidá samo). Pak
   `npx wrangler@4.168.0 pages secret put DASHBOARD_GITHUB_TOKEN --project-name <projekt>` a nové nasazení.

Podrobně pro začátečníky: WordPress → Vzhled → About template → návod „Údaje z Cloudflare na nástěnce“.

Lokálně: `npx wrangler@4.168.0 pages dev .` – `/api/dashboard` přijme jen token s `aud` = lokální adresa, bez
`DASHBOARD_API_TOKEN` v `.dev.vars` vrátí jen nastavení a lokální databázi.

## Nastavení zóny z WordPressu – [2026-11-27]

`GET /api/zone-settings` a `POST /api/zone-settings` (`functions/api/zone-settings.js`, logika
`functions/_lib/zone-settings.js`) používá nástroj **Nástroje → Nastavení Cloudflare** ve WordPressu: stav a přepínání
voleb zóny vlastní domény projektu – režim Pod útokem, kontrola integrity prohlížeče, platnost ověření, Bot Fight Mode,
blokování AI robotů, AI Labyrinth, vlastní pravidla WAF proti pingbackům (`ddt-block-pingback-verification`: User-Agent
„verifying pingback from“, `ddt-block-xmlrpc`: `/xmlrpc.php` a `/wp-trackback.php`), vývojový režim, Always Online,
vyčištění celé mezipaměti, HTTPS a TLS, Email Address Obfuscation, Rocket Loader, Hotlink Protection. Režim šifrování
SSL/TLS jen čte.

- `GET` s tokenem WordPressu (`scope` = `ddt-zone-settings`, token nástěnky tu neplatí) vrátí stav voleb ve všech
  zónách vlastních domén projektu (zónu najde podle `zone_tag` domény, jako `/api/dashboard/traffic`). Bez paměti.
- `POST` provede **jen změnu z tokenu** (`change = { zone, setting, value }`, tělo požadavku se nečte; token pro změnu
  platí nejvýš 5 minut, WordPress dává 2). Funkce ji ověří proti svému seznamu `SETTINGS` (`security_level` = `off` ani
  `ssl` nedovolí) a zkontroluje, že zóna patří vlastní doméně projektu. Vrátí hodnotu před změnou a po ní.
- Pravidla WAF se při prvním zapnutí založí (sada fáze `http_request_firewall_custom` se vytvoří jen tehdy, když zóna
  žádnou nemá – jinak se pravidlo přidá na konec), pak se jen zapínají a vypínají; výraz upravený v administraci
  Cloudflare zůstane. Bezplatný tarif: 5 vlastních pravidel na zónu.
- Bot management se mění PUT se všemi stávajícími poli bezplatného tarifu (`BOT_MANAGEMENT_FIELDS`).

Nastavení (jednou):

1. API token: My Profile → API Tokens → Create Token → Custom token (**jiný** než `DASHBOARD_API_TOKEN` – tento smí
   měnit nastavení) s oprávněními **Account → Cloudflare Pages → Read**, **Zone → Zone → Read** (nepovinné – název
   a tarif zóny), **Zone → Zone Settings → Edit**, **Zone → Zone WAF → Edit**, **Zone → Bot Management → Edit**,
   **Zone → Cache Purge → Purge**; Account Resources = váš účet, Zone Resources = jen zóna domény webu.
2. `npx wrangler@4.168.0 pages secret put ZONE_SETTINGS_API_TOKEN --project-name <projekt>` a nové nasazení.
3. Ve WordPressu vyplněné ID účtu a projekt (jako pro nástěnku).

Chybějící oprávnění se ukáže jen u voleb, kterých se týká. Podrobně: WordPress → Vzhled → About template → návod „Údaje
z Cloudflare na nástěnce“, krok „Nastavení Cloudflare z WordPressu“.

## Jak to funguje

- Registrace: widget pošle jméno, API vrátí výzvu a volby pro `navigator.credentials.create()` (klíč uložený
  v autentizátoru – „discoverable“, bez atestace). Odpověď autentizátoru API ověří a v jedné transakci založí účet,
  uloží veřejný klíč a přihlásí.
- Přihlášení: výzva bez seznamu klíčů, prohlížeč nabídne klíče uložené pro tento web. API najde klíč podle ID, ověří
  podpis, počítadlo podpisů a založí relaci.
- Relace: náhodný token v cookie `__Host-ddt-session` (HttpOnly, Secure, SameSite=Strict, 30 dní), v databázi je jen
  jeho SHA-256. Widget si v `localStorage` pamatuje jen jméno, nepřihlášený návštěvník API nevolá.
- Ochrana: požadavky, které mění data, musí mít hlavičku `Origin` z povolených adres; těla jen `application/json`;
  výzvy jsou jednorázové s platností 6 minut; jméno 1–64 znaků bez řídicích znaků. Ověřuje se typ, výzva a původ
  v `clientDataJSON`, hash RP ID, přítomnost uživatele a podpis. Token pro WordPress jen pro adresu
  z `ALLOWED_ORIGINS`, s `state` od WordPressu, platnost 2 minuty.
- Profil: změna jména, seznam přístupových klíčů, přidání klíče z dalšího zařízení, odebrání klíče (ne posledního –
  ukončí i relace přihlášené tímto klíčem), smazání účtu. Signal API prohlížeče (Chrome 132+) pak správci hesel oznámí
  nové jméno, odebrané klíče i smazaný účet. Smazání účtu v D1 propojený účet WordPressu nesmaže.

## Omezení prototypu

- **Bez omezení počtu požadavků** – registrace zakládá účty bez omezení. Na produkci nastavit v Cloudflare pravidlo
  Rate limiting (Security → WAF) pro `/api/auth/*`, např. 20 požadavků za minutu z jedné IP.
- Bez atestace: server nezjišťuje, jaký autentizátor klíč vytvořil (pro přihlašování na webu to není potřeba).
- Na statickém webu přihlášení nic neodemyká – widget zatím ukazuje jen profil. Další funkce pro přihlášené přidávat
  do API (relaci zjistí `getSession()`) a do widgetu.
- Role a oprávnění jsou jen ve WordPressu, API o nich neví.
- Změna schématu databáze = nový soubor `migrations/0002_….sql` ve šabloně, hotové migrace neměnit.
