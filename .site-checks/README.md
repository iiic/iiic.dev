# Kontroly statického webu

Testy a lintery výstupu exportu „Vygenerovat statické soubory“ (WordPress, šablona domdocument-template). Běží:

- **před každým commitem** v tomto repozitáři (`.githooks/pre-commit`), i před commitem, který dělá export. Když kontroly
  najdou chybu, commit se neprovede a export skončí s hlášením v horní liště WordPressu (celý výpis je v protokolu exportu).
- **na GitHubu** po každém pushi a u pull requestů (`.github/workflows/site-checks.yml`, záložka Actions). Nálezy se
  ukážou i jako anotace u souborů. Push do výchozí větve se po úspěšných kontrolách **zveřejní** – na GitHub Pages,
  na Cloudflare Pages, nebo na obojí podle `.github/hosting.env` (viz níže). Když kontroly najdou chybu, zveřejnění se
  neprovede a na webu zůstane předchozí verze.

[2026-11-25] **Kam se zveřejňuje** určuje soubor `.github/hosting.env`, který vytváří export z nastavení WordPressu
**Hosting statického webu** (Nastavení → Standalone template parts & options):

| Hosting | `GITHUB_PAGES` | `CLOUDFLARE_PAGES` | Zveřejní |
|---|---|---|---|
| Jen GitHub | `true` | `false` | GitHub Pages – čistě statický web (export do repozitáře nedá `functions/` ani `migrations/`) |
| GitHub + Cloudflare – web i API na Cloudflare Pages | `false` | `true` | Cloudflare Pages – web i API přihlašování (`functions/README.md`) |
| GitHub + Cloudflare – web na GitHub Pages, API na Cloudflare | `true` | `true` | obojí: web na GitHub Pages, API na Cloudflare Pages (vlastní subdoména) |

Bez souboru se zveřejní jen na GitHub Pages. Soubor nahradil proměnnou repozitáře `DDT_GITHUB_PAGES` (už se nečte).
Podle stejného souboru hlídá `check-site.php` limity hostingu (kontrola `velikost`).

Aby zveřejňování na GitHub Pages hlídaly kontroly, musí být v nastavení repozitáře **Settings → Pages → Build and deployment → Source:
„GitHub Actions“**. Při „Deploy from a branch“ zveřejňuje GitHub každý push sám, bez ohledu na kontroly, a zveřejňovací
část workflow skončí chybou. Vlastní doménu (`iiic.dev`) pak GitHub bere z pole **Custom domain** ve stejném nastavení.
Soubor `CNAME` při zveřejnění přes Actions nepoužívá, kontroly z něj ale berou adresu webu. Zveřejní se obsah commitu bez
složek `.github/`, `.githooks/` a `.site-checks/` ([2026-11-25] a bez API přihlašování: `functions/`, `migrations/`,
`wrangler.toml`, `.gitignore`).

[2026-11-25] S hostingem GitHub + Cloudflare workflow po kontrolách nasadí web i s API přihlašování přístupovými klíči
na **Cloudflare Pages** (potřebuje `wrangler.toml`, ten vytváří export) – nastavení a postup jsou ve `functions/README.md`.
S webem jen na Cloudflare Pages vypněte GitHub Pages v nastavení repozitáře (Settings → Pages), jinak tam zůstane
poslední zveřejněná verze.

Složky `.site-checks/`, `.githooks/` a `.github/` ([2026-11-25] i `functions/`, `migrations/` a `.gitignore`) pochází
ze šablony (`static-export/repository/`) a každý export je přepíše. Změny proto dělat ve šabloně. Jediný soubor, který sem patří ručně, je `.site-checks/ignore.txt` (viz níže).
Ten export nevytváří ani nepřepisuje.

## Spuštění ručně

V kořeni repozitáře:

```sh
npm ci --prefix .site-checks               # jednou: nainstaluje HTML linter html-validate (Node.js 22.22+ nebo 24.8+)
php .site-checks/check-site.php            # všechny kontroly včetně html-validate (PHP 8.4+)
php .site-checks/check-site.php --max=0    # vypsat všechny nálezy, ne jen prvních 25 u každé kontroly
# podrobný výpis přímo z html-validate (s ukázkou kódu u každého nálezu):
node .site-checks/node_modules/html-validate/bin/html-validate.mjs --config .site-checks/htmlvalidate.mjs "**/*.html"
# [2026-11-25] testy API přihlašování (functions/) s podrobným výpisem:
cd .site-checks && node --test webauthn.test.mjs sso-token.test.mjs
# [2026-11-25] klíč pro přihlášení do WordPressu účtem z D1 (functions/README.md):
node .site-checks/sso-keygen.mjs
```

Bez instalace html-validate (nebo bez Node.js) se HTML linter přeskočí s upozorněním a commit to nezastaví. Na GitHubu
se instaluje vždy a bez něj kontroly neprojdou.

Jinou složku webu a veřejnou adresu jde zadat: `php check-site.php C:\cesta\k\webu --url=https://example.cz/`. Bez
`--url` se adresa vezme ze souboru `CNAME`.

V novém klonu repozitáře je potřeba hook zapnout: `git config core.hooksPath .githooks` (export to dělá sám).
Přeskočit kontroly u jednoho commitu: `git commit --no-verify`.

## Co se kontroluje

Chyby zastaví commit i zveřejnění (id kontroly je ve výpisu v hranatých závorkách za názvem kontroly):

| Kontrola | Co hledá |
|---|---|
| `povinne-soubory` | `index.html`, `404.html`, platný `CNAME`; soubory začínající `_` bez `.nojekyll` (GitHub Pages by je nezveřejnil; [2026-11-25] jen s GitHub Pages) |
| `zakazane-soubory` | PHP, SQL, databáze, `.env`, `wp-config*`, klíče (`.pem`, `.key`, `id_rsa`…), zálohy (`.bak`, `.old`, `~`) |
| `velikost` | soubor nad 100 MB (GitHub ho odmítne), web nad 1 GB (limit GitHub Pages); [2026-11-25] s Cloudflare Pages (`CLOUDFLARE_PAGES=true` v `.github/hosting.env`) soubor nad 25 MiB (Cloudflare ho nenasadí) |
| `velikost-pismen` | cesty, které se liší jen velikostí písmen (na Windows a macOS se při klonování přepíšou) |
| `syntaxe-html` | chyby parseru HTML5 (neuzavřené a překřížené značky, `&nbsp` bez středníku…) |
| `zaklad-stranky` | `<!DOCTYPE html>`, `<html lang>`, `<meta charset="utf-8">`, právě jeden neprázdný `<title>` |
| `duplicitni-id` | stejné `id` dvakrát na stránce |
| `neexistujici-cile` | odkazy, obrázky, skripty, styly, `srcset`, `url()` v CSS, adresy v sitemapě, RSS, `robots.txt` a webmanifestu, které ve webu nejsou. GitHub Pages rozlišuje velikost písmen, kontrola také |
| `neexistujici-kotvy` | `#kotva` (na stejné i jiné stránce), pro kterou na cílové stránce není prvek s tím `id` |
| `stranka-404` | relativní adresy ve `404.html` – stránka se zobrazuje na libovolné adrese, adresy musí začínat `/` |
| `integrity` | atribut `integrity` (SRI) u `<script>` a `<link>`, který nesouhlasí se souborem (prohlížeč by soubor zablokoval) |
| `lokalni-adresy` | adresy lokálního webu (`localhost`, `127.0.0.1`, `*.test`, `*.local`) v odkazech, atributech, sitemapě a JSON |
| `http-na-https` | skripty, styly, obrázky a další soubory přes `http://` (na https stránce je prohlížeč zablokuje) |
| `kanonicka-adresa` | `rel="canonical"` a `og:url` musí být celá adresa na doméně webu, nejvýš jeden canonical |
| `xml` | platnost XML: sitemapa, RSS, XSL, SVG |
| `json` | platnost JSON: soubory `.json` a `.webmanifest`, `<script type="application/ld+json">`, `importmap`, `speculationrules` |
| `testy-api` | [2026-11-25] testy API přihlašování přístupovými klíči ve `functions/` (`node --test` se soubory `.site-checks/*.test.mjs`): ověřování odpovědí WebAuthn, podvržené a poškozené odpovědi, token pro přihlášení do WordPressu (`sso-token.test.mjs`). Jen když repozitář má složku `functions/`; bez Node.js upozornění, na GitHubu chyba |
| `html-validate` | HTML linter html-validate: obsah prvků, atributy, přístupnost (odkaz bez textu, `<button>` bez `type`…). Pravidla jsou v `htmlvalidate.mjs` – doporučená sada, vypnutý jen styl zápisu, který vytváří DOMDocument. Zpráva začíná názvem pravidla v hranatých závorkách a končí selektorem prvku (celé `<body>` je na jednom řádku) |

Upozornění (commit nezastaví): `html-validate-upozorneni` (pravidla html-validate nastavená jako `warn`),
`lokalni-adresy-v-textu` (localhost zmíněný v textu článku), `alt-obrazku` (`<img>` bez `alt`), `zbytecne-soubory`
(`.DS_Store`, `Thumbs.db`), `doporuceni` (chybí `<meta name="viewport">`, `robots.txt` zakazuje celý web, [2026-11-25] s Cloudflare Pages víc než 20 000 souborů – limit bezplatného tarifu, soubor nad
50 MB, nepoužité pravidlo v `ignore.txt`, html-validate není nainstalovaný).

## Přeskočení známých nálezů – `.site-checks/ignore.txt`

Když chybu nejde nebo nechcete hned opravit (např. odkaz nebo HTML v textu článku), zapište ji do
`.site-checks/ignore.txt` v tomto repozitáři. Na každém řádku je jedno pravidlo:

```
# <kontrola nebo *>  <soubor>  [text, který zpráva obsahuje]
neexistujici-cile  o-csp-v-2020/index.html  /demo-http-auth-v-obrazku
neexistujici-cile  *  /css/special-article-persistent-light-async.min.css
html-validate  nejaky-clanek/index.html  [no-implicit-button-type]
html-validate  *  <small> element is not permitted as content under <picture>
```

- kontrola: id z hranatých závorek za názvem kontroly (`neexistujici-cile`, `html-validate`…), `*` = všechny kontroly,
- soubor: cesta jako ve výpisu (bez čísla řádku), smí obsahovat `*` a `?`,
- text (nepovinný, zbytek řádku): přeskočí se jen nález, jehož zpráva text obsahuje. U html-validate to může být
  pravidlo (`[no-implicit-button-type]`), text zprávy nebo selektor (`#dialog-starter`).

Pravidlo, které nic nepřeskočilo (chyba je mezitím opravená), se vypíše jako upozornění, aby se dalo smazat. Pravidla
pro `html-validate` se za nepoužitá nehlásí, když se html-validate nespustil (není nainstalovaný).
