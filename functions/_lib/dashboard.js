/**
* [2026-11-27] Údaje z Cloudflare pro widget „Cloudflare“ na nástěnce WordPressu (šablona domdocument-template:
* dashboard-widgets/cloudflare.php, js/modules/admin-dashboard-cloudflare.mjs). Trasa GET /api/dashboard je
* functions/api/dashboard.js, logika je tady (kvůli testům v .site-checks/dashboard-api.test.mjs).
*
* Proč přes Pages Function: WordPress (PHP) během požadavku nic nestahuje, nástěnku plní prohlížeč. API Cloudflare
* (api.cloudflare.com) ale prohlížeč volat nesmí (nemá CORS) a API token by byl ve stránce. Tajný API token jen pro čtení
* proto zná jen Cloudflare (tajná proměnná DASHBOARD_API_TOKEN) a prohlížeč administrátora sem pošle krátkodobý token
* podepsaný WordPressem. Funkce ho ověří veřejným klíčem WORDPRESS_PUBLIC_KEY (proměnná ve wrangler.toml, zapisuje ji
* export z WordPressu – soukromý klíč WordPress odvozuje ze solí ve wp-config.php a nikam ho neposílá).
*
* Odpověď (JSON, CORS pro všechny – bez cookies, bez platného tokenu nic nevydá):
*   settings    nastavení na Cloudflare bez tajných hodnot: vazba DB, SSO_PRIVATE_KEY, ALLOWED_ORIGINS, RP_ID, RP_NAME, token
*   database    přes vazbu DB (bez API tokenu): velikost, počet účtů, přístupových klíčů a platných relací, poslední migrace
*   cloudflare  přes API Cloudflare s DASHBOARD_API_TOKEN:
*     project      projekt Pages (produkční větev, aktuální produkční a poslední nasazení), domains (vlastní domény a stav),
*     deployments  posledních DEPLOYMENTS_LIMIT nasazení s commity,
*     usage        čerpání od půlnoci UTC (tehdy se denní limity bezplatného tarifu nulují): požadavky Pages Functions
*                  a Workers, řádky D1 čtené a zapsané, velikost databází,
*     errors       chyby za posledních ERROR_DAYS dní (nebo kolik dovolí tarif): Pages Functions podle stavu, D1 podle
*                  textu chyby – počet a poslední výskyt.
* Část, která selže (chybí oprávnění tokenu, projekt neexistuje…), má místo dat { error: { code, message } } – ostatní
* části se vrátí i tak.
*
* Token WordPressu (JWT, EdDSA): { iss, aud = origin této funkce, scope = TOKEN_SCOPE, sub, iat, exp (nejvýš TOKEN_MAX_TTL),
* account, project, database, repository } – účet, projekt, databázi a [2026-11-27] repozitář na GitHubu bere funkce
* z tokenu (WordPress je má v nastavení a token podepsal). Podepisuje ho \FUNCTIONS\ANALYTICS\createToken() ve
* functions.php šablony ([2026-11-27] dříve \FUNCTIONS\DASHBOARD\createCloudflareToken() – načítání a ukládání údajů
* z Cloudflare a GitHubu má teď na starost stránka Analytická data, widgety na nástěnce berou údaje od ní).
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/functions/), export ho kopíruje do repozitáře
* statického webu – upravovat ho ve šabloně. Popis: functions/README.md, „Údaje pro nástěnku WordPressu“.
*/

import { fromBase64Url } from './webauthn.js';
import { SsoKeyError, importSsoPrivateKey } from './sso-token.js';

/** @type {String} \VARS\ANALYTICS::TOKEN_SCOPE (do 27. 11. 2026 \VARS\DASHBOARD_WIDGET::CLOUDFLARE_TOKEN_SCOPE) */
export const TOKEN_SCOPE = 'ddt-dashboard';

/** @type {String} */
export const TOKEN_ALGORITHM = 'EdDSA';

/** @type {Number} s – nejdelší platnost tokenu (WordPress dává \VARS\ANALYTICS::TOKEN_TTL) */
export const TOKEN_MAX_TTL = 600;

/** @type {Number} s – rozdíl hodin WordPressu a Cloudflare */
export const CLOCK_LEEWAY = 60;

/** @type {Number} dní, za které se počítají chyby (tarif může dovolit méně – uzel settings GraphQL API) */
export const ERROR_DAYS = 7;

/** @type {Number} nasazení ve výpisu */
export const DEPLOYMENTS_LIMIT = 10;

/** @type {Number} s – jak dlouho si instance funkce pamatuje údaje z API Cloudflare (ochrana limitu 300 dotazů GraphQL za 5 minut) */
export const CACHE_SECONDS = 60;

/** @type {Number} s – jak dlouho si instance pamatuje, co tarif u datových sad GraphQL dovolí */
const SETTINGS_CACHE_SECONDS = 3600;

/** @type {String} */
const API_BASE = 'https://api.cloudflare.com/client/v4';

/** @type {Number} ms */
const REQUEST_TIMEOUT = 10000;

/** @type {Number} skupin v odpovědi GraphQL (skripty, databáze, stavy, texty chyb) */
const GROUP_LIMIT = 100;

/** @type {Number} minut s chybou, ze kterých se hledá poslední výskyt (seřazené od nejnovější) */
const LAST_OCCURRENCE_LIMIT = 200;

/** @type {Number} znaků textu chyby nebo zprávy commitu */
const TEXT_LENGTH = 300;

/** @type {Object<String, String>} */
export const ERRORS = Object.freeze( { // kódy chyb – stejné klíče má modul nástěnky v textech (\FUNCTIONS\DASHBOARD\getCloudflareTexts())
	UNAUTHENTICATED: 'unauthenticated',
	INVALID_TOKEN: 'invalid-token',
	EXPIRED_TOKEN: 'expired-token',
	METHOD_NOT_ALLOWED: 'method-not-allowed',
	SERVER_MISCONFIGURED: 'server-misconfigured',
	SERVER_ERROR: 'server-error',
	// chyby jedné části odpovědi
	TOKEN_MISSING: 'token-missing', // chybí DASHBOARD_API_TOKEN
	NOT_CONFIGURED: 'not-configured', // WordPress neposlal účet / projekt / databázi
	CLOUDFLARE_API: 'cloudflare-api', // API Cloudflare odpovědělo chybou (oprávnění, neexistující projekt…)
	GRAPHQL: 'graphql',
	DISABLED: 'disabled', // datová sada GraphQL na tomto účtu není
	DATABASE: 'database', // dotaz do D1 přes vazbu selhal
	TIMEOUT: 'timeout',
	NO_ZONE: 'no-zone', // [2026-11-27] /api/dashboard/traffic: projekt nemá vlastní doménu v zóně Cloudflare (functions/_lib/dashboard-traffic.js)
	ZONE_ACCESS: 'zone-access', // token nemá přístup k zóně (oprávnění Zone → Analytics → Read)
	// [2026-11-27] /api/dashboard/referrers a /api/dashboard/github (stránka Analytická data ve WordPressu)
	FIELDS: 'fields', // tarif zóny nedovolí pole potřebná pro odkazující weby (uzel settings, availableFields)
	NO_SITE: 'no-site', // Web Analytics nemá web pro vlastní domény projektu
	GITHUB_TOKEN_MISSING: 'github-token-missing', // chybí tajná proměnná DASHBOARD_GITHUB_TOKEN
	NO_REPOSITORY: 'no-repository', // WordPress neposlal repozitář statického webu na GitHubu
	GITHUB_API: 'github-api', // API GitHubu odpovědělo chybou (oprávnění tokenu, neexistující repozitář…)
} );

/** @type {Object<String, String>} datové sady GraphQL Analytics API (účet) */
export const DATASETS = Object.freeze( {
	PAGES: 'pagesFunctionsInvocationsAdaptiveGroups',
	WORKERS: 'workersInvocationsAdaptive',
	D1: 'd1AnalyticsAdaptiveGroups',
	D1_STORAGE: 'd1StorageAdaptiveGroups',
	D1_QUERIES: 'd1QueriesAdaptiveGroups',
} );

/** @type {Object<String, String>} stav SSO_PRIVATE_KEY v settings */
export const KEY_STATES = Object.freeze( {
	OK: 'ok',
	MISSING: 'missing',
	INVALID: 'invalid',
} );

/** @type {RegExp} ID účtu Cloudflare */
const ACCOUNT_PATTERN = /^[0-9a-f]{32}$/;

/** @type {RegExp} \VARS\STATIC_EXPORT::CLOUDFLARE_PROJECT_PATTERN */
const PROJECT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;

/** @type {RegExp} \VARS\STATIC_EXPORT::UUID_PATTERN */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** @type {RegExp} [2026-11-27] repozitář na GitHubu „uživatel/název“ (\FUNCTIONS\ANALYTICS\getGithubRepository() ve WordPressu) */
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** @type {Object<String, String>} */
const CORS_HEADERS = Object.freeze( {
	'Access-Control-Allow-Origin': '*', // bez cookies (credentials: 'omit') – údaje vydá jen platný token WordPressu
} );

/** @type {TextEncoder} */
const textEncoder = new TextEncoder();

/** @type {TextDecoder} */
const textDecoder = new TextDecoder( 'utf-8', { fatal: true } );

/**
* Chyba celé odpovědi (HTTP stav a kód pro modul nástěnky).
*/
export class HttpError extends Error {

	constructor ( /** @type {Number} */ status, /** @type {String} */ code, /** @type {String} */ message, /** @type {Object} */ headers = {} )
	{
		super( message );
		this.status = status;
		this.code = code;
		this.headers = headers;
	}

}

/**
* Chyba jedné části odpovědi (vrací se jako { error: { code, message, … } }).
*/
export class SectionError extends Error {

	constructor ( /** @type {String} */ code, /** @type {String} */ message, /** @type {Object} */ details = {} )
	{
		super( message );
		this.code = code;
		this.details = details;
	}

}

/** @type {Function} */
const now = function ()
{
	return Math.floor( Date.now() / 1000 );
};

/** @returns {String} čas ISO 8601 bez milisekund (typ Time v GraphQL API) */
export const isoTime = function ( /** @type {Number} */ seconds )
{
	return new Date( seconds * 1000 ).toISOString().replace( /\.\d{3}Z$/, 'Z' );
};

/** @returns {String} první řádek textu, zkrácený */
export const shortText = function ( /** @type {*} */ value )
{

	/** @type {String} */
	const text = String( value ?? '' ).split( /\r?\n/, 1 )[ 0 ].trim();

	return text.length > TEXT_LENGTH ? text.slice( 0, TEXT_LENGTH - 1 ) + '…' : text;
};

/** @returns {String} */
export const stringOf = function ( /** @type {*} */ value )
{
	return typeof value === 'string' ? value : '';
};

/** @returns {Number} */
export const numberOf = function ( /** @type {*} */ value )
{

	/** @type {Number} */
	const number = Number( value );

	return Number.isFinite( number ) ? number : 0;
};

/** @type {Function} */
export const json = function ( /** @type {Object} */ data, /** @type {Number} */ status = 200, /** @type {Object} */ headers = {} )
{
	return new Response( JSON.stringify( data ), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
			...CORS_HEADERS,
			...headers,
		},
	} );
};

/** @returns {Object} { error: { code, message, … } } části odpovědi */
const sectionError = function ( /** @type {Error} */ error )
{
	if ( error instanceof SectionError ) {
		return { error: { code: error.code, message: error.message, ...error.details } };
	}
	console.error( error );
	return { error: { code: ERRORS.SERVER_ERROR, message: shortText( error?.message ?? error ) } };
};

/** @returns {Promise<Object>} výsledek funkce, nebo { error } (chyba jedné části nezastaví ostatní) */
export const section = async function ( /** @type {Function} */ callback )
{
	try {
		return await callback();
	} catch ( error ) {
		return sectionError( error );
	}
};

// -----------------------------------------------------------------------------------------------------------------------------
// Token WordPressu

/**
* Ověří token WordPressu (JWT s podpisem EdDSA) veřejným klíčem WORDPRESS_PUBLIC_KEY (32 bajtů Ed25519 v base64url).
*
* @returns {Promise<Object>} { account, project, database, subject, issuer } – prázdný řetězec = WordPress hodnotu nemá
*/
export const verifyWordpressToken = async function ( /** @type {String} */ token, /** @type {String|undefined} */ publicKey, /** @type {String} */ audience, /** @type {Number} */ time = now() )
{
	return wordpressClaims( await verifySignedToken( token, publicKey, audience, time, TOKEN_SCOPE ) );
};

/**
* [2026-11-27] Ověřené údaje tokenu → { account, project, database, repository, subject, issuer } (prázdný řetězec =
* WordPress hodnotu nemá; neplatná hodnota = token se odmítne). Vyčleněné z verifyWordpressToken() pro tokeny s jiným
* scope (functions/_lib/zone-settings.js – změny nastavení zóny).
*
* @returns {Object}
*/
export const wordpressClaims = function ( /** @type {Object} */ claims )
{

	/** @type {Function} */
	const valueOf = ( /** @type {String} */ name, /** @type {RegExp} */ pattern ) => {

		/** @type {String} */
		const value = stringOf( claims[ name ] );

		if ( value !== '' && !pattern.test( value ) ) {
			throw new HttpError( 401, ERRORS.INVALID_TOKEN, `Token WordPressu má neplatnou hodnotu ${ name }.` );
		}
		return value;
	};

	return {
		account: valueOf( 'account', ACCOUNT_PATTERN ),
		project: valueOf( 'project', PROJECT_PATTERN ),
		database: valueOf( 'database', UUID_PATTERN ),
		repository: valueOf( 'repository', REPOSITORY_PATTERN ), // [2026-11-27] /api/dashboard/github; starší WordPress ho neposílá ('')
		subject: shortText( claims.sub ),
		issuer: shortText( claims.iss ),
	};
};

/**
* [2026-11-27] Ověří podpis, příjemce (aud), scope a dobu platnosti tokenu WordPressu a vrátí všechny jeho údaje (claims).
* Vyčleněné z verifyWordpressToken() – functions/_lib/zone-settings.js ověřuje tokeny se scope pro změny nastavení zóny
* a čte z nich i údaj change.
*
* @returns {Promise<Object>} údaje tokenu (JSON objekt)
*/
export const verifySignedToken = async function ( /** @type {String} */ token, /** @type {String|undefined} */ publicKey, /** @type {String} */ audience, /** @type {Number} */ time, /** @type {String} */ scope )
{

	/** @type {String} */
	const keyText = String( publicKey ?? '' ).trim();

	if ( keyText === '' ) {
		throw new HttpError( 500, ERRORS.SERVER_MISCONFIGURED, 'Chybí proměnná WORDPRESS_PUBLIC_KEY – zapisuje ji do wrangler.toml export z WordPressu. Spusťte export a nasaďte ho (functions/README.md, „Údaje pro nástěnku WordPressu“).' );
	}

	/** @type {Uint8Array|null} */
	let rawKey = null;

	try {
		rawKey = fromBase64Url( keyText );
	} catch {
		rawKey = null;
	}
	if ( !rawKey || rawKey.length !== 32 ) {
		throw new HttpError( 500, ERRORS.SERVER_MISCONFIGURED, 'WORDPRESS_PUBLIC_KEY není veřejný klíč Ed25519 (32 bajtů v base64url) – ve wrangler.toml ho zapisuje export z WordPressu.' );
	}

	/** @type {String[]} */
	const parts = String( token ?? '' ).split( '.' );

	if ( parts.length !== 3 ) {
		throw new HttpError( 401, ERRORS.INVALID_TOKEN, 'Token WordPressu nemá tvar JWT.' );
	}

	/** @type {*} */
	let header;

	/** @type {*} */
	let claims;

	/** @type {Uint8Array} */
	let signature;

	try {
		header = JSON.parse( textDecoder.decode( fromBase64Url( parts[ 0 ] ) ) );
		claims = JSON.parse( textDecoder.decode( fromBase64Url( parts[ 1 ] ) ) );
		signature = fromBase64Url( parts[ 2 ] );
	} catch {
		throw new HttpError( 401, ERRORS.INVALID_TOKEN, 'Token WordPressu nejde přečíst.' );
	}
	if ( !header || header.alg !== TOKEN_ALGORITHM ) {
		throw new HttpError( 401, ERRORS.INVALID_TOKEN, 'Token WordPressu nemá podpis EdDSA.' );
	}

	/** @type {CryptoKey} */
	const key = await crypto.subtle.importKey( 'raw', rawKey, { name: 'Ed25519' }, false, [ 'verify' ] );

	if ( signature.length !== 64 || !await crypto.subtle.verify( { name: 'Ed25519' }, key, signature, textEncoder.encode( parts[ 0 ] + '.' + parts[ 1 ] ) ) ) {
		throw new HttpError( 401, ERRORS.INVALID_TOKEN, 'Podpis tokenu nesouhlasí s WORDPRESS_PUBLIC_KEY. Klíč ve wrangler.toml je z jiného WordPressu, nebo se od posledního exportu změnily soli ve wp-config.php – spusťte export a nasaďte ho.' );
	}
	if ( !claims || typeof claims !== 'object' || Array.isArray( claims ) || claims.scope !== scope ) {
		throw new HttpError( 401, ERRORS.INVALID_TOKEN, scope === TOKEN_SCOPE ? 'Token WordPressu není pro nástěnku.' : 'Token WordPressu není pro toto API.' );
	}
	if ( claims.aud !== audience ) {
		throw new HttpError( 401, ERRORS.INVALID_TOKEN, `Token WordPressu je pro ${ String( claims.aud ) }, ne pro ${ audience }.` );
	}
	if ( !Number.isInteger( claims.iat ) || !Number.isInteger( claims.exp ) || claims.exp - claims.iat > TOKEN_MAX_TTL || claims.iat > time + CLOCK_LEEWAY ) {
		throw new HttpError( 401, ERRORS.INVALID_TOKEN, 'Token WordPressu má neplatnou dobu platnosti – zkontrolujte hodiny počítače s WordPressem.' );
	}
	if ( claims.exp < time - CLOCK_LEEWAY ) {
		throw new HttpError( 401, ERRORS.EXPIRED_TOKEN, 'Platnost tokenu WordPressu vypršela.' );
	}
	return claims;
};

// -----------------------------------------------------------------------------------------------------------------------------
// Nastavení a databáze (bez API tokenu)

/** @returns {Promise<Object>} nastavení na Cloudflare bez tajných hodnot */
export const readSettings = async function ( /** @type {Object} */ env )
{

	/** @type {String} */
	let ssoPrivateKey = KEY_STATES.OK;

	/** @type {String|null} */
	let ssoMessage = null;

	try {
		await importSsoPrivateKey( env.SSO_PRIVATE_KEY );
	} catch ( error ) {
		if ( !( error instanceof SsoKeyError ) ) {
			throw error;
		}
		ssoPrivateKey = env.SSO_PRIVATE_KEY ? KEY_STATES.INVALID : KEY_STATES.MISSING;
		ssoMessage = error.message;
	}
	return {
		database: Boolean( env.DB ),
		ssoPrivateKey,
		ssoMessage,
		allowedOrigins: String( env.ALLOWED_ORIGINS ?? '' ).split( /[\s,]+/ ).filter( Boolean ),
		rpId: env.RP_ID ? String( env.RP_ID ) : null,
		rpName: env.RP_NAME ? String( env.RP_NAME ) : null,
		apiToken: String( env.DASHBOARD_API_TOKEN ?? '' ).trim() !== '',
	};
};

/** @returns {Promise<Object>} databáze přes vazbu DB: velikost, počty, poslední migrace */
export const readDatabase = async function ( /** @type {Object} */ env, /** @type {Number} */ time = now() )
{
	if ( !env.DB ) {
		return { error: { code: ERRORS.NOT_CONFIGURED, message: 'Chybí vazba DB na databázi D1 (wrangler.toml).' } };
	}
	try {
		const [ users, credentials, sessions ] = await env.DB.batch( [
			env.DB.prepare( 'SELECT COUNT(*) AS count FROM users' ),
			env.DB.prepare( 'SELECT COUNT(*) AS count FROM credentials' ),
			env.DB.prepare( 'SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?' ).bind( time ),
		] );

		/** @type {Object|null} */
		let migration = null;

		try { // tabulku d1_migrations zakládá wrangler při první migraci
			migration = await env.DB.prepare( 'SELECT name, applied_at FROM d1_migrations ORDER BY id DESC LIMIT 1' ).first();
		} catch {
			migration = null;
		}

		/** @type {*} */
		const size = users?.meta?.size_after;

		return {
			sizeBytes: Number.isFinite( size ) ? size : null,
			users: numberOf( users?.results?.[ 0 ]?.count ),
			credentials: numberOf( credentials?.results?.[ 0 ]?.count ),
			sessions: numberOf( sessions?.results?.[ 0 ]?.count ),
			lastMigration: migration ? { name: shortText( migration.name ), appliedAt: stringOf( migration.applied_at ) } : null, // applied_at = 'RRRR-MM-DD HH:MM:SS' v UTC
		};
	} catch ( error ) {
		return { error: { code: ERRORS.DATABASE, message: shortText( error?.message ?? error ) } };
	}
};

// -----------------------------------------------------------------------------------------------------------------------------
// API Cloudflare (REST a GraphQL) s DASHBOARD_API_TOKEN

/** @returns {Promise<Object>} odpověď JSON, nebo SectionError s textem chyby od Cloudflare */
const request = async function ( /** @type {String} */ url, /** @type {String} */ token, /** @type {Object} */ options = {} )
{

	/** @type {Response} */
	let response;

	try {
		response = await fetch( url, {
			...options,
			headers: { Authorization: `Bearer ${ token }`, ...( options.headers ?? {} ) },
			signal: AbortSignal.timeout( REQUEST_TIMEOUT ),
		} );
	} catch ( error ) {
		if ( error?.name === 'TimeoutError' ) {
			throw new SectionError( ERRORS.TIMEOUT, `API Cloudflare neodpovědělo do ${ REQUEST_TIMEOUT / 1000 } s.` );
		}
		throw new SectionError( ERRORS.CLOUDFLARE_API, shortText( error?.message ?? error ) );
	}

	/** @type {*} */
	let data = null;

	try {
		data = await response.json();
	} catch {
		data = null;
	}
	return { response, data };
};

/** @returns {Promise<*>} result z odpovědi REST API Cloudflare; [2026-11-27] options = { method, headers, body } fetch() pro změny (functions/_lib/zone-settings.js), bez nich GET */
export const cloudflareApi = async function ( /** @type {String} */ token, /** @type {String} */ path, /** @type {Object} */ options = {} )
{
	const { response, data } = await request( API_BASE + path, token, options );

	if ( !response.ok || !data || data.success !== true ) {

		/** @type {Object} */
		const first = Array.isArray( data?.errors ) ? data.errors[ 0 ] ?? {} : {};

		throw new SectionError( ERRORS.CLOUDFLARE_API, shortText( first.message || `HTTP ${ response.status }` ), { status: response.status, cloudflareCode: Number.isInteger( first.code ) ? first.code : null } );
	}
	return data.result;
};

/** @returns {Promise<Object>} { data, errors } z GraphQL Analytics API (chyba jedné části dotazu nezahodí ostatní) */
export const graphql = async function ( /** @type {String} */ token, /** @type {String} */ query )
{
	const { response, data } = await request( API_BASE + '/graphql', token, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify( { query } ),
	} );

	/** @type {Object[]} */
	const errors = Array.isArray( data?.errors ) ? data.errors : [];

	if ( !data?.data ) {
		throw new SectionError( ERRORS.GRAPHQL, shortText( errors[ 0 ]?.message || `HTTP ${ response.status }` ), { status: response.status } );
	}
	return { data: data.data, errors };
};

/** @returns {Object|null} nasazení Pages zkrácené na to, co nástěnka ukazuje */
export const deploymentSummary = function ( /** @type {*} */ deployment )
{
	if ( !deployment || typeof deployment !== 'object' ) {
		return null;
	}

	/** @type {Object} */
	const metadata = deployment.deployment_trigger?.metadata ?? {};

	return {
		id: stringOf( deployment.id ),
		shortId: stringOf( deployment.short_id ),
		url: stringOf( deployment.url ),
		environment: stringOf( deployment.environment ), // production | preview
		createdOn: stringOf( deployment.created_on ),
		stage: stringOf( deployment.latest_stage?.name ), // queued | initialize | clone_repo | build | deploy
		status: stringOf( deployment.latest_stage?.status ), // success | idle | active | failure | canceled | skipped
		endedOn: stringOf( deployment.latest_stage?.ended_on ) || null,
		trigger: stringOf( deployment.deployment_trigger?.type ), // ad_hoc (wrangler pages deploy) | github:push | deploy_hook
		branch: stringOf( metadata.branch ),
		commitHash: stringOf( metadata.commit_hash ),
		commitMessage: shortText( metadata.commit_message ),
		commitDirty: metadata.commit_dirty === true,
		isSkipped: deployment.is_skipped === true,
	};
};

/** @returns {Object} projekt Pages */
export const projectSummary = function ( /** @type {*} */ project )
{
	return {
		name: stringOf( project?.name ),
		subdomain: stringOf( project?.subdomain ),
		productionBranch: stringOf( project?.production_branch ),
		createdOn: stringOf( project?.created_on ),
		source: stringOf( project?.source?.type ) || null, // github | gitlab = projekt napojený na Git v Cloudflare (sestavuje ho i Cloudflare), null = jen přímé nahrávání (wrangler)
		domains: Array.isArray( project?.domains ) ? project.domains.filter( ( /** @type {*} */ name ) => typeof name === 'string' ) : [],
		canonical: deploymentSummary( project?.canonical_deployment ), // nasazení, které je teď na produkční adrese
		latest: deploymentSummary( project?.latest_deployment ),
	};
};

/** @returns {Object} vlastní doména projektu Pages */
export const domainSummary = function ( /** @type {*} */ domain )
{
	return {
		name: stringOf( domain?.name ),
		status: stringOf( domain?.status ), // initializing | pending | active | deactivated | blocked | error
		error: shortText( domain?.verification_data?.error_message || domain?.validation_data?.error_message || '' ) || null,
	};
};

/** @type {Map<String, Object>} ID účtu → { expires, settings } */
const datasetSettingsCache = new Map();

/** @returns {Promise<Object>} datová sada → { enabled, maxDuration, notOlderThan } (s) podle tarifu účtu */
const getDatasetSettings = async function ( /** @type {String} */ token, /** @type {String} */ account, /** @type {Number} */ time )
{

	/** @type {Object|undefined} */
	const cached = datasetSettingsCache.get( account );

	if ( cached && cached.expires > time ) {
		return cached.settings;
	}

	const { data, errors } = await graphql( token, `query DdtDashboardSettings {
		viewer { accounts(filter: { accountTag: ${ JSON.stringify( account ) } }) { settings {
			${ Object.values( DATASETS ).map( ( /** @type {String} */ name ) => `${ name } { enabled maxDuration notOlderThan }` ).join( '\n' ) }
		} } }
	}` );

	/** @type {Object|undefined} */
	const settings = data?.viewer?.accounts?.[ 0 ]?.settings;

	if ( !settings ) {
		throw new SectionError( ERRORS.GRAPHQL, shortText( errors[ 0 ]?.message || 'Token nemá přístup k údajům účtu (oprávnění Account Analytics → Read pro tento účet).' ) );
	}
	datasetSettingsCache.set( account, { expires: time + SETTINGS_CACHE_SECONDS, settings } );
	return settings;
};

/**
* Kolik sekund zpět smí dotaz na datovou sadu sahat: chtěný rozsah omezený tarifem (uzel settings GraphQL API:
* maxDuration = nejširší rozsah jednoho dotazu, notOlderThan = nejstarší údaj), nejméně minuta.
*
* @returns {Number} s
*/
export const reachOf = function ( /** @type {Object|undefined} */ limits, /** @type {Number} */ wanted )
{
	return Math.max( 60, Math.min( wanted, numberOf( limits?.maxDuration ) || wanted, numberOf( limits?.notOlderThan ) || wanted ) );
};

/** @returns {Number} začátek dnešního dne v UTC (s) – denní limity bezplatného tarifu se nulují o půlnoci UTC */
export const utcDayStart = function ( /** @type {Number} */ time )
{
	return time - ( time % 86400 );
};

/**
* Čerpání od půlnoci UTC a chyby za posledních ERROR_DAYS dní z GraphQL Analytics API. Dotaz se skládá jen z datových
* sad, které tarif účtu dovolí (getDatasetSettings()), a s rozsahem, který dovolí (maxDuration, notOlderThan).
*
* @returns {Promise<Object>} { usage, errors } – každá položka data, nebo { error }
*/
export const readAnalytics = async function ( /** @type {String} */ token, /** @type {Object} */ claims, /** @type {Number} */ time = now() )
{

	/** @type {Object} */
	const settings = await getDatasetSettings( token, claims.account, time );

	/** @type {Number} */
	const dayStart = utcDayStart( time );

	/** @type {Function} od kdy smí dotaz na datovou sadu sahat (s) */
	const sinceFor = ( /** @type {String} */ dataset, /** @type {Number} */ wanted ) => time - reachOf( settings[ dataset ], wanted );

	/** @type {Function} */
	const enabled = ( /** @type {String} */ dataset ) => settings[ dataset ]?.enabled === true;

	/** @type {String} */
	const nowIso = JSON.stringify( isoTime( time ) );

	/** @type {Number} */
	const errorSeconds = ERROR_DAYS * 86400;

	/** @type {Object<String, String>} alias → část dotazu */
	const parts = {};

	/** @type {Object<String, Number>} od kdy se počítají chyby (s) */
	const errorSince = {};

	if ( enabled( DATASETS.PAGES ) ) {

		/** @type {String} */
		const todayFilter = `{ datetime_geq: ${ JSON.stringify( isoTime( Math.max( dayStart, sinceFor( DATASETS.PAGES, time - dayStart ) ) ) ) }, datetime_leq: ${ nowIso } }`;

		errorSince.pages = sinceFor( DATASETS.PAGES, errorSeconds );

		/** @type {String} */
		const errorFilter = `{ datetime_geq: ${ JSON.stringify( isoTime( errorSince.pages ) ) }, datetime_leq: ${ nowIso }, status_neq: "success" }`;

		parts.pagesToday = `${ DATASETS.PAGES }(limit: ${ GROUP_LIMIT }, filter: ${ todayFilter }) { sum { requests errors } dimensions { scriptName } }`;
		parts.pagesErrorCounts = `${ DATASETS.PAGES }(limit: ${ GROUP_LIMIT }, filter: ${ errorFilter }) { sum { requests } dimensions { status scriptName } }`;
		parts.pagesErrorLast = `${ DATASETS.PAGES }(limit: ${ LAST_OCCURRENCE_LIMIT }, filter: ${ errorFilter }, orderBy: [datetimeMinute_DESC]) { sum { requests } dimensions { status scriptName datetimeMinute } }`;
	}
	if ( enabled( DATASETS.WORKERS ) ) {
		parts.workersToday = `${ DATASETS.WORKERS }(limit: ${ GROUP_LIMIT }, filter: { datetime_geq: ${ JSON.stringify( isoTime( Math.max( dayStart, sinceFor( DATASETS.WORKERS, time - dayStart ) ) ) ) }, datetime_leq: ${ nowIso } }) { sum { requests errors } dimensions { scriptName } }`;
	}
	if ( enabled( DATASETS.D1 ) ) {

		/** @type {String} */
		const today = JSON.stringify( isoTime( dayStart ).slice( 0, 10 ) );

		parts.d1Today = `${ DATASETS.D1 }(limit: ${ GROUP_LIMIT }, filter: { date_geq: ${ today }, date_leq: ${ today } }) { sum { rowsRead rowsWritten readQueries writeQueries } dimensions { databaseId } }`;
	}
	if ( enabled( DATASETS.D1_STORAGE ) ) {
		parts.d1Storage = `${ DATASETS.D1_STORAGE }(limit: ${ GROUP_LIMIT }, filter: { datetime_geq: ${ JSON.stringify( isoTime( sinceFor( DATASETS.D1_STORAGE, 86400 ) ) ) }, datetime_leq: ${ nowIso } }) { max { databaseSizeBytes } dimensions { databaseId } }`;
	}
	if ( enabled( DATASETS.D1_QUERIES ) && claims.database !== '' ) {
		errorSince.d1 = sinceFor( DATASETS.D1_QUERIES, errorSeconds );

		/** @type {String} */
		const errorFilter = `{ databaseId: ${ JSON.stringify( claims.database ) }, datetime_geq: ${ JSON.stringify( isoTime( errorSince.d1 ) ) }, datetime_leq: ${ nowIso }, error_neq: "" }`;

		parts.d1ErrorCounts = `${ DATASETS.D1_QUERIES }(limit: ${ GROUP_LIMIT }, filter: ${ errorFilter }) { count dimensions { error } }`;
		parts.d1ErrorLast = `${ DATASETS.D1_QUERIES }(limit: ${ LAST_OCCURRENCE_LIMIT }, filter: ${ errorFilter }, orderBy: [datetimeMinute_DESC]) { count dimensions { error datetimeMinute } }`;
	}

	/** @type {Object} */
	let result = { data: null, errors: [] };

	if ( Object.keys( parts ).length ) {
		result = await graphql( token, `query DdtDashboard {
			viewer { accounts(filter: { accountTag: ${ JSON.stringify( claims.account ) } }) {
				${ Object.entries( parts ).map( ( [ alias, part ] ) => `${ alias }: ${ part }` ).join( '\n' ) }
			} }
		}` );
	}
	return shapeAnalytics( result, { settings, claims, time, dayStart, errorSince } );
};

/**
* Odpověď GraphQL → { usage, errors } pro nástěnku. Vyčleněné kvůli testům.
*
* @returns {Object}
*/
export const shapeAnalytics = function ( /** @type {Object} */ result, /** @type {Object} */ context )
{
	const { settings, claims, time, dayStart, errorSince } = context;

	/** @type {Object} */
	const account = result.data?.viewer?.accounts?.[ 0 ] ?? null;

	/** @type {Function} chyba části dotazu podle aliasu (path: viewer, accounts, 0, alias) */
	const errorOf = ( /** @type {String} */ alias ) => result.errors.find( ( /** @type {Object} */ error ) => Array.isArray( error?.path ) && error.path.includes( alias ) )
		?? ( !account && result.errors.length ? result.errors[ 0 ] : null );

	/** @type {Function} řádky aliasu, nebo { error } */
	const rowsOf = ( /** @type {String} */ alias, /** @type {String} */ dataset ) => {
		if ( settings[ dataset ]?.enabled !== true ) {
			return { error: { code: ERRORS.DISABLED, message: `Datová sada ${ dataset } není na tomto účtu dostupná.` } };
		}

		/** @type {Object|null} */
		const error = errorOf( alias );

		if ( error || !Array.isArray( account?.[ alias ] ) ) {
			return { error: { code: ERRORS.GRAPHQL, message: shortText( error?.message || 'GraphQL API nevrátilo data.' ) } };
		}
		return { rows: account[ alias ] };
	};

	/** @type {Function} požadavky a chyby podle skriptu */
	const invocations = ( /** @type {String} */ alias, /** @type {String} */ dataset ) => {
		const { rows, error } = rowsOf( alias, dataset );

		if ( error ) {
			return { error };
		}

		/** @type {Object[]} */
		const scripts = rows.map( ( /** @type {Object} */ row ) => ( {
			name: stringOf( row?.dimensions?.scriptName ),
			requests: numberOf( row?.sum?.requests ),
			errors: numberOf( row?.sum?.errors ),
		} ) ).sort( ( a, b ) => b.requests - a.requests );

		return {
			requests: scripts.reduce( ( total, script ) => total + script.requests, 0 ),
			errors: scripts.reduce( ( total, script ) => total + script.errors, 0 ),
			scripts,
		};
	};

	/** @type {Object} */
	const usage = {
		dayStart: isoTime( dayStart ),
		generatedAt: isoTime( time ),
		pagesFunctions: invocations( 'pagesToday', DATASETS.PAGES ),
		workers: invocations( 'workersToday', DATASETS.WORKERS ),
	};

	// D1 – řádky a dotazy dnes (účet celkem a databáze z nastavení WordPressu)
	{
		const { rows, error } = rowsOf( 'd1Today', DATASETS.D1 );

		if ( error ) {
			usage.d1 = { error };
		} else {

			/** @type {Function} */
			const sums = ( /** @type {Object[]} */ list ) => ( {
				rowsRead: list.reduce( ( total, row ) => total + numberOf( row?.sum?.rowsRead ), 0 ),
				rowsWritten: list.reduce( ( total, row ) => total + numberOf( row?.sum?.rowsWritten ), 0 ),
				readQueries: list.reduce( ( total, row ) => total + numberOf( row?.sum?.readQueries ), 0 ),
				writeQueries: list.reduce( ( total, row ) => total + numberOf( row?.sum?.writeQueries ), 0 ),
			} );

			usage.d1 = {
				...sums( rows ),
				databases: rows.length,
				database: claims.database !== '' ? sums( rows.filter( ( row ) => row?.dimensions?.databaseId === claims.database ) ) : null,
			};
		}
	}

	// D1 – velikost databází (největší za posledních 24 hodin)
	{
		const { rows, error } = rowsOf( 'd1Storage', DATASETS.D1_STORAGE );

		if ( error ) {
			usage.d1Storage = { error };
		} else {

			/** @type {Object|undefined} */
			const own = rows.find( ( row ) => row?.dimensions?.databaseId === claims.database );

			usage.d1Storage = {
				accountBytes: rows.reduce( ( total, row ) => total + numberOf( row?.max?.databaseSizeBytes ), 0 ),
				databaseBytes: own ? numberOf( own.max?.databaseSizeBytes ) : null,
				databases: rows.length,
			};
		}
	}

	/** @type {Function} počty podle klíče a poslední výskyt (řádky last jsou seřazené od nejnovější minuty) */
	const occurrences = ( /** @type {Object[]} */ counts, /** @type {Object[]} */ last, /** @type {Function} */ keyOf, /** @type {Function} */ countOf, /** @type {Function} */ describe ) => {

		/** @type {Map<String, Object>} */
		const items = new Map();

		for ( const row of counts ) {

			/** @type {String} */
			const key = keyOf( row );

			/** @type {Object} */
			const item = items.get( key ) ?? { ...describe( row ), count: 0, last: null };

			item.count += countOf( row );
			items.set( key, item );
		}
		for ( const row of last ) {

			/** @type {Object|undefined} */
			const item = items.get( keyOf( row ) );

			if ( item && item.last === null ) {
				item.last = stringOf( row?.dimensions?.datetimeMinute ) || null;
			}
		}

		/** @type {Object[]} */
		const list = [ ...items.values() ].filter( ( item ) => item.count > 0 ).sort( ( a, b ) => String( b.last ?? '' ).localeCompare( String( a.last ?? '' ) ) || b.count - a.count );

		return {
			total: list.reduce( ( total, item ) => total + item.count, 0 ),
			items: list,
		};
	};

	/** @type {Object} */
	const errors = { days: ERROR_DAYS };

	{
		const counts = rowsOf( 'pagesErrorCounts', DATASETS.PAGES );
		const last = rowsOf( 'pagesErrorLast', DATASETS.PAGES );

		errors.pagesFunctions = counts.error ? { error: counts.error } : {
			since: isoTime( errorSince.pages ?? time ),
			...occurrences(
				counts.rows,
				last.rows ?? [],
				( row ) => stringOf( row?.dimensions?.status ) + '\n' + stringOf( row?.dimensions?.scriptName ),
				( row ) => numberOf( row?.sum?.requests ),
				( row ) => ( { status: stringOf( row?.dimensions?.status ), scriptName: stringOf( row?.dimensions?.scriptName ) } ),
			),
		};
	}
	if ( claims.database === '' ) {
		errors.d1 = { error: { code: ERRORS.NOT_CONFIGURED, message: 'WordPress nemá vyplněné ID databáze D1.' } };
	} else {
		const counts = rowsOf( 'd1ErrorCounts', DATASETS.D1_QUERIES );
		const last = rowsOf( 'd1ErrorLast', DATASETS.D1_QUERIES );

		errors.d1 = counts.error ? { error: counts.error } : {
			since: isoTime( errorSince.d1 ?? time ),
			...occurrences(
				counts.rows,
				last.rows ?? [],
				( row ) => stringOf( row?.dimensions?.error ),
				( row ) => numberOf( row?.count ),
				( row ) => ( { error: shortText( row?.dimensions?.error ) } ),
			),
		};
	}
	return { usage, errors };
};

// -----------------------------------------------------------------------------------------------------------------------------
// Odpověď

/** @type {Map<String, Object>} otisk tokenu (účet, projekt, databáze) → { expires, cloudflare } */
const reportCache = new Map();

/**
* Celá odpověď pro nástěnku.
*
* @returns {Promise<Object>}
*/
export const buildReport = async function ( /** @type {Object} */ env, /** @type {Object} */ claims, /** @type {Number} */ time = now() )
{
	const [ settings, database ] = await Promise.all( [ readSettings( env ), readDatabase( env, time ) ] );

	/** @type {Object} */
	const report = {
		version: 1,
		generatedAt: isoTime( time ),
		target: { account: claims.account, project: claims.project, database: claims.database },
		settings,
		database,
	};

	/** @type {String} */
	const token = String( env.DASHBOARD_API_TOKEN ?? '' ).trim();

	if ( token === '' ) {
		report.cloudflare = { error: { code: ERRORS.TOKEN_MISSING, message: 'Chybí tajná proměnná DASHBOARD_API_TOKEN (API token jen pro čtení) – bez ní jsou tu jen údaje z databáze.' } };
		return report;
	}
	if ( claims.account === '' ) {
		report.cloudflare = { error: { code: ERRORS.NOT_CONFIGURED, message: 'WordPress nemá vyplněné ID účtu Cloudflare.' } };
		return report;
	}

	/** @type {String} */
	const cacheKey = [ claims.account, claims.project, claims.database ].join( '\n' );

	/** @type {Object|undefined} */
	const cached = reportCache.get( cacheKey );

	if ( cached && cached.expires > time ) {
		report.cloudflare = { ...cached.cloudflare, cachedAt: cached.cachedAt };
		return report;
	}

	/** @type {String} */
	const projectPath = `/accounts/${ claims.account }/pages/projects/${ claims.project }`;

	/** @type {Object} */
	const notConfigured = { error: { code: ERRORS.NOT_CONFIGURED, message: 'WordPress nemá vyplněný název projektu Cloudflare Pages.' } };

	const [ project, domains, deployments, analytics ] = await Promise.all( [
		claims.project === '' ? notConfigured : section( async () => projectSummary( await cloudflareApi( token, projectPath ) ) ),
		claims.project === '' ? notConfigured : section( async () => {

			/** @type {*} */
			const list = await cloudflareApi( token, projectPath + '/domains' );

			return { items: Array.isArray( list ) ? list.map( domainSummary ) : [] };
		} ),
		claims.project === '' ? notConfigured : section( async () => {

			/** @type {*} */
			const list = await cloudflareApi( token, `${ projectPath }/deployments?per_page=${ DEPLOYMENTS_LIMIT }` );

			return { items: Array.isArray( list ) ? list.map( deploymentSummary ).filter( Boolean ).slice( 0, DEPLOYMENTS_LIMIT ) : [] };
		} ),
		section( () => readAnalytics( token, claims, time ) ),
	] );

	/** @type {Object} */
	const cloudflare = {
		project,
		domains,
		deployments,
		usage: analytics.error ? { error: analytics.error } : analytics.usage,
		errors: analytics.error ? { error: analytics.error } : analytics.errors,
	};

	reportCache.set( cacheKey, { expires: time + CACHE_SECONDS, cachedAt: isoTime( time ), cloudflare } );
	report.cloudflare = cloudflare;
	return report;
};

/** Vyprázdní paměť instance (testy). */
export const clearCaches = function ()
{
	reportCache.clear();
	datasetSettingsCache.clear();
};

/**
* Společná obsluha tras nástěnky (/api/dashboard, /api/dashboard/traffic, [2026-11-27] /api/dashboard/referrers
* a /api/dashboard/github): předběžný dotaz CORS, jen GET, token WordPressu v hlavičce Authorization. Odpověď sestaví
* build( env, claims, time, url ) – url kvůli parametrům dotazu (?days=).
*
* @returns {Promise<Response>}
*/
export const handleRequest = async function ( /** @type {EventContext} */ context, /** @type {Function} */ build )
{

	/** @type {Request} */
	const request = context.request;

	try {
		if ( request.method === 'OPTIONS' ) { // předběžný dotaz CORS (hlavička Authorization)
			return new Response( null, {
				status: 204,
				headers: {
					...CORS_HEADERS,
					'Access-Control-Allow-Methods': 'GET',
					'Access-Control-Allow-Headers': 'Authorization',
					'Access-Control-Max-Age': '600',
				},
			} );
		}
		if ( request.method !== 'GET' ) {
			throw new HttpError( 405, ERRORS.METHOD_NOT_ALLOWED, 'Metoda není povolená.', { Allow: 'GET, OPTIONS' } );
		}

		/** @type {RegExpExecArray|null} */
		const match = /^Bearer\s+([A-Za-z0-9_.-]+)$/.exec( request.headers.get( 'Authorization' ) ?? '' );

		if ( !match ) {
			throw new HttpError( 401, ERRORS.UNAUTHENTICATED, 'Chybí token WordPressu (hlavička Authorization).' );
		}

		/** @type {Object} */
		const claims = await verifyWordpressToken( match[ 1 ], context.env.WORDPRESS_PUBLIC_KEY, new URL( request.url ).origin );

		return json( await build( context.env, claims, now(), new URL( request.url ) ) ); // [2026-11-27] adresa kvůli parametrům (?days= u /api/dashboard/traffic)
	} catch ( error ) {
		if ( error instanceof HttpError ) {
			return json( { error: error.code, message: error.message }, error.status, error.headers );
		}
		console.error( error );
		return json( { error: ERRORS.SERVER_ERROR, message: 'Chyba serveru.' }, 500 );
	}
};

/**
* Pages Function pro /api/dashboard (functions/api/dashboard.js).
*/
export const handleDashboardRequest = function ( /** @type {EventContext} */ context )
{
	return handleRequest( context, buildReport );
};
