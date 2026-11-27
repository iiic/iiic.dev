/**
* [2026-11-26] Nástroj „Nasazení statického webu“ (Nástroje → Nasazení statického webu) šablony domdocument-template:
* stránku skládá admin-tools/nasazeni-statickeho-webu.php, konstanty \VARS\STATIC_SITE_DEPLOYMENT ve functions.php,
* popis v README.md šablony – sekce „Nástroje v administraci“.
*
* Po kliknutí na tlačítko prohlížeč zjistí (PHP během požadavku nic nestahuje – pravidlo 17 v README.md):
* - jestli statický web odpovídá a jestli jeho soubory mají stejný otisk (SHA-256) jako soubory v cílové složce exportu
*   (seznam a otisky dodá PHP). HTML se porovnává bez prvků <script>: Cloudflare do něj vkládá vlastní skript s náhodnou
*   adresou (i na *.pages.dev), syrový otisk by nikdy nesouhlasil,
* - DNS záznamy domény (DNS over HTTPS, JSON API dns.google) a jestli je před webem Cloudflare (/cdn-cgi/trace),
* - který server web obsluhuje. Prohlížeč přes CORS přečte jen „bezpečné“ hlavičky (Cache-Control, Expires,
*   Last-Modified…), ne Server, X-GitHub-Request-Id ani CF-Ray. Rozhoduje proto: GitHub Pages posílá Last-Modified
*   a Expires a /index.html zobrazí, Cloudflare Pages je neposílá a /index.html přesměruje na / (308); k tomu DNS
*   (adresy GitHub Pages, CNAME na *.github.io nebo *.pages.dev) – viz detectServer(),
* - jestli to odpovídá nastavení „Hosting statického webu“,
* - projekt Cloudflare Pages (<projekt>.pages.dev) a API přihlašování (GET <API>sso/public-key),
* - poslední běh workflow site-checks.yml a poslední nasazení na GitHub Pages (veřejné API GitHubu bez přihlášení,
*   60 dotazů za hodinu; nástroj jich na jednu kontrolu potřebuje 4).
* Ověřeno 26. 11. 2026: GitHub Pages, Cloudflare Pages (i jejich přesměrování 308), /cdn-cgi/trace, dns.google
* a api.github.com posílají Access-Control-Allow-Origin: *.
*
* Požadavky jdou bez cookies a bez hlavičky Referer (adresa administrace se ven nedostane). Výsledky se skládají přes DOM
* (textContent), žádné HTML řetězce. Texty jsou z PHP (překlady), klíče v \FUNCTIONS\ADMIN_TOOL\getStaticSiteDeploymentTexts().
*
* [2026-11-26] v0.2: tlačítko „Odeslat na GitHub (git push)“ u neodeslaného commitu (settings.pushUrl) a odkaz na ruční
* spuštění workflow na GitHubu (settings.actionsUrl).
*
* @version 0.2
* @since Q4 2026
*/

/** @type {String} \VARS\STATIC_SITE_DEPLOYMENT::SETTINGS_ID */
const SETTINGS_ELEMENT_ID = 'ddt-nasazeni-statickeho-webu-settings';

/** @type {String} \VARS\STATIC_SITE_DEPLOYMENT::ROOT_ID */
const ROOT_ID = 'ddt-nasazeni-statickeho-webu';

/** @type {Object.<string, string>} \VARS\STATIC_SITE_DEPLOYMENT::…_ATTRIBUTE */
const ATTRIBUTES = Object.freeze( {
	BUTTON: 'data-deployment-check',
	STATUS: 'data-deployment-status',
	SUMMARY: 'data-deployment-summary',
	RESULTS: 'data-deployment-results',
} );

/** @type {Object.<string, string>} stav jedné kontroly */
const STATES = Object.freeze( {
	RUNNING: 'running',
	SKIPPED: 'skipped', // nešlo ověřit (chybí data, služba neodpovídá)
	INFO: 'info', // jen informace, nic se nemusí dělat
	OK: 'ok',
	WARNING: 'warning',
	ERROR: 'error',
} );

/** @type {Object.<string, string>} třídy řádku výsledku (css/admin-tools.css) */
const STATE_CLASSES = Object.freeze( { running: 'is-running', skipped: 'is-skipped', info: 'is-info', ok: 'is-ok', warning: 'is-warning', error: 'is-error' } );

/** @type {Object.<string, string>} ikony Dashicons */
const STATE_ICONS = Object.freeze( { running: 'dashicons-update', skipped: 'dashicons-minus', info: 'dashicons-info-outline', ok: 'dashicons-yes-alt', warning: 'dashicons-warning', error: 'dashicons-dismiss' } );

/** @type {Object.<string, string>} text stavu pro čtečky obrazovky (klíče textů) */
const STATE_TEXTS = Object.freeze( { running: 'stateRunning', skipped: 'stateSkipped', info: 'stateInfo', ok: 'stateOk', warning: 'stateWarning', error: 'stateError' } );

/** @type {Object.<string, string>} třída oznámení se shrnutím (wp-admin/css/common.css) */
const NOTICE_CLASSES = Object.freeze( { ok: 'notice-success', info: 'notice-info', warning: 'notice-warning', error: 'notice-error' } );

/** @type {Object.<string, string>} kdo web obsluhuje */
const SERVERS = Object.freeze( { GITHUB_PAGES: 'github-pages', CLOUDFLARE_PAGES: 'cloudflare-pages', UNKNOWN: 'unknown' } );

/** @type {Object.<string, string>} výsledek porovnání jednoho souboru */
const FILE_STATES = Object.freeze( { SAME: 'same', DIFFERENT: 'different', MISSING: 'missing', ERROR: 'error' } );

/** @type {Object.<string, string>} chyba požadavku */
const REQUEST_ERRORS = Object.freeze( { TIMEOUT: 'timeout', NETWORK: 'network', CORS: 'cors' } );

/** @type {Object.<string, number>} typy záznamů DNS a stav NXDOMAIN (RFC 1035, JSON API dns.google) */
const DNS = Object.freeze( { A: 1, NS: 2, CNAME: 5, SOA: 6, AAAA: 28, NXDOMAIN: 3, NOERROR: 0 } );

/** @type {Object.<string, string>} co říkají záznamy DNS */
const DNS_KINDS = Object.freeze( {
	GITHUB: 'github', GITHUB_CNAME: 'github-cname', PAGES_DEV_CNAME: 'pages-dev-cname', CLOUDFLARE: 'cloudflare',
	MIXED: 'mixed', LEGACY: 'legacy', OTHER: 'other', NONE: 'none', NXDOMAIN: 'nxdomain',
} );

/** @type {RegExp} Cache-Control z Cloudflare Pages (bez Last-Modified a Expires) */
const CLOUDFLARE_PAGES_CACHE_CONTROL = /must-revalidate/i;

/**
* @type {RegExp} prvky <script> – Cloudflare je do HTML vkládá (detekce botů, i na *.pages.dev), otisk HTML se proto počítá
* bez nich. Stejný výraz má PHP: \VARS\STATIC_SITE_DEPLOYMENT::SCRIPT_ELEMENT_PATTERN (\FUNCTIONS\ADMIN_TOOL\deploymentFileHash()).
*/
const SCRIPT_ELEMENT_PATTERN = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;

/** @type {String} parametr adresy, který obejde mezipaměť CDN (GitHub Pages i Cloudflare Pages ho jinak ignorují) */
const CACHE_BUSTER = 'ddt-kontrola';

/** @type {String} */
const INDEX_FILE = 'index.html';

/** @type {Array.<String>} workflow_runs[].status / deployment statuses[].state, které znamenají „ještě běží“ */
const RUNNING_GITHUB_STATES = Object.freeze( [ 'queued', 'in_progress', 'waiting', 'requested', 'pending' ] );

/** @type {Object} nastavení z PHP */
let settings = {};

/** @type {Object.<string, string>} */
let texts = {};

/** @type {String} hodnota CACHE_BUSTER – jedna na kontrolu */
let runId = '';

/**
* Text s doplněnými hodnotami (%s, %1$s… jako sprintf() v PHP). Hodnota může být i uzel DOM (odkaz) – výsledek je pole
* částí pro append().
* @returns {Array.<String|Node>}
*/
const parts = function ( /** @type {String} */ key, /** @type {...(String|Number|Node)} */ ...values )
{
	const template = String( texts[ key ] ?? key );
	const result = [];
	let index = 0;
	let last = 0;
	for ( const match of template.matchAll( /%(?:(\d+)\$)?s/g ) ) {
		result.push( template.slice( last, match.index ) );
		const value = values[ match[ 1 ] ? Number( match[ 1 ] ) - 1 : index++ ];
		result.push( value instanceof Node ? value.cloneNode( true ) : String( value ?? '' ) );
		last = match.index + match[ 0 ].length;
	}
	result.push( template.slice( last ) );
	return result.filter( ( part ) => part !== '' );
};

/** @returns {String} */
const text = ( /** @type {String} */ key, /** @type {...(String|Number)} */ ...values ) => parts( key, ...values ).map( ( part ) => part instanceof Node ? part.textContent : part ).join( '' );

/** @returns {Array.<Node>} */
const toNodes = ( /** @type {String|Node|Array} */ content ) => [ content ].flat( Infinity ).filter( ( part ) => part !== null && part !== undefined && part !== '' ).map( ( part ) => part instanceof Node ? part : document.createTextNode( String( part ) ) );

/** @returns {HTMLElement} */
const element = function ( /** @type {String} */ tagName, /** @type {Array.<String>} */ classNames = [], /** @type {String|Node|Array} */ content = [] )
{
	const node = document.createElement( tagName );
	if ( classNames.length ) {
		node.className = classNames.join( ' ' );
	}
	node.append( ...toNodes( content ) );
	return node;
};

/** @returns {HTMLElement} odkaz na jiný web: nová záložka, ikona a text pro čtečky (jako \FUNCTIONS\ADMIN_GUIDE\externalLink()) */
const externalLink = function ( /** @type {String} */ href, /** @type {String} */ label = href )
{
	const anchor = element( 'a', [], [ label, element( 'span', [ 'screen-reader-text' ], ' ' + text( 'newTab' ) ) ] );
	const icon = element( 'span', [ 'dashicons', 'dashicons-external' ] );
	icon.setAttribute( 'aria-hidden', 'true' );
	anchor.append( icon );
	anchor.href = href;
	anchor.target = '_blank';
	anchor.rel = 'noopener noreferrer';
	return anchor;
};

/** @returns {HTMLElement} odkaz do administrace tohoto webu */
const adminLink = function ( /** @type {String} */ href, /** @type {String} */ label )
{
	const anchor = element( 'a', [], label );
	anchor.href = href;
	return anchor;
};

/** @returns {HTMLElement} */
const code = ( /** @type {String} */ value ) => element( 'code', [], value );

/** @returns {Array.<String|Node>} [2026-11-26] tlačítko „Odeslat na GitHub (git push)“ – admin.php?action=ddtStaticExportPush, stav a dotazy ssh pak ukazuje horní lišta */
const pushLink = function ()
{
	const anchor = element( 'a', [ 'button', 'button-small' ], text( 'pushButton' ) );
	anchor.href = settings.pushUrl;
	return parts( 'pushHint', anchor );
};

/** @returns {String} */
const shortSha = ( /** @type {?String} */ sha ) => String( sha ?? '' ).slice( 0, 7 );

/** @returns {String} datum a čas podle jazyka uživatele administrace */
const formatDate = function ( /** @type {Date|String|Number} */ value )
{
	const date = value instanceof Date ? value : new Date( value );
	if ( Number.isNaN( date.getTime() ) ) {
		return String( value );
	}
	try {
		return new Intl.DateTimeFormat( settings.locale, { dateStyle: 'medium', timeStyle: 'short' } ).format( date );
	} catch {
		return date.toLocaleString();
	}
};

/** @returns {String} adresa s parametrem CACHE_BUSTER */
const bust = function ( /** @type {String} */ url )
{
	const address = new URL( url );
	address.searchParams.set( CACHE_BUSTER, runId );
	return address.href;
};

/**
* Požadavek bez cookies a bez Referer, s časovým limitem. Nikdy nevyhodí výjimku.
* @returns {Promise.<{ response: ?Response, body: ?ArrayBuffer, error: ?String, ms: Number }>}
*/
const request = async function ( /** @type {String} */ url, /** @type {Object} */ options = {} )
{
	const started = performance.now();
	try {
		const response = await fetch( url, {
			cache: 'no-store',
			credentials: 'omit',
			mode: 'cors',
			redirect: 'follow',
			referrerPolicy: 'no-referrer',
			signal: AbortSignal.timeout( settings.timeout ),
			...options,
		} );
		const body = await response.arrayBuffer();
		return { response, body, error: null, ms: Math.round( performance.now() - started ) };
	} catch ( error ) {
		return { response: null, body: null, error: error?.name === 'TimeoutError' ? REQUEST_ERRORS.TIMEOUT : REQUEST_ERRORS.NETWORK, ms: Math.round( performance.now() - started ) };
	}
};

/**
* request(), který u chyby sítě zjistí, jestli server odpověděl a jen chybí hlavička CORS: požadavek no-cors se pak
* povede (odpověď je neprůhledná), kdežto u nedostupného serveru (DNS, HTTPS, offline) selže taky.
*/
const probe = async function ( /** @type {String} */ url )
{
	const result = await request( url );
	if ( result.error === REQUEST_ERRORS.NETWORK ) {
		try {
			await fetch( url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout( settings.timeout ) } );
			result.error = REQUEST_ERRORS.CORS;
		} catch {
			// opravdu nedostupný
		}
	}
	return result;
};

/** @returns {?Object} JSON z odpovědi, null = není JSON */
const jsonOf = function ( /** @type {?ArrayBuffer} */ body )
{
	try {
		return JSON.parse( new TextDecoder().decode( body ?? new ArrayBuffer( 0 ) ) );
	} catch {
		return null;
	}
};

/** @returns {Promise.<?String>} SHA-256 (hex), null = prohlížeč ho neumí (crypto.subtle jen v zabezpečeném kontextu – https, localhost) */
const sha256 = async function ( /** @type {ArrayBuffer} */ body )
{
	if ( !globalThis.crypto?.subtle ) {
		return null;
	}
	const digest = await crypto.subtle.digest( 'SHA-256', body );
	return [ ...new Uint8Array( digest ) ].map( ( byte ) => byte.toString( 16 ).padStart( 2, '0' ) ).join( '' );
};

/** @returns {Boolean} počítá se otisk souboru bez prvků <script>? (settings.normalizedExtensions, jako v PHP) */
const isNormalized = ( /** @type {String} */ relative ) => settings.normalizedExtensions.includes( relative.split( '.' ).pop().toLowerCase() );

/**
* Otisk souboru stejně jako \FUNCTIONS\ADMIN_TOOL\deploymentFileHash(): HTML bez prvků <script> (UTF-8 i s případným BOM,
* jinak by text nesouhlasil s bajty, ze kterých počítá PHP), ostatní soubory celé.
* @returns {Promise.<?String>}
*/
const fileHash = async function ( /** @type {String} */ relative, /** @type {ArrayBuffer} */ body )
{
	if ( !isNormalized( relative ) ) {
		return sha256( body );
	}
	const html = new TextDecoder( 'utf-8', { ignoreBOM: true } ).decode( body );
	return sha256( new TextEncoder().encode( html.replace( SCRIPT_ELEMENT_PATTERN, '' ) ) );
};

/** @returns {String} adresa souboru z cílové složky na webu: …/index.html jako složka (Cloudflare Pages by ho jinak přesměroval) */
const fileUrl = function ( /** @type {String} */ base, /** @type {String} */ relative )
{
	const path = relative === INDEX_FILE ? '' : relative.endsWith( '/' + INDEX_FILE ) ? relative.slice( 0, -INDEX_FILE.length ) : relative;
	return new URL( path.split( '/' ).map( encodeURIComponent ).join( '/' ), base ).href;
};

/**
* Porovná soubory z cílové složky (settings.files) se soubory na adrese $base.
* @returns {Promise.<{ files: Array.<{ relative: String, state: String, status: ?Number }>, different: Number, unsupported: Boolean }>}
*/
const compareFiles = async function ( /** @type {String} */ base )
{
	const entries = Object.entries( settings.files ?? {} );
	if ( !globalThis.crypto?.subtle ) {
		return { files: [], different: 0, unsupported: true };
	}
	const files = await Promise.all( entries.map( async ( [ relative, expected ] ) =>
	{
		const result = await request( bust( fileUrl( base, relative ) ) );
		if ( result.error ) {
			return { relative, state: FILE_STATES.ERROR, status: null };
		}
		if ( !result.response.ok ) {
			return { relative, state: FILE_STATES.MISSING, status: result.response.status };
		}
		return { relative, state: await fileHash( relative, result.body ) === expected ? FILE_STATES.SAME : FILE_STATES.DIFFERENT, status: result.response.status };
	} ) );
	const notSame = files.filter( ( file ) => file.state !== FILE_STATES.SAME );
	return {
		files,
		different: notSame.length,
		// liší se jen HTML a aspoň jeden jiný soubor (XML) je stejný – HTML mohl upravit Cloudflare (Email Address Obfuscation…)
		onlyHtmlDiffers: notSame.length > 0 && notSame.every( ( file ) => file.state === FILE_STATES.DIFFERENT && isNormalized( file.relative ) )
			&& files.some( ( file ) => file.state === FILE_STATES.SAME && !isNormalized( file.relative ) ),
		unsupported: false,
	};
};

/** @returns {Array.<String|Node>} řádek podrobností k souboru */
const fileDetail = function ( /** @type {Object} */ file )
{
	switch ( file.state ) {
		case FILE_STATES.SAME: return parts( 'fileSame', code( file.relative ) );
		case FILE_STATES.DIFFERENT: return parts( 'fileDifferent', code( file.relative ) );
		case FILE_STATES.MISSING: return parts( 'fileMissing', code( file.relative ), file.status );
		default: return parts( 'fileError', code( file.relative ) );
	}
};

// ---------------------------------------------------------------------------------------------------------------------
// Adresy IP

/** @returns {?BigInt} adresa IPv4 nebo IPv6 jako číslo, null = neplatná */
const ipToBigInt = function ( /** @type {String} */ address )
{
	if ( /^\d{1,3}(\.\d{1,3}){3}$/.test( address ) ) {
		const octets = address.split( '.' ).map( Number );
		return octets.some( ( octet ) => octet > 255 ) ? null : octets.reduce( ( value, octet ) => ( value << 8n ) + BigInt( octet ), 0n );
	}
	if ( !address.includes( ':' ) ) {
		return null;
	}
	const [ head, tail, extra ] = address.toLowerCase().split( '::' );
	if ( extra !== undefined ) {
		return null;
	}
	const headGroups = head ? head.split( ':' ) : [];
	const tailGroups = tail ? tail.split( ':' ) : [];
	const missing = 8 - headGroups.length - tailGroups.length;
	if ( ( tail === undefined && missing !== 0 ) || missing < 0 ) {
		return null;
	}
	const groups = [ ...headGroups, ...Array( tail === undefined ? 0 : missing ).fill( '0' ), ...tailGroups ];
	if ( groups.length !== 8 || groups.some( ( group ) => !/^[0-9a-f]{1,4}$/.test( group ) ) ) {
		return null;
	}
	return groups.reduce( ( value, group ) => ( value << 16n ) + BigInt( parseInt( group, 16 ) ), 0n );
};

/** @returns {Boolean} je adresa v rozsahu CIDR (stejná rodina adres)? */
const isInRange = function ( /** @type {String} */ address, /** @type {String} */ range )
{
	const [ network, prefix ] = range.split( '/' );
	const isV6 = network.includes( ':' );
	if ( isV6 !== address.includes( ':' ) ) {
		return false;
	}
	const value = ipToBigInt( address );
	const start = ipToBigInt( network );
	if ( value === null || start === null ) {
		return false;
	}
	const shift = BigInt( ( isV6 ? 128 : 32 ) - Number( prefix ) );
	return ( value >> shift ) === ( start >> shift );
};

/** @returns {Boolean} */
const isSameAddress = ( /** @type {String} */ a, /** @type {String} */ b ) => ipToBigInt( a ) !== null && ipToBigInt( a ) === ipToBigInt( b );

/** @returns {Boolean} */
const isGithubPagesAddress = ( /** @type {String} */ address ) => settings.githubPagesAddresses.some( ( known ) => isSameAddress( address, known ) );

/** @returns {Boolean} */
const isLegacyGithubPagesAddress = ( /** @type {String} */ address ) => settings.githubPagesLegacyAddresses.some( ( known ) => isSameAddress( address, known ) );

/** @returns {Boolean} */
const isCloudflareAddress = ( /** @type {String} */ address ) => settings.cloudflareRanges.some( ( range ) => isInRange( address, range ) );

/** @returns {String} název bez tečky na konci, malými písmeny */
const hostName = ( /** @type {String} */ name ) => String( name ).toLowerCase().replace( /\.$/, '' );

// ---------------------------------------------------------------------------------------------------------------------
// DNS (DNS over HTTPS, JSON API: https://developers.google.com/speed/public-dns/docs/doh/json)

/** @returns {Promise.<Object>} odpověď JSON API, výjimka = služba neodpovídá */
const resolveDns = async function ( /** @type {String} */ name, /** @type {Number} */ type )
{
	const url = new URL( settings.dnsResolver );
	url.searchParams.set( 'name', name );
	url.searchParams.set( 'type', String( type ) );
	const result = await request( url.href );
	const data = result.response?.ok ? jsonOf( result.body ) : null;
	if ( !data || typeof data.Status !== 'number' ) {
		throw new Error( 'DNS' );
	}
	return data;
};

/** @returns {Promise.<Object>} záznamy domény a co znamenají; { error: true } = služba DNS neodpovídá */
const lookupDns = async function ( /** @type {String} */ host )
{
	try {
		const [ a, aaaa, ns ] = await Promise.all( [ resolveDns( host, DNS.A ), resolveDns( host, DNS.AAAA ), resolveDns( host, DNS.NS ) ] );
		if ( a.Status === DNS.NXDOMAIN ) {
			return { kind: DNS_KINDS.NXDOMAIN, addresses: [], cnames: [], nameservers: [] };
		}
		const answers = [ ...( a.Answer ?? [] ), ...( aaaa.Answer ?? [] ) ];
		const cnames = [ ...new Set( answers.filter( ( record ) => record.type === DNS.CNAME ).map( ( record ) => hostName( record.data ) ) ) ];
		const addresses = [ ...new Set( answers.filter( ( record ) => record.type === DNS.A || record.type === DNS.AAAA ).map( ( record ) => String( record.data ) ) ) ];
		// Jmenné servery: u subdomény bez vlastní zóny je v odpovědi jen SOA zóny (Authority) – zeptat se na ni
		let nameservers = ( ns.Answer ?? [] ).filter( ( record ) => record.type === DNS.NS ).map( ( record ) => hostName( record.data ) );
		const zone = ( ns.Authority ?? [] ).find( ( record ) => record.type === DNS.SOA )?.name;
		if ( !nameservers.length && zone && hostName( zone ) !== host ) {
			nameservers = ( ( await resolveDns( hostName( zone ), DNS.NS ) ).Answer ?? [] ).filter( ( record ) => record.type === DNS.NS ).map( ( record ) => hostName( record.data ) );
		}
		const github = addresses.filter( isGithubPagesAddress );
		const legacy = addresses.filter( isLegacyGithubPagesAddress );
		const cloudflare = addresses.filter( isCloudflareAddress );
		const others = addresses.filter( ( address ) => !github.includes( address ) ); // DNS_KINDS.MIXED: adresy vedle adres GitHub Pages
		let kind = DNS_KINDS.OTHER;
		if ( cnames.some( ( name ) => name.endsWith( settings.githubPagesHostSuffix ) ) ) {
			kind = DNS_KINDS.GITHUB_CNAME;
		} else if ( cnames.some( ( name ) => name.endsWith( settings.pagesDevSuffix ) ) ) {
			kind = DNS_KINDS.PAGES_DEV_CNAME;
		} else if ( !addresses.length ) {
			kind = DNS_KINDS.NONE;
		} else if ( legacy.length ) {
			kind = DNS_KINDS.LEGACY;
		} else if ( github.length && github.length === addresses.length ) {
			kind = DNS_KINDS.GITHUB;
		} else if ( github.length ) {
			kind = DNS_KINDS.MIXED;
		} else if ( cloudflare.length === addresses.length ) {
			kind = DNS_KINDS.CLOUDFLARE;
		}
		return { kind, addresses, cnames, nameservers, others, legacy };
	} catch {
		return { error: true };
	}
};

// ---------------------------------------------------------------------------------------------------------------------
// GitHub (veřejné REST API bez přihlášení)

/** @returns {Promise.<{ data: ?Object, error: ?String, reset: ?Number }>} error: 'not-found', 'rate-limit', 'http', 'network' */
const githubApi = async function ( /** @type {String} */ path )
{
	const result = await request( settings.githubApi + path, { headers: { Accept: 'application/vnd.github+json' } } );
	if ( result.error ) {
		return { data: null, error: 'network', reset: null };
	}
	const { status, headers } = result.response;
	if ( ( status === 403 || status === 429 ) && headers.get( 'x-ratelimit-remaining' ) === '0' ) {
		return { data: null, error: 'rate-limit', reset: Number( headers.get( 'x-ratelimit-reset' ) ) * 1000 || null };
	}
	if ( status === 404 ) {
		return { data: null, error: 'not-found', reset: null };
	}
	const data = result.response.ok ? jsonOf( result.body ) : null;
	return data === null ? { data: null, error: 'http', reset: null } : { data, error: null, reset: null };
};

/** @returns {Array.<String|Node>} hláška k chybě API GitHubu */
const githubError = function ( /** @type {Object} */ result )
{
	if ( result.error === 'rate-limit' ) {
		return parts( 'githubRateLimit', result.reset ? formatDate( result.reset ) : '?' );
	}
	if ( result.error === 'not-found' ) {
		return parts( 'githubPrivate', settings.github.owner + '/' + settings.github.repository );
	}
	return parts( 'githubUnavailable' );
};

/**
* Repozitář, poslední běh workflow a poslední nasazení na GitHub Pages.
* @returns {Promise.<Object>}
*/
const loadGithub = async function ()
{
	const repositoryPath = '/repos/' + encodeURIComponent( settings.github.owner ) + '/' + encodeURIComponent( settings.github.repository );
	const repository = await githubApi( repositoryPath );
	if ( repository.error ) {
		return { repository };
	}
	const branch = String( repository.data.default_branch ?? '' );
	const [ runs, deployments ] = await Promise.all( [
		githubApi( repositoryPath + '/actions/workflows/' + encodeURIComponent( settings.workflowFile ) + '/runs?per_page=1&branch=' + encodeURIComponent( branch ) ),
		githubApi( repositoryPath + '/deployments?per_page=1&environment=' + encodeURIComponent( settings.githubPagesEnvironment ) ),
	] );
	const deployment = Array.isArray( deployments.data ) ? deployments.data[ 0 ] ?? null : null;
	const statuses = deployment ? await githubApi( repositoryPath + '/deployments/' + encodeURIComponent( String( deployment.id ) ) + '/statuses?per_page=1' ) : null;
	return { repository, runs, deployments, deployment, deploymentState: Array.isArray( statuses?.data ) ? String( statuses.data[ 0 ]?.state ?? '' ) : '' };
};

// ---------------------------------------------------------------------------------------------------------------------
// Řádky výsledků

/**
* Řádek tabulky výsledků. set() ho přepíše: stav (ikona, třída, text pro čtečky), výsledek a podrobnosti (seznam).
* @returns {{ title: String, state: String, result: String, set: Function }}
*/
const createRow = function ( /** @type {HTMLElement} */ body, /** @type {String} */ title )
{
	const row = element( 'tr' );
	const icon = element( 'span' );
	icon.setAttribute( 'aria-hidden', 'true' );
	const stateText = element( 'span', [ 'screen-reader-text' ] );
	const header = element( 'th', [], [ icon, stateText, title ] );
	header.scope = 'row';
	const cell = element( 'td' );
	row.append( header, cell );
	body.append( row );
	const record = {
		title,
		state: STATES.RUNNING,
		result: '',
		set ( /** @type {String} */ state, /** @type {String|Node|Array} */ result, /** @type {Array} */ details = [] )
		{
			record.state = state;
			row.className = STATE_CLASSES[ state ];
			icon.className = 'dashicons ' + STATE_ICONS[ state ];
			stateText.textContent = text( STATE_TEXTS[ state ] ) + ' ';
			const paragraph = element( 'p', [], result );
			record.result = paragraph.textContent;
			cell.replaceChildren( paragraph );
			const items = details.filter( ( detail ) => detail && ( !Array.isArray( detail ) || detail.length ) );
			if ( items.length ) {
				cell.append( element( 'ul', [], items.map( ( detail ) => element( 'li', [], detail ) ) ) );
			}
		},
	};
	record.set( STATES.RUNNING, text( 'pending' ) );
	return record;
};

/** @returns {Array.<String|Node>} hláška k nepovedenému požadavku */
const requestError = function ( /** @type {Object} */ result, /** @type {String} */ unreachableKey )
{
	if ( result.error === REQUEST_ERRORS.TIMEOUT ) {
		return parts( 'timeout', Math.round( settings.timeout / 1000 ) );
	}
	return parts( result.error === REQUEST_ERRORS.CORS ? 'siteCors' : unreachableKey );
};

/**
* Podrobnosti odpovědi webu (přesměrování, typ obsahu, poslední změna). Cache-Control se neukazuje: prohlížeč kvůli
* cache: 'no-store' žádá no-cache a GitHub Pages pak vrací no-cache, no-store – návštěvník dostane jinou hodnotu.
* @returns {Array}
*/
const responseDetails = function ( /** @type {Response} */ response, /** @type {String} */ requestedUrl )
{
	const details = [];
	const finalUrl = new URL( response.url );
	finalUrl.searchParams.delete( CACHE_BUSTER );
	if ( response.redirected && finalUrl.href !== new URL( requestedUrl ).href ) {
		details.push( parts( 'siteRedirected', code( finalUrl.href ) ) );
	}
	const contentType = response.headers.get( 'content-type' );
	const lastModified = response.headers.get( 'last-modified' );
	if ( contentType ) {
		details.push( parts( 'detailContentType', code( contentType ) ) );
	}
	if ( lastModified ) {
		details.push( parts( 'detailLastModified', formatDate( lastModified ) ) );
	}
	return details;
};

/**
* Kdo web obsluhuje – podle hlaviček, přesměrování /index.html a DNS.
* - GitHub Pages posílá vždy Last-Modified a Expires a /index.html zobrazí. Cache-Control rozhodovat nemůže: prohlížeč
*   s cache: 'no-store' posílá Cache-Control: no-cache a GitHub Pages (Fastly) pak vrací no-cache, no-store,
*   must-revalidate místo max-age=600 (ověřeno 26. 11. 2026, curl dostane max-age=600).
* - Cloudflare Pages Last-Modified ani Expires neposílá (jen ETag, ten prohlížeč přes CORS nepřečte), Cache-Control je
*   public, max-age=0, must-revalidate a /index.html přesměruje na / (308).
* Hlavičky Last-Modified a Expires posílá i leckterý jiný server (nginx…). Bez Cloudflare před webem proto o GitHub Pages
* rozhodne až DNS (adresy GitHub Pages, CNAME na *.github.io); za proxy Cloudflare DNS skutečný server neprozradí a rozhodnou
* hlavičky.
* @returns {{ server: String, reasons: Array }}
*/
const detectServer = function ( /** @type {Object} */ site, /** @type {Object} */ index, /** @type {Object} */ dns, /** @type {Boolean} */ behindCloudflare )
{
	const headers = site.response?.headers;
	const cacheControl = String( headers?.get( 'cache-control' ) ?? '' ).trim();
	const lastModified = headers?.get( 'last-modified' );
	const expires = headers?.get( 'expires' );
	const indexServed = Boolean( index.response?.ok && !index.response.redirected );
	const indexRedirected = Boolean( index.response?.redirected && new URL( index.response.url ).pathname === new URL( settings.siteUrl ).pathname );
	const github = [];
	const cloudflare = [];
	if ( lastModified && expires && indexServed ) {
		github.push( parts( 'reasonGithubHeaders' ) );
	}
	if ( indexRedirected ) {
		cloudflare.push( parts( 'reasonIndexRedirect' ) );
	}
	if ( !lastModified && !expires && CLOUDFLARE_PAGES_CACHE_CONTROL.test( cacheControl ) ) {
		cloudflare.push( parts( 'reasonCloudflareHeaders', code( cacheControl ) ) );
	}
	const dnsGithub = [ DNS_KINDS.GITHUB, DNS_KINDS.GITHUB_CNAME ].includes( dns.kind );
	if ( dnsGithub ) {
		github.unshift( parts( 'reasonDnsGithub' ) );
	} else if ( dns.kind === DNS_KINDS.PAGES_DEV_CNAME ) {
		cloudflare.unshift( parts( 'reasonDnsPagesDev' ) );
	} else if ( [ DNS_KINDS.MIXED, DNS_KINDS.LEGACY ].includes( dns.kind ) && github.length ) {
		github.unshift( parts( 'reasonDnsPartlyGithub' ) );
	}
	const githubDecides = github.length && ( dnsGithub || behindCloudflare || github.length > 1 ); // samotné hlavičky bez Cloudflare nestačí
	if ( githubDecides && !cloudflare.length ) {
		return { server: SERVERS.GITHUB_PAGES, reasons: github };
	}
	if ( cloudflare.length && !github.length ) {
		return { server: SERVERS.CLOUDFLARE_PAGES, reasons: cloudflare };
	}
	return { server: SERVERS.UNKNOWN, reasons: [ ...github, ...cloudflare ] };
};

/** @returns {String} */
const serverLabel = function ( /** @type {String} */ server, /** @type {Boolean} */ behindCloudflare )
{
	switch ( server ) {
		case SERVERS.GITHUB_PAGES: return text( behindCloudflare ? 'serverGithubPagesProxy' : 'serverGithubPages' );
		case SERVERS.CLOUDFLARE_PAGES: return text( 'serverCloudflarePages' );
		default: return text( behindCloudflare ? 'serverUnknownCloudflare' : 'serverUnknown' );
	}
};

/** @returns {Object.<string, string>} odpověď /cdn-cgi/trace (řádky klíč=hodnota) */
const parseTrace = ( /** @type {?ArrayBuffer} */ body ) => Object.fromEntries( new TextDecoder().decode( body ?? new ArrayBuffer( 0 ) ).split( '\n' ).map( ( line ) => line.split( '=' ) ).filter( ( pair ) => pair.length >= 2 ).map( ( [ key, ...value ] ) => [ key.trim(), value.join( '=' ).trim() ] ) );

/** @returns {Promise.<Object>} výsledek kontroly API na jedné adrese */
const checkApi = async function ( /** @type {String} */ apiUrl )
{
	const url = new URL( settings.apiPublicKeyPath, apiUrl ).href;
	const result = await probe( url );
	if ( result.error ) {
		return { url, state: STATES.ERROR, message: result.error === REQUEST_ERRORS.CORS ? parts( 'apiCors', externalLink( url ) ) : requestError( result, 'apiUnreachable' ) };
	}
	const data = jsonOf( result.body );
	if ( !result.response.ok ) {
		if ( data?.message ) {
			return { url, state: STATES.ERROR, message: parts( 'apiError', result.response.status, data.message ) };
		}
		return { url, state: STATES.ERROR, message: parts( 'apiNotFound', result.response.status ), notFound: true };
	}
	const key = Array.isArray( data?.keys ) ? data.keys[ 0 ] : null;
	if ( !key?.x ) {
		return { url, state: STATES.ERROR, message: parts( 'apiNotFound', result.response.status ), notFound: true };
	}
	const details = [];
	let state = STATES.OK;
	if ( !settings.publicKeyX ) {
		details.push( parts( 'apiKeyMissing' ) );
		state = STATES.WARNING;
	} else if ( key.x === settings.publicKeyX ) {
		details.push( parts( 'apiKeySame' ) );
	} else {
		details.push( parts( 'apiKeyDifferent', externalLink( url ) ) );
		state = STATES.ERROR;
	}
	return { url, state, message: parts( 'apiOk', result.ms ), details };
};

// ---------------------------------------------------------------------------------------------------------------------

/** @returns {Promise.<void>} celá kontrola */
const run = async function ( /** @type {HTMLElement} */ root )
{
	const button = root.querySelector( '[' + ATTRIBUTES.BUTTON + ']' );
	const status = root.querySelector( '[' + ATTRIBUTES.STATUS + ']' );
	const summary = root.querySelector( '[' + ATTRIBUTES.SUMMARY + ']' );
	const table = root.querySelector( '[' + ATTRIBUTES.RESULTS + ']' );
	const body = table.tBodies[ 0 ];
	button.disabled = true;
	status.replaceChildren( element( 'span', [ 'spinner', 'is-active' ] ), text( 'running' ) );
	summary.replaceChildren();
	body.replaceChildren();
	table.hidden = false;
	runId = Date.now().toString( 36 );

	const siteUrl = settings.siteUrl;
	const host = new URL( siteUrl ).hostname;
	const hasFiles = Object.keys( settings.files ?? {} ).length > 0;
	const rows = {
		site: createRow( body, text( 'titleSite', siteUrl ) ),
		dns: createRow( body, text( 'titleDns', host ) ),
		cloudflare: createRow( body, text( 'titleCloudflare' ) ),
		server: createRow( body, text( 'titleServer' ) ),
		hosting: createRow( body, text( 'titleHosting' ) ),
		content: createRow( body, text( 'titleContent' ) ),
		pagesDev: settings.pagesDevUrl ? createRow( body, text( 'titlePagesDev', new URL( settings.pagesDevUrl ).hostname ) ) : null,
		api: settings.apiUrls.length ? createRow( body, text( 'titleApi' ) ) : null,
		workflow: settings.github ? createRow( body, text( 'titleWorkflow' ) ) : null,
		githubPages: settings.github ? createRow( body, text( 'titleGithubPages' ) ) : null,
	};

	// Všechny požadavky najednou, řádky se vyplňují postupně
	const siteRequest = probe( bust( siteUrl ) );
	const indexRequest = probe( bust( new URL( INDEX_FILE, siteUrl ).href ) );
	const traceRequest = request( new URL( '/' + settings.cloudflareTrace, siteUrl ).href );
	const dnsRequest = lookupDns( host );
	const contentRequest = hasFiles ? compareFiles( siteUrl ) : null;
	const pagesDevRequest = settings.pagesDevUrl ? Promise.all( [ probe( bust( settings.pagesDevUrl ) ), hasFiles ? compareFiles( settings.pagesDevUrl ) : null ] ) : null;
	const apiRequest = settings.apiUrls.length ? Promise.all( settings.apiUrls.map( checkApi ) ) : null;
	const githubRequest = settings.github ? loadGithub() : null;
	const tasks = [];

	// Web
	const site = await siteRequest;
	const online = !site.error && site.response.ok;
	const answered = Boolean( site.response ); // odpověď s hlavičkami, i chybová (např. 404 z GitHub Pages bez webu) – podle ní jde poznat server
	const unavailable = parts( site.error === REQUEST_ERRORS.CORS ? 'notReadable' : 'notOnline' );
	if ( site.error ) {
		rows.site.set( STATES.ERROR, requestError( site, 'siteUnreachable' ) );
	} else if ( !site.response.ok ) {
		rows.site.set( STATES.ERROR, parts( 'siteHttpError', site.response.status ), responseDetails( site.response, siteUrl ) );
	} else {
		rows.site.set( STATES.OK, parts( 'siteOk', site.response.status, site.ms ), responseDetails( site.response, siteUrl ) );
	}

	// DNS
	const dns = await dnsRequest;
	if ( dns.error ) {
		rows.dns.set( STATES.SKIPPED, parts( 'dnsUnavailable', new URL( settings.dnsResolver ).hostname ) );
	} else {
		const details = [];
		if ( dns.cnames.length ) {
			details.push( parts( 'dnsRecords', 'CNAME', code( dns.cnames.join( ', ' ) ) ) );
		}
		for ( const [ type, matches ] of [ [ 'A', ( address ) => !address.includes( ':' ) ], [ 'AAAA', ( address ) => address.includes( ':' ) ] ] ) {
			const addresses = dns.addresses.filter( matches );
			if ( addresses.length ) {
				details.push( parts( 'dnsRecords', type, code( addresses.join( ', ' ) ) ) );
			}
		}
		if ( dns.nameservers.length ) {
			const cloudflareDns = dns.nameservers.every( ( name ) => name.endsWith( settings.cloudflareNameserverSuffix ) );
			details.push( parts( cloudflareDns ? 'dnsCloudflareNameservers' : 'dnsNameservers', code( dns.nameservers.join( ', ' ) ) ) );
		}
		details.push( parts( 'dnsVia', new URL( settings.dnsResolver ).hostname ) );
		const guide = adminLink( settings.guideDnsUrl, text( 'guideDnsLink' ) );
		switch ( dns.kind ) {
			case DNS_KINDS.NXDOMAIN: rows.dns.set( STATES.ERROR, parts( 'dnsNxdomain' ), details ); break;
			case DNS_KINDS.NONE: rows.dns.set( STATES.ERROR, parts( 'dnsNoAddress' ), details ); break;
			case DNS_KINDS.GITHUB: rows.dns.set( STATES.OK, parts( 'dnsGithub' ), details ); break;
			case DNS_KINDS.GITHUB_CNAME: rows.dns.set( STATES.OK, parts( 'dnsGithubCname', code( dns.cnames.join( ', ' ) ) ), details ); break;
			case DNS_KINDS.PAGES_DEV_CNAME: rows.dns.set( STATES.OK, parts( 'dnsPagesDevCname', code( dns.cnames.join( ', ' ) ) ), details ); break;
			case DNS_KINDS.CLOUDFLARE: rows.dns.set( STATES.INFO, parts( host.endsWith( settings.pagesDevSuffix ) ? 'dnsPagesDevHost' : 'dnsCloudflare' ), details ); break;
			case DNS_KINDS.MIXED: rows.dns.set( STATES.WARNING, parts( 'dnsMixed', code( dns.others.join( ', ' ) ) ), [ ...details, guide ] ); break;
			case DNS_KINDS.LEGACY: rows.dns.set( STATES.WARNING, parts( 'dnsLegacy', code( dns.legacy.join( ', ' ) ) ), [ ...details, guide ] ); break;
			default: rows.dns.set( STATES.WARNING, parts( 'dnsOther', code( dns.addresses.join( ', ' ) ) ), details );
		}
	}

	// Cloudflare před webem
	const trace = await traceRequest;
	const traceData = !trace.error && trace.response.ok ? parseTrace( trace.body ) : {};
	const behindCloudflare = Boolean( traceData.h && traceData.colo );
	if ( behindCloudflare ) {
		rows.cloudflare.set( STATES.INFO, parts( 'cloudflareYes', traceData.colo, traceData.http ?? '?', traceData.tls ?? '?' ) );
	} else if ( !answered && site.error !== REQUEST_ERRORS.CORS ) {
		rows.cloudflare.set( STATES.SKIPPED, unavailable );
	} else {
		rows.cloudflare.set( STATES.INFO, parts( 'cloudflareNo' ) );
	}

	// Kdo web obsluhuje
	const index = await indexRequest;
	const { server, reasons } = answered ? detectServer( site, index, dns.error ? {} : dns, behindCloudflare ) : { server: SERVERS.UNKNOWN, reasons: [] };
	const label = serverLabel( server, behindCloudflare );
	if ( !answered ) {
		rows.server.set( STATES.SKIPPED, unavailable );
	} else {
		rows.server.set( server === SERVERS.UNKNOWN ? STATES.WARNING : STATES.INFO, label, reasons );
		if ( server === SERVERS.GITHUB_PAGES && behindCloudflare ) {
			rows.cloudflare.set( STATES.INFO, parts( 'cloudflareYes', traceData.colo, traceData.http ?? '?', traceData.tls ?? '?' ), [ parts( 'cloudflareProxyNote' ) ] );
		}
	}

	// Odpovídá nastavení hostingu?
	const settingsLink = adminLink( settings.settingsUrl, text( 'settingsLink' ) );
	if ( !answered ) {
		rows.hosting.set( STATES.SKIPPED, unavailable );
	} else if ( server === SERVERS.UNKNOWN ) {
		rows.hosting.set( STATES.WARNING, parts( 'hostingUnknown', settings.hostingLabel ) );
	} else if ( ( server === SERVERS.GITHUB_PAGES ) === settings.expectsGithubPages ) {
		rows.hosting.set( STATES.OK, parts( 'hostingOk', settings.hostingLabel, label ) );
	} else if ( settings.expectsGithubPages ) {
		rows.hosting.set( STATES.ERROR, parts( 'hostingExpectGithub', settings.hostingLabel, host ), [ parts( 'hostingExpectGithubFix' ), settingsLink ] );
	} else {
		rows.hosting.set( STATES.ERROR, parts( 'hostingExpectCloudflare', settings.hostingLabel, host ), [ parts( 'hostingExpectCloudflareFix', host, settings.project || '?' ), settingsLink ] );
	}

	// Obsah = poslední export?
	if ( !hasFiles ) {
		rows.content.set( STATES.SKIPPED, parts( 'contentNoFiles' ) );
	} else if ( !online ) {
		rows.content.set( STATES.SKIPPED, answered ? parts( 'siteHttpError', site.response.status ) : unavailable );
	} else {
		const content = await contentRequest;
		const total = Object.keys( settings.files ).length;
		if ( content.unsupported ) {
			rows.content.set( STATES.SKIPPED, parts( 'contentUnsupported' ) );
		} else if ( !content.different ) {
			rows.content.set( STATES.OK, parts( 'contentSame', total ), content.files.map( fileDetail ) );
		} else {
			const hints = [];
			if ( settings.pushed === false ) {
				hints.push( parts( 'contentNotPushed' ) );
				if ( settings.pushUrl ) {
					hints.push( pushLink() ); // [2026-11-26]
				}
			}
			if ( settings.hostingChanged ) {
				hints.push( parts( 'hostingChangedSinceExport' ) ); // [2026-11-26]
			}
			const cloudflareMayChangeHtml = content.onlyHtmlDiffers && behindCloudflare;
			if ( cloudflareMayChangeHtml ) {
				hints.push( parts( 'contentCloudflareHtml' ) );
			}
			if ( rows.hosting.state !== STATES.ERROR ) { // doména ukazuje jinam = důvod je známý
				hints.push( parts( 'contentFreshDeployNote' ) );
			}
			rows.content.set( cloudflareMayChangeHtml ? STATES.WARNING : STATES.ERROR, parts( 'contentDifferent', content.different, total ), [ ...content.files.map( fileDetail ), ...hints ] );
		}
	}

	// Projekt Cloudflare Pages
	if ( pagesDevRequest ) {
		tasks.push( pagesDevRequest.then( ( [ pagesSite, pagesContent ] ) =>
		{
			const used = settings.usesCloudflare;
			const unused = used ? [] : [ parts( 'pagesDevUnused', settings.hostingLabel ) ];
			if ( pagesSite.error ) {
				rows.pagesDev.set( used ? STATES.ERROR : STATES.INFO, requestError( pagesSite, 'pagesDevUnreachable' ), unused );
			} else if ( !pagesSite.response.ok ) {
				rows.pagesDev.set( used ? STATES.ERROR : STATES.INFO, parts( 'pagesDevHttpError', pagesSite.response.status ), unused );
			} else if ( !pagesContent || pagesContent.unsupported ) {
				rows.pagesDev.set( used ? STATES.OK : STATES.INFO, parts( 'pagesDevOnline', pagesSite.response.status ), unused );
			} else if ( !pagesContent.different ) {
				rows.pagesDev.set( used ? STATES.OK : STATES.INFO, parts( 'pagesDevSame', pagesContent.files.length ), unused );
			} else if ( pagesContent.onlyHtmlDiffers ) {
				rows.pagesDev.set( used ? STATES.WARNING : STATES.INFO, parts( 'pagesDevDifferent', pagesContent.different, pagesContent.files.length ), [ ...pagesContent.files.map( fileDetail ), parts( 'contentCloudflareHtml' ), ...unused ] );
			} else {
				rows.pagesDev.set( used ? STATES.ERROR : STATES.INFO, parts( 'pagesDevDifferent', pagesContent.different, pagesContent.files.length ), [ ...pagesContent.files.map( fileDetail ), ...( used ? [ parts( 'pagesDevFailedDeploy' ) ] : unused ) ] );
			}
		} ) );
	}

	// API přihlašování
	if ( apiRequest ) {
		tasks.push( apiRequest.then( ( results ) =>
		{
			const [ primary ] = results;
			const details = results.length > 1
				? results.map( ( result ) => [ code( result.url ), ': ', ...result.message, ...( result.details ?? [] ).flatMap( ( detail ) => [ ' ', ...detail ] ) ] )
				: primary.details ?? [];
			const message = primary.notFound && server === SERVERS.GITHUB_PAGES && new URL( primary.url ).hostname === host ? parts( 'apiNotFoundGithub' ) : primary.message;
			rows.api.set( primary.state, message, details );
		} ) );
	}

	// GitHub
	if ( githubRequest ) {
		tasks.push( githubRequest.then( ( github ) =>
		{
			if ( github.repository.error ) {
				rows.workflow.set( STATES.WARNING, githubError( github.repository ) );
				rows.githubPages.set( STATES.SKIPPED, githubError( github.repository ) );
				return;
			}
			const commit = settings.commit;
			// Workflow
			const run = github.runs.error ? null : github.runs.data?.workflow_runs?.[ 0 ] ?? null;
			if ( github.runs.error === 'not-found' ) {
				rows.workflow.set( STATES.WARNING, parts( 'workflowMissing', code( settings.workflowFile ) ) );
			} else if ( github.runs.error ) {
				rows.workflow.set( STATES.WARNING, githubError( github.runs ) );
			} else if ( !run ) {
				rows.workflow.set( STATES.WARNING, parts( 'workflowNoRuns', code( settings.workflowFile ) ) );
			} else {
				const isLatest = !commit || run.head_sha === commit;
				const details = [ externalLink( String( run.html_url ), text( 'workflowLink' ) ) ];
				if ( settings.hostingChanged ) { // [2026-11-26] opakovaný běh na starém commitu by nasadil podle starého .github/hosting.env
					details.push( parts( 'hostingChangedSinceExport' ) );
				} else if ( settings.actionsUrl ) { // [2026-11-26] ruční spuštění (Run workflow) – API by potřebovalo token s právem zápisu
					details.push( parts( 'workflowRunManually', externalLink( settings.actionsUrl, text( 'workflowActionsLink' ) ) ) );
				}
				if ( !isLatest ) {
					details.unshift( settings.pushed === false ? parts( 'workflowNotPushed', code( shortSha( commit ) ) ) : parts( 'workflowOlderCommit', code( shortSha( run.head_sha ) ), code( shortSha( commit ) ) ) );
					if ( settings.pushUrl ) { // [2026-11-26] jen git push (\FUNCTIONS\STATIC_EXPORT\startPush())
						details.splice( 1, 0, pushLink() );
					}
				}
				const values = [ run.run_number, code( shortSha( run.head_sha ) ), formatDate( run.created_at ) ];
				if ( RUNNING_GITHUB_STATES.includes( run.status ) ) {
					rows.workflow.set( STATES.WARNING, parts( 'workflowRunning', ...values ), details );
				} else if ( run.conclusion === 'success' ) {
					rows.workflow.set( isLatest ? STATES.OK : STATES.WARNING, parts( 'workflowSuccess', ...values ), details );
				} else {
					rows.workflow.set( STATES.ERROR, parts( 'workflowFailure', ...values, String( run.conclusion ?? run.status ) ), details );
				}
			}
			// GitHub Pages
			const expected = settings.expectsGithubPages;
			const hasPages = github.repository.data.has_pages === true;
			const deployment = github.deployment;
			const unusedDetails = expected ? [] : [ parts( hasPages ? 'pagesUnusedHosting' : 'pagesDisabledUnused', settings.hostingLabel ) ];
			if ( github.deployments.error ) {
				rows.githubPages.set( STATES.SKIPPED, githubError( github.deployments ) );
			} else if ( expected && !hasPages ) {
				rows.githubPages.set( STATES.ERROR, parts( 'pagesDisabled' ) );
			} else if ( !deployment ) {
				rows.githubPages.set( expected ? STATES.WARNING : STATES.INFO, parts( 'pagesNone' ), unusedDetails );
			} else {
				const isLatest = !commit || deployment.sha === commit;
				const state = github.deploymentState;
				const details = [ parts( 'pagesState', code( state || '?' ) ), ...unusedDetails, ...( settings.hostingChanged ? [ parts( 'hostingChangedSinceExport' ) ] : [] ) ];
				const message = isLatest
					? parts( 'pagesDeployedLatest', code( shortSha( deployment.sha ) ), formatDate( deployment.created_at ) )
					: parts( 'pagesDeployedOlder', code( shortSha( deployment.sha ) ), formatDate( deployment.created_at ), code( shortSha( commit ) ) );
				if ( !expected ) {
					rows.githubPages.set( STATES.INFO, message, details );
				} else if ( [ 'failure', 'error' ].includes( state ) ) {
					rows.githubPages.set( STATES.ERROR, parts( 'pagesFailed', code( shortSha( deployment.sha ) ), state ), details );
				} else if ( RUNNING_GITHUB_STATES.includes( state ) ) {
					rows.githubPages.set( STATES.WARNING, message, details );
				} else {
					rows.githubPages.set( isLatest ? STATES.OK : STATES.WARNING, message, details );
				}
			}
		} ) );
	}

	await Promise.allSettled( tasks );
	for ( const row of Object.values( rows ) ) { // pojistka: řádek, který kvůli chybě v kódu zůstal „probíhá“
		if ( row?.state === STATES.RUNNING ) {
			row.set( STATES.SKIPPED, parts( 'unexpectedError' ) );
		}
	}

	// Shrnutí
	const all = Object.values( rows ).filter( Boolean );
	const problems = all.filter( ( row ) => row.state === STATES.ERROR || row.state === STATES.WARNING );
	const unverified = all.filter( ( row ) => row.state === STATES.SKIPPED );
	let noticeState = STATES.OK;
	let message;
	let list = [];
	if ( !online ) {
		noticeState = STATES.ERROR;
		message = answered ? parts( 'summaryHttpError', siteUrl, site.response.status ) : parts( site.error === REQUEST_ERRORS.CORS ? 'summaryUnreadable' : 'summaryOffline', siteUrl );
		list = problems;
	} else if ( problems.length ) {
		noticeState = problems.some( ( row ) => row.state === STATES.ERROR ) ? STATES.ERROR : STATES.WARNING;
		message = parts( 'summaryProblems', siteUrl, label );
		list = problems;
	} else if ( unverified.length || rows.content.state !== STATES.OK ) {
		noticeState = STATES.INFO;
		message = parts( 'summaryUnverified', siteUrl, label );
		list = unverified;
	} else {
		message = parts( 'summaryOk', siteUrl, label );
	}
	const notice = element( 'div', [ 'notice', NOTICE_CLASSES[ noticeState ], 'inline' ], element( 'p', [], message ) );
	if ( list.length ) {
		notice.append( element( 'ul', [], list.map( ( row ) => element( 'li', [], [ element( 'strong', [], row.title ), ' – ', row.result ] ) ) ) );
	}
	summary.replaceChildren( notice );
	status.replaceChildren( text( 'finished', formatDate( new Date() ) ) );
	button.disabled = false;
};

const root = document.getElementById( ROOT_ID );
const settingsElement = document.getElementById( SETTINGS_ELEMENT_ID );
if ( root && settingsElement ) {
	settings = JSON.parse( settingsElement.textContent );
	texts = settings.texts ?? {};
	root.querySelector( '[' + ATTRIBUTES.BUTTON + ']' )?.addEventListener( 'click', () =>
	{
		run( root ).catch( ( error ) =>
		{
			console.error( error );
			const status = root.querySelector( '[' + ATTRIBUTES.STATUS + ']' );
			status.replaceChildren( text( 'unexpectedError' ) );
			root.querySelector( '[' + ATTRIBUTES.BUTTON + ']' ).disabled = false;
		} );
	} );
}
