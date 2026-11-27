/**
* [2026-11-27] Načítání a ukládání analytických údajů šablony domdocument-template – jediné místo pro stránku Analytická data
* (admin-pages/analyticka-data.php, js/modules/admin-analytics.mjs) i widgety na nástěnce (js/modules/admin-dashboard-cloudflare.mjs,
* widget „Analytická data“). README šablony – sekce „Analytická data“, PHP strana \FUNCTIONS\ANALYTICS ve functions.php.
*
* Zdroje a jejich stav uložený ve WordPressu dá PHP do stránky jako <script type="application/json" data-ddt-analytics-data>
* (\FUNCTIONS\ANALYTICS\printDataModule(); prvků může být víc, modul je sloučí). Pro každý zdroj:
* 1. uložený stav (record: report = poslední odpověď API, history = historie po dnech) je k dispozici hned (getRecord()),
* 2. load() ho vrátí, dokud není starší než maxAge; jinak (nebo s fresh) si přes admin-ajax.php vyžádá token podepsaný
*    WordPressem, zavolá s ním Pages Function zdroje na <projekt>.pages.dev, odpověď pošle do WordPressu k uložení
*    (\FUNCTIONS\ANALYTICS\ajaxStore() – ten ji přidá do historie) a vrátí uložený stav. Když se uložení nepovede, vrátí
*    nové údaje s dosavadní historií a varováním,
* 3. souběžné load() téhož zdroje (dva widgety na nástěnce) sdílí jeden požadavek, token poslouží všem zdrojům minutu.
* PHP nic nestahuje (pravidlo 17); API Cloudflare ani GitHubu prohlížeč přímo nevolá – tokeny API zná jen Cloudflare.
*
* Moduly šablony ho načítají přes importVerified() (pravidlo 9): PHP ho vypíše jako <script type="module" integrity>.
*
* @version 0.1
* @since Q4 2026
*/

/** @type {String} \VARS\ANALYTICS::DATA_ATTRIBUTE */
const DATA_ATTRIBUTE = 'data-ddt-analytics-data';

/** @type {Number} ms – jak dlouho jeden token WordPressu poslouží dalším požadavkům (platí 5 minut, \VARS\ANALYTICS::TOKEN_TTL) */
const TOKEN_REUSE = 60000;

/** @type {Object} sloučené nastavení všech prvků DATA_ATTRIBUTE */
let settings = { texts: {}, sources: {} };

for ( const element of document.querySelectorAll( 'script[type="application/json"][' + DATA_ATTRIBUTE + ']' ) ) {
	try {
		const part = JSON.parse( element.textContent ?? '{}' );
		settings = { ...settings, ...part, texts: { ...settings.texts, ...part.texts }, sources: { ...settings.sources, ...part.sources } };
	} catch ( error ) {
		console.error( 'Analytická data: neplatné nastavení', error );
	}
}

/** @type {Map<String, Object>} zdroj → uložený stav { version, source, savedAt (s), report, history } */
const records = new Map( Object.values( settings.sources ).filter( ( source ) => source?.record ).map( ( source ) => [ source.id, source.record ] ) );

/** @type {Map<String, Promise>} zdroj → probíhající načtení */
const inFlight = new Map();

/** @type {Set<Function>} posluchači změn ( id, record ) */
const listeners = new Set();

/** chyba s textem pro uživatele */
export class AnalyticsDataError extends Error {}

/** @returns {String} text s doplněnými hodnotami (%s, %1$s… jako sprintf() v PHP) */
const text = function ( /** @type {String} */ key, /** @type {...(String|Number)} */ ...values )
{
	let index = 0;
	return String( settings.texts?.[ key ] ?? key ).replace( /%(?:(\d+)\$)?s/g, ( match, position ) => String( values[ position ? Number( position ) - 1 : index++ ] ?? '' ) );
};

/** @returns {String} text kódu chyby z API (functions/_lib/dashboard.js, ERRORS) */
const codeText = function ( /** @type {String} */ code, /** @type {String} */ message )
{
	const template = settings.texts?.codes?.[ code ];
	return template ? String( template ).replace( '%s', message ) : ( message || code );
};

/** @returns {Object|null} zdroj { id, label, endpoint, maxAge (s), problem } */
export const getSource = function ( /** @type {String} */ id )
{
	return settings.sources[ id ] ?? null;
};

/** @returns {Object[]} všechny zdroje ve stránce */
export const getSources = function ()
{
	return Object.values( settings.sources );
};

/** @returns {Object|null} uložený stav zdroje */
export const getRecord = function ( /** @type {String} */ id )
{
	return records.get( id ) ?? null;
};

/** @returns {Boolean} uložený stav chybí, nebo je starší než maxAge zdroje */
export const isStale = function ( /** @type {String} */ id )
{
	const record = getRecord( id );
	const source = getSource( id );
	return !record || !source || ( Number( record.savedAt ) + Number( source.maxAge ) ) * 1000 <= Date.now();
};

/** @returns {Function} odhlášení – callback( id, record ) se zavolá po každém novém stavu zdroje */
export const subscribe = function ( /** @type {Function} */ callback )
{
	listeners.add( callback );
	return () => listeners.delete( callback );
};

/** @returns {String} text chyby pro uživatele */
export const errorText = function ( /** @type {*} */ error )
{
	return error instanceof AnalyticsDataError ? error.message : String( error?.message ?? error );
};

// -----------------------------------------------------------------------------------------------------------------------------
// Token WordPressu

/** @type {Object|null} { token: Promise.<String>, expires } */
let sharedToken = null;

/** @returns {Promise.<String>} token pro Pages Functions (jeden pro všechny zdroje, nanejvýš TOKEN_REUSE) */
const getToken = function ()
{
	if ( sharedToken && sharedToken.expires > Date.now() ) {
		return sharedToken.token;
	}
	const token = requestToken();
	sharedToken = { token, expires: Date.now() + TOKEN_REUSE };
	token.catch( () => {
		sharedToken = null; // příště znovu
	} );
	return token;
};

/** @returns {Promise.<Object|null>} odpověď admin-ajax.php { success, data } (stav HTTP může být kvůli cgi.rfc2616_headers vždy 200) */
const ajax = async function ( /** @type {Object} */ fields, /** @type {String} */ errorKey )
{
	let response;
	try {
		response = await fetch( settings.ajaxUrl, { method: 'POST', credentials: 'same-origin', body: new URLSearchParams( fields ), signal: AbortSignal.timeout( settings.timeout ) } );
	} catch ( error ) {
		throw new AnalyticsDataError( text( errorKey, error?.name === 'TimeoutError' ? text( 'timeout', Math.round( settings.timeout / 1000 ) ) : String( error?.message ?? error ) ) );
	}
	let data = null;
	try {
		data = await response.json();
	} catch {
		data = null;
	}
	if ( !data?.success ) {
		throw new AnalyticsDataError( text( errorKey, data?.data?.message ?? ( response.ok ? text( 'invalid' ) : text( 'http', response.status ) ) ) );
	}
	return data.data;
};

/** @returns {Promise.<String>} */
const requestToken = async function ()
{
	const data = await ajax( { action: settings.tokenAction, [ settings.nonceName ]: settings.tokenNonce }, 'tokenRequest' );
	if ( typeof data?.token !== 'string' ) {
		throw new AnalyticsDataError( text( 'tokenRequest', text( 'invalid' ) ) );
	}
	return data.token;
};

// -----------------------------------------------------------------------------------------------------------------------------
// Načtení a uložení

/** @returns {Promise.<Object>} odpověď Pages Function zdroje */
const fetchReport = async function ( /** @type {Object} */ source )
{
	const token = await getToken();
	let response;
	try {
		response = await fetch( source.endpoint, {
			headers: { Authorization: 'Bearer ' + token },
			credentials: 'omit',
			referrerPolicy: 'no-referrer',
			cache: 'no-store',
			signal: AbortSignal.timeout( settings.timeout ),
		} );
	} catch ( error ) {
		throw new AnalyticsDataError( error?.name === 'TimeoutError' ? text( 'timeout', Math.round( settings.timeout / 1000 ) ) : text( 'network', source.endpoint ) );
	}
	let data = null;
	try {
		data = await response.json();
	} catch {
		data = null;
	}
	if ( !response.ok ) {
		if ( typeof data?.error === 'string' ) {
			throw new AnalyticsDataError( codeText( data.error, String( data.message ?? '' ) ) );
		}
		throw new AnalyticsDataError( response.status === 404 ? text( 'notFound', source.endpoint ) : text( 'http', response.status ) );
	}
	if ( !data || typeof data !== 'object' || Array.isArray( data ) || data.version === undefined ) {
		throw new AnalyticsDataError( text( 'invalid' ) );
	}
	return data;
};

/** @returns {Promise.<Object>} stav uložený ve WordPressu (i s historií) */
const storeReport = async function ( /** @type {Object} */ source, /** @type {Object} */ report )
{
	const data = await ajax( { action: settings.storeAction, [ settings.nonceName ]: settings.storeNonce, source: source.id, report: JSON.stringify( report ) }, 'storeFailed' );
	if ( !data?.record || typeof data.record !== 'object' ) {
		throw new AnalyticsDataError( text( 'storeFailed', text( 'invalid' ) ) );
	}
	return data.record;
};

/**
* Stav zdroje: uložený, dokud není starší než maxAge (fresh = načíst vždy), jinak nově načtený a uložený.
*
* @returns {Promise.<Object>} { record, fresh: Boolean (nově načtené), warning: String|null (nové údaje se neuložily) }
*/
export const load = function ( /** @type {String} */ id, /** @type {Object} */ { fresh = false } = {} )
{
	const source = getSource( id );
	if ( !source ) {
		return Promise.reject( new AnalyticsDataError( text( 'unavailable', id ) ) );
	}
	if ( source.problem ) {
		return Promise.reject( new AnalyticsDataError( text( 'unavailable', source.problem ) ) );
	}
	if ( !fresh && !isStale( id ) ) {
		return Promise.resolve( { record: getRecord( id ), fresh: false, warning: null } );
	}
	if ( inFlight.has( id ) ) {
		return inFlight.get( id );
	}
	const promise = ( async () => {
		const report = await fetchReport( source );
		let record;
		let warning = null;
		try {
			record = await storeReport( source, report );
		} catch ( error ) {
			warning = errorText( error );
			record = { history: {}, ...getRecord( id ), source: id, savedAt: Math.floor( Date.now() / 1000 ), report, unsaved: true }; // historie zůstane, jak byla
		}
		records.set( id, record );
		for ( const listener of listeners ) {
			try {
				listener( id, record );
			} catch ( error ) {
				console.error( 'Analytická data:', error );
			}
		}
		return { record, fresh: true, warning };
	} )().finally( () => inFlight.delete( id ) );
	inFlight.set( id, promise );
	return promise;
};
