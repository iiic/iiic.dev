/**
* [2026-11-27] Upozornění na nástěnce, když je v zóně Cloudflare zapnutý režim Pod útokem (šablona domdocument-template,
* \FUNCTIONS\CLOUDFLARE_SETTINGS\admin_notices() ve functions.php, README.md šablony – sekce „Nastavení Cloudflare
* z WordPressu“, část Upozornění na nástěnce).
*
* PHP oznámení vypíše podle stavu uloženého ve WordPressu (skryté, když režim zapnutý není) a tento modul přidá jen tehdy,
* když je uložený stav starší než 10 minut nebo ještě není. Modul stav ověří u Cloudflare stejně jako nástroj Nastavení
* Cloudflare: token jen pro čtení (admin-ajax.php) → GET /api/zone-settings na <projekt>.pages.dev → odpověď pošle do
* WordPressu k uložení (admin-ajax.php, ajaxState()). WordPress vrátí texty upozornění; modul je vloží a oznámení ukáže
* nebo skryje. Pozná tak i režim zapnutý přímo v administraci Cloudflare. Když se ověření nepovede, zůstane oznámení podle
* uloženého stavu (chyba jen v konzoli). PHP nic nestahuje (pravidlo 17).
*
* @version 0.1
* @since Q4 2026
*/

/** @type {String} \VARS\CLOUDFLARE_SETTINGS::DASHBOARD_SETTINGS_ID */
const SETTINGS_ELEMENT_ID = 'ddt-nastenka-pod-utokem-nastaveni';

/** @type {String} \VARS\CLOUDFLARE_SETTINGS::NOTICE_ID */
const NOTICE_ID = 'ddt-cloudflare-pod-utokem';

/** @type {Object.<string, string>} \VARS\CLOUDFLARE_SETTINGS::NOTICE_…_ATTRIBUTE */
const ATTRIBUTES = Object.freeze( {
	ITEMS: 'data-under-attack-zones',
	CHECKED: 'data-under-attack-checked',
} );

/** @returns {Promise.<Object>} data odpovědi admin-ajax.php (wp_send_json_success); stav HTTP může být kvůli cgi.rfc2616_headers vždy 200 */
const ajax = async function ( /** @type {Object} */ settings, /** @type {Object} */ fields )
{
	const response = await fetch( settings.ajaxUrl, { method: 'POST', credentials: 'same-origin', body: new URLSearchParams( fields ), signal: AbortSignal.timeout( settings.timeout ) } );
	const data = await response.json();
	if ( !data?.success ) {
		throw new Error( data?.data?.message ?? 'admin-ajax.php: HTTP ' + response.status );
	}
	return data.data;
};

/** Ověří stav u Cloudflare, uloží ho do WordPressu a podle něj upraví oznámení. */
const refresh = async function ( /** @type {Object} */ settings, /** @type {HTMLElement} */ notice )
{
	const { token } = await ajax( settings, { action: settings.tokenAction, [ settings.nonceName ]: settings.tokenNonce } );
	const response = await fetch( settings.endpoint, {
		headers: { Authorization: 'Bearer ' + token },
		credentials: 'omit',
		referrerPolicy: 'no-referrer',
		cache: 'no-store',
		signal: AbortSignal.timeout( settings.timeout ),
	} );
	if ( !response.ok ) {
		throw new Error( settings.endpoint + ': HTTP ' + response.status );
	}
	const report = await response.json();
	const data = await ajax( settings, { action: settings.stateAction, [ settings.nonceName ]: settings.stateNonce, [ settings.reportField ]: JSON.stringify( report ) } );
	notice.querySelector( '[' + ATTRIBUTES.ITEMS + ']' )?.replaceChildren( ...( Array.isArray( data.items ) ? data.items : [] ).map( ( item ) =>
	{
		const element = document.createElement( 'li' );
		element.textContent = String( item );
		return element;
	} ) );
	const checked = notice.querySelector( '[' + ATTRIBUTES.CHECKED + ']' );
	if ( checked ) {
		checked.textContent = String( data.checked ?? '' );
	}
	notice.hidden = !data.underAttack;
};

const notice = document.getElementById( NOTICE_ID );
const settingsElement = document.getElementById( SETTINGS_ELEMENT_ID );
if ( notice && settingsElement ) {
	refresh( JSON.parse( settingsElement.textContent ?? '{}' ), notice ).catch( ( error ) => console.warn( 'Režim Pod útokem: stav z Cloudflare se nepodařilo ověřit, platí uložený –', error?.message ?? error ) );
}
