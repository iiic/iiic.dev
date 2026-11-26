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
