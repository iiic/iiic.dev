/**
* [2026-11-27] Widget „Cloudflare“ na nástěnce šablony domdocument-template (dashboard-widgets/cloudflare.php,
* \FUNCTIONS\DASHBOARD ve functions.php, README.md šablony – sekce „Cloudflare na nástěnce“).
*
* API Cloudflare prohlížeč volat nesmí (api.cloudflare.com nemá CORS) a PHP nic nestahuje (pravidlo 17). Modul proto:
* 1. si přes admin-ajax.php vyžádá token podepsaný WordPressem (platí 5 minut, \FUNCTIONS\DASHBOARD\ajaxCloudflareToken()),
* 2. s ním zavolá Pages Function GET https://<projekt>.pages.dev/api/dashboard (functions/_lib/dashboard.js statického webu),
*    která má tajný API token jen pro čtení a vrátí souhrn: nastavení na Cloudflare, databázi, projekt a nasazení,
*    čerpání limitů od půlnoci UTC a chyby za posledních 7 dní,
* 3. vyplní části widgetu: Nastavení na Cloudflare, Nasazení a commity (porovnání s posledním exportem z WordPressu),
*    Čerpání limitů dnes (ukazatele proti limitům bezplatného tarifu), Chyby (počet a poslední výskyt).
* Výsledek si pamatuje v sessionStorage (tlačítko „Načíst znovu“ paměť obejde). Vše přes DOM (textContent).
*
* [2026-11-27] v0.2: i widget „Cloudflare – provoz zóny“ (dashboard-widgets/cloudflare-provoz.php): Pages Function
* GET /api/dashboard/traffic (functions/_lib/dashboard-traffic.js) vrátí HTTP provoz zóny vlastní domény projektu a modul
* vyplní části Zóna, Posledních 24 hodin (požadavky, přenesená data, podíl z cache, zablokované hrozby), Po dnech (tabulka)
* a Zablokované hrozby (podle akce a zdroje, počet a poslední výskyt). Každý widget má vlastní nastavení (kind, endpoint,
* paměť, atribut obalu), texty a odkazy se slučují. Token WordPressu si modul vyžádá jednou pro oba widgety.
*
* [2026-11-27] v0.3: kroky 1 a 2 a paměť v sessionStorage nahradil modul stránky Analytická data (js/modules/analytics-data.mjs,
* přes importVerified()). Widget má v nastavení jen zdroj (source = \VARS\ANALYTICS::SOURCE_…): údaje uložené ve WordPressu
* ukáže hned a starší než maxAge zdroje nechá načíst znovu (WordPress je uloží a složí z nich historii pro stránku
* Analytická data). „Načíst znovu“ načte vždy. Když nové údaje nepřijdou, zůstanou vidět uložené s upozorněním. Tabulka
* „Po dnech“ ukazuje jen posledních daysShown dní – zdroj provozu načítá 30 dní kvůli historii.
*
* @version 0.3
* @since Q4 2026
*/

/** @type {String[]} \VARS\DASHBOARD_WIDGET::CLOUDFLARE_SETTINGS_ID a CLOUDFLARE_TRAFFIC_SETTINGS_ID */
const SETTINGS_ELEMENT_IDS = [ 'ddt-nastenka-cloudflare-nastaveni', 'ddt-nastenka-cloudflare-provoz-nastaveni' ];

/** @type {Object<String, String>} druh widgetu – \VARS\DASHBOARD_WIDGET::CLOUDFLARE_KIND_… */
const KINDS = Object.freeze( {
	OVERVIEW: 'overview',
	TRAFFIC: 'traffic',
} );

/** @type {String} [2026-11-27] modul načítání a ukládání (\VARS\ANALYTICS::DATA_SCRIPT bez ?verze) */
const DATA_MODULE = 'analytics-data.mjs';

/** @type {String} \VARS\VERIFIED_MODULE::LOADED_ATTRIBUTE a FAILED_ATTRIBUTE (\FUNCTIONS\TEMPLATE\verifiedModuleScript()) */
const LOADED_ATTRIBUTE = 'data-module-loaded';
const FAILED_ATTRIBUTE = 'data-module-failed';

/** @type {Object<String, String>} stavy položek – \POSSIBILITIES\DASHBOARD_STATES */
const STATES = Object.freeze( {
	OK: 'ok',
	WARNING: 'warning',
	ERROR: 'error',
	INFO: 'info',
} );

/** @type {String[]} stavy vyvolání Pages Functions, které nejsou chybou funkce (GraphQL dimenze status) */
const NOT_ERROR_STATUSES = [ 'clientDisconnected' ];

/** @type {Number} znaků hashe commitu, které se ukazují */
const SHORT_HASH = 7;

/** @type {Object} nastavení společné widgetům (jazyk, třídy, stavy, texty a odkazy obou widgetů); vlastní má každý widget v card */
let settings = {};

/** @returns {String} text s doplněnými hodnotami (%s, %1$s… jako sprintf() v PHP) */
const fill = function ( /** @type {String} */ template, /** @type {...(String|Number)} */ ...values )
{
	let index = 0;
	return String( template ?? '' ).replace( /%(?:(\d+)\$)?s/g, ( match, position ) => String( values[ position ? Number( position ) - 1 : index++ ] ?? '' ) );
};

/** @returns {String} */
const text = function ( /** @type {String} */ key, /** @type {...(String|Number)} */ ...values )
{
	return fill( settings.texts?.[ key ] ?? key, ...values );
};

/** @returns {Array.<String|Node>} text s doplněnými hodnotami, které můžou být i prvky (čas, odkaz, kód) */
const compose = function ( /** @type {String} */ key, /** @type {...(String|Number|Node)} */ ...values )
{
	const parts = [];
	const template = String( settings.texts?.[ key ] ?? key );
	const pattern = /%(?:(\d+)\$)?s/g;
	let index = 0;
	let last = 0;
	for ( const match of template.matchAll( pattern ) ) {
		parts.push( template.slice( last, match.index ) );
		const value = values[ match[ 1 ] ? Number( match[ 1 ] ) - 1 : index++ ];
		parts.push( value instanceof Node ? value : String( value ?? '' ) );
		last = match.index + match[ 0 ].length;
	}
	parts.push( template.slice( last ) );
	return parts.filter( ( part ) => part !== '' );
};

/** @returns {String} tvar podle počtu (one / few / other) */
const plural = function ( /** @type {String} */ key, /** @type {Number} */ count )
{
	const forms = settings.texts?.[ key ] ?? {};
	const form = new Intl.PluralRules( settings.locale ).select( count );
	return String( forms[ form ] ?? forms.other ?? '' ).replace( '%s', formatNumber( count ) );
};

/** @returns {String} text chyby z API podle kódu (functions/_lib/dashboard.js, ERRORS), u chybějícího oprávnění s radou hintKey */
const codeText = function ( /** @type {Object|null} */ error, /** @type {String} */ hintKey = 'permissionHint' )
{
	const template = settings.texts?.codes?.[ error?.code ];
	const message = String( error?.message ?? '' );
	if ( !template ) {
		return message || String( error?.code ?? '' );
	}
	let result = fill( template, message );
	if ( error?.code === 'zone-access' || error?.status === 403 || error?.cloudflareCode === 10000 || error?.cloudflareCode === 9109 ) { // chybí oprávnění tokenu
		result += ( /[.!?…]$/.test( result ) ? ' ' : '. ' ) + text( hintKey ); // texty chyb od Cloudflare bývají bez tečky
	}
	return result;
};

/** @returns {HTMLElement} */
const element = function ( /** @type {String} */ tagName, /** @type {Array.<String>} */ classNames = [], /** @type {Array.<String|Node>} */ content = [] )
{
	const node = document.createElement( tagName );
	if ( classNames.length ) {
		node.className = classNames.filter( Boolean ).join( ' ' );
	}
	node.append( ...content );
	return node;
};

/** @returns {HTMLAnchorElement} odkaz na jiný web (nová karta, ikona a text pro čtečky jako v administraci) */
const externalLink = function ( /** @type {String} */ url, /** @type {String} */ label )
{
	const link = element( 'a', [], [ label, element( 'span', [ settings.classes.screenReader ], [ ' ' + text( 'newTab' ) ] ) ] );
	const icon = element( 'span', settings.classes.externalIcon );
	icon.setAttribute( 'aria-hidden', 'true' );
	link.append( icon );
	link.href = url;
	link.target = '_blank';
	link.rel = 'noopener noreferrer';
	return link;
};

/** @returns {String} */
const formatNumber = function ( /** @type {Number} */ value, /** @type {Object} */ options = {} )
{
	return new Intl.NumberFormat( settings.locale, options ).format( value );
};

/** @returns {String} 61,4 kB, 5 GB (desítkové jednotky jako limity Cloudflare) */
const formatBytes = function ( /** @type {Number} */ bytes )
{
	const units = [ 'byte', 'kilobyte', 'megabyte', 'gigabyte' ];
	let value = bytes;
	let unit = 0;
	while ( value >= 1000 && unit < units.length - 1 ) {
		value /= 1000;
		unit++;
	}
	return formatNumber( value, { style: 'unit', unit: units[ unit ], unitDisplay: 'short', maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0 } );
};

/** @returns {Number} čas v ms (ISO 8601, nebo „RRRR-MM-DD HH:MM:SS“ v UTC z tabulky d1_migrations), 0 = neznámý */
const timeOf = function ( /** @type {String} */ value )
{
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test( String( value ?? '' ) ) ? String( value ).replace( ' ', 'T' ) + 'Z' : String( value ?? '' );
	const time = Date.parse( normalized );
	return Number.isNaN( time ) ? 0 : time;
};

/** @returns {String} „před 3 hodinami“ */
const relativeTime = function ( /** @type {Number} */ time )
{
	const seconds = Math.round( ( time - Date.now() ) / 1000 );
	const units = [ [ 'year', 31536000 ], [ 'month', 2592000 ], [ 'week', 604800 ], [ 'day', 86400 ], [ 'hour', 3600 ], [ 'minute', 60 ] ];
	const format = new Intl.RelativeTimeFormat( settings.locale, { numeric: 'auto' } );
	for ( const [ unit, size ] of units ) {
		if ( Math.abs( seconds ) >= size ) {
			return format.format( Math.round( seconds / size ), unit );
		}
	}
	return format.format( 0, 'minute' );
};

/** @returns {HTMLTimeElement|String} 27. 11. 2026 14:02 (před 2 hodinami) */
const timeElement = function ( /** @type {String} */ value )
{
	const time = timeOf( value );
	if ( !time ) {
		return text( 'unknown' );
	}
	const node = element( 'time', [], [ new Intl.DateTimeFormat( settings.locale, { dateStyle: 'medium', timeStyle: 'short' } ).format( new Date( time ) ) + ' (' + relativeTime( time ) + ')' ] );
	node.dateTime = new Date( time ).toISOString();
	return node;
};

/** @returns {HTMLElement} kód (hash commitu, hodnota) */
const code = function ( /** @type {String} */ value )
{
	return element( 'code', [], [ value ] );
};

/** @returns {Boolean} stejný commit (plný hash, nebo zkrácený na začátku plného) */
const sameCommit = function ( /** @type {String|null} */ first, /** @type {String|null} */ second )
{
	if ( !first || !second || Math.min( first.length, second.length ) < SHORT_HASH ) {
		return false;
	}
	return first.startsWith( second ) || second.startsWith( first );
};

/** @returns {HTMLUListElement} seznam se stavovou ikonou u každé položky (jako \FUNCTIONS\DASHBOARD\stateList()) */
const stateList = function ( /** @type {Array.<Array>} */ items, /** @type {Array.<String>} */ extraClasses = [] )
{
	const list = element( 'ul', [ settings.classes.items, ...extraClasses ] );
	for ( const [ state, content ] of items ) {
		const definition = settings.states[ state ] ?? settings.states[ STATES.INFO ];
		const icon = element( 'span', definition.icon );
		icon.setAttribute( 'aria-hidden', 'true' );
		list.append( element( 'li', [ definition.className ], [
			icon,
			element( 'span', [], [ element( 'span', [ settings.classes.screenReader ], [ definition.label + ' ' ] ), ...[ content ].flat() ] ),
		] ) );
	}
	return list;
};

/** @returns {HTMLElement} vysvětlivka šedým písmem */
const note = function ( /** @type {...(String|Node)} */ ...content )
{
	return element( 'p', [ settings.classes.note ], content );
};

/** @returns {HTMLElement} podnadpis uvnitř části (Pages Functions, D1…) */
const subheading = function ( /** @type {String} */ label )
{
	return element( 'p', [], [ element( 'strong', [], [ label ] ) ] );
};

/** chyba s textem pro uživatele */
class DashboardError extends Error {}

/**
* [2026-11-27] Modul ověřený přes SRI podle názvu souboru: PHP ho vypíše jako <script type="module" integrity> (adresa i s ?verzí),
* import() až po úspěšném načtení – prohlížeč ho pak vezme z mapy modulů bez nového stažení (pravidlo 9, vzor importVerified()
* v js/modules/admin-static-export.mjs).
*
* @returns {Promise.<Object>}
*/
const importVerified = ( /** @type {String} */ fileName ) => new Promise( ( resolve, reject ) =>
{
	const element = [ ...document.querySelectorAll( 'script[type="module"][integrity]' ) ].find( ( script ) => new URL( script.src ).pathname.endsWith( '/' + fileName ) );
	const settle = () =>
	{
		if ( element.hasAttribute( FAILED_ATTRIBUTE ) ) {
			reject( new Error( 'Modul neprošel kontrolou integrity (SRI) nebo se nenačetl: ' + element.src ) );
		} else if ( element.hasAttribute( LOADED_ATTRIBUTE ) ) {
			resolve( import( element.src ) );
		} else {
			return false;
		}
		return true;
	};
	if ( !element ) {
		reject( new Error( 'Ve stránce chybí <script type="module" integrity> pro ' + fileName ) );
	} else if ( !settle() ) { // ještě se nenačetl (atributy nastaví onload / onerror prvku dřív, než se zavolají tyto posluchače)
		element.addEventListener( 'load', settle, { once: true } );
		element.addEventListener( 'error', settle, { once: true } );
	}
} );

/** @type {Promise.<Object>|null} [2026-11-27] modul načítání a ukládání (js/modules/analytics-data.mjs) – token, stažení i uložení dělá on */
let analyticsData = null;

/** @returns {Promise.<Object>} */
const getAnalyticsData = function ()
{
	analyticsData ??= importVerified( DATA_MODULE );
	return analyticsData;
};

/** @returns {Boolean} odpověď má tvar, který widget umí vypsat */
const isValidReport = function ( /** @type {Object} */ card, /** @type {*} */ report )
{
	return Boolean( report && typeof report === 'object' && report.settings && ( card.kind === KINDS.TRAFFIC ? report.cloudflare : report.database ) );
};

// -----------------------------------------------------------------------------------------------------------------------------
// Části widgetu

/** @returns {Array.<Array>} položky části „Nastavení na Cloudflare“ */
const settingsItems = function ( /** @type {Object} */ report )
{
	const items = [];
	const remote = report.settings;
	const cloudflare = report.cloudflare ?? {};
	const loginState = ( /** @type {String} */ problem ) => settings.wordpressLogin ? problem : STATES.INFO; // bez přihlášení do WordPressu přístupovým klíčem jen pro informaci

	items.push( [ STATES.OK, text( 'signatureOk' ) ] );
	items.push( remote.apiToken ? [ STATES.OK, text( 'apiTokenOk' ) ] : [ STATES.WARNING, codeText( { code: 'token-missing' } ) ] );
	items.push( remote.database ? [ STATES.OK, text( 'binding' ) ] : [ STATES.ERROR, text( 'bindingMissing' ) ] );
	if ( remote.ssoPrivateKey === 'ok' ) {
		items.push( [ STATES.OK, text( 'ssoOk' ) ] );
	} else if ( remote.ssoPrivateKey === 'invalid' ) {
		items.push( [ loginState( STATES.ERROR ), text( 'ssoInvalid', remote.ssoMessage ?? '' ) ] );
	} else {
		items.push( [ loginState( STATES.WARNING ), text( 'ssoMissing' ) ] );
	}
	const origins = Array.isArray( remote.allowedOrigins ) ? remote.allowedOrigins : [];
	if ( origins.map( ( origin ) => origin.replace( /\/+$/, '' ) ).includes( settings.wordpressOrigin ) ) {
		items.push( [ STATES.OK, text( 'originOk', settings.wordpressOrigin ) ] );
	} else {
		items.push( [ loginState( STATES.WARNING ), text( 'originMissing', settings.wordpressOrigin, origins.length ? origins.join( ', ' ) : text( 'none' ) ) ] );
	}
	items.push( [ STATES.INFO, remote.rpId ? text( 'rpId', remote.rpId ) : text( 'rpIdDefault' ) ] );

	const database = report.database;
	if ( database.error ) {
		items.push( [ STATES.ERROR, codeText( database.error ) ] );
	} else {
		const migration = database.lastMigration ? text( 'migration', database.lastMigration.name, new Intl.DateTimeFormat( settings.locale, { dateStyle: 'medium', timeStyle: 'short' } ).format( new Date( timeOf( database.lastMigration.appliedAt ) || Date.now() ) ) ) : text( 'noMigration' );
		items.push( [ database.lastMigration ? STATES.INFO : STATES.WARNING, text( 'database', database.sizeBytes !== null ? formatBytes( database.sizeBytes ) : text( 'unknown' ), plural( 'users', database.users ), plural( 'credentials', database.credentials ) + ', ' + plural( 'sessions', database.sessions ), migration ) ] );
	}

	if ( cloudflare.error ) {
		items.push( [ cloudflare.error.code === 'token-missing' ? STATES.INFO : STATES.WARNING, codeText( cloudflare.error ) ] );
	} else if ( cloudflare.project?.error ) {
		items.push( [ STATES.ERROR, codeText( cloudflare.project.error ) ] );
	} else if ( cloudflare.project ) {
		const branch = cloudflare.project.productionBranch;
		if ( branch && settings.git?.branch && branch !== settings.git.branch ) {
			items.push( [ STATES.WARNING, text( 'productionBranchMismatch', branch, settings.git.branch ) ] );
		} else if ( branch ) {
			items.push( [ STATES.INFO, text( 'productionBranch', branch ) ] );
		}
		if ( cloudflare.project.source ) {
			items.push( [ STATES.INFO, text( 'gitSource', cloudflare.project.source ) ] );
		}
	}
	return items;
};

/** @returns {String} stav položky podle stavu nasazení */
const deploymentState = function ( /** @type {String} */ status )
{
	return { success: STATES.OK, failure: STATES.ERROR, active: STATES.INFO, idle: STATES.INFO }[ status ] ?? STATES.WARNING;
};

/** @returns {Array.<String|Node>} commit nasazení: zkrácený hash a první řádek zprávy */
const commitOf = function ( /** @type {Object} */ deployment )
{
	if ( !deployment.commitHash ) {
		return [ text( 'noCommit' ) ];
	}
	const content = compose( 'commit', code( deployment.commitHash.slice( 0, SHORT_HASH ) ) );
	if ( deployment.commitMessage ) {
		content.push( ' „' + deployment.commitMessage + '“' );
	}
	return content;
};

/** @returns {Array.<Node>} obsah části „Nasazení a commity“ */
const deploymentsContent = function ( /** @type {Object} */ report )
{
	const cloudflare = report.cloudflare ?? {};
	if ( cloudflare.error ) {
		return [ stateList( [ [ cloudflare.error.code === 'token-missing' ? STATES.INFO : STATES.WARNING, codeText( cloudflare.error ) ] ] ) ];
	}
	const content = [];
	const items = [];
	const project = cloudflare.project;
	const deployments = Array.isArray( cloudflare.deployments?.items ) ? cloudflare.deployments.items : [];
	const lastCommit = settings.lastExport?.commit ?? null;

	if ( project?.error ) {
		items.push( [ STATES.ERROR, codeText( project.error ) ] );
	} else if ( project && !project.canonical ) {
		items.push( [ STATES.WARNING, text( 'noCanonical' ) ] );
	} else if ( project ) {
		const canonical = project.canonical;
		const link = canonical.url ? externalLink( canonical.url, canonical.shortId || canonical.id ) : code( canonical.shortId || canonical.id );
		items.push( [ deploymentState( canonical.status ), [ ...compose( 'canonical', link, timeElement( canonical.createdOn ) ), ', ', ...commitOf( canonical ), '.' ] ] );
		if ( lastCommit ) {
			const short = lastCommit.slice( 0, SHORT_HASH );
			if ( sameCommit( canonical.commitHash, lastCommit ) ) {
				items.push( [ STATES.OK, text( 'isLastExport' ) ] );
			} else {
				const forLast = deployments.find( ( deployment ) => deployment.environment === 'production' && sameCommit( deployment.commitHash, lastCommit ) );
				if ( forLast?.status === 'failure' ) {
					items.push( [ STATES.ERROR, [ text( 'lastExportFailed', short ), ...( forLast.url ? [ ' ', externalLink( forLast.url, text( 'open' ) ) ] : [] ) ] ] );
				} else if ( forLast && [ 'active', 'idle' ].includes( forLast.status ) ) {
					items.push( [ STATES.INFO, text( 'lastExportActive', short ) ] );
				} else if ( settings.git?.pushed === false && sameCommit( settings.git.head, lastCommit ) ) {
					items.push( [ STATES.WARNING, text( 'lastExportNotPushed', short ) ] );
				} else {
					items.push( [ STATES.WARNING, [ text( 'lastExportPending', short ), ...( settings.links.actions ? [ ' ', externalLink( settings.links.actions, 'GitHub Actions' ) ] : [] ) ] ] );
				}
			}
		}
	}
	if ( cloudflare.deployments?.error ) {
		items.push( [ STATES.ERROR, codeText( cloudflare.deployments.error ) ] );
	}
	content.push( stateList( items ) );

	if ( deployments.length ) {
		content.push( subheading( text( 'deploymentsHeading' ) ) );
		content.push( stateList( deployments.map( ( deployment ) => {
			const parts = [ timeElement( deployment.createdOn ), ' · ', text( deployment.environment === 'production' ? 'production' : 'preview' ) ];
			if ( deployment.branch ) {
				parts.push( ' (' + deployment.branch + ')' );
			}
			parts.push( ' · ', ...commitOf( deployment ), ' · ', settings.texts.statuses?.[ deployment.status ] ?? deployment.status );
			if ( deployment.status === 'failure' && deployment.stage ) {
				parts.push( ', ' + text( 'stage', deployment.stage ) );
			}
			if ( deployment.url ) {
				parts.push( ' · ', externalLink( deployment.url, text( 'open' ) ) );
			}
			return [ deploymentState( deployment.status ), parts ];
		} ), [ settings.classes.deployments ] ) );
	}

	const domains = cloudflare.domains;
	if ( domains?.error ) {
		content.push( subheading( text( 'domainsHeading' ) ), stateList( [ [ STATES.ERROR, codeText( domains.error ) ] ] ) );
	} else if ( Array.isArray( domains?.items ) ) {
		content.push( subheading( text( 'domainsHeading' ) ) );
		content.push( stateList( domains.items.length ? domains.items.map( ( domain ) => {
			const state = domain.status === 'active' ? STATES.OK : ( [ 'error', 'blocked', 'deactivated' ].includes( domain.status ) ? STATES.ERROR : STATES.WARNING );
			const parts = [ externalLink( 'https://' + domain.name + '/', domain.name ), ' – ', settings.texts.domainStatuses?.[ domain.status ] ?? domain.status ];
			if ( domain.error ) {
				parts.push( ': ' + domain.error );
			}
			return [ state, parts ];
		} ) : [ [ STATES.INFO, text( 'noDomains' ) ] ] ) );
	}
	return content;
};

/**
* Řádek čerpání: název, ukazatel (role="meter"), číslo, podrobnosti. [2026-11-27] options.neutral = podíl bez stavu (podíl
* z cache – víc není horší, ukazatel zůstává modrý), options.valueKey = text čísla (výchozí meterValue: 1 200 z 100 000 (1 %)).
*
* @returns {HTMLLIElement}
*/
const meterRow = function ( /** @type {String} */ label, /** @type {Number|null} */ value, /** @type {Number} */ limit, /** @type {Function} */ format, /** @type {String} */ detail = '', /** @type {Object|null} */ error = null, /** @type {Object} */ options = {} )
{
	const className = settings.classes.meters;
	const row = element( 'li', [], [ element( 'span', [ className + '-label' ], [ label ] ) ] );
	if ( error || value === null ) {
		row.append( element( 'span', [ className + '-value' ], [ error ? codeText( error, options.hintKey ) : text( 'unknown' ) ] ) );
		return row;
	}
	const ratio = limit > 0 ? value / limit : 0;
	const level = options.neutral ? '' : ( ratio >= 1 ? 'over' : ( ratio >= settings.ratios.danger ? 'danger' : ( ratio >= settings.ratios.warning ? 'warning' : '' ) ) );
	const percent = formatNumber( ratio, { style: 'percent', maximumFractionDigits: ratio > 0 && ratio < 0.01 ? 1 : 0 } );
	const valueText = text( options.valueKey ?? 'meterValue', format( value ), format( limit ), percent );
	const meter = element( 'span', [ settings.classes.meter, level ? settings.classes.meter + '-' + ( level === 'over' ? 'danger' : level ) : '' ], [ element( 'span' ) ] );
	meter.setAttribute( 'role', 'meter' );
	meter.setAttribute( 'aria-label', label );
	meter.setAttribute( 'aria-valuemin', '0' );
	meter.setAttribute( 'aria-valuemax', String( limit ) );
	meter.setAttribute( 'aria-valuenow', String( Math.min( value, limit ) ) );
	meter.setAttribute( 'aria-valuetext', valueText );
	meter.firstElementChild.style.width = Math.min( 100, Math.max( ratio > 0 ? 1 : 0, ratio * 100 ) ) + '%'; // i malé čerpání je vidět
	const valueContent = [ valueText ];
	if ( level ) { // stav i slovem a ikonou, ne jen barvou
		const state = level === 'warning' ? STATES.WARNING : STATES.ERROR;
		const icon = element( 'span', settings.states[ state ].icon );
		icon.setAttribute( 'aria-hidden', 'true' );
		valueContent.push( ' ', icon, text( level === 'over' ? 'meterOver' : ( level === 'danger' ? 'meterDanger' : 'meterWarning' ) ) );
	}
	row.append( element( 'span', [ className + '-value' ], valueContent ), meter ); // název a číslo na jednom řádku, ukazatel pod nimi

	if ( detail ) {
		row.append( element( 'span', [ className + '-detail' ], [ detail ] ) );
	}
	return row;
};

/** @returns {HTMLLIElement} [2026-11-27] řádek bez ukazatele: název a hodnota na jednom řádku, pod nimi podrobnosti */
const statRow = function ( /** @type {String} */ label, /** @type {String|Node|Array} */ value, /** @type {String|Node|Array} */ detail = '' )
{
	const className = settings.classes.meters;
	const row = element( 'li', [ className + '-stat' ], [
		element( 'span', [ className + '-label' ], [ label ] ),
		element( 'span', [ className + '-value' ], [ value ].flat() ),
	] );
	if ( detail !== '' && !( Array.isArray( detail ) && !detail.length ) ) {
		row.append( element( 'span', [ className + '-detail' ], [ detail ].flat() ) );
	}
	return row;
};

/** @returns {Array.<Node>} obsah části „Čerpání limitů dnes“ */
const usageContent = function ( /** @type {Object} */ report )
{
	const cloudflare = report.cloudflare ?? {};
	const usage = cloudflare.error ? null : cloudflare.usage;
	const limits = settings.limits;
	const content = [];
	const rows = [];
	const number = ( /** @type {Number} */ value ) => formatNumber( value );

	if ( usage && !usage.error ) {
		const dayStart = timeOf( usage.dayStart );
		content.push( note( text( 'usageNote', dayStart ? new Intl.DateTimeFormat( settings.locale, { timeStyle: 'short' } ).format( new Date( dayStart ) ) : text( 'unknown' ) ) ) );
		const pages = usage.pagesFunctions;
		const workers = usage.workers;
		const requests = ( pages?.error ? 0 : pages?.requests ?? 0 ) + ( workers?.error ? 0 : workers?.requests ?? 0 );
		rows.push( meterRow( text( 'requests' ), pages?.error && workers?.error ? null : requests, limits.requests, number,
			text( 'requestsDetail', pages?.error ? codeText( pages.error ) : number( pages?.requests ?? 0 ), workers?.error ? codeText( workers.error ) : number( workers?.requests ?? 0 ) ),
			pages?.error && workers?.error ? pages.error : null ) );
		const d1 = usage.d1;
		rows.push( meterRow( text( 'rowsRead' ), d1?.error ? null : d1?.rowsRead ?? 0, limits.rowsRead, number, d1?.database ? text( 'databaseDetail', number( d1.database.rowsRead ) ) : '', d1?.error ?? null ) );
		rows.push( meterRow( text( 'rowsWritten' ), d1?.error ? null : d1?.rowsWritten ?? 0, limits.rowsWritten, number, d1?.database ? text( 'databaseDetail', number( d1.database.rowsWritten ) ) : '', d1?.error ?? null ) );
		const storage = usage.d1Storage;
		const databaseBytes = report.database?.sizeBytes ?? storage?.databaseBytes ?? null; // přes vazbu DB je velikost přesná a aktuální
		rows.push( meterRow( text( 'databaseSize' ), databaseBytes, limits.databaseSize, formatBytes ) );
		rows.push( meterRow( text( 'storage' ), storage?.error ? null : storage?.accountBytes ?? null, limits.storage, formatBytes, '', storage?.error ?? null ) );
	} else {
		const error = cloudflare.error ?? usage?.error ?? null;
		if ( error ) {
			content.push( stateList( [ [ error.code === 'token-missing' || error.code === 'not-configured' ? STATES.INFO : STATES.ERROR, codeText( error ) ] ] ) );
		}
		if ( report.database?.sizeBytes !== null && report.database?.sizeBytes !== undefined ) {
			rows.push( meterRow( text( 'databaseSize' ), report.database.sizeBytes, limits.databaseSize, formatBytes ) );
		}
	}
	if ( settings.webFiles !== null ) {
		rows.push( meterRow( text( 'pagesFiles' ), settings.webFiles, limits.pagesFiles, number ) );
	}
	content.push( element( 'ul', [ settings.classes.meters ], rows ) );
	content.push( note( text( 'buildsNote' ), ' ', externalLink( settings.links.limitsWorkers, 'Workers' ), ', ', externalLink( settings.links.limitsD1, 'D1' ), ', ', externalLink( settings.links.limitsPages, 'Pages' ) ) );
	return content;
};

/** @returns {Array.<Array>} položky chyb (počet a poslední výskyt) */
const occurrenceItems = function ( /** @type {Object} */ errors, /** @type {Function} */ describe, /** @type {Function} */ stateOf )
{
	if ( errors?.error ) {
		return [ [ errors.error.code === 'not-configured' ? STATES.INFO : STATES.ERROR, codeText( errors.error ) ] ];
	}
	const items = Array.isArray( errors?.items ) ? errors.items : [];
	if ( !items.length ) {
		return [ [ STATES.OK, text( 'noErrors' ) ] ];
	}
	return items.map( ( item ) => [ stateOf( item ), [
		...[ describe( item ) ].flat(),
		': ', plural( 'times', item.count ), ' · ',
		...( item.last ? compose( 'lastSeen', timeElement( item.last ) ) : [ text( 'lastUnknown' ) ] ),
	] ] );
};

/** @returns {Array.<Node>} obsah části „Chyby“ */
const errorsContent = function ( /** @type {Object} */ report )
{
	const cloudflare = report.cloudflare ?? {};
	if ( cloudflare.error ) {
		return [ stateList( [ [ STATES.INFO, codeText( cloudflare.error ) ] ] ) ];
	}
	const errors = cloudflare.errors ?? {};
	if ( errors.error ) {
		return [ stateList( [ [ STATES.ERROR, codeText( errors.error ) ] ] ) ];
	}
	const content = [];
	const since = timeOf( errors.pagesFunctions?.since ?? errors.d1?.since );
	content.push( note( text( 'errorsNote', String( errors.days ?? '' ), since ? new Intl.DateTimeFormat( settings.locale, { dateStyle: 'medium', timeStyle: 'short' } ).format( new Date( since ) ) : text( 'unknown' ) ) ) );

	const scripts = new Set( ( errors.pagesFunctions?.items ?? [] ).map( ( item ) => item.scriptName ) );
	content.push( subheading( text( 'pagesErrors' ) ) );
	content.push( stateList( occurrenceItems( errors.pagesFunctions,
		( item ) => {
			const name = settings.texts.invocationStatuses?.[ item.status ];
			const parts = [ name ? name + ' (' + item.status + ')' : item.status ];
			if ( scripts.size > 1 && item.scriptName ) {
				parts.push( ', ' + text( 'script', item.scriptName ) );
			}
			return parts;
		},
		( item ) => NOT_ERROR_STATUSES.includes( item.status ) ? STATES.INFO : STATES.ERROR,
	) ) );
	content.push( note( text( 'caughtNote' ) ) );

	content.push( subheading( text( 'd1Errors' ) ) );
	content.push( stateList( occurrenceItems( errors.d1, ( item ) => [ code( item.error ) ], () => STATES.ERROR ) ) );

	const deployments = cloudflare.deployments?.items;
	if ( Array.isArray( deployments ) && deployments.length ) {
		const failed = deployments.filter( ( deployment ) => deployment.status === 'failure' );
		content.push( subheading( text( 'deploymentErrors' ) ) );
		if ( failed.length ) {
			content.push( stateList( [ [ STATES.ERROR, compose( 'failedDeployments', formatNumber( failed.length ), formatNumber( deployments.length ), timeElement( failed[ 0 ].createdOn ) ) ] ] ) );
		} else {
			content.push( stateList( [ [ STATES.OK, text( 'noFailedDeployments', formatNumber( deployments.length ) ) ] ] ) );
		}
	}
	return content;
};

// -----------------------------------------------------------------------------------------------------------------------------
// [2026-11-27] Části widgetu „Cloudflare – provoz zóny“ (odpověď /api/dashboard/traffic, functions/_lib/dashboard-traffic.js)

/** @type {String} rada u chybějícího oprávnění tokenu (Zone → Analytics → Read) */
const ZONE_HINT = 'zonePermissionHint';

/** @returns {String} kód bez velikosti písmen a oddělovačů – normalizeCode() ve functions/_lib/dashboard-traffic.js */
const normalizeCode = function ( /** @type {*} */ value )
{
	return String( value ?? '' ).toLowerCase().replace( /[^a-z0-9]/g, '' );
};

/** @returns {String} 45 % (podíl, u malých hodnot s desetinou) */
const formatShare = function ( /** @type {Number} */ part, /** @type {Number} */ whole )
{
	const ratio = whole > 0 ? part / whole : 0;
	return formatNumber( ratio, { style: 'percent', maximumFractionDigits: ratio > 0 && ratio < 0.1 ? 1 : 0 } );
};

/** @returns {String} 27. 11. 2026 10:20 */
const formatDateTime = function ( /** @type {String} */ value )
{
	const time = timeOf( value );
	return time ? new Intl.DateTimeFormat( settings.locale, { dateStyle: 'medium', timeStyle: 'short' } ).format( new Date( time ) ) : text( 'unknown' );
};

/** @returns {Array.<Array>} položky části „Zóna“ */
const zoneItems = function ( /** @type {Object} */ report )
{
	const cloudflare = report.cloudflare ?? {};
	if ( cloudflare.error ) {
		if ( cloudflare.error.code === 'no-zone' ) {
			const domains = Array.isArray( cloudflare.error.domains ) ? cloudflare.error.domains : [];
			return [ [ STATES.INFO, domains.length ? text( 'noZoneDomains', domains.join( ', ' ) ) : text( 'noZone' ) ] ];
		}
		return [ [ [ 'token-missing', 'not-configured' ].includes( cloudflare.error.code ) ? STATES.INFO : STATES.ERROR, codeText( cloudflare.error, ZONE_HINT ) ] ];
	}
	const zones = cloudflare.zones ?? {};
	const list = Array.isArray( zones.items ) ? zones.items : [];
	const items = list.map( ( zone ) => {
		const domains = zone.domains?.length ? ' ' + text( 'zoneDomains', zone.domains.join( ', ' ) ) : '';
		if ( zone.error ) {
			return [ STATES.ERROR, [ text( 'zone', zone.name ?? zone.id ), ': ', codeText( zone.error, ZONE_HINT ), domains ] ];
		}
		if ( !zone.name ) {
			return [ STATES.OK, [ text( 'zone', zone.id ), '.', domains, ' ', text( 'zoneNameHidden' ) ] ];
		}
		const status = zone.paused ? 'paused' : zone.status;
		const parts = [ text( 'zone', zone.name ) ];
		if ( zone.plan ) {
			parts.push( ' (' + zone.plan + ')' );
		}
		if ( status ) {
			parts.push( ' – ' + ( settings.texts.zoneStatuses?.[ status ] ?? status ) );
		}
		parts.push( '.', domains );
		return [ zone.paused || ( zone.status && zone.status !== 'active' ) ? STATES.WARNING : STATES.OK, parts ];
	} );
	const working = list.filter( ( zone ) => !zone.error ).length;
	if ( working > 1 ) {
		items.push( [ STATES.INFO, text( 'zonesSum', formatNumber( working ) ) ] );
	}
	if ( zones.skipped > 0 ) {
		items.push( [ STATES.WARNING, text( 'skippedZones', formatNumber( zones.skipped ) ) ] );
	}
	if ( Array.isArray( zones.external ) && zones.external.length ) {
		items.push( [ STATES.INFO, text( 'externalDomains', zones.external.join( ', ' ) ) ] );
	}
	return items;
};

/** @returns {Array.<Node>} obsah části „Zóna“ */
const zoneContent = function ( /** @type {Object} */ report )
{
	const content = [ stateList( zoneItems( report ) ) ];
	if ( !report.cloudflare?.error ) {
		content.push( note( text( 'zoneNote' ) ) );
	}
	return content;
};

/** @returns {Boolean} odpověď bez údajů o provozu: chyba celé odpovědi, nebo žádná zóna nefunguje (důvod ukáže jen část Zóna) */
const withoutTraffic = function ( /** @type {Object} */ report )
{
	const cloudflare = report.cloudflare ?? {};
	const zones = Array.isArray( cloudflare.zones?.items ) ? cloudflare.zones.items : [];
	return Boolean( cloudflare.error ) || ( zones.length > 0 && zones.every( ( zone ) => zone.error ) );
};

/** @returns {Array.<Array>|null} upozornění, že část nepočítá zóny bez přístupu */
const failedZonesItem = function ( /** @type {Object} */ part )
{
	return part?.failedZones > 0 ? [ STATES.WARNING, text( 'failedZones', formatNumber( part.failedZones ) ) ] : null;
};

/** @returns {String} počet zablokovaných hrozeb za 24 hodin s „nejméně“ / „asi“ */
const threatsValue = function ( /** @type {Object} */ security )
{
	const count = formatNumber( security.lastDay.blocked + security.lastDay.challenged );
	if ( !security.lastDay.complete ) {
		return text( 'atLeast', count );
	}
	return security.sampled ? text( 'approximately', count ) : count;
};

/** @returns {Array.<Node>|null} obsah části „Posledních 24 hodin“ (bez zóny se část nezobrazí – důvod je v části Zóna) */
const summaryContent = function ( /** @type {Object} */ report )
{
	const cloudflare = report.cloudflare ?? {};
	if ( withoutTraffic( report ) ) {
		return null;
	}
	const hours = cloudflare.traffic?.hours;
	const security = cloudflare.security;
	const content = [];
	const rows = [];
	if ( !hours || hours.error ) {
		content.push( stateList( [ [ STATES.ERROR, hours?.error ? codeText( hours.error, ZONE_HINT ) : text( 'invalid' ) ] ] ) );
	} else {
		content.push( note( text( 'summaryNote', formatDateTime( hours.since ) ) ) );
		const warning = failedZonesItem( hours );
		if ( warning ) {
			content.push( stateList( [ warning ] ) );
		}
		rows.push( statRow( text( 'trafficRequests' ), formatNumber( hours.requests ), text( 'pageViewsDetail', formatNumber( hours.pageViews ) ) ) );
		rows.push( statRow( text( 'trafficBytes' ), formatBytes( hours.bytes ) ) );
		rows.push( meterRow( text( 'cachedRequests' ), hours.cachedRequests, hours.requests, formatNumber, '', null, { neutral: true, valueKey: 'shareValue' } ) );
		rows.push( meterRow( text( 'cachedBytes' ), hours.cachedBytes, hours.bytes, formatBytes, '', null, { neutral: true, valueKey: 'shareValue' } ) );
	}
	if ( !security || security.error ) {
		rows.push( statRow( text( 'threats' ), '–', security?.error ? codeText( security.error, ZONE_HINT ) : text( 'unknown' ) ) );
	} else {
		rows.push( statRow( text( 'threats' ), threatsValue( security ), text( 'threatsDetail', formatNumber( security.lastDay.blocked ), formatNumber( security.lastDay.challenged ) ) ) );
	}
	content.push( element( 'ul', [ settings.classes.meters ], rows ) );
	return content;
};

/** @returns {HTMLTableCellElement} */
const cell = function ( /** @type {String} */ tagName, /** @type {Array.<String|Node>} */ content, /** @type {String} */ scope = '' )
{
	const node = element( tagName, [], content );
	if ( scope ) {
		node.scope = scope;
	}
	return node;
};

/** @returns {Array.<Node>|null} obsah části „Po dnech“: tabulka den – požadavky – data – z cache, dole součet */
const daysContent = function ( /** @type {Object} */ report )
{
	const cloudflare = report.cloudflare ?? {};
	if ( withoutTraffic( report ) ) {
		return null;
	}
	const days = cloudflare.traffic?.days;
	if ( !days || days.error || !Array.isArray( days.items ) ) {
		return [ stateList( [ [ STATES.ERROR, days?.error ? codeText( days.error, ZONE_HINT ) : text( 'invalid' ) ] ] ) ];
	}
	const content = [];
	const items = [];
	// [2026-11-27] zdroj načítá 30 dní (historie na stránce Analytická data), widget ukazuje posledních daysShown
	const shownDays = Math.max( 1, Number( settings.daysShown ) || days.items.length );
	const shown = days.items.slice( 0, shownDays );
	const total = shown.reduce( ( sums, item ) => {
		for ( const key of [ 'requests', 'cachedRequests', 'bytes', 'cachedBytes', 'pageViews' ] ) {
			sums[ key ] += Number( item[ key ] ) || 0;
		}
		return sums;
	}, { requests: 0, cachedRequests: 0, bytes: 0, cachedBytes: 0, pageViews: 0 } );
	if ( shown.length < Math.min( days.wanted ?? shownDays, shownDays ) ) {
		items.push( [ STATES.INFO, text( 'daysLimited', formatNumber( shown.length ) ) ] );
	}
	const warning = failedZonesItem( days );
	if ( warning ) {
		items.push( warning );
	}
	if ( items.length ) {
		content.push( stateList( items ) );
	}
	const dayFormat = new Intl.DateTimeFormat( settings.locale, { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' } );
	const values = ( /** @type {Object} */ sums ) => [
		cell( 'td', [ formatNumber( sums.requests ) ] ),
		cell( 'td', [ formatBytes( sums.bytes ) ] ),
		cell( 'td', [ sums.requests > 0 ? formatShare( sums.cachedRequests, sums.requests ) : '–' ] ),
	];
	const table = element( 'table', [ settings.classes.counts ], [
		element( 'caption', [ settings.classes.screenReader ], [ text( 'daysCaption' ) ] ),
		element( 'thead', [], [ element( 'tr', [], [ 'dayColumn', 'requestsColumn', 'bytesColumn', 'cachedColumn' ].map( ( key ) => cell( 'th', [ text( key ) ], 'col' ) ) ) ] ),
		element( 'tbody', [], shown.map( ( item ) => {
			const time = element( 'time', [], [ item.date === days.until ? text( 'today' ) : dayFormat.format( new Date( item.date + 'T00:00:00Z' ) ) ] );
			time.dateTime = item.date;
			return element( 'tr', [], [ cell( 'th', [ time ], 'row' ), ...values( item ) ] );
		} ) ),
		element( 'tfoot', [], [ element( 'tr', [], [ cell( 'th', [ text( 'total' ) ], 'row' ), ...values( total ) ] ) ] ),
	] );
	content.push( table, note( text( 'daysNote' ) ) );
	return content;
};

/** @returns {String} akce – zdroj bezpečnostní události (zablokováno – kontrola integrity prohlížeče (bic)) */
const threatLabel = function ( /** @type {Object} */ item )
{
	const action = settings.texts.actions?.[ normalizeCode( item.action ) ] ?? item.action;
	const sourceName = settings.texts.sources?.[ normalizeCode( item.source ) ];
	const source = sourceName ? sourceName + ' (' + item.source + ')' : ( item.source || text( 'unknown' ) );
	return text( 'threatItem', action, source );
};

/** @returns {Array.<Node>|null} obsah části „Zablokované hrozby“ */
const threatsContent = function ( /** @type {Object} */ report )
{
	const cloudflare = report.cloudflare ?? {};
	if ( withoutTraffic( report ) ) {
		return null;
	}
	const security = cloudflare.security;
	if ( !security || security.error ) {
		return [ stateList( [ [ security?.error?.code === 'disabled' ? STATES.INFO : STATES.ERROR, security?.error ? codeText( security.error, ZONE_HINT ) : text( 'invalid' ) ] ] ) ];
	}
	const content = [ note( ...compose( 'threatsNote', timeElement( security.since ) ) ) ];
	const notices = [];
	if ( security.truncated ) {
		notices.push( [ STATES.WARNING, compose( 'threatsTruncated', timeElement( security.completeSince ) ) ] );
	}
	const warning = failedZonesItem( security );
	if ( warning ) {
		notices.push( warning );
	}
	if ( notices.length ) {
		content.push( stateList( notices ) );
	}
	const items = Array.isArray( security.items ) ? security.items : [];
	if ( items.length ) {
		content.push( stateList( [
			[ STATES.INFO, text( 'threatsTotals', formatNumber( security.blocked ), formatNumber( security.challenged ) ) ],
			...items.map( ( item ) => [ STATES.INFO, [
				threatLabel( item ), ': ', plural( 'times', item.count ), ' · ',
				...( item.last ? compose( 'lastSeen', timeElement( item.last ) ) : [ text( 'lastUnknown' ) ] ),
			] ] ),
		], [ settings.classes.deployments ] ) );
	} else {
		content.push( stateList( [ [ STATES.OK, text( 'noThreats' ) ] ] ) );
	}
	if ( security.other > 0 ) {
		content.push( note( plural( 'otherEvents', security.other ) ) );
	}
	if ( security.sampled ) {
		content.push( note( text( 'threatsSampled' ) ) );
	}
	return content;
};

/** Odkazy widgetu do administrace Cloudflare: s jedinou zónou známého názvu vedou rovnou na ni (jinak se Cloudflare zeptá). */
const updateZoneLinks = function ( /** @type {Object} */ report, /** @type {HTMLElement} */ root, /** @type {Object} */ card )
{
	const zones = ( report.cloudflare?.zones?.items ?? [] ).filter( ( zone ) => zone.name && !zone.error );
	if ( zones.length !== 1 ) {
		return;
	}
	for ( const link of root.parentElement?.querySelectorAll( '[' + card.attribute + '-link]' ) ?? [] ) {
		const template = settings.links?.[ link.getAttribute( card.attribute + '-link' ) ];
		if ( template ) {
			link.href = template.replace( ':zone', encodeURIComponent( zones[ 0 ].name ) );
		}
	}
};

/** @type {Object<String, Object>} druh widgetu → { části: funkce( report ) → obsah (null = část skrýt), after( report, root, card ) } */
const BUILDERS = {
	[ KINDS.OVERVIEW ]: {
		sections: {
			settings: ( report ) => [ stateList( settingsItems( report ) ) ],
			deployments: deploymentsContent,
			usage: usageContent,
			errors: errorsContent,
		},
	},
	[ KINDS.TRAFFIC ]: {
		sections: {
			zone: zoneContent,
			summary: summaryContent,
			days: daysContent,
			threats: threatsContent,
		},
		after: updateZoneLinks,
	},
};

// -----------------------------------------------------------------------------------------------------------------------------

class CloudflareDashboard {

	/** @type {HTMLElement} */
	#root;

	/** @type {Object} kind, source, attribute – nastavení tohoto widgetu ([2026-11-27] source místo endpoint a cacheKey) */
	#card;

	/** @type {HTMLElement} */
	#status;

	/** @type {HTMLButtonElement|null} */
	#reload;

	/** @type {Object<String, HTMLElement>} */
	#sections = {};

	constructor ( /** @type {HTMLElement} */ root, /** @type {Object} */ card )
	{
		this.#root = root;
		this.#card = card;
		this.#status = root.querySelector( '[' + card.attribute + '-status]' );
		this.#reload = root.querySelector( '[' + card.attribute + '-reload]' );
		for ( const section of root.querySelectorAll( '[' + card.attribute + '-section]' ) ) {
			this.#sections[ section.getAttribute( card.attribute + '-section' ) ] = section;
		}
		this.#reload?.addEventListener( 'click', () => this.#show( true ) );
		this.#show( false );
	}

	/*
		[2026-11-27] Uložené údaje (modul analytics-data.mjs je má od WordPressu) ukáže hned, starší než maxAge zdroje (nebo
		s fresh vždy) nechá načíst znovu. Když nové nepřijdou, uložené zůstanou vidět s upozorněním; bez uložených chyba.
	*/
	async #show ( /** @type {Boolean} */ fresh )
	{
		if ( this.#reload ) {
			this.#reload.disabled = true;
		}
		this.#status.classList.remove( ...settings.classes.notice );
		let shown = null; // čas uložení údajů, které widget právě ukazuje
		try {
			const data = await getAnalyticsData();
			const stored = data.getRecord( this.#card.source );
			const stale = fresh || data.isStale( this.#card.source );
			if ( stored && isValidReport( this.#card, stored.report ) ) {
				this.#render( stored.report, stale ? 'refreshing' : 'cached', stored.savedAt );
				shown = stored.savedAt;
			} else {
				this.#status.replaceChildren( text( 'loading' ) );
			}
			if ( !stale ) {
				return;
			}
			const result = await data.load( this.#card.source, { fresh } );
			if ( !isValidReport( this.#card, result.record.report ) ) {
				throw new DashboardError( text( 'invalid' ) );
			}
			this.#render( result.record.report, 'loaded', result.record.savedAt );
			if ( result.warning ) {
				this.#status.append( ' ' + result.warning );
			}
		} catch ( error ) {
			const message = error instanceof DashboardError || error?.constructor?.name === 'AnalyticsDataError' ? error.message : String( error?.message ?? error );
			this.#status.classList.add( ...settings.classes.notice ); // žluté oznámení administrace
			if ( shown !== null ) {
				this.#status.replaceChildren( text( 'refreshFailed', this.#formatTime( shown ), message ) );
			} else {
				for ( const section of Object.values( this.#sections ) ) {
					section.hidden = true;
				}
				this.#status.replaceChildren( text( 'error', message ) );
			}
			if ( !( error instanceof DashboardError ) && error?.constructor?.name !== 'AnalyticsDataError' ) {
				console.error( 'Cloudflare na nástěnce:', error );
			}
		} finally {
			if ( this.#reload ) {
				this.#reload.disabled = false;
			}
		}
	}

	/** @returns {String} 14:02 (čas uložení v sekundách) */
	#formatTime ( /** @type {Number} */ savedAt )
	{
		return new Intl.DateTimeFormat( settings.locale, { timeStyle: 'short' } ).format( new Date( Number( savedAt ) * 1000 ) );
	}

	#render ( /** @type {Object} */ report, /** @type {String} */ state, /** @type {Number} */ savedAt )
	{
		const generated = timeOf( report.cloudflare?.cachedAt ?? report.generatedAt ) || Number( savedAt ) * 1000;
		this.#status.classList.remove( ...settings.classes.notice );
		this.#status.replaceChildren( text( state, new Intl.DateTimeFormat( settings.locale, { timeStyle: 'short' } ).format( new Date( generated ) ) ) );
		const result = { report };
		const builders = BUILDERS[ this.#card.kind ] ?? { sections: {} };
		for ( const [ name, section ] of Object.entries( this.#sections ) ) {
			const heading = section.firstElementChild; // nadpis části vypsal PHP
			const builder = builders.sections[ name ];
			let content;
			try {
				content = builder ? builder( result.report ) : [];
			} catch ( error ) {
				console.error( 'Cloudflare na nástěnce, část ' + name + ':', error );
				content = [ stateList( [ [ STATES.ERROR, text( 'invalid' ) ] ] ) ];
			}
			section.replaceChildren( ...( heading ? [ heading ] : [] ), ...( content ?? [] ) );
			section.hidden = content === null; // null = část nemá co ukázat (důvod je v jiné části)
		}
		try {
			builders.after?.( result.report, this.#root, this.#card );
		} catch ( error ) {
			console.error( 'Cloudflare na nástěnce:', error );
		}
	}
}

// Nastavení obou widgetů: společné části se slučují (texty a odkazy po klíčích), vlastní má každý widget v card
const cards = [];
for ( const id of SETTINGS_ELEMENT_IDS ) {
	const settingsElement = document.getElementById( id );
	if ( !settingsElement ) {
		continue;
	}
	const { kind, source, attribute, ...shared } = JSON.parse( settingsElement.textContent ?? '{}' ); // [2026-11-27] source místo endpoint a cacheKey
	settings = { ...settings, ...shared, texts: { ...settings.texts, ...shared.texts }, links: { ...settings.links, ...shared.links } };
	cards.push( { kind, source, attribute } );
}
for ( const card of cards ) {
	const root = document.querySelector( '[' + card.attribute + ']' );
	if ( root ) {
		new CloudflareDashboard( root, card );
	}
}
