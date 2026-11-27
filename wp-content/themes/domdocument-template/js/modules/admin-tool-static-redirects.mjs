/**
* [2026-11-26] Nástroj „Přesměrování na statickém webu“ (Nástroje → Přesměrování na statickém webu) šablony
* domdocument-template: stránku a seznam přesměrování skládá admin-tools/presmerovani-statickeho-webu.php, konstanty
* \VARS\STATIC_REDIRECTS ve functions.php, popis v README.md šablony – sekce „Nástroje v administraci“.
*
* Statický web má místo přesměrování HTTP stránku <stará adresa>/index.html s <meta http-equiv="refresh" content="0; url=…">
* (\DDT\StaticExporter::redirectDocument()). Prohlížeč pro každé přesměrování stáhne starou adresu na zvoleném webu
* (veřejná adresa, nebo <projekt>.pages.dev), přečte cíl z meta refresh, porovná ho s cílem podle nastavení WordPressu
* a ověří, že cíl odpovídá. PHP během požadavku nic nestahuje (pravidlo 17). Požadavky bez cookies a bez Referer, adresy
* s parametrem, který obejde mezipaměť CDN. Výsledky se skládají přes DOM (textContent), texty jsou z PHP.
*
* @version 0.1
* @since Q4 2026
*/

/** @type {String} \VARS\STATIC_REDIRECTS::SETTINGS_ID */
const SETTINGS_ELEMENT_ID = 'ddt-presmerovani-statickeho-webu-settings';

/** @type {String} \VARS\STATIC_REDIRECTS::ROOT_ID */
const ROOT_ID = 'ddt-presmerovani-statickeho-webu';

/** @type {Object.<string, string>} \VARS\STATIC_REDIRECTS::…_ATTRIBUTE */
const ATTRIBUTES = Object.freeze( {
	BASE: 'data-redirects-base',
	BUTTON: 'data-redirects-check',
	STATUS: 'data-redirects-status',
	SUMMARY: 'data-redirects-summary',
	RESULTS: 'data-redirects-results',
} );

/** @type {Object.<string, string>} */
const STATES = Object.freeze( { RUNNING: 'running', OK: 'ok', WARNING: 'warning', ERROR: 'error' } );

/** @type {Object.<string, string>} třídy řádku (css/admin-tools.css, stejné jako v nástroji Nasazení statického webu) */
const STATE_CLASSES = Object.freeze( { running: 'is-running', ok: 'is-ok', warning: 'is-warning', error: 'is-error' } );

/** @type {Object.<string, string>} */
const STATE_ICONS = Object.freeze( { running: 'dashicons-update', ok: 'dashicons-yes-alt', warning: 'dashicons-warning', error: 'dashicons-dismiss' } );

/** @type {Object.<string, string>} */
const STATE_TEXTS = Object.freeze( { running: 'stateRunning', ok: 'stateOk', warning: 'stateWarning', error: 'stateError' } );

/** @type {String} parametr adresy, který obejde mezipaměť CDN (stejný jako v nástroji Nasazení statického webu) */
const CACHE_BUSTER = 'ddt-kontrola';

/** @type {RegExp} cíl v content="0; url=…" */
const REFRESH_URL_PATTERN = /url\s*=\s*['"]?([^'"\s]+)/i;

/** @type {Object} */
let settings = {};

/** @returns {Array.<String|Node>} text s doplněnými hodnotami (%s, %1$s…); hodnota může být uzel DOM */
const parts = function ( /** @type {String} */ key, /** @type {...(String|Number|Node)} */ ...values )
{
	const template = String( settings.texts?.[ key ] ?? key );
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

/** @returns {HTMLElement} */
const element = function ( /** @type {String} */ tagName, /** @type {Array.<String>} */ classNames = [], /** @type {Array} */ content = [] )
{
	const node = document.createElement( tagName );
	if ( classNames.length ) {
		node.className = classNames.join( ' ' );
	}
	node.append( ...[ content ].flat( Infinity ).filter( ( part ) => part !== null && part !== undefined && part !== '' ) );
	return node;
};

/** @returns {HTMLElement} */
const code = ( /** @type {String} */ value ) => element( 'code', [], [ value ] );

/** @returns {String} adresa s parametrem CACHE_BUSTER */
const bust = function ( /** @type {String} */ url, /** @type {String} */ runId )
{
	const address = new URL( url );
	address.searchParams.set( CACHE_BUSTER, runId );
	return address.href;
};

/** @returns {String} adresa na zvoleném webu (veřejná adresa → <projekt>.pages.dev), jiné adresy beze změny */
const rebase = ( /** @type {String} */ url, /** @type {String} */ base ) => url.startsWith( settings.siteUrl ) ? base + url.slice( settings.siteUrl.length ) : url;

/** @returns {Promise.<{ response: ?Response, body: String, error: ?String }>} požadavek bez cookies a Referer, nikdy nevyhodí výjimku */
const request = async function ( /** @type {String} */ url, /** @type {String} */ mode = 'cors' )
{
	try {
		const response = await fetch( url, { cache: 'no-store', credentials: 'omit', mode, redirect: 'follow', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout( settings.timeout ) } );
		return { response, body: mode === 'cors' ? await response.text() : '', error: null };
	} catch ( error ) {
		return { response: null, body: '', error: error?.name === 'TimeoutError' ? 'timeout' : 'network' };
	}
};

/** @type {WeakMap.<HTMLTableRowElement, Object>} řádky už připravené prvním během (popis z PHP se smí převzít jen jednou) */
const records = new WeakMap();

/** @returns {Object} řádek tabulky (vytvořený v PHP) s metodou set() */
const rowOf = function ( /** @type {HTMLTableRowElement} */ row )
{
	if ( records.has( row ) ) {
		return records.get( row );
	}
	const header = row.querySelector( 'th' );
	const icon = header.querySelector( 'span' ) ?? header.insertBefore( element( 'span' ), header.firstChild );
	icon.setAttribute( 'aria-hidden', 'true' );
	const stateText = element( 'span', [ 'screen-reader-text' ] );
	icon.after( stateText );
	const cell = row.querySelector( 'td' );
	const description = cell.querySelector( 'p' ).cloneNode( true ); // druh a název přesměrování z PHP
	const record = {
		state: STATES.RUNNING,
		set ( /** @type {String} */ state, /** @type {Array} */ result, /** @type {Array} */ details = [] )
		{
			record.state = state;
			row.className = STATE_CLASSES[ state ];
			icon.className = 'dashicons ' + STATE_ICONS[ state ];
			stateText.textContent = text( STATE_TEXTS[ state ] ) + ' ';
			cell.replaceChildren( element( 'p', [], result ), description.cloneNode( true ) );
			if ( details.length ) {
				cell.append( element( 'ul', [], details.map( ( detail ) => element( 'li', [], detail ) ) ) );
			}
		},
	};
	records.set( row, record );
	return record;
};

/** @returns {Promise.<void>} */
const run = async function ( /** @type {HTMLElement} */ root )
{
	const button = root.querySelector( '[' + ATTRIBUTES.BUTTON + ']' );
	const status = root.querySelector( '[' + ATTRIBUTES.STATUS + ']' );
	const summary = root.querySelector( '[' + ATTRIBUTES.SUMMARY + ']' );
	const base = root.querySelector( '[' + ATTRIBUTES.BASE + ']' ).value || settings.siteUrl;
	const rows = [ ...root.querySelector( '[' + ATTRIBUTES.RESULTS + '] tbody' ).rows ].map( rowOf );
	const runId = Date.now().toString( 36 );
	const targetChecks = new Map(); // stejný cíl se stahuje jen jednou
	button.disabled = true;
	status.replaceChildren( element( 'span', [ 'spinner', 'is-active' ] ), text( 'running' ) );
	summary.replaceChildren();
	for ( const row of rows ) {
		row.set( STATES.RUNNING, [ text( 'pending' ) ] );
	}

	const checkTarget = function ( /** @type {String} */ url, /** @type {Boolean} */ external )
	{
		const fetchUrl = rebase( url, base );
		if ( !targetChecks.has( fetchUrl ) ) {
			targetChecks.set( fetchUrl, ( async () =>
			{
				const result = await request( external ? fetchUrl : bust( fetchUrl, runId ) );
				if ( result.error && external ) { // cizí web bez CORS: stačí, že odpovídá
					const opaque = await request( fetchUrl, 'no-cors' );
					return { ok: !opaque.error, status: null };
				}
				return { ok: Boolean( result.response?.ok ), status: result.response?.status ?? null };
			} )() );
		}
		return targetChecks.get( fetchUrl );
	};

	await Promise.all( settings.redirects.map( async ( redirect, index ) =>
	{
		const row = rows[ index ];
		const oldUrl = rebase( redirect.oldUrl, base );
		const page = await request( bust( oldUrl, runId ) );
		if ( page.error ) {
			row.set( STATES.ERROR, page.error === 'timeout' ? parts( 'timeout', Math.round( settings.timeout / 1000 ) ) : parts( 'unreachable' ) );
			return;
		}
		if ( page.response.status === 404 ) {
			const deploymentLink = element( 'a', [], [ text( 'deploymentLink' ) ] );
			deploymentLink.href = settings.deploymentUrl;
			row.set( STATES.ERROR, parts( 'missing', 404 ), [ redirect.exported ? parts( 'missingNotDeployed', deploymentLink ) : parts( 'missingNotExported' ) ] );
			return;
		}
		if ( !page.response.ok ) {
			row.set( STATES.ERROR, parts( 'httpError', page.response.status ) );
			return;
		}
		const html = new DOMParser().parseFromString( page.body, 'text/html' );
		const refresh = [ ...html.querySelectorAll( 'meta[http-equiv]' ) ].find( ( meta ) => meta.getAttribute( 'http-equiv' ).toLowerCase() === 'refresh' );
		const match = refresh ? REFRESH_URL_PATTERN.exec( refresh.getAttribute( 'content' ) ?? '' ) : null;
		if ( !match ) { // v cílové složce přesměrování je → na webu je starší export, jinak stránku se stejnou adresou export vykreslil místo přesměrování
			const deploymentLink = element( 'a', [], [ text( 'deploymentLink' ) ] );
			deploymentLink.href = settings.deploymentUrl;
			row.set( STATES.ERROR, redirect.exported ? parts( 'notRedirectNotDeployed', deploymentLink ) : parts( 'notRedirect' ) );
			return;
		}
		const pageUrl = new URL( page.response.url );
		pageUrl.searchParams.delete( CACHE_BUSTER );
		const destination = new URL( match[ 1 ], pageUrl ).href;
		const expected = new URL( redirect.target ).href;
		const targetResult = await checkTarget( destination, redirect.external );
		const targetProblem = targetResult.ok ? null : ( targetResult.status ? parts( 'targetMissing', code( destination ), targetResult.status ) : parts( 'targetUnreachable', code( destination ) ) );
		if ( destination !== expected ) {
			row.set( STATES.WARNING, parts( 'wrongTarget', code( destination ), code( expected ) ), targetProblem ? [ targetProblem ] : [] );
		} else if ( targetProblem ) {
			row.set( STATES.ERROR, targetProblem );
		} else {
			row.set( STATES.OK, redirect.external ? parts( 'okExternal' ) : parts( 'ok', targetResult.status ) );
		}
	} ) );

	const problems = rows.filter( ( row ) => row.state !== STATES.OK ).length;
	const notice = element( 'div', [ 'notice', problems ? ( rows.some( ( row ) => row.state === STATES.ERROR ) ? 'notice-error' : 'notice-warning' ) : 'notice-success', 'inline' ], [
		element( 'p', [], problems ? parts( 'summaryProblems', problems, base, rows.length ) : parts( 'summaryOk', rows.length, base ) ),
	] );
	summary.replaceChildren( notice );
	let finished = new Date().toLocaleString();
	try {
		finished = new Intl.DateTimeFormat( settings.locale, { dateStyle: 'medium', timeStyle: 'short' } ).format( new Date() );
	} catch {
		// výchozí formát
	}
	status.replaceChildren( text( 'finished', finished ) );
	button.disabled = false;
};

const root = document.getElementById( ROOT_ID );
const settingsElement = document.getElementById( SETTINGS_ELEMENT_ID );
if ( root && settingsElement ) {
	settings = JSON.parse( settingsElement.textContent );
	root.querySelector( '[' + ATTRIBUTES.BUTTON + ']' )?.addEventListener( 'click', () =>
	{
		run( root ).catch( ( error ) =>
		{
			console.error( error );
			root.querySelector( '[' + ATTRIBUTES.STATUS + ']' ).replaceChildren( text( 'unexpectedError' ) );
			root.querySelector( '[' + ATTRIBUTES.BUTTON + ']' ).disabled = false;
		} );
	} );
}
