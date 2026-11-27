/**
* [2026-11-27] Nástroj „Nastavení Cloudflare“ (Nástroje → Nastavení Cloudflare) šablony domdocument-template: stránku,
* tabulky voleb a historii skládá admin-tools/nastaveni-cloudflare.php, konstanty \VARS\CLOUDFLARE_SETTINGS a PHP strana
* \FUNCTIONS\CLOUDFLARE_SETTINGS ve functions.php, popis v README.md šablony – sekce „Nastavení Cloudflare z WordPressu“.
*
* Stav voleb zóny i změny jdou přes Pages Function /api/zone-settings na <projekt>.pages.dev
* (static-export/repository/functions/_lib/zone-settings.js), která má tajný API token s právem zápisu. PHP nic nestahuje
* (pravidlo 17) a API Cloudflare prohlížeč volat nesmí (nemá CORS).
* - Stav: token jen pro čtení (admin-ajax.php, bez volby) → GET /api/zone-settings → vyplní tabulky.
* - Změna: u voleb s textem v confirm se nejdřív zeptá v okně Dialogic (pravidlo 19). Pak si vyžádá token pro tuto jednu
*   změnu (WordPress ji zapíše do historie jako „čeká“) → POST /api/zone-settings (co změnit, je jen v tokenu) → výsledek
*   pošle do historie (admin-ajax.php) → stav načte znovu.
* Požadavky na Cloudflare bez cookies a bez Referer. Výpis se skládá přes DOM (textContent), texty jsou z PHP.
* [2026-11-27] v0.2: každý načtený stav pošle do WordPressu (admin-ajax.php, \FUNCTIONS\CLOUDFLARE_SETTINGS\ajaxState()) –
* podle něj nástěnka upozorňuje na zapnutý režim Pod útokem.
*
* @version 0.2
* @since Q4 2026
*/

/** @type {String} \VARS\CLOUDFLARE_SETTINGS::SETTINGS_ID */
const SETTINGS_ELEMENT_ID = 'ddt-nastaveni-cloudflare-settings';

/** @type {String} \VARS\CLOUDFLARE_SETTINGS::ROOT_ID */
const ROOT_ID = 'ddt-nastaveni-cloudflare';

/** @type {Object.<string, string>} \VARS\CLOUDFLARE_SETTINGS::…_ATTRIBUTE */
const ATTRIBUTES = Object.freeze( {
	RELOAD: 'data-zone-settings-reload',
	STATUS: 'data-zone-settings-status',
	ZONE: 'data-zone-settings-zone',
	NOTICE: 'data-zone-settings-notice',
	ROW: 'data-zone-setting',
	GROUP_LINK: 'data-zone-settings-link',
	LOG: 'data-zone-settings-log',
} );

/** @type {Object.<string, string>} \VARS\CLOUDFLARE_SETTINGS::CONTROL_… */
const CONTROLS = Object.freeze( {
	TOGGLE: 'toggle',
	UNDER_ATTACK: 'under-attack',
	SELECT: 'select',
	ACTION: 'action',
	READ_ONLY: 'read-only',
} );

/** @type {Object.<string, string>} stav hodnoty (třída buňky: settings.classes.statePrefix + stav, css/admin-tools.css) */
const VALUE_STATES = Object.freeze( { ON: 'on', OFF: 'off', ATTENTION: 'attention', UNKNOWN: 'unknown' } );

/** @type {String} kód chyby chybějící tajné proměnné (ZONE_ERRORS.TOKEN_MISSING v zone-settings.js) – k chybě se přidá odkaz na návod */
const TOKEN_MISSING_CODE = 'zone-token-missing';

/** @type {Array.<String>} \VARS\DIALOGIC::HASH_CODE_MODULE a ::MODULE – <script type="module" integrity> vypisuje \FUNCTIONS\DIALOGIC\appendScripts() */
const DIALOGIC_MODULES = [ './dialogic/0.2.0/modules/string/hashCode.mjs', './dialogic/0.2.0/dialogic.mjs' ];

/** @type {String} \VARS\VERIFIED_MODULE::LOADED_ATTRIBUTE */
const LOADED_ATTRIBUTE = 'data-module-loaded';

/** @type {String} \VARS\VERIFIED_MODULE::FAILED_ATTRIBUTE */
const FAILED_ATTRIBUTE = 'data-module-failed';

/** @type {String} hodnota tlačítka potvrzení v okně */
const CONFIRM_VALUE = 'yes';

/**
* Modul s kontrolou SRI (vzor a vysvětlení v js/modules/admin-static-export.mjs): import() až po úspěšném načtení prvku
* <script type="module" integrity> ve stránce.
* @returns {Promise.<Object>} jmenný prostor modulu
*/
const importVerified = ( /** @type {String} */ path ) => new Promise( ( resolve, reject ) =>
{
	const url = new URL( path, import.meta.url ).href;
	const element = [ ...document.querySelectorAll( 'script[type="module"][integrity]' ) ].find( ( script ) => script.src === url );
	const settle = () =>
	{
		if ( element.hasAttribute( FAILED_ATTRIBUTE ) ) {
			reject( new Error( 'Modul neprošel kontrolou integrity (SRI) nebo se nenačetl: ' + url ) );
		} else if ( element.hasAttribute( LOADED_ATTRIBUTE ) ) {
			resolve( import( url ) );
		} else {
			return false;
		}
		return true;
	};
	if ( !element ) {
		reject( new Error( 'Ve stránce chybí <script type="module" integrity> pro ' + url ) );
	} else if ( !settle() ) {
		element.addEventListener( 'load', settle, { once: true } );
		element.addEventListener( 'error', settle, { once: true } );
	}
} );

/** chyba s textem pro uživatele (a kódem z API) */
class ToolError extends Error {

	constructor ( /** @type {String} */ message, /** @type {String} */ code = '' )
	{
		super( message );
		this.code = code;
	}

}

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

/** @returns {String} text kódu chyby z API (functions/_lib/dashboard.js ERRORS, zone-settings.js ZONE_ERRORS) */
const codeText = function ( /** @type {String} */ code, /** @type {String} */ message )
{
	const template = settings.texts?.codes?.[ code ];
	return template ? String( template ).replace( '%s', message ) : ( message || code );
};

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

/** @returns {String} datum a čas podle jazyka administrace */
const formatTime = function ( /** @type {Date} */ date, /** @type {Object} */ options = { dateStyle: 'medium', timeStyle: 'short' } )
{
	try {
		return new Intl.DateTimeFormat( settings.locale, options ).format( date );
	} catch {
		return date.toLocaleString();
	}
};

/** @returns {String} popisek hodnoty volby (neznámá hodnota = hodnota sama) */
const valueLabel = function ( /** @type {Object} */ definition, /** @type {String} */ value )
{
	return definition.choices.find( ( [ choice ] ) => choice === value )?.[ 1 ] ?? value;
};

// -----------------------------------------------------------------------------------------------------------------------------
// WordPress a Pages Function

/** @returns {Promise.<Object>} data odpovědi admin-ajax.php (wp_send_json_success); stav HTTP může být kvůli cgi.rfc2616_headers vždy 200 */
const ajax = async function ( /** @type {Object} */ fields, /** @type {String} */ errorKey )
{
	let response;
	try {
		response = await fetch( settings.ajaxUrl, { method: 'POST', credentials: 'same-origin', body: new URLSearchParams( fields ), signal: AbortSignal.timeout( settings.timeout ) } );
	} catch ( error ) {
		throw new ToolError( text( errorKey, error?.name === 'TimeoutError' ? text( 'timeout', Math.round( settings.timeout / 1000 ) ) : String( error?.message ?? error ) ) );
	}
	let data = null;
	try {
		data = await response.json();
	} catch {
		data = null;
	}
	if ( !data?.success ) {
		throw new ToolError( text( errorKey, data?.data?.message ?? ( response.ok ? text( 'invalid' ) : text( 'http', response.status ) ) ) );
	}
	return data.data;
};

/** @returns {Promise.<Object>} { token, expires, id, entry } – bez change token jen pro čtení */
const requestToken = async function ( /** @type {?Object} */ change = null )
{
	const fields = { action: settings.tokenAction, [ settings.nonceName ]: settings.tokenNonce };
	if ( change ) {
		fields[ settings.fields.zone ] = change.zone;
		fields[ settings.fields.zoneName ] = change.zoneName;
		fields[ settings.fields.setting ] = change.setting;
		fields[ settings.fields.value ] = change.value;
	}
	const data = await ajax( fields, 'tokenRequest' );
	if ( typeof data?.token !== 'string' ) {
		throw new ToolError( text( 'tokenRequest', text( 'invalid' ) ) );
	}
	return data;
};

/** @returns {Promise.<Object>} odpověď Pages Function (GET stav, POST změna podle tokenu) */
const callApi = async function ( /** @type {String} */ method, /** @type {String} */ token )
{
	let response;
	try {
		response = await fetch( settings.endpoint, {
			method,
			headers: { Authorization: 'Bearer ' + token },
			credentials: 'omit',
			referrerPolicy: 'no-referrer',
			cache: 'no-store',
			signal: AbortSignal.timeout( settings.timeout ),
		} );
	} catch ( error ) {
		throw new ToolError( error?.name === 'TimeoutError' ? text( 'timeout', Math.round( settings.timeout / 1000 ) ) : text( 'network', settings.endpoint ) );
	}
	let data = null;
	try {
		data = await response.json();
	} catch {
		data = null;
	}
	if ( !response.ok ) {
		if ( typeof data?.error === 'string' ) {
			throw new ToolError( codeText( data.error, String( data.message ?? '' ) ), data.error );
		}
		throw new ToolError( response.status === 404 ? text( 'notFound', settings.endpoint ) : text( 'http', response.status ) );
	}
	if ( !data || typeof data !== 'object' || Array.isArray( data ) || data.version === undefined ) {
		throw new ToolError( text( 'invalid' ) );
	}
	return data;
};

// -----------------------------------------------------------------------------------------------------------------------------
// Potvrzovací okno (Dialogic, pravidlo 19)

/** @type {?Promise.<Function>} třída Dialogic po kontrole SRI */
let dialogicPromise = null;

/** @returns {Promise.<Function>} */
const getDialogic = function ()
{
	dialogicPromise ??= Promise.all( DIALOGIC_MODULES.map( importVerified ) ).then( ( modules ) => modules[ 1 ].Dialogic );
	dialogicPromise.catch( () =>
	{
		dialogicPromise = null; // příště znovu
	} );
	return dialogicPromise;
};

/**
* Okno s otázkou a tlačítky potvrdit / zrušit. Zavření křížkem nebo vedle okna = zrušit.
* @returns {Promise.<Boolean>} potvrzeno
*/
const confirmDialog = async function ( /** @type {String} */ title, /** @type {String} */ message, /** @type {String} */ confirmLabel )
{
	const Dialogic = await getDialogic();
	return new Promise( ( resolve ) =>
	{
		const form = element( 'form' );
		const confirmButton = element( 'button', [ settings.classes.button, settings.classes.buttonPrimary ], [ confirmLabel ] );
		confirmButton.type = 'submit';
		confirmButton.value = CONFIRM_VALUE;
		const cancelButton = element( 'button', [ settings.classes.button ], [ text( 'cancel' ) ] );
		cancelButton.type = 'submit';
		cancelButton.value = '';
		form.append( element( 'p', [], [ message ] ), element( 'p', [ settings.classes.dialogButtons ], [ confirmButton, cancelButton ] ) );

		// stejně jako v admin-static-export.mjs: vibrate: 0 (Dialogic 0.2.0 jinak volá navigator.vibrate) a obnovení posunu stránky (první okno ještě nemá styly)
		const { scrollX, scrollY } = window;
		const dialog = new Dialogic( title, { requireInteraction: true, silent: true, vibrate: 0 }, settings.dialogicSettingsId );
		if ( window.scrollX !== scrollX || window.scrollY !== scrollY ) {
			window.scrollTo( scrollX, scrollY );
		}
		( document.getElementById( dialog.getAttribute( 'aria-describedby' ) ?? '' ) ?? dialog ).append( form );

		let answered = false;
		const answer = ( /** @type {Boolean} */ confirmed ) =>
		{
			if ( answered ) {
				return;
			}
			answered = true;
			resolve( confirmed );
			if ( dialog.open ) {
				dialog.close(); // Dialogic: událost close (podruhé ji pošle prohlížeč – answer() už nic neudělá)
			} else if ( dialog.isConnected ) {
				Dialogic.removeDialogFromList( dialog );
				dialog.remove();
			}
		};
		form.addEventListener( 'submit', ( event ) =>
		{
			event.preventDefault();
			answer( event.submitter instanceof HTMLButtonElement && event.submitter.value === CONFIRM_VALUE );
		} );
		dialog.addEventListener( 'close', () => answer( false ) );
		cancelButton.focus( { preventScroll: true } ); // výchozí volba je bezpečná
	} );
};

// -----------------------------------------------------------------------------------------------------------------------------
// Nástroj

class ZoneSettingsTool {

	/** @type {HTMLElement} */
	#root;

	/** @type {?Object} poslední odpověď GET */
	#report = null;

	/** @type {String} ID vybrané zóny */
	#zoneId = '';

	/** @type {Boolean} běží načítání nebo změna – ovládání je vypnuté */
	#busy = false;

	constructor ( /** @type {HTMLElement} */ root )
	{
		this.#root = root;
		this.#notices = { report: element( 'div' ), change: element( 'div' ) };
		this.#find( ATTRIBUTES.NOTICE )?.append( this.#notices.report, this.#notices.change );
		this.#find( ATTRIBUTES.RELOAD )?.addEventListener( 'click', () => this.load() );
		root.addEventListener( 'click', ( event ) =>
		{
			const button = event.target instanceof Element ? event.target.closest( 'button[data-value]' ) : null;
			const row = button?.closest( '[' + ATTRIBUTES.ROW + ']' );
			if ( button && row && !this.#busy ) {
				const select = row.querySelector( 'select' );
				this.change( row.getAttribute( ATTRIBUTES.ROW ), button.dataset.value === '' && select ? select.value : button.dataset.value );
			}
		} );
		root.addEventListener( 'change', ( event ) =>
		{
			if ( event.target instanceof HTMLSelectElement && event.target.closest( '[' + ATTRIBUTES.ROW + ']' ) ) { // Použít jen se změněnou hodnotou
				const apply = event.target.parentElement.querySelector( 'button' );
				if ( apply ) {
					apply.dataset.disabled = String( event.target.value === event.target.dataset.current ); // #setBusy() ho podle toho po skončení načítání nechá vypnuté
					apply.disabled = this.#busy || apply.dataset.disabled === 'true';
				}
			}
		} );
	}

	/** @returns {?HTMLElement} */
	#find ( /** @type {String} */ attribute )
	{
		return this.#root.querySelector( '[' + attribute + ']' );
	}

	#setStatus ( /** @type {Array} */ content, /** @type {Boolean} */ spinning = false )
	{
		this.#find( ATTRIBUTES.STATUS )?.replaceChildren( ...( spinning ? [ element( 'span', [ 'spinner', 'is-active' ] ) ] : [] ), ...content );
	}

	/** @type {Object.<string, HTMLElement>} oblasti oznámení v prvku NOTICE: report = stav zóny (mění ho každé načtení), change = výsledek poslední změny (smaže ho až další změna nebo Načíst znovu) */
	#notices = {};

	#setNotice ( /** @type {String} */ area, /** @type {?String} */ type, /** @type {Array} */ content = [] )
	{
		this.#notices[ area ]?.replaceChildren( ...( type ? [ element( 'div', [ settings.classes.notice, type, settings.classes.inline ], [ element( 'p', [], content ) ] ) ] : [] ) );
	}

	#addNotice ( /** @type {String} */ area, /** @type {String} */ type, /** @type {Array} */ content )
	{
		this.#notices[ area ]?.append( element( 'div', [ settings.classes.notice, type, settings.classes.inline ], [ element( 'p', [], content ) ] ) );
	}

	#setBusy ( /** @type {Boolean} */ busy )
	{
		this.#busy = busy;
		for ( const control of this.#root.querySelectorAll( 'button, select' ) ) {
			if ( control.hasAttribute( ATTRIBUTES.RELOAD ) || control.closest( '[' + ATTRIBUTES.ROW + ']' ) || control.closest( '[' + ATTRIBUTES.ZONE + ']' ) ) {
				control.disabled = busy || ( control.dataset.disabled === 'true' );
			}
		}
	}

	/** @returns {?Object} vybraná zóna z poslední odpovědi */
	#zone ()
	{
		const items = this.#report?.cloudflare?.zones?.items ?? [];
		return items.find( ( zone ) => zone.id === this.#zoneId ) ?? items[ 0 ] ?? null;
	}

	/** @returns {HTMLAnchorElement} odkaz do administrace Cloudflare (nová záložka) */
	#externalLink ( /** @type {String} */ url, /** @type {String} */ label )
	{
		const link = element( 'a', [], [ label, element( 'span', [ settings.classes.screenReader ], [ ' ' + text( 'newTab' ) ] ) ] );
		link.href = url;
		link.target = '_blank';
		link.rel = 'noopener noreferrer';
		return link;
	}

	/** @returns {String} adresa v administraci Cloudflare s doplněnou zónou (bez názvu zóny se Cloudflare na zónu zeptá) */
	#dashboardUrl ( /** @type {String} */ template, /** @type {?Object} */ zone )
	{
		return zone?.name ? template.replace( ':zone', zone.name ) : template;
	}

	/** Stav ze všech zón (GET). */
	async load ( /** @type {Boolean} */ keepChangeNotice = false )
	{
		if ( this.#busy ) {
			return;
		}
		if ( !keepChangeNotice ) {
			this.#setNotice( 'change', null );
		}
		this.#setBusy( true );
		this.#setStatus( [ text( 'loading' ) ], true );
		try {
			const { token } = await requestToken();
			this.#report = await callApi( 'GET', token );
			ajax( { action: settings.stateAction, [ settings.nonceName ]: settings.stateNonce, [ settings.fields.report ]: JSON.stringify( this.#report ) }, 'loadFailed' ) // [2026-11-27] stav zón pro upozornění na nástěnce (režim Pod útokem) – na výsledek se nečeká
				.catch( ( error ) => console.warn( 'Nastavení Cloudflare: stav pro nástěnku se neuložil –', error?.message ?? error ) );
			this.#render();
			this.#setStatus( [ text( 'loaded', formatTime( new Date(), { timeStyle: 'short' } ) ) ] );
		} catch ( error ) {
			if ( !( error instanceof ToolError ) ) {
				console.error( error );
			}
			this.#report = null;
			this.#render();
			this.#setNotice( 'report', settings.classes.noticeError, parts( 'loadFailed', error instanceof ToolError ? error.message : text( 'unexpectedError' ) ) );
			this.#setStatus( [] );
		} finally {
			this.#setBusy( false );
		}
	}

	#render ()
	{
		const cloudflare = this.#report?.cloudflare ?? null;
		const zones = cloudflare?.zones?.items ?? [];
		if ( !zones.some( ( zone ) => zone.id === this.#zoneId ) ) {
			this.#zoneId = zones[ 0 ]?.id ?? '';
		}
		const zone = this.#zone();
		this.#setNotice( 'report', null );
		if ( cloudflare?.error ) {
			const content = [ codeText( cloudflare.error.code, cloudflare.error.message ) ];
			if ( cloudflare.error.code === TOKEN_MISSING_CODE ) {
				const guide = element( 'a', [], [ text( 'guideLink' ) ] );
				guide.href = settings.guideUrl;
				content.push( ' ', guide );
			}
			this.#setNotice( 'report', settings.classes.noticeError, content );
		}
		this.#renderZone( zones, zone, cloudflare );
		for ( const link of this.#root.querySelectorAll( '[' + ATTRIBUTES.GROUP_LINK + ']' ) ) {
			link.href = this.#dashboardUrl( link.getAttribute( ATTRIBUTES.GROUP_LINK ), zone );
		}
		for ( const row of this.#root.querySelectorAll( 'tr[' + ATTRIBUTES.ROW + ']' ) ) {
			const id = row.getAttribute( ATTRIBUTES.ROW );
			const definition = settings.definitions[ id ];
			const state = zone?.values?.[ id ] ?? null;
			if ( definition ) {
				this.#renderRow( row, id, definition, state, zone );
			}
		}
	}

	#renderZone ( /** @type {Array.<Object>} */ zones, /** @type {?Object} */ zone, /** @type {?Object} */ cloudflare )
	{
		const container = this.#find( ATTRIBUTES.ZONE );
		if ( !container ) {
			return;
		}
		container.replaceChildren();
		if ( !zone ) {
			return;
		}
		if ( zones.length > 1 ) {
			const select = element( 'select' );
			select.id = ROOT_ID + '-zona';
			for ( const item of zones ) {
				const option = element( 'option', [], [ item.name ?? item.id ] );
				option.value = item.id;
				option.selected = item.id === zone.id;
				select.append( option );
			}
			select.addEventListener( 'change', () =>
			{
				this.#zoneId = select.value;
				this.#render();
			} );
			const label = element( 'label', [], [ text( 'zoneSelect' ), ' ' ] );
			label.htmlFor = select.id;
			container.append( element( 'p', [], [ label, select ] ) );
		}
		const summary = zone.name
			? parts( 'zoneSummary', zone.name, zone.plan ?? '?', zone.status ?? '?' )
			: parts( 'zoneUnknown', zone.id );
		const lines = [ element( 'p', [], [ ...summary, ' ', this.#externalLink( this.#dashboardUrl( settings.zoneLink, zone ), text( 'zoneLink' ) ) ] ) ];
		if ( zone.domains?.length ) {
			lines.push( element( 'p', [], parts( 'zoneDomains', zone.domains.join( ', ' ) ) ) );
		}
		if ( zone.paused ) {
			lines.push( element( 'div', [ settings.classes.notice, settings.classes.noticeWarning, settings.classes.inline ], [ element( 'p', [], parts( 'zonePaused' ) ) ] ) );
		}
		if ( cloudflare?.zones?.external?.length ) {
			lines.push( element( 'p', [], parts( 'zoneExternal', cloudflare.zones.external.join( ', ' ) ) ) );
		}
		if ( cloudflare?.zones?.skipped ) {
			lines.push( element( 'p', [], parts( 'zoneSkipped', cloudflare.zones.skipped ) ) );
		}
		if ( Number.isInteger( zone.customRules?.total ) ) {
			lines.push( element( 'p', [], parts( 'customRules', zone.customRules.total ) ) );
		}
		container.append( ...lines );
	}

	/** @returns {String} úroveň zabezpečení, kterou vrátí vypnutí režimu Pod útokem */
	#restoreLevel ( /** @type {?Object} */ zone )
	{
		return settings.restoreLevels?.[ zone?.id ?? '' ] ?? settings.defaultRestoreLevel;
	}

	#renderRow ( /** @type {HTMLTableRowElement} */ row, /** @type {String} */ id, /** @type {Object} */ definition, /** @type {?Object} */ state, /** @type {?Object} */ zone )
	{
		const stateCell = row.cells[ 1 ];
		const controlCell = row.cells[ 2 ];
		const prefix = settings.classes.statePrefix;
		stateCell.className = settings.classes.state;
		controlCell.replaceChildren();
		if ( !state ) {
			stateCell.replaceChildren( '—' );
			return;
		}
		if ( state.error ) {
			stateCell.classList.add( prefix + VALUE_STATES.UNKNOWN );
			stateCell.replaceChildren( text( 'unavailable', codeText( state.error.code, state.error.message ) ) );
			return;
		}

		// Teď
		const value = String( state.value ?? '' );
		const details = [];
		let label = valueLabel( definition, value );
		let valueState = VALUE_STATES.OFF;
		if ( definition.control === CONTROLS.ACTION ) {
			label = '—';
		} else if ( definition.control === CONTROLS.UNDER_ATTACK ) {
			if ( value !== definition.onValue ) {
				label = text( 'underAttackOff', valueLabel( definition, value ) );
			}
		}
		if ( definition.attention.includes( value ) ) {
			valueState = VALUE_STATES.ATTENTION;
		} else if ( value === definition.onValue || ( definition.control === CONTROLS.SELECT && value !== '' ) || definition.control === CONTROLS.READ_ONLY ) {
			valueState = VALUE_STATES.ON;
		}
		if ( definition.control !== CONTROLS.ACTION ) {
			stateCell.classList.add( prefix + valueState );
		}
		if ( Number.isFinite( state.timeRemaining ) && state.timeRemaining > 0 && value === definition.onValue ) {
			details.push( text( 'timeRemaining', Math.ceil( state.timeRemaining / 60 ) ) );
		}
		if ( definition.recommended !== null && definition.recommended !== undefined && value !== definition.recommended ) {
			details.push( text( 'recommended', valueLabel( definition, definition.recommended ) ) );
		}
		if ( state.exists === false ) {
			details.push( text( 'ruleMissing' ) );
		}
		if ( state.customized ) {
			details.push( text( 'ruleCustomized' ) );
		}
		if ( state.modifiedOn ) {
			const modified = new Date( state.modifiedOn );
			if ( !Number.isNaN( modified.getTime() ) ) {
				details.push( text( 'modifiedOn', formatTime( modified ) ) );
			}
		}
		stateCell.replaceChildren( element( 'strong', [], [ label ] ), ...( details.length ? [ element( 'p', [ settings.classes.description ], [ details.join( ' · ' ) ] ) ] : [] ) );

		// Změnit
		if ( definition.control === CONTROLS.READ_ONLY ) {
			controlCell.append( element( 'p', [ settings.classes.description ], [ text( 'readOnly' ) ] ) );
			return;
		}
		if ( state.editable === false ) {
			controlCell.append( element( 'p', [ settings.classes.description ], [ text( 'notEditable' ) ] ) );
			return;
		}
		const button = ( /** @type {String} */ caption, /** @type {String} */ target, /** @type {String} */ accessibleLabel, /** @type {Boolean} */ primary = false ) =>
		{
			const node = element( 'button', primary ? [ settings.classes.button, settings.classes.buttonPrimary ] : [ settings.classes.button ], [ caption ] );
			node.type = 'button';
			node.dataset.value = target;
			node.setAttribute( 'aria-label', accessibleLabel );
			node.disabled = this.#busy;
			return node;
		};
		switch ( definition.control ) {
			case CONTROLS.TOGGLE:
				controlCell.append( value === definition.onValue
					? button( text( 'turnOff' ), definition.offValue, text( 'turnOffLabel', definition.label ) )
					: button( text( 'turnOn' ), definition.onValue, text( 'turnOnLabel', definition.label ) ) );
				break;
			case CONTROLS.UNDER_ATTACK:
				if ( value === definition.onValue ) {
					const restore = this.#restoreLevel( zone );
					controlCell.append( button( text( 'turnOff' ), restore, text( 'turnOffLabel', definition.label ), true ), element( 'p', [ settings.classes.description ], [ text( 'restoreLevel', valueLabel( definition, restore ) ) ] ) );
				} else {
					controlCell.append( button( text( 'turnOn' ), definition.onValue, text( 'turnOnLabel', definition.label ) ) );
				}
				break;
			case CONTROLS.SELECT: {
				const select = element( 'select' );
				select.setAttribute( 'aria-label', definition.label );
				select.dataset.current = value;
				select.disabled = this.#busy;
				if ( !definition.choices.some( ( [ choice ] ) => choice === value ) && value !== '' ) {
					select.append( element( 'option', [], [ value ] ) ); // hodnota, kterou seznam nezná (nastavená jinde) – jen pro zobrazení
				}
				for ( const [ choice, choiceLabel ] of definition.choices ) {
					const option = element( 'option', [], [ choiceLabel ] );
					option.value = choice;
					option.selected = choice === value;
					select.append( option );
				}
				const apply = button( text( 'apply' ), '', text( 'applyLabel', definition.label ) ); // hodnotu vezme z výběru
				apply.dataset.disabled = 'true'; // až po změně výběru
				apply.disabled = true;
				controlCell.append( select, ' ', apply );
				break;
			}
			case CONTROLS.ACTION:
				controlCell.append( button( text( 'purge' ), definition.onValue, definition.label ) );
				break;
		}
	}

	/** Změna jedné volby vybrané zóny na hodnotu value. */
	async change ( /** @type {String} */ id, /** @type {String} */ value )
	{
		const definition = settings.definitions[ id ];
		const zone = this.#zone();
		if ( !definition || !zone || this.#busy ) {
			return;
		}
		const confirmText = definition.confirm?.[ value ];
		if ( confirmText ) {
			let confirmed = false;
			try {
				const actionLabel = definition.control === CONTROLS.ACTION ? text( 'purge' ) : ( definition.control === CONTROLS.SELECT ? text( 'apply' ) : text( 'turnOn' ) );
				confirmed = await confirmDialog( text( 'confirmTitle', definition.label ), confirmText, actionLabel );
			} catch ( error ) {
				console.error( error );
				this.#setNotice( 'change', settings.classes.noticeError, parts( 'dialogsUnavailable' ) );
				return;
			}
			if ( !confirmed ) {
				return;
			}
		}

		this.#setBusy( true );
		this.#setNotice( 'change', null );
		this.#setStatus( [ text( 'changing' ) ], true );
		let logId = '';
		let succeeded = false;
		try {
			const issued = await requestToken( { zone: zone.id, zoneName: zone.name ?? '', setting: id, value } );
			logId = String( issued.id ?? '' );
			this.#addLogRow( issued.entry );
			let data;
			try {
				data = await callApi( 'POST', issued.token );
			} catch ( error ) {
				await this.#finishLog( logId, settings.logStates.error, '', '', error instanceof ToolError ? error.message : String( error?.message ?? error ) );
				throw error;
			}
			const result = data.result ?? {};
			succeeded = true;
			if ( definition.control === CONTROLS.UNDER_ATTACK && value === definition.onValue && result.before && result.before !== definition.onValue ) { // kam se vrátit při vypnutí (příště to WordPress najde v historii, getRestoreLevels())
				settings.restoreLevels = { ...settings.restoreLevels, [ zone.id ]: result.before };
			}
			this.#setNotice( 'change', settings.classes.noticeSuccess, definition.control === CONTROLS.ACTION
				? parts( 'purged' )
				: parts( 'changed', definition.label, valueLabel( definition, String( result.after ?? value ) ) ) );
			await this.#finishLog( logId, settings.logStates.ok, String( result.before ?? '' ), String( result.after ?? '' ), '' );
		} catch ( error ) {
			if ( !( error instanceof ToolError ) ) {
				console.error( error );
			}
			if ( !succeeded ) {
				this.#setNotice( 'change', settings.classes.noticeError, parts( 'changeFailed', error instanceof ToolError ? error.message : text( 'unexpectedError' ) ) );
			}
		} finally {
			this.#setBusy( false );
			this.#setStatus( [] );
		}
		await this.load( true ); // stav po změně (i po chybě – mohla proběhnout jen část)
	}

	/** Výsledek změny do historie ve WordPressu; chyba zápisu se jen oznámí (změna sama proběhla nebo ne nezávisle na ní). */
	async #finishLog ( /** @type {String} */ id, /** @type {String} */ state, /** @type {String} */ before, /** @type {String} */ after, /** @type {String} */ message )
	{
		if ( id === '' ) {
			return;
		}
		try {
			const data = await ajax( {
				action: settings.logAction,
				[ settings.nonceName ]: settings.logNonce,
				[ settings.fields.id ]: id,
				[ settings.fields.state ]: state,
				[ settings.fields.before ]: before,
				[ settings.fields.after ]: after,
				[ settings.fields.message ]: message,
			}, 'logFailed' );
			this.#addLogRow( data?.entry );
		} catch ( error ) {
			this.#addNotice( 'change', settings.classes.noticeWarning, [ error instanceof ToolError ? error.message : String( error ) ] ); // vedle oznámení o změně
		}
	}

	/** Řádek historie (záznam z \FUNCTIONS\CLOUDFLARE_SETTINGS\logView()); stejný záznam nahradí, nový přidá nahoru. Sloupce jako appendLogRow() v PHP. */
	#addLogRow ( /** @type {?Object} */ entry )
	{
		const body = this.#find( ATTRIBUTES.LOG );
		if ( !body || !entry?.id ) {
			return;
		}
		const change = entry.action
			? entry.label
			: ( entry.before !== '' ? text( 'logChange', entry.label, entry.before, entry.value ) : text( 'logChangeTo', entry.label, entry.value ) );
		const results = { ok: text( 'logOk' ), error: text( 'logError', entry.message ), unknown: text( 'logUnknown' ) };
		const row = element( 'tr', [], [ entry.time, entry.user, entry.zone, change, results[ entry.state ] ?? text( 'logPending' ) ].map( ( value ) => element( 'td', [], [ String( value ?? '' ) ] ) ) );
		row.dataset.id = entry.id;
		const existing = [ ...body.rows ].find( ( item ) => item.dataset.id === entry.id );
		if ( existing ) {
			existing.replaceWith( row );
			return;
		}
		for ( const empty of [ ...body.rows ].filter( ( item ) => item.cells.length === 1 ) ) { // „Zatím žádné změny.“
			empty.remove();
		}
		body.prepend( row );
	}

}

const root = document.getElementById( ROOT_ID );
const settingsElement = document.getElementById( SETTINGS_ELEMENT_ID );
if ( root && settingsElement ) {
	settings = JSON.parse( settingsElement.textContent ?? '{}' );
	new ZoneSettingsTool( root ).load();
}
