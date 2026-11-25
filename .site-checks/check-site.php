<?php
declare(strict_types=1); // [2026-11-24] striktní typy jako v celé šabloně (pravidlo 18 v README.md šablony)
	/*
		[2026-11-24] Kontroly statického webu – testy výstupu exportu „Vygenerovat statické soubory“.

		Soubor pochází ze šablony domdocument-template (static-export/repository/.site-checks/check-site.php). Export ho
		kopíruje do repozitáře statického webu, a co se v repozitáři změní ručně, další export přepíše. Upravovat ho proto
		ve šabloně.

		Spouští ho:
		- .githooks/pre-commit před každým commitem v repozitáři statického webu, i před commitem exportu,
		- .github/workflows/site-checks.yml na GitHubu po každém pushi a pull requestu,
		- ručně: php .site-checks/check-site.php [složka webu] [--url=https://example.cz/] [--max=N]

		Potřebuje jen PHP 8.4+ (HTML5 parser \Dom\HTMLDocument), žádné knihovny ani síť. Seznam kontrol je v SiteChecker::CHECKS
		a v .site-checks/README.md.
		[2026-11-25] Navíc spouští HTML linter html-validate (Node.js), když je nainstalovaný (npm ci --prefix .site-checks),
		a jeho nálezy vypíše a přeskakuje podle .site-checks/ignore.txt jako ostatní – viz checkHtmlLint().
		[2026-11-25] Když má repozitář složku functions/ (API přihlašování přístupovými klíči na Cloudflare Pages Functions),
		spustí i její testy (node --test, .site-checks/*.test.mjs) – viz checkApiTests(). Složky functions/, migrations/
		a .wrangler/ na web nepatří a jako web se nekontrolují.
		Návratový kód: 0 = bez chyb (upozornění commit nezastaví), 1 = chyby, 2 = chybné použití.
	*/

	namespace DDT\SiteChecks;

	if ( PHP_SAPI !== 'cli' ) { // leží i ve složce šablony, přes web se spustit nesmí
		http_response_code( 403 );
		exit;
	}

	final class SiteChecker {

		const ERROR = 'error';
		const WARNING = 'warning';

		// kontroly (id se vypisuje v hlášení, podle něj se dá hledat v README)
		const REQUIRED_FILES = 'povinne-soubory';
		const FORBIDDEN_FILES = 'zakazane-soubory';
		const JUNK_FILES = 'zbytecne-soubory';
		const FILE_SIZE = 'velikost';
		const CASE_COLLISION = 'velikost-pismen';
		const HTML_SYNTAX = 'syntaxe-html';
		const HTML_BASICS = 'zaklad-stranky';
		const DUPLICATE_ID = 'duplicitni-id';
		const BROKEN_LINK = 'neexistujici-cile';
		const BROKEN_FRAGMENT = 'neexistujici-kotvy';
		const NOT_FOUND_PAGE = 'stranka-404';
		const INTEGRITY = 'integrity';
		const LOCAL_URL = 'lokalni-adresy';
		const LOCAL_URL_TEXT = 'lokalni-adresy-v-textu';
		const MIXED_CONTENT = 'http-na-https';
		const CANONICAL = 'kanonicka-adresa';
		const XML = 'xml';
		const JSON = 'json';
		const MISSING_ALT = 'alt-obrazku';
		const HTML_LINT = 'html-validate'; // [2026-11-25] nálezy HTML linteru html-validate (checkHtmlLint())
		const HTML_LINT_WARNING = 'html-validate-upozorneni';
		const API_TESTS = 'testy-api'; // [2026-11-25] testy API přihlašování ve functions/ (checkApiTests())
		const RECOMMENDATIONS = 'doporuceni';

		const CHECKS = [ // id => [ popis, závažnost ] – v tomto pořadí se vypisují
			self::REQUIRED_FILES => [ 'Povinné soubory (index.html, 404.html, CNAME, .nojekyll)', self::ERROR ],
			self::FORBIDDEN_FILES => [ 'Soubory, které na veřejný web nepatří (PHP, SQL, klíče, zálohy)', self::ERROR ],
			self::FILE_SIZE => [ 'Velikost souborů a webu (limity GitHubu)', self::ERROR ],
			self::CASE_COLLISION => [ 'Cesty, které se liší jen velikostí písmen', self::ERROR ],
			self::HTML_SYNTAX => [ 'Syntaxe HTML (chyby parseru HTML5)', self::ERROR ],
			self::HTML_BASICS => [ 'Základ stránky (doctype, jazyk, kódování, titulek)', self::ERROR ],
			self::DUPLICATE_ID => [ 'Duplicitní atribut id', self::ERROR ],
			self::BROKEN_LINK => [ 'Odkazy a soubory, které ve webu nejsou', self::ERROR ],
			self::BROKEN_FRAGMENT => [ 'Odkazy na kotvy (#id), které na stránce nejsou', self::ERROR ],
			self::NOT_FOUND_PAGE => [ 'Relativní adresy ve 404.html (zobrazuje se na libovolné adrese)', self::ERROR ],
			self::INTEGRITY => [ 'Atribut integrity (SRI) nesouhlasí se souborem', self::ERROR ],
			self::LOCAL_URL => [ 'Adresy lokálního webu (localhost) v odkazech a datech', self::ERROR ],
			self::MIXED_CONTENT => [ 'Soubory načítané přes http:// (prohlížeč je na https zablokuje)', self::ERROR ],
			self::CANONICAL => [ 'Kanonická adresa a og:url', self::ERROR ],
			self::XML => [ 'Platnost XML (sitemapa, RSS, XSL, SVG)', self::ERROR ],
			self::JSON => [ 'Platnost JSON (soubory, JSON-LD, importmap, speculationrules)', self::ERROR ],
			self::HTML_LINT => [ 'HTML linter html-validate (pravidla v .site-checks/htmlvalidate.mjs)', self::ERROR ],
			self::HTML_LINT_WARNING => [ 'HTML linter html-validate – upozornění', self::WARNING ],
			self::API_TESTS => [ 'Testy API přihlašování (functions/, node --test)', self::ERROR ],
			self::LOCAL_URL_TEXT => [ 'Adresy lokálního webu v textu', self::WARNING ],
			self::MISSING_ALT => [ 'Obrázky bez atributu alt', self::WARNING ],
			self::JUNK_FILES => [ 'Zbytečné soubory', self::WARNING ],
			self::RECOMMENDATIONS => [ 'Doporučení', self::WARNING ],
		];

		const SITE_URL_OPTION = '--url='; // veřejná adresa webu (jinak podle souboru CNAME)
		const MAX_OPTION = '--max='; // kolik nálezů vypsat u jedné kontroly (0 = všechny)
		const HELP_OPTIONS = [ '-h', '--help' ];
		const DEFAULT_MAX = 25;
		const IGNORE_FILE = '.site-checks/ignore.txt'; // přeskočené nálezy (loadIgnoreRules()); vytváří ho uživatel v repozitáři statického webu, export ho nepřepisuje
		const IGNORE_ANY_CHECK = '*';

		const IGNORED_ROOT_DIRECTORIES = [ '.git', '.github', '.githooks', '.site-checks', 'functions', 'migrations', '.wrangler' ]; // nástroje repozitáře, na webu nejsou ([2026-11-25] functions/ a migrations/: API na Cloudflare – workflow je nezveřejňuje jako soubory webu; .wrangler/: lokální databáze D1)
		const IGNORED_DIRECTORY_NAMES = [ 'node_modules' ];
		// [2026-11-25] HTML linter html-validate (checkHtmlLint())
		const HTML_LINT_RUNNER = 'run-html-validate.mjs'; // ve složce tohoto skriptu
		const HTML_LINT_PACKAGE = 'node_modules/html-validate/package.json'; // ve složce tohoto skriptu, existuje po instalaci
		const HTML_LINT_INSTALL = 'npm ci --prefix .site-checks';
		const HTML_LINT_ERROR = 2; // závažnost nálezu v html-validate (1 = upozornění)
		const PACKAGE_FILE = '.site-checks/package.json'; // u něj se hlásí, že html-validate nejde spustit
		const NODE_BINARY = 'node';
		// [2026-11-25] testy API přihlašování (checkApiTests())
		const FUNCTIONS_DIRECTORY = 'functions'; // v kořeni repozitáře (o úroveň výš než tento skript)
		const API_TEST_PATTERN = '*.test.mjs'; // ve složce tohoto skriptu
		const COMMAND_NOT_FOUND = 127; // návratový kód, když program neexistuje (Linux, macOS)
		const CNAME_FILE = 'CNAME';
		const NOJEKYLL_FILE = '.nojekyll';
		const INDEX_FILE = 'index.html';
		const NOT_FOUND_FILE = '404.html';
		const ROBOTS_FILE = 'robots.txt';
		const HTML_EXTENSIONS = [ 'html', 'htm' ];
		const XML_EXTENSIONS = [ 'xml', 'xsl', 'xslt', 'svg', 'rss', 'atom' ];
		const XSL_EXTENSIONS = [ 'xsl', 'xslt' ];
		const JSON_EXTENSIONS = [ 'json', 'webmanifest' ];
		const MANIFEST_EXTENSION = 'webmanifest';
		const CSS_EXTENSION = 'css';
		const FORBIDDEN_EXTENSIONS = [ 'php', 'phtml', 'phar', 'phps', 'php3', 'php4', 'php5', 'php7', 'php8', 'inc', 'sql', 'sqlite', 'sqlite3', 'db', 'env', 'pem', 'key', 'p12', 'pfx', 'ppk', 'bak', 'old', 'orig', 'swp', 'log' ];
		const FORBIDDEN_NAMES = [ '.htpasswd', '.git-credentials', '.npmrc', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk' ];
		const FORBIDDEN_NAME_PREFIXES = [ '.env', 'wp-config' ];
		const JUNK_NAMES = [ '.ds_store', 'thumbs.db', 'desktop.ini' ];
		const MAX_FILE_SIZE = 100 * 1024 * 1024; // GitHub soubor nad 100 MB odmítne
		const LARGE_FILE_SIZE = 50 * 1024 * 1024; // od 50 MB GitHub při pushi varuje
		const MAX_SITE_SIZE = 1024 * 1024 * 1024; // GitHub Pages: web nejvýš 1 GB

		const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
		const URL_SCHEMES = [ 'http', 'https' ]; // jiná schémata (mailto:, tel:, data:, javascript:…) se nekontrolují
		const ORIGIN_ONLY_RELS = [ 'preconnect', 'dns-prefetch' ]; // <link href> jen s doménou – soubor to není
		const LOADING_RELS = [ 'stylesheet', 'icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon', 'preload', 'modulepreload', 'prefetch', 'manifest' ]; // <link>, který prohlížeč stahuje
		const URL_ATTRIBUTE_SELECTOR = '[href], [src], [srcset], [imagesrcset], [poster], object[data], [action], [formaction], blockquote[cite], q[cite], del[cite], ins[cite], meta[content]';
		const URL_ATTRIBUTES = [ 'href', 'src', 'poster', 'action', 'formaction', 'cite' ];
		const SRCSET_ATTRIBUTES = [ 'srcset', 'imagesrcset' ];
		const SUBRESOURCE_ELEMENTS = [ 'script', 'img', 'source', 'video', 'audio', 'track', 'iframe', 'embed', 'object', 'input' ]; // jejich adresu prohlížeč stahuje (smíšený obsah)
		const JSON_SCRIPT_TYPES = [ 'application/ld+json', 'application/json', 'importmap', 'speculationrules' ];
		const SAFE_FRAGMENTS = [ '', 'top' ]; // # a #top posunou na začátek stránky i bez prvku s id
		const TEXT_FRAGMENT_PREFIX = ':~:'; // #:~:text=… (zvýraznění textu)
		const SRI_ALGORITHMS = [ 'sha512', 'sha384', 'sha256' ]; // od nejsilnějšího – prohlížeč použije nejsilnější uvedený
		const MANIFEST_URL_KEYS = [ 'start_url', 'scope', 'src', 'url' ]; // klíče webmanifestu s adresou (icons[].src, shortcuts[].url…)
		const SITEMAP_ROOTS = [ 'urlset', 'sitemapindex' ];
		const XML_URL_ATTRIBUTES = [ 'href', 'url', 'src' ]; // atributy s adresou v XML (atom:link, enclosure, xml-stylesheet)

		// adresa lokálního webu: localhost, *.localhost, 127.x.x.x, [::1], *.test, *.local (jako \VARS\STATIC_EXPORT::LOCAL_HOSTS šablony); i v JSON (\/\/localhost)
		const LOCAL_URL_PATTERN = '~(?:https?:)?(?://|\\\\/\\\\/)(?:(?:[a-z0-9-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\]|(?:[a-z0-9-]+\.)+(?:test|local))(?::\d+)?(?![a-z0-9.-])~i';
		const HOSTNAME_PATTERN = '~^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$~i';
		const CSS_URL_PATTERN = '~url\(\s*([\'"]?)(.*?)\1\s*\)|@import\s+([\'"])(.*?)\3~is';
		const META_REFRESH_PATTERN = '~^\s*\d*(?:\.\d+)?\s*[;,]\s*(?:url\s*=\s*)?([\'"]?)(.+?)\1\s*$~i';

		private string $root;
		private ?string $siteHost = null; // doména veřejného webu (z CNAME nebo --url) – absolutní adresy na ni se kontrolují jako místní
		private string $sitePath = '/';
		private string $siteUrlSource = '';
		private int $max;
		private bool $color;
		private bool $githubActions;

		private array $files = [];          // cesta (přesně podle velikosti písmen) => velikost
		private array $filesLowercase = []; // cesta malými písmeny => cesta (nápověda u odkazu, který se liší jen velikostí písmen)
		private array $pageIds = [];        // stránka HTML => [ id => true ]
		private array $references = [];     // odkazy ke kontrole po načtení všech stránek
		private array $findings = [];       // id kontroly => [ [ soubor, řádek, zpráva ], … ]
		private array $counts = [ 'html' => 0, 'xml' => 0, 'json' => 0, 'css' => 0 ];
		private array $ignoreRules = [];    // [ [ kontrola, vzor souboru, text zprávy, řádek v IGNORE_FILE, kolikrát použito ], … ]
		private int $ignored = 0;
		private ?string $htmlLintVersion = null; // [2026-11-25] verze html-validate, null = linter se nespustil
		private string $htmlLintSkipped = '';    // proč se nespustil
		private ?string $apiTestsResult = null;  // [2026-11-25] souhrn testů API („7 prošlo“), null = nespustily se
		private string $apiTestsSkipped = '';    // proč se nespustily

		public function __construct( string $root, ?string $siteUrl, int $max )
		{
			$this->root = rtrim( str_replace( '\\', '/', $root ), '/' );
			$this->max = $max;
			$this->githubActions = getenv( 'GITHUB_ACTIONS' ) === 'true';
			$this->color = getenv( 'NO_COLOR' ) === false && ( $this->githubActions || ( function_exists( 'stream_isatty' ) && stream_isatty( STDOUT ) ) );
			if ( $siteUrl !== null ) {
				$this->setSiteUrl( $siteUrl, 'parametr ' . self::SITE_URL_OPTION );
			}
		}

		public function run() : int
		{
			$startedAt = microtime( true );
			$this->loadIgnoreRules();
			$this->collectFiles();
			$this->checkRepositoryFiles();
			$htmlFiles = [];
			foreach ( $this->fileList() as $file ) {
				$extension = $this->extensionOf( $file );
				if ( in_array( $extension, self::HTML_EXTENSIONS, true ) ) {
					$this->checkHtmlFile( $file );
					$htmlFiles[] = $file;
				}
			}
			$this->checkHtmlLint( $htmlFiles );
			$this->checkApiTests(); // [2026-11-25]
			foreach ( $this->fileList() as $file ) { // až po stránkách: odkazy z XML a JSON se ověřují stejně
				$extension = $this->extensionOf( $file );
				if ( in_array( $extension, self::XML_EXTENSIONS, true ) ) {
					$this->checkXmlFile( $file );
				} else if ( in_array( $extension, self::JSON_EXTENSIONS, true ) ) {
					$this->checkJsonFile( $file );
				} else if ( $extension === self::CSS_EXTENSION ) {
					$this->counts['css']++;
					$this->checkCss( $this->read( $file ), $file, $this->directoryOf( $file ), 1, $file === self::NOT_FOUND_FILE );
				}
			}
			$this->checkRobots();
			$this->checkReferences();
			$this->reportUnusedIgnoreRules();
			return $this->report( microtime( true ) - $startedAt );
		}

		/* ---------- soubory ---------- */

		private function collectFiles() : void
		{
			$iterator = new \RecursiveIteratorIterator( new \RecursiveCallbackFilterIterator(
				new \RecursiveDirectoryIterator( $this->root, \FilesystemIterator::SKIP_DOTS ),
				function ( \SplFileInfo $file ) : bool {
					if ( !$file->isDir() ) {
						return true;
					}
					$relative = $this->relativePath( $file->getPathname() );
					return !in_array( $file->getFilename(), self::IGNORED_DIRECTORY_NAMES, true ) && !in_array( $relative, self::IGNORED_ROOT_DIRECTORIES, true );
				}
			) );
			foreach ( $iterator as $file ) {
				if ( $file->isFile() ) {
					$relative = $this->relativePath( $file->getPathname() );
					$this->files[$relative] = (int) $file->getSize();
				}
			}
			ksort( $this->files, SORT_STRING );
			foreach ( $this->fileList() as $file ) {
				$lowercase = strtolower( $file );
				if ( isset( $this->filesLowercase[$lowercase] ) ) {
					$this->add( self::CASE_COLLISION, $file, 0, 'stejná cesta jako ' . $this->filesLowercase[$lowercase] . ' – na Windows a macOS se při klonování přepíšou' );
					continue;
				}
				$this->filesLowercase[$lowercase] = $file;
			}
		}

		private function checkRepositoryFiles() : void
		{
			if ( $this->siteHost === null && isset( $this->files[self::CNAME_FILE] ) ) {
				$lines = preg_split( '~\R~', trim( $this->read( self::CNAME_FILE ) ) );
				$host = trim( (string) $lines[0] );
				if ( count( $lines ) !== 1 || !preg_match( self::HOSTNAME_PATTERN, $host ) ) {
					$this->add( self::REQUIRED_FILES, self::CNAME_FILE, 1, 'má obsahovat jen doménu na jednom řádku (např. example.cz), obsahuje „' . $this->shorten( trim( $this->read( self::CNAME_FILE ) ) ) . '“' );
				} else {
					$this->setSiteUrl( 'https://' . $host . '/', 'soubor ' . self::CNAME_FILE );
				}
			}
			if ( !isset( $this->files[self::INDEX_FILE] ) ) {
				$this->add( self::REQUIRED_FILES, self::INDEX_FILE, 0, 'chybí úvodní stránka' );
			}
			if ( !isset( $this->files[self::NOT_FOUND_FILE] ) ) {
				$this->add( self::REQUIRED_FILES, self::NOT_FOUND_FILE, 0, 'chybí stránka 404 (GitHub Pages by místo ní zobrazil svou)' );
			}
			if ( $this->siteHost === null ) {
				$this->add( self::RECOMMENDATIONS, self::CNAME_FILE, 0, 'chybí – absolutní adresy webu (canonical, sitemapa, RSS) se nekontrolují; adresu jde zadat parametrem ' . self::SITE_URL_OPTION );
			}
			$total = 0;
			foreach ( $this->fileList() as $file ) {
				$size = $this->files[$file];
				$total += $size;
				$name = strtolower( basename( $file ) );
				$extension = $this->extensionOf( $file );
				if ( in_array( $extension, self::FORBIDDEN_EXTENSIONS, true ) || in_array( $name, self::FORBIDDEN_NAMES, true ) || $this->startsWithAny( $name, self::FORBIDDEN_NAME_PREFIXES ) || str_ends_with( $name, '~' ) ) {
					$this->add( self::FORBIDDEN_FILES, $file, 0, 'na veřejný web nepatří (zdrojový kód, data, klíč nebo záloha)' );
				} else if ( in_array( $name, self::JUNK_NAMES, true ) ) {
					$this->add( self::JUNK_FILES, $file, 0, 'soubor systému, na web nepatří' );
				}
				if ( $size > self::MAX_FILE_SIZE ) {
					$this->add( self::FILE_SIZE, $file, 0, sprintf( '%s – GitHub soubory nad 100 MB odmítne', $this->formatSize( $size ) ) );
				} else if ( $size > self::LARGE_FILE_SIZE ) {
					$this->add( self::RECOMMENDATIONS, $file, 0, sprintf( '%s – GitHub od 50 MB varuje, zvažte menší soubor', $this->formatSize( $size ) ) );
				}
				if ( !isset( $this->files[self::NOJEKYLL_FILE] ) && preg_match( '~(?:^|/)_~', $file ) ) {
					$this->add( self::REQUIRED_FILES, $file, 0, 'začíná podtržítkem a bez souboru .nojekyll ho GitHub Pages (Jekyll) nezveřejní' );
				}
			}
			if ( $total > self::MAX_SITE_SIZE ) {
				$this->add( self::FILE_SIZE, '.', 0, sprintf( 'web má %s – GitHub Pages zveřejní nejvýš 1 GB', $this->formatSize( $total ) ) );
			}
		}

		/* ---------- stránky HTML ---------- */

		private function checkHtmlFile( string $file ) : void
		{
			$this->counts['html']++;
			$html = $this->read( $file );
			$isNotFoundPage = $file === self::NOT_FOUND_FILE;
			$directory = $this->directoryOf( $file );

			libxml_use_internal_errors( true );
			libxml_clear_errors();
			try {
				$document = \Dom\HTMLDocument::createFromString( $html, 0, 'UTF-8' );
			} catch ( \Throwable $exception ) {
				$this->add( self::HTML_SYNTAX, $file, 0, 'stránku nejde načíst: ' . $exception->getMessage() );
				return;
			}
			foreach ( libxml_get_errors() as $error ) {
				$this->add( self::HTML_SYNTAX, $file, (int) $error->line, $this->parserMessage( $error->message, (int) $error->column ) );
			}
			libxml_clear_errors();

			// základ stránky
			if ( $document->doctype === null || strtolower( (string) $document->doctype->name ) !== 'html' ) {
				$this->add( self::HTML_BASICS, $file, 1, 'chybí <!DOCTYPE html> (prohlížeč stránku zobrazí v režimu quirks)' );
			}
			$root = $document->documentElement;
			if ( $root === null || trim( (string) $root->getAttribute( 'lang' ) ) === '' ) {
				$this->add( self::HTML_BASICS, $file, $root ? $this->lineOf( $root ) : 0, 'chybí jazyk stránky (<html lang="…">)' );
			}
			$charset = null;
			foreach ( $document->querySelectorAll( 'meta[charset], meta[http-equiv="content-type" i]' ) as $meta ) {
				$charset ??= $meta->hasAttribute( 'charset' ) ? (string) $meta->getAttribute( 'charset' ) : (string) preg_replace( '~^.*charset\s*=\s*~i', '', (string) $meta->getAttribute( 'content' ) );
			}
			if ( $charset === null ) {
				$this->add( self::HTML_BASICS, $file, 0, 'chybí <meta charset="utf-8">' );
			} else if ( strtolower( trim( $charset ) ) !== 'utf-8' ) {
				$this->add( self::HTML_BASICS, $file, 0, 'kódování stránky je „' . $charset . '“, má být utf-8' );
			}
			$titles = array_filter( iterator_to_array( $document->getElementsByTagName( 'title' ) ), fn( \Dom\Element $title ) : bool => $title->namespaceURI === self::HTML_NAMESPACE );
			$hasRefresh = $document->querySelector( 'meta[http-equiv="refresh" i]' ) !== null;
			if ( count( $titles ) !== 1 ) {
				$this->add( self::HTML_BASICS, $file, 0, count( $titles ) ? sprintf( 'stránka má %d prvků <title>, má mít jeden', count( $titles ) ) : 'chybí <title>' );
			} else if ( trim( (string) reset( $titles )->textContent ) === '' ) {
				$this->add( self::HTML_BASICS, $file, $this->lineOf( reset( $titles ) ), 'prázdný <title>' );
			}
			if ( !$hasRefresh && $document->querySelector( 'meta[name="viewport" i]' ) === null ) {
				$this->add( self::RECOMMENDATIONS, $file, 0, 'chybí <meta name="viewport"> – na mobilu se stránka zobrazí zmenšená' );
			}

			// id a kotvy
			$ids = [];
			foreach ( $document->querySelectorAll( '[id]' ) as $element ) {
				$id = (string) $element->getAttribute( 'id' );
				if ( isset( $ids[$id] ) ) {
					$this->add( self::DUPLICATE_ID, $file, $this->lineOf( $element ), sprintf( 'id="%s" už je na řádku %d', $this->shorten( $id ), $ids[$id] ) );
					continue;
				}
				$ids[$id] = $this->lineOf( $element );
			}
			foreach ( $document->querySelectorAll( 'a[name]' ) as $anchor ) {
				$ids[(string) $anchor->getAttribute( 'name' )] ??= $this->lineOf( $anchor );
			}
			$this->pageIds[$file] = array_fill_keys( array_map( 'strval', array_keys( $ids ) ), true );

			// adresy
			$canonicals = [];
			foreach ( $document->querySelectorAll( self::URL_ATTRIBUTE_SELECTOR ) as $element ) {
				$tag = strtolower( $element->localName );
				$line = $this->lineOf( $element );
				$rels = $tag === 'link' ? $this->relsOf( $element ) : [];
				if ( array_intersect( $rels, self::ORIGIN_ONLY_RELS ) ) {
					continue;
				}
				$isSubresource = in_array( $tag, self::SUBRESOURCE_ELEMENTS, true ) || array_intersect( $rels, self::LOADING_RELS );
				$values = []; // [ atribut, adresa ]
				foreach ( self::URL_ATTRIBUTES as $attribute ) {
					if ( $element->hasAttribute( $attribute ) ) {
						$values[] = [ $attribute, trim( (string) $element->getAttribute( $attribute ) ) ];
					}
				}
				foreach ( self::SRCSET_ATTRIBUTES as $attribute ) {
					foreach ( $this->splitSrcset( (string) $element->getAttribute( $attribute ) ) as $url ) {
						$values[] = [ $attribute, $url ];
					}
				}
				if ( $tag === 'object' ) {
					$values[] = [ 'data', trim( (string) $element->getAttribute( 'data' ) ) ];
				}
				if ( $tag === 'meta' ) {
					$content = (string) $element->getAttribute( 'content' );
					if ( strtolower( (string) $element->getAttribute( 'http-equiv' ) ) === 'refresh' ) {
						if ( preg_match( self::META_REFRESH_PATTERN, $content, $match ) ) {
							$values[] = [ 'http-equiv="refresh"', trim( $match[2] ) ];
						}
					} else if ( preg_match( '~^\s*https?://~i', $content ) ) {
						$values[] = [ 'content', trim( $content ) ]; // og:url, og:image, twitter:image…
						$property = strtolower( (string) $element->getAttribute( 'property' ) );
						if ( $property === 'og:url' ) {
							$this->checkAbsoluteSiteUrl( trim( $content ), $file, $line, '<meta property="og:url" content' );
						}
					}
				}
				if ( in_array( 'canonical', $rels, true ) ) {
					$canonicals[] = [ trim( (string) $element->getAttribute( 'href' ) ), $line ];
				}
				foreach ( $values as [ $attribute, $value ] ) {
					if ( $value === '' ) {
						continue;
					}
					$label = '<' . $tag . ' ' . $attribute . '="' . $this->shorten( $value ) . '">';
					if ( preg_match( self::LOCAL_URL_PATTERN, $value ) ) {
						$this->add( self::LOCAL_URL, $file, $line, $label . ' vede na lokální web' );
						continue;
					}
					if ( $isSubresource && $attribute !== 'cite' && preg_match( '~^http://~i', $value ) ) {
						$this->add( self::MIXED_CONTENT, $file, $line, $label . ' – na https stránce se nenačte, použijte https://' );
					}
					if ( $isNotFoundPage && $this->isRelativeReference( $value ) ) {
						$this->add( self::NOT_FOUND_PAGE, $file, $line, $label . ' – 404.html se zobrazuje na libovolné adrese, adresa musí začínat lomítkem' );
						continue;
					}
					$this->addReference( $file, $line, $label, $value, $isNotFoundPage ? '' : $directory, true );
				}
				if ( $element->hasAttribute( 'integrity' ) && in_array( $tag, [ 'script', 'link' ], true ) ) {
					$this->checkIntegrity( $element, $file, $line, $isNotFoundPage ? '' : $directory );
				}
			}
			if ( count( $canonicals ) > 1 ) {
				$this->add( self::CANONICAL, $file, $canonicals[1][1], 'stránka má ' . $this->plural( count( $canonicals ), 'odkaz', 'odkazy', 'odkazů' ) . ' rel="canonical", má mít nejvýš jeden' );
			}
			foreach ( $canonicals as [ $href, $line ] ) {
				if ( $this->checkAbsoluteSiteUrl( $href, $file, $line, '<link rel="canonical" href' ) && !$hasRefresh && !$isNotFoundPage ) {
					$target = $this->resolve( $href, $directory );
					$targetFile = $target && !$target['outside'] ? $this->findTarget( $target['path'] ) : null;
					if ( $targetFile !== null && $targetFile !== $file ) {
						$this->add( self::CANONICAL, $file, $line, sprintf( 'rel="canonical" vede na jinou stránku (%s) – vyhledávače tuto stránku vynechají', $targetFile ) );
					}
				}
			}

			// obrázky, vložená data, styly, text
			foreach ( $document->querySelectorAll( 'img:not([alt])' ) as $image ) {
				$this->add( self::MISSING_ALT, $file, $this->lineOf( $image ), '<img src="' . $this->shorten( (string) $image->getAttribute( 'src' ) ) . '"> – doplňte alt (u ozdobného obrázku alt="")' );
			}
			foreach ( $document->querySelectorAll( 'script[type]' ) as $script ) {
				$type = strtolower( trim( (string) $script->getAttribute( 'type' ) ) );
				if ( in_array( $type, self::JSON_SCRIPT_TYPES, true ) && !$script->hasAttribute( 'src' ) ) {
					$this->counts['json']++;
					$this->checkJsonText( (string) $script->textContent, $file, $this->lineOf( $script ), '<script type="' . $type . '">' );
				}
			}
			foreach ( $document->querySelectorAll( 'style' ) as $style ) {
				$this->checkCss( (string) $style->textContent, $file, $directory, $this->lineOf( $style ), $isNotFoundPage );
			}
			foreach ( $document->querySelectorAll( '[style]' ) as $element ) {
				$this->checkCss( (string) $element->getAttribute( 'style' ), $file, $directory, $this->lineOf( $element ), $isNotFoundPage );
			}
			foreach ( $document->querySelectorAll( '*' ) as $element ) { // ostatní atributy (data-*, …) – adresa lokálního webu tam nefunguje
				foreach ( $element->attributes as $attribute ) {
					if ( !in_array( strtolower( $attribute->name ), array_merge( self::URL_ATTRIBUTES, self::SRCSET_ATTRIBUTES, [ 'data', 'content' ] ), true ) && preg_match( self::LOCAL_URL_PATTERN, $attribute->value ) ) {
						$this->add( self::LOCAL_URL, $file, $this->lineOf( $element ), sprintf( '<%s %s="%s"> obsahuje adresu lokálního webu', strtolower( $element->localName ), $attribute->name, $this->shorten( $attribute->value ) ) );
					}
				}
			}
			$xpath = new \Dom\XPath( $document );
			foreach ( $xpath->query( '//text()' ) as $text ) {
				$parent = $text->parentNode instanceof \Dom\Element ? strtolower( $text->parentNode->localName ) : '';
				if ( $parent === 'script' && in_array( strtolower( trim( (string) $text->parentNode->getAttribute( 'type' ) ) ), self::JSON_SCRIPT_TYPES, true ) ) {
					continue; // zkontroloval checkJsonText()
				}
				if ( preg_match( self::LOCAL_URL_PATTERN, (string) $text->data, $match, PREG_OFFSET_CAPTURE ) ) {
					$line = $this->lineOf( $text ) + substr_count( substr( (string) $text->data, 0, (int) $match[0][1] ), "\n" );
					$this->add( self::LOCAL_URL_TEXT, $file, $line, sprintf( '„%s“ v %s', $match[0][0], $parent !== '' ? '<' . $parent . '>' : 'textu' ) );
				}
			}
		}

		/*
			[2026-11-25] HTML linter html-validate (Node.js, pravidla v .site-checks/htmlvalidate.mjs). Spouští ho
			.site-checks/run-html-validate.mjs se seznamem stránek na vstupu. Nálezy se vypisují a přeskakují (IGNORE_FILE)
			stejně jako nálezy ostatních kontrol; selektor na konci zprávy ukazuje místo na stránce (DOMDocument píše celé
			<body> na jeden řádek, číslo řádku samo nestačí).
			Bez instalace (HTML_LINT_INSTALL) nebo bez Node.js se linter přeskočí s upozorněním a commit to nezastaví. Na GitHubu
			(GITHUB_ACTIONS) je to chyba – web by se zveřejnil bez kontroly linterem.
		*/
		private function checkHtmlLint( array $htmlFiles ) : void
		{
			if ( !$htmlFiles ) {
				return;
			}
			$skippedCheck = $this->githubActions ? self::HTML_LINT : self::RECOMMENDATIONS;
			$nodeMissing = function () use ( $skippedCheck ) : void {
				$this->htmlLintSkipped = 'chybí Node.js';
				$this->add( $skippedCheck, self::PACKAGE_FILE, 0, 'Node.js (příkaz ' . self::NODE_BINARY . ') nejde spustit, HTML linter html-validate se přeskočil' );
			};
			if ( !is_file( __DIR__ . '/' . self::HTML_LINT_PACKAGE ) ) {
				$this->htmlLintSkipped = 'není nainstalovaný';
				$this->add( $skippedCheck, self::PACKAGE_FILE, 0, 'html-validate není nainstalovaný, HTML linter se přeskočil – instalace: ' . self::HTML_LINT_INSTALL );
				return;
			}
			$process = @proc_open( [ self::NODE_BINARY, __DIR__ . '/' . self::HTML_LINT_RUNNER ], [ [ 'pipe', 'r' ], [ 'pipe', 'w' ], [ 'pipe', 'w' ] ], $pipes, $this->root );
			if ( !is_resource( $process ) ) { // Windows: node není v PATH
				$nodeMissing();
				return;
			}
			$input = implode( "\n", $htmlFiles ) . "\n";
			while ( $input !== '' && ( $written = fwrite( $pipes[0], $input ) ) ) { // dlouhý seznam se nemusí zapsat najednou
				$input = substr( $input, $written );
			}
			fclose( $pipes[0] );
			$output = (string) stream_get_contents( $pipes[1] );
			$errorOutput = trim( (string) stream_get_contents( $pipes[2] ) );
			fclose( $pipes[1] );
			fclose( $pipes[2] );
			$code = proc_close( $process );
			if ( $code === self::COMMAND_NOT_FOUND ) {
				$nodeMissing();
				return;
			}
			$result = json_decode( $output, true );
			if ( $code !== 0 || !is_array( $result ) || !is_array( $result['messages'] ?? null ) ) {
				$this->htmlLintSkipped = 'skončil chybou';
				$reason = $errorOutput !== '' ? $errorOutput : $output;
				if ( preg_match( '~^\w*Error\b.*$~m', $reason, $match ) ) { // výpis chyby z Node.js začíná cestou a ukázkou kódu, důležitý je řádek „UserError: …“
					$reason = $match[0];
				}
				$reason = (string) preg_replace( '~\s+~', ' ', $reason );
				$this->add( self::HTML_LINT, '.site-checks/' . self::HTML_LINT_RUNNER, 0, sprintf( 'html-validate skončil chybou (kód %d): %s', $code, $this->shorten( $reason, 400 ) ) );
				return;
			}
			$this->htmlLintVersion = (string) ( $result['version'] ?? '' );
			foreach ( $result['messages'] as [ $file, $line, $severity, $rule, $message, $selector ] ) {
				$this->add(
					$severity === self::HTML_LINT_ERROR ? self::HTML_LINT : self::HTML_LINT_WARNING,
					(string) $file,
					(int) $line,
					sprintf( '[%s] %s%s', $rule, $message, (string) $selector !== '' ? ' – ' . $selector : '' )
				);
			}
		}

		/*
			[2026-11-25] Testy API přihlašování přístupovými klíči (functions/ – Cloudflare Pages Functions, widget „Přihlášení
			přístupovým klíčem“ šablony): node --test s testy z této složky (API_TEST_PATTERN). Testy importují kód relativně
			(../functions/…), takže zkouší složku functions/ repozitáře, ve kterém skript leží – spustí se, jen když existuje.
			Bez Node.js se přeskočí s upozorněním, na GitHubu (GITHUB_ACTIONS) je to chyba – API by se nasadilo bez testů.
		*/
		private function checkApiTests() : void
		{
			if ( !is_dir( dirname( __DIR__ ) . '/' . self::FUNCTIONS_DIRECTORY ) ) {
				$this->apiTestsSkipped = 'repozitář nemá složku ' . self::FUNCTIONS_DIRECTORY . '/';
				return;
			}
			$tests = array_map( 'basename', glob( __DIR__ . '/' . self::API_TEST_PATTERN ) ?: [] );
			if ( !$tests ) {
				$this->apiTestsSkipped = 'žádné testy ' . self::API_TEST_PATTERN;
				return;
			}
			$location = '.site-checks/' . ( count( $tests ) === 1 ? $tests[0] : self::API_TEST_PATTERN );
			$nodeMissing = function () use ( $location ) : void {
				$this->apiTestsSkipped = 'chybí Node.js';
				$this->add( $this->githubActions ? self::API_TESTS : self::RECOMMENDATIONS, $location, 0, 'Node.js (příkaz ' . self::NODE_BINARY . ') nejde spustit, testy API se přeskočily' );
			};
			// relativní cesty ze složky skriptu – node --test bere parametry jako vzory a zpětná lomítka z Windows by v nich nefungovala
			$process = @proc_open( array_merge( [ self::NODE_BINARY, '--test', '--test-reporter=tap' ], $tests ), [ [ 'pipe', 'r' ], [ 'pipe', 'w' ], [ 'pipe', 'w' ] ], $pipes, __DIR__ );
			if ( !is_resource( $process ) ) {
				$nodeMissing();
				return;
			}
			fclose( $pipes[0] );
			$output = (string) stream_get_contents( $pipes[1] );
			$errorOutput = trim( (string) stream_get_contents( $pipes[2] ) );
			fclose( $pipes[1] );
			fclose( $pipes[2] );
			$code = proc_close( $process );
			if ( $code === self::COMMAND_NOT_FOUND ) {
				$nodeMissing();
				return;
			}
			preg_match_all( '~^not ok \d+ - (.*)$~m', $output, $failed );
			foreach ( $failed[1] as $name ) {
				$this->add( self::API_TESTS, $location, 0, 'test neprošel: ' . trim( $name ) . ' – podrobnosti: cd .site-checks && node --test ' . implode( ' ', $tests ) );
			}
			if ( $code !== 0 && !$failed[1] ) {
				$reason = (string) preg_replace( '~\s+~', ' ', $errorOutput !== '' ? $errorOutput : $output );
				$this->add( self::API_TESTS, $location, 0, sprintf( 'node --test skončil chybou (kód %d): %s', $code, $this->shorten( $reason, 400 ) ) );
			}
			$passed = preg_match( '~^# pass (\d+)$~m', $output, $match ) ? (int) $match[1] : 0;
			$this->apiTestsResult = $passed . ' prošlo' . ( $failed[1] ? ', ' . count( $failed[1] ) . ' neprošlo' : '' );
		}

		private function checkIntegrity( \Dom\Element $element, string $file, int $line, string $directory ) : void
		{
			$attribute = strtolower( $element->localName ) === 'script' ? 'src' : 'href';
			$url = trim( (string) $element->getAttribute( $attribute ) );
			$label = '<' . strtolower( $element->localName ) . ' ' . $attribute . '="' . $this->shorten( $url ) . '">';
			$expected = []; // algoritmus => [ hash, … ]
			foreach ( preg_split( '~\s+~', trim( (string) $element->getAttribute( 'integrity' ) ), -1, PREG_SPLIT_NO_EMPTY ) as $token ) {
				if ( preg_match( '~^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$~', $token, $match ) ) {
					$expected[$match[1]][] = $match[2];
				}
			}
			if ( !$expected ) {
				$this->add( self::INTEGRITY, $file, $line, $label . ' – atribut integrity neobsahuje platný hash (sha256-…, sha384-…, sha512-…)' );
				return;
			}
			$target = $url !== '' ? $this->resolve( $url, $directory ) : null;
			if ( $target === null || $target['outside'] || $target['sameDocument'] ) {
				return; // cizí server – bez sítě se ověřit nedá
			}
			$targetFile = $this->findTarget( $target['path'] );
			if ( $targetFile === null ) {
				return; // nahlásí kontrola odkazů
			}
			foreach ( self::SRI_ALGORITHMS as $algorithm ) {
				if ( !isset( $expected[$algorithm] ) ) {
					continue;
				}
				$actual = base64_encode( (string) hash_file( $algorithm, $this->root . '/' . $targetFile, true ) );
				if ( !in_array( $actual, $expected[$algorithm], true ) ) {
					$this->add( self::INTEGRITY, $file, $line, sprintf( '%s – soubor %s má %s-%s, prohlížeč ho zablokuje', $label, $targetFile, $algorithm, $actual ) );
				}
				return; // prohlížeč ověřuje jen nejsilnější uvedený algoritmus
			}
		}

		private function checkAbsoluteSiteUrl( string $url, string $file, int $line, string $label ) : bool // canonical, og:url: celá adresa na doméně webu
		{
			if ( !preg_match( '~^https?://~i', $url ) ) {
				$this->add( self::CANONICAL, $file, $line, sprintf( '%s="%s"> – má to být celá adresa (https://…)', $label, $this->shorten( $url ) ) );
				return false;
			}
			$host = strtolower( (string) parse_url( $url, PHP_URL_HOST ) );
			if ( $this->siteHost !== null && $host !== $this->siteHost && !preg_match( self::LOCAL_URL_PATTERN, $url ) ) {
				$this->add( self::CANONICAL, $file, $line, sprintf( '%s="%s"> – vede na jinou doménu než %s', $label, $this->shorten( $url ), $this->siteHost ) );
				return false;
			}
			if ( preg_match( '~^http://~i', $url ) ) {
				$this->add( self::RECOMMENDATIONS, $file, $line, sprintf( '%s="%s"> – GitHub Pages s vlastní doménou běží na https://', $label, $this->shorten( $url ) ) );
			}
			return true;
		}

		/* ---------- CSS, XML, JSON, robots.txt ---------- */

		private function checkCss( string $css, string $file, string $directory, int $firstLine, bool $rootOnly ) : void
		{
			if ( !str_contains( $css, 'url(' ) && !str_contains( $css, '@import' ) ) {
				return;
			}
			$css = (string) preg_replace_callback( '~/\*.*?\*/~s', fn( array $comment ) : string => str_repeat( "\n", substr_count( $comment[0], "\n" ) ), $css ); // komentáře pryč, čísla řádků zůstanou
			if ( !preg_match_all( self::CSS_URL_PATTERN, $css, $matches, PREG_SET_ORDER | PREG_OFFSET_CAPTURE ) ) {
				return;
			}
			foreach ( $matches as $match ) {
				$url = trim( (string) ( ( $match[2][0] ?? '' ) !== '' ? $match[2][0] : ( $match[4][0] ?? '' ) ) );
				if ( $url === '' || str_starts_with( $url, 'data:' ) || str_starts_with( $url, '#' ) ) {
					continue;
				}
				$line = $firstLine + substr_count( substr( $css, 0, (int) $match[0][1] ), "\n" );
				$label = 'url(' . $this->shorten( $url ) . ')';
				if ( preg_match( self::LOCAL_URL_PATTERN, $url ) ) {
					$this->add( self::LOCAL_URL, $file, $line, $label . ' vede na lokální web' );
					continue;
				}
				if ( preg_match( '~^http://~i', $url ) ) {
					$this->add( self::MIXED_CONTENT, $file, $line, $label . ' – na https stránce se nenačte, použijte https://' );
				}
				if ( $rootOnly && $this->isRelativeReference( $url ) ) {
					$this->add( self::NOT_FOUND_PAGE, $file, $line, $label . ' – 404.html se zobrazuje na libovolné adrese, adresa musí začínat lomítkem' );
					continue;
				}
				$this->addReference( $file, $line, $label, $url, $rootOnly ? '' : $directory, false );
			}
		}

		private function checkXmlFile( string $file ) : void
		{
			$this->counts['xml']++;
			libxml_use_internal_errors( true );
			libxml_clear_errors();
			$document = new \DOMDocument();
			$loaded = $document->loadXML( $this->read( $file ), LIBXML_NONET | LIBXML_COMPACT | LIBXML_PARSEHUGE );
			$errors = libxml_get_errors();
			libxml_clear_errors();
			if ( !$loaded || $errors ) {
				foreach ( $errors ?: [ null ] as $error ) {
					$this->add( self::XML, $file, $error ? (int) $error->line : 0, $error ? trim( $error->message ) : 'soubor nejde načíst jako XML' );
				}
				return;
			}
			if ( $this->extensionOf( $file ) === 'svg' ) {
				return; // obrázek: jen platnost
			}
			$directory = $this->directoryOf( $file );
			$isSitemap = in_array( (string) $document->documentElement?->localName, self::SITEMAP_ROOTS, true );
			$isStylesheet = in_array( $this->extensionOf( $file ), self::XSL_EXTENSIONS, true );
			$xpath = new \DOMXPath( $document );
			foreach ( $xpath->query( '//processing-instruction("xml-stylesheet")' ) as $instruction ) {
				if ( preg_match( '~href\s*=\s*(["\'])(.*?)\1~', (string) $instruction->data, $match ) ) {
					$this->checkXmlUrl( html_entity_decode( $match[2], ENT_QUOTES | ENT_XML1, 'UTF-8' ), $file, $instruction->getLineNo(), '<?xml-stylesheet href>', $directory );
				}
			}
			foreach ( $xpath->query( '//@*' ) as $attribute ) {
				if ( in_array( strtolower( $attribute->localName ), self::XML_URL_ATTRIBUTES, true ) && !$isStylesheet ) { // v XSL jsou v atributech šablony ({sitemap:loc}), ne adresy
					$this->checkXmlUrl( trim( (string) $attribute->value ), $file, $attribute->ownerElement?->getLineNo() ?? 0, '<' . $attribute->ownerElement?->nodeName . ' ' . $attribute->nodeName . '>', $directory );
				} else if ( preg_match( self::LOCAL_URL_PATTERN, (string) $attribute->value ) ) {
					$this->add( self::LOCAL_URL, $file, $attribute->ownerElement?->getLineNo() ?? 0, sprintf( '<%s %s="%s"> obsahuje adresu lokálního webu', $attribute->ownerElement?->nodeName, $attribute->nodeName, $this->shorten( (string) $attribute->value ) ) );
				}
			}
			foreach ( $xpath->query( '//text()' ) as $text ) {
				$value = trim( (string) $text->data );
				$element = $text->parentNode;
				if ( $value === '' || !$element ) {
					continue;
				}
				if ( !$isStylesheet && preg_match( '~^\S+$~', $value ) && preg_match( '~^(?:https?:)?//~i', $value ) ) { // text je jen adresa: <loc>, <link>, <guid>, <comments>…
					$this->checkXmlUrl( $value, $file, $element->getLineNo(), '<' . $element->nodeName . '>', $directory, $isSitemap );
				} else if ( preg_match( self::LOCAL_URL_PATTERN, $value, $match ) ) {
					$this->add( self::LOCAL_URL_TEXT, $file, $element->getLineNo(), sprintf( '„%s“ v <%s>', $match[0], $element->nodeName ) );
				}
			}
		}

		private function checkXmlUrl( string $url, string $file, int $line, string $label, string $directory, bool $mustBeSiteUrl = false ) : void
		{
			if ( $url === '' ) {
				return;
			}
			$label .= ' ' . $this->shorten( $url );
			if ( preg_match( self::LOCAL_URL_PATTERN, $url ) ) {
				$this->add( self::LOCAL_URL, $file, $line, $label . ' vede na lokální web' );
				return;
			}
			if ( $mustBeSiteUrl && $this->siteHost !== null && strtolower( (string) parse_url( $url, PHP_URL_HOST ) ) !== $this->siteHost ) {
				$this->add( self::BROKEN_LINK, $file, $line, $label . ' – sitemapa musí být na doméně ' . $this->siteHost );
				return;
			}
			$this->addReference( $file, $line, $label, $url, $directory, false );
		}

		private function checkJsonFile( string $file ) : void
		{
			$this->counts['json']++;
			$data = $this->checkJsonText( $this->read( $file ), $file, 0, '' );
			if ( $this->extensionOf( $file ) !== self::MANIFEST_EXTENSION || !is_array( $data ) ) {
				return;
			}
			$directory = $this->directoryOf( $file );
			$walk = function ( array $data ) use ( &$walk, $file, $directory ) : void { // start_url, scope, icons[].src, screenshots[].src, shortcuts[].url…
				foreach ( $data as $key => $value ) {
					if ( is_array( $value ) ) {
						$walk( $value );
					} else if ( is_string( $value ) && in_array( (string) $key, self::MANIFEST_URL_KEYS, true ) && $value !== '' ) {
						$this->addReference( $file, 0, '"' . $key . '": "' . $this->shorten( $value ) . '"', $value, $directory, false );
					}
				}
			};
			$walk( $data );
		}

		private function checkJsonText( string $json, string $file, int $line, string $label ) : mixed
		{
			try {
				$data = json_decode( $json, true, 512, JSON_THROW_ON_ERROR );
			} catch ( \JsonException $exception ) {
				$this->add( self::JSON, $file, $line, trim( $label . ' neplatný JSON: ' . $exception->getMessage() ) );
				return null;
			}
			$walk = function ( mixed $value ) use ( &$walk, $file, $line, $label ) : void {
				if ( is_array( $value ) ) {
					array_walk( $value, fn( mixed $item ) => $walk( $item ) );
				} else if ( is_string( $value ) && preg_match( self::LOCAL_URL_PATTERN, $value, $match ) ) {
					$wholeUrl = (bool) preg_match( '~^\S+$~', trim( $value ) );
					$this->add( $wholeUrl ? self::LOCAL_URL : self::LOCAL_URL_TEXT, $file, $line, trim( $label . ' „' . $this->shorten( $wholeUrl ? $value : $match[0] ) . '“' ) );
				}
			};
			$walk( $data );
			return $data;
		}

		private function checkRobots() : void
		{
			if ( !isset( $this->files[self::ROBOTS_FILE] ) ) {
				return;
			}
			$agent = null;
			foreach ( preg_split( '~\R~', $this->read( self::ROBOTS_FILE ) ) as $index => $line ) {
				$line = trim( (string) preg_replace( '~#.*$~', '', $line ) );
				if ( !preg_match( '~^([a-z-]+)\s*:\s*(.*)$~i', $line, $match ) ) {
					continue;
				}
				$field = strtolower( $match[1] );
				$value = trim( $match[2] );
				if ( $field === 'user-agent' ) {
					$agent = $value;
				} else if ( $field === 'sitemap' ) {
					$this->checkXmlUrl( $value, self::ROBOTS_FILE, $index + 1, 'Sitemap:', '', true );
				} else if ( $field === 'disallow' && $value === '/' && $agent === '*' ) {
					$this->add( self::RECOMMENDATIONS, self::ROBOTS_FILE, $index + 1, 'Disallow: / – vyhledávače nesmí web indexovat (WordPress: Nastavení → Zobrazování → Viditelnost pro vyhledávače)' );
				}
			}
		}

		/* ---------- odkazy ---------- */

		private function addReference( string $file, int $line, string $label, string $url, string $directory, bool $checkFragment ) : void
		{
			$this->references[] = [ $file, $line, $label, $url, $directory, $checkFragment ];
		}

		private function checkReferences() : void // až po načtení všech stránek – kotvy na jiných stránkách
		{
			foreach ( $this->references as [ $file, $line, $label, $url, $directory, $checkFragment ] ) {
				$target = $this->resolve( $url, $directory );
				if ( $target === null ) {
					continue; // cizí web, mailto:, data:…
				}
				if ( $target['outside'] ) {
					$this->add( self::BROKEN_LINK, $file, $line, $label . ' – vede mimo web' );
					continue;
				}
				$targetFile = $target['sameDocument'] ? $file : $this->findTarget( $target['path'] );
				if ( $targetFile === null ) {
					$hint = $this->caseHint( $target['path'] );
					$this->add( self::BROKEN_LINK, $file, $line, $label . ' → /' . $target['path'] . ' neexistuje' . ( $hint !== null ? ' (soubor je jako /' . $hint . ' – GitHub Pages rozlišuje velikost písmen)' : '' ) );
					continue;
				}
				$fragment = $target['fragment'];
				if ( !$checkFragment || $fragment === null || in_array( strtolower( $fragment ), self::SAFE_FRAGMENTS, true ) || str_starts_with( $fragment, self::TEXT_FRAGMENT_PREFIX ) || !isset( $this->pageIds[$targetFile] ) ) {
					continue;
				}
				if ( !isset( $this->pageIds[$targetFile][$fragment] ) ) {
					$this->add( self::BROKEN_FRAGMENT, $file, $line, $label . ( $targetFile === $file ? ' – na stránce' : ' – na stránce ' . $targetFile ) . ' není prvek s id="' . $this->shorten( $fragment ) . '"' );
				}
			}
		}

		/*
			Adresa z odkazu → cesta ve webu. Vrací null pro cizí web a jiná schémata než http(s), jinak
			[ 'path' => cesta od kořene webu bez ? a # (dekódovaná), 'fragment' => text za # nebo null,
			  'outside' => vede nad kořen webu, 'sameDocument' => jen ?… nebo #… (stejná stránka) ].
		*/
		private function resolve( string $url, string $directory ) : ?array
		{
			$url = trim( $url );
			if ( $url === '' ) {
				return null;
			}
			$fragment = null;
			if ( ( $position = strpos( $url, '#' ) ) !== false ) {
				$fragment = rawurldecode( substr( $url, $position + 1 ) );
				$url = substr( $url, 0, $position );
			}
			if ( ( $position = strpos( $url, '?' ) ) !== false ) {
				$url = substr( $url, 0, $position );
			}
			$result = [ 'path' => '', 'fragment' => $fragment, 'outside' => false, 'sameDocument' => false ];
			if ( $url === '' ) {
				$result['sameDocument'] = true;
				return $result;
			}
			if ( str_starts_with( $url, '//' ) ) {
				$url = 'https:' . $url;
			}
			if ( preg_match( '~^([a-z][a-z0-9+.-]*):~i', $url, $match ) ) {
				if ( !in_array( strtolower( $match[1] ), self::URL_SCHEMES, true ) ) {
					return null;
				}
				$host = strtolower( (string) parse_url( $url, PHP_URL_HOST ) );
				if ( $this->siteHost === null || $host !== $this->siteHost ) {
					return null;
				}
				$path = (string) ( parse_url( $url, PHP_URL_PATH ) ?: '/' );
				if ( !str_starts_with( $path . '/', $this->sitePath ) ) {
					return null; // jiný web na stejné doméně (např. user.github.io/jiny-repozitar/)
				}
				$relative = substr( $path, strlen( $this->sitePath ) );
			} else if ( str_starts_with( $url, '/' ) ) {
				if ( !str_starts_with( $url . '/', $this->sitePath ) ) {
					$result['outside'] = true;
					return $result;
				}
				$relative = substr( $url, strlen( $this->sitePath ) );
			} else {
				$relative = ( $directory === '' ? '' : $directory . '/' ) . $url;
			}
			$normalized = $this->normalize( rawurldecode( (string) $relative ) );
			if ( $normalized === null ) {
				$result['outside'] = true;
				return $result;
			}
			$result['path'] = $normalized;
			return $result;
		}

		private function normalize( string $path ) : ?string // odstraní . a .. ; null = nad kořenem webu
		{
			$isDirectory = $path === '' || str_ends_with( $path, '/' ) || (bool) preg_match( '~(?:^|/)\.\.?$~', $path );
			$segments = [];
			foreach ( explode( '/', $path ) as $segment ) {
				if ( $segment === '' || $segment === '.' ) {
					continue;
				}
				if ( $segment === '..' ) {
					if ( !$segments ) {
						return null;
					}
					array_pop( $segments );
					continue;
				}
				$segments[] = $segment;
			}
			return $segments ? implode( '/', $segments ) . ( $isDirectory ? '/' : '' ) : '';
		}

		private function findTarget( string $path ) : ?string // soubor, který GitHub Pages pro cestu vrátí (rozlišuje velikost písmen)
		{
			if ( $path === '' || str_ends_with( $path, '/' ) ) {
				return isset( $this->files[$path . self::INDEX_FILE] ) ? $path . self::INDEX_FILE : null;
			}
			foreach ( [ $path, $path . '/' . self::INDEX_FILE, $path . '.html' ] as $candidate ) { // /slozka → /slozka/, /stranka → stranka.html
				if ( isset( $this->files[$candidate] ) ) {
					return $candidate;
				}
			}
			return null;
		}

		private function caseHint( string $path ) : ?string
		{
			$candidates = ( $path === '' || str_ends_with( $path, '/' ) ) ? [ $path . self::INDEX_FILE ] : [ $path, $path . '/' . self::INDEX_FILE, $path . '.html' ];
			foreach ( $candidates as $candidate ) {
				if ( isset( $this->filesLowercase[strtolower( $candidate )] ) ) {
					return $this->filesLowercase[strtolower( $candidate )];
				}
			}
			return null;
		}

		private function isRelativeReference( string $url ) : bool // relativní adresa (ne /…, //…, #…, ?…, schéma:)
		{
			$url = trim( $url );
			return $url !== '' && !preg_match( '~^(?:/|#|\?|[a-z][a-z0-9+.-]*:)~i', $url );
		}

		/* ---------- pomocné ---------- */

		private function setSiteUrl( string $url, string $source ) : void
		{
			$parts = parse_url( trim( $url ) );
			if ( !is_array( $parts ) || empty( $parts['host'] ) || !in_array( strtolower( (string) ( $parts['scheme'] ?? '' ) ), self::URL_SCHEMES, true ) ) {
				throw new \InvalidArgumentException( 'Neplatná adresa webu: ' . $url );
			}
			$this->siteHost = strtolower( $parts['host'] );
			$this->sitePath = '/' . trim( (string) ( $parts['path'] ?? '' ), '/' ) . '/';
			$this->sitePath = $this->sitePath === '//' ? '/' : $this->sitePath;
			$this->siteUrlSource = sprintf( 'https://%s%s (%s)', $this->siteHost, $this->sitePath, $source );
		}

		private function splitSrcset( string $value ) : array // adresy z srcset (bez popisovačů 2x, 300w)
		{
			$urls = [];
			if ( trim( $value ) !== '' && preg_match_all( '~\s*([^\s,][^\s]*?)(?:\s+[^,]+)?\s*(?:,|$)~', $value, $matches ) ) {
				$urls = array_map( 'trim', $matches[1] );
			}
			return array_filter( $urls, fn( string $url ) : bool => $url !== '' );
		}

		private function relsOf( \Dom\Element $element ) : array
		{
			return preg_split( '~\s+~', strtolower( trim( (string) $element->getAttribute( 'rel' ) ) ), -1, PREG_SPLIT_NO_EMPTY );
		}

		private function lineOf( \Dom\Node $node ) : int
		{
			return $node->getLineNo() + 1; // parser HTML5 v PHP čísluje řádky od nuly
		}

		private function parserMessage( string $message, int $column ) : string // „tree error unexpected-closed-token in Entity, line: 4, column: 14-16“ → „unexpected-closed-token (sloupec 14)“
		{
			$message = trim( (string) preg_replace( '~\s+in Entity, line: .*$~s', '', trim( $message ) ) );
			$message = (string) preg_replace( '~^(?:tokenizer|tree) error\s+~', '', $message );
			return $message . ( $column > 0 ? sprintf( ' (sloupec %d)', $column ) : '' ) . ' – viz https://html.spec.whatwg.org/multipage/parsing.html#parse-errors';
		}

		private function fileList() : array // cesty souborů jako řetězce (soubor „2024“ by byl v klíči pole číslo)
		{
			return array_map( 'strval', array_keys( $this->files ) );
		}

		private function read( string $file ) : string
		{
			return (string) file_get_contents( $this->root . '/' . $file );
		}

		private function relativePath( string $path ) : string
		{
			return substr( str_replace( '\\', '/', $path ), strlen( $this->root ) + 1 );
		}

		private function directoryOf( string $file ) : string
		{
			$directory = dirname( $file );
			return $directory === '.' ? '' : $directory;
		}

		private function extensionOf( string $file ) : string
		{
			return strtolower( pathinfo( $file, PATHINFO_EXTENSION ) );
		}

		private function startsWithAny( string $value, array $prefixes ) : bool
		{
			foreach ( $prefixes as $prefix ) {
				if ( str_starts_with( $value, $prefix ) ) {
					return true;
				}
			}
			return false;
		}

		private function shorten( string $value, int $length = 90 ) : string
		{
			$value = (string) preg_replace( '~\s+~', ' ', $value );
			return strlen( $value ) > $length ? substr( $value, 0, $length - 1 ) . '…' : $value;
		}

		private function formatSize( int $bytes ) : string
		{
			return number_format( $bytes / 1024 / 1024, 1, ',', ' ' ) . ' MB';
		}

		private function add( string $check, string $file, int $line, string $message ) : void
		{
			foreach ( $this->ignoreRules as $index => [ $ruleCheck, $rulePattern, $ruleText ] ) {
				if ( ( $ruleCheck === self::IGNORE_ANY_CHECK || $ruleCheck === $check ) && fnmatch( $rulePattern, $file ) && ( $ruleText === '' || str_contains( $message, $ruleText ) ) ) {
					$this->ignoreRules[$index][4]++;
					$this->ignored++;
					return;
				}
			}
			$this->findings[$check][] = [ $file, $line, $message ];
		}

		/*
			Nálezy, které se mají přeskočit: soubor IGNORE_FILE v repozitáři statického webu (export ho nevytváří ani
			nepřepisuje). Na každém řádku: <kontrola> <soubor> [text zprávy]
			- kontrola: id z hranatých závorek ve výpisu (např. neexistujici-cile), nebo * pro všechny kontroly,
			- soubor: cesta jako ve výpisu (bez čísla řádku), smí obsahovat * a ?,
			- text zprávy (nepovinný, zbytek řádku): přeskočí se jen nález, jehož zpráva ho obsahuje.
			Prázdné řádky a řádky začínající # se přeskakují. Pravidlo, které nic nepřeskočilo, se vypíše jako upozornění.
		*/
		private function loadIgnoreRules() : void
		{
			$path = $this->root . '/' . self::IGNORE_FILE;
			if ( !is_file( $path ) ) {
				return;
			}
			foreach ( preg_split( '~\R~', (string) file_get_contents( $path ) ) as $index => $line ) {
				$line = trim( $line );
				if ( $line === '' || str_starts_with( $line, '#' ) ) {
					continue;
				}
				$parts = preg_split( '~\s+~', $line, 3 );
				if ( count( $parts ) < 2 || ( $parts[0] !== self::IGNORE_ANY_CHECK && !isset( self::CHECKS[$parts[0]] ) ) ) {
					$this->add( self::RECOMMENDATIONS, self::IGNORE_FILE, $index + 1, 'neplatné pravidlo „' . $this->shorten( $line ) . '“ – má být: <kontrola nebo *> <soubor> [text zprávy]' );
					continue;
				}
				$this->ignoreRules[] = [ $parts[0], $parts[1], trim( $parts[2] ?? '' ), $index + 1, 0 ];
			}
		}

		private function reportUnusedIgnoreRules() : void
		{
			$rules = $this->ignoreRules;
			$this->ignoreRules = []; // upozornění samo přeskočit nejde
			foreach ( $rules as [ $check, $pattern, $text, $line, $used ] ) {
				// [2026-11-25] Když se html-validate nespustil (není nainstalovaný), jeho pravidla nemohla nic přeskočit – nejsou zbytečná.
				// [2026-11-25] Stejně tak pravidla pro testy API, když se testy nespustily.
				if ( !$used && !( $this->htmlLintVersion === null && in_array( $check, [ self::HTML_LINT, self::HTML_LINT_WARNING ], true ) ) && !( $this->apiTestsResult === null && $check === self::API_TESTS ) ) {
					$this->add( self::RECOMMENDATIONS, self::IGNORE_FILE, $line, sprintf( 'pravidlo „%s %s%s“ nic nepřeskočilo – chyba je opravená, pravidlo smažte', $check, $pattern, $text !== '' ? ' ' . $text : '' ) );
				}
			}
		}

		/* ---------- výpis ---------- */

		private function report( float $seconds ) : int
		{
			$errors = 0;
			$warnings = 0;
			$this->write( $this->paint( 'Kontroly statického webu', '1' ) . ': ' . $this->root );
			$this->write( 'Adresa webu: ' . ( $this->siteUrlSource !== '' ? $this->siteUrlSource : 'neznámá' ) );
			$this->write( sprintf( 'Zkontrolováno: %d stránek HTML, %d XML, %d JSON, %d CSS, %d souborů celkem (%s s)', $this->counts['html'], $this->counts['xml'], $this->counts['json'], $this->counts['css'], count( $this->files ), number_format( $seconds, 1, ',', ' ' ) ) );
			$this->write( 'HTML linter: ' . ( $this->htmlLintVersion !== null ? 'html-validate ' . $this->htmlLintVersion : 'nespuštěn' . ( $this->htmlLintSkipped !== '' ? ' (' . $this->htmlLintSkipped . ')' : '' ) ) ); // [2026-11-25]
			$this->write( 'Testy API: ' . ( $this->apiTestsResult ?? 'nespuštěny' . ( $this->apiTestsSkipped !== '' ? ' (' . $this->apiTestsSkipped . ')' : '' ) ) ); // [2026-11-25] řádek hledá export (\VARS\STATIC_EXPORT::CHECKS_SUMMARY_PATTERN)
			foreach ( self::CHECKS as $check => [ $title, $severity ] ) {
				$items = $this->findings[$check] ?? [];
				if ( !$items ) {
					continue;
				}
				$isError = $severity === self::ERROR;
				if ( $isError ) {
					$errors += count( $items );
				} else {
					$warnings += count( $items );
				}
				$this->write( '' );
				$this->write( $this->paint( $isError ? 'CHYBA' : 'UPOZORNĚNÍ', $isError ? '1;31' : '1;33' ) . '  ' . $title . ' (' . count( $items ) . ') [' . $check . ']' );
				foreach ( $this->max > 0 ? array_slice( $items, 0, $this->max ) : $items as [ $file, $line, $message ] ) {
					$this->write( '  ' . $this->paint( $file . ( $line > 0 ? ':' . $line : '' ), '36' ) . '  ' . $message );
				}
				if ( $this->max > 0 && count( $items ) > $this->max ) {
					$this->write( sprintf( '  … a dalších %d (všechny: %s0)', count( $items ) - $this->max, self::MAX_OPTION ) );
				}
				if ( $this->githubActions ) { // anotace u souborů v přehledu běhu a v pull requestu
					foreach ( array_slice( $items, 0, 50 ) as [ $file, $line, $message ] ) {
						$this->write( sprintf( '::%s file=%s%s,title=%s::%s', $isError ? 'error' : 'warning', $this->escapeAnnotation( $file, true ), $line > 0 ? ',line=' . $line : '', $this->escapeAnnotation( $title, true ), $this->escapeAnnotation( $message, false ) ) );
					}
				}
			}
			$this->write( '' );
			$details = array_filter( [
				$warnings ? $this->plural( $warnings, 'upozornění', 'upozornění', 'upozornění' ) : '',
				$this->ignored ? sprintf( '%d přeskočeno podle %s', $this->ignored, self::IGNORE_FILE ) : '',
			] );
			$this->write( $errors
				? $this->paint( 'Výsledek: ' . implode( ', ', array_merge( [ $this->plural( $errors, 'chyba', 'chyby', 'chyb' ) ], $details ) ) . '.', '1;31' )
				: $this->paint( 'Výsledek: bez chyb', '1;32' ) . ( $details ? ' (' . implode( ', ', $details ) . ')' : '' ) . '.'
			);
			return $errors ? 1 : 0;
		}

		private function plural( int $count, string $one, string $few, string $many ) : string
		{
			return $count . ' ' . ( $count === 1 ? $one : ( $count >= 2 && $count <= 4 ? $few : $many ) );
		}

		private function paint( string $text, string $code ) : string
		{
			return $this->color ? "\033[" . $code . 'm' . $text . "\033[0m" : $text;
		}

		private function escapeAnnotation( string $value, bool $property ) : string // https://docs.github.com/actions/reference/workflow-commands-for-github-actions
		{
			$value = str_replace( [ '%', "\r", "\n" ], [ '%25', '%0D', '%0A' ], $value );
			return $property ? str_replace( [ ':', ',' ], [ '%3A', '%2C' ], $value ) : $value;
		}

		private function write( string $line ) : void
		{
			fwrite( STDOUT, $line . "\n" );
		}
	}

	/* ---------- spuštění ---------- */

	$usage = 'Použití: php check-site.php [složka webu] [' . SiteChecker::SITE_URL_OPTION . 'https://example.cz/] [' . SiteChecker::MAX_OPTION . 'N]' . "\n"
		. '  složka webu   výchozí je repozitář, ve kterém skript leží (o úroveň výš než .site-checks)' . "\n"
		. '  ' . SiteChecker::SITE_URL_OPTION . '        veřejná adresa webu, výchozí podle souboru CNAME' . "\n"
		. '  ' . SiteChecker::MAX_OPTION . '        kolik nálezů vypsat u jedné kontroly (výchozí ' . SiteChecker::DEFAULT_MAX . ', 0 = všechny)' . "\n";
	if ( PHP_VERSION_ID < 80400 || !class_exists( \Dom\HTMLDocument::class ) ) {
		fwrite( STDERR, 'Kontroly statického webu potřebují PHP 8.4 nebo novější s rozšířením dom (HTML5 parser \Dom\HTMLDocument), toto je PHP ' . PHP_VERSION . ".\n" );
		exit( 2 );
	}
	$root = null;
	$siteUrl = null;
	$max = SiteChecker::DEFAULT_MAX;
	foreach ( array_slice( $argv, 1 ) as $argument ) {
		if ( in_array( $argument, SiteChecker::HELP_OPTIONS, true ) ) {
			fwrite( STDOUT, $usage );
			exit( 0 );
		} else if ( str_starts_with( $argument, SiteChecker::SITE_URL_OPTION ) ) {
			$siteUrl = substr( $argument, strlen( SiteChecker::SITE_URL_OPTION ) );
		} else if ( str_starts_with( $argument, SiteChecker::MAX_OPTION ) ) {
			$max = max( 0, (int) substr( $argument, strlen( SiteChecker::MAX_OPTION ) ) );
		} else if ( $root === null && !str_starts_with( $argument, '-' ) ) {
			$root = $argument;
		} else {
			fwrite( STDERR, 'Neznámý parametr: ' . $argument . "\n" . $usage );
			exit( 2 );
		}
	}
	$root = realpath( $root ?? dirname( __DIR__ ) );
	if ( $root === false || !is_dir( $root ) ) {
		fwrite( STDERR, "Složka webu neexistuje.\n" . $usage );
		exit( 2 );
	}
	try {
		exit( ( new SiteChecker( $root, $siteUrl, $max ) )->run() );
	} catch ( \InvalidArgumentException $exception ) {
		fwrite( STDERR, $exception->getMessage() . "\n" );
		exit( 2 );
	}
