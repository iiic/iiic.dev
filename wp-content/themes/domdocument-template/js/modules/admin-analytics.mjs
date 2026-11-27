/**
* [2026-11-27] Výpis stránky Analytická data (admin-pages/analyticka-data.php) a widgetu „Analytická data“ na nástěnce
* (dashboard-widgets/analyticka-data.php) šablony domdocument-template. README šablony – sekce „Analytická data“.
*
* Vyplní části s atributem data-ddt-analytics (\VARS\ANALYTICS::VIEW_ATTRIBUTE):
*   traffic    Návštěvnost webu – dlaždice (zobrazení stránek, požadavky, data, z cache, příchody z odkazů, návštěvy Web
*              Analytics) se změnou proti předchozímu období, sloupcový graf zobrazení po dnech a tabulka po dnech,
*   referrers  Zpětné odkazy – nejčastější odkazující weby (pruhy), tabulka všech zdrojů (Cloudflare, Web Analytics, GitHub,
*              pingbacky) s prvním a posledním výskytem, celé adresy odkazů a cílové stránky z posledního načtení,
*   github     Repozitář na GitHubu – dlaždice, graf zobrazení po dnech, odkud lidé přišli, nejnavštěvovanější stránky,
*   sources    Zdroje údajů – kdy se který zdroj uložil, kolik dní historie má, stav a chyby částí, „Načíst znovu“,
*   summary    widget na nástěnce – zobrazení stránek a příchody z odkazů za 7 dní, 5 nejčastějších odkazujících webů, pingbacky.
* Období (výběr nad částmi) platí pro všechny části. Údaje bere z js/modules/analytics-data.mjs (přes importVerified(),
* pravidlo 9): uložené ve WordPressu ukáže hned, starší zdroje nechá načíst znovu a po načtení části překreslí (při
* načítání drží předchozí obsah, jen ztlumený). Historie po dnech je ve WordPressu, takže období může být delší, než
* kolik drží API. Vše přes DOM (textContent), texty a třídy z PHP (\FUNCTIONS\ANALYTICS\getViewSettings()).
*
* @version 0.1
* @since Q4 2026
*/

/** @type {String} \VARS\ANALYTICS::VIEW_SETTINGS_ID */
const SETTINGS_ID = 'ddt-analyticka-data-vypis';

/** @type {String} modul načítání a ukládání (\VARS\ANALYTICS::DATA_SCRIPT bez ?verze) */
const DATA_MODULE = 'analytics-data.mjs';

/** @type {String} \VARS\VERIFIED_MODULE::LOADED_ATTRIBUTE a FAILED_ATTRIBUTE */
const LOADED_ATTRIBUTE = 'data-module-loaded';
const FAILED_ATTRIBUTE = 'data-module-failed';

/** @type {Object<String, String>} části výpisu – \VARS\ANALYTICS::VIEW_… */
const VIEWS = Object.freeze( {
	TRAFFIC: 'traffic',
	REFERRERS: 'referrers',
	GITHUB: 'github',
	SOURCES: 'sources',
	SUMMARY: 'summary',
} );

/** @type {Number} ms za den */
const DAY = 86400000;

/** @type {Number} od kolika se číslo v dlaždici zkracuje (12,9 tis.) */
const COMPACT_FROM = 10000;

/** @type {Object} */
const settings = JSON.parse( document.getElementById( SETTINGS_ID )?.textContent ?? '{}' );

/** @type {Object} třídy CSS (\CSS\CLASS_NAMES\ANALYTICS v camelCase a třídy administrace) */
const classes = settings.classes ?? {};

// -----------------------------------------------------------------------------------------------------------------------------
// Pomocné funkce

/** @returns {String} text s doplněnými hodnotami (%s, %1$s… jako sprintf() v PHP) */
const text = function ( /** @type {String} */ key, /** @type {...(String|Number)} */ ...values )
{
	let index = 0;
	return String( settings.texts?.[ key ] ?? key ).replace( /%(?:(\d+)\$)?s/g, ( match, position ) => String( values[ position ? Number( position ) - 1 : index++ ] ?? '' ) );
};

/** @returns {String} tvar podle počtu (one / few / other) */
const plural = function ( /** @type {String} */ key, /** @type {Number} */ count )
{
	const forms = settings.texts?.[ key ] ?? {};
	return String( forms[ new Intl.PluralRules( settings.locale ).select( count ) ] ?? forms.other ?? '' ).replace( '%s', formatNumber( count ) );
};

/** @returns {String} text chyby části odpovědi { code, message } */
const codeText = function ( /** @type {Object} */ error )
{
	const template = settings.texts?.codes?.[ error?.code ];
	const message = String( error?.message ?? '' );
	return template ? String( template ).replace( '%s', message ) : ( message || String( error?.code ?? '' ) );
};

/** @returns {HTMLElement} */
const element = function ( /** @type {String} */ tagName, /** @type {Array.<String>|String} */ classNames = [], /** @type {Array.<String|Node>} */ content = [] )
{
	const node = document.createElement( tagName );
	const list = [ classNames ].flat().filter( Boolean );
	if ( list.length ) {
		node.className = list.join( ' ' );
	}
	node.append( ...content.filter( ( part ) => part !== null && part !== undefined ) );
	return node;
};

/** @returns {HTMLAnchorElement} odkaz na jiný web (nová karta, ikona a text pro čtečky jako v administraci) */
const externalLink = function ( /** @type {String} */ url, /** @type {String} */ label )
{
	const icon = element( 'span', classes.externalIcon );
	icon.setAttribute( 'aria-hidden', 'true' );
	const link = element( 'a', [], [ label, element( 'span', classes.screenReader, [ ' ' + text( 'newTab' ) ] ), icon ] );
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

/** @returns {String} 1 284 / 12,9 tis. – hodnota dlaždice */
const formatTileNumber = function ( /** @type {Number} */ value )
{
	return Math.abs( value ) >= COMPACT_FROM ? formatNumber( value, { notation: 'compact', maximumFractionDigits: 1 } ) : formatNumber( value );
};

/** @returns {String} 61,4 kB (desítkové jednotky jako Cloudflare) */
const formatBytes = function ( /** @type {Number} */ bytes )
{
	const units = [ 'byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte' ];
	let value = bytes;
	let unit = 0;
	while ( value >= 1000 && unit < units.length - 1 ) {
		value /= 1000;
		unit++;
	}
	return formatNumber( value, { style: 'unit', unit: units[ unit ], unitDisplay: 'short', maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0 } );
};

/** @returns {String} 45 % */
const formatShare = function ( /** @type {Number} */ part, /** @type {Number} */ whole )
{
	return whole > 0 ? formatNumber( part / whole, { style: 'percent', maximumFractionDigits: 0 } ) : '–';
};

/** @returns {String} RRRR-MM-DD podle UTC */
const isoDate = function ( /** @type {Number} */ time )
{
	return new Date( time ).toISOString().slice( 0, 10 );
};

/** @returns {Number} ms začátku dne RRRR-MM-DD (UTC) */
const timeOfDate = function ( /** @type {String} */ date )
{
	return Date.parse( date + 'T00:00:00Z' );
};

/** @returns {String} po 24. 11. (den podle UTC) */
const formatDay = function ( /** @type {String} */ date, /** @type {Boolean} */ withWeekday = true )
{
	return new Intl.DateTimeFormat( settings.locale, { ...( withWeekday ? { weekday: 'short' } : {} ), day: 'numeric', month: 'numeric', ...( date.slice( 0, 4 ) !== isoDate( Date.now() ).slice( 0, 4 ) ? { year: 'numeric' } : {} ), timeZone: 'UTC' } ).format( new Date( timeOfDate( date ) ) );
};

/** @returns {String} „před 3 hodinami“ */
const relativeTime = function ( /** @type {Number} */ time )
{
	const seconds = Math.round( ( time - Date.now() ) / 1000 );
	const format = new Intl.RelativeTimeFormat( settings.locale, { numeric: 'auto' } );
	for ( const [ unit, size ] of [ [ 'year', 31536000 ], [ 'month', 2592000 ], [ 'week', 604800 ], [ 'day', 86400 ], [ 'hour', 3600 ], [ 'minute', 60 ] ] ) {
		if ( Math.abs( seconds ) >= size ) {
			return format.format( Math.round( seconds / size ), unit );
		}
	}
	return format.format( 0, 'minute' );
};

/** @returns {HTMLTimeElement} 27. 11. 2026 14:02 (před 2 hodinami) – čas uložení v sekundách */
const savedTime = function ( /** @type {Number} */ savedAt )
{
	const time = Number( savedAt ) * 1000;
	const node = element( 'time', [], [ new Intl.DateTimeFormat( settings.locale, { dateStyle: 'medium', timeStyle: 'short' } ).format( new Date( time ) ) + ' (' + relativeTime( time ) + ')' ] );
	node.dateTime = new Date( time ).toISOString();
	return node;
};

/** @returns {HTMLElement} vysvětlivka šedým písmem */
const note = function ( /** @type {...(String|Node)} */ ...content )
{
	return element( 'p', classes.note, content );
};

/** @returns {HTMLElement} upozornění administrace (žluté) */
const warning = function ( /** @type {...(String|Node)} */ ...content )
{
	return element( 'div', classes.notice, [ element( 'p', [], content ) ] );
};

/** @returns {HTMLElement} nadpis uvnitř části */
const subheading = function ( /** @type {String} */ label )
{
	return element( 'h3', [], [ label ] );
};

/** @returns {String} host z adresy, nebo vstup */
const hostOf = function ( /** @type {String} */ value )
{
	try {
		return new URL( value ).hostname.toLowerCase();
	} catch {
		return String( value ?? '' ).toLowerCase();
	}
};

// -----------------------------------------------------------------------------------------------------------------------------
// Období a historie

/** @type {Number} vybrané období v dnech (0 = vše uložené) */
let period = Number( settings.defaultPeriod ) || 30;

/**
* Rozsah dnů období (RRRR-MM-DD, včetně dneška podle UTC) a stejně dlouhé předchozí období.
*
* @returns {Object} { since, until, days, previous: { since, until } | null }
*/
const rangeOf = function ( /** @type {Number} */ days, /** @type {String|null} */ earliest = null )
{
	const until = isoDate( Date.now() );
	if ( !days ) {
		const since = earliest ?? until;
		return { since, until, days: Math.round( ( timeOfDate( until ) - timeOfDate( since ) ) / DAY ) + 1, previous: null };
	}
	const since = isoDate( timeOfDate( until ) - ( days - 1 ) * DAY );
	return { since, until, days, previous: { since: isoDate( timeOfDate( since ) - days * DAY ), until: isoDate( timeOfDate( since ) - DAY ) } };
};

/** @returns {Array.<Array>} [[ RRRR-MM-DD, údaje dne ]] řady historie zdroje v rozsahu, od nejstaršího */
const seriesIn = function ( /** @type {Object|null} */ record, /** @type {String} */ series, /** @type {Object} */ range )
{
	const history = record?.history?.[ series ];
	if ( !history || typeof history !== 'object' || Array.isArray( history ) ) {
		return [];
	}
	return Object.entries( history ).filter( ( [ date ] ) => date >= range.since && date <= range.until ).sort( ( a, b ) => a[ 0 ].localeCompare( b[ 0 ] ) );
};

/** @returns {String|null} nejstarší den řad historie (pro období „vše uložené“) */
const earliestOf = function ( /** @type {Array.<Array>} */ pairs )
{
	let earliest = null;
	for ( const [ record, series ] of pairs ) {
		const dates = Object.keys( record?.history?.[ series ] ?? {} ).sort();
		if ( dates.length && ( earliest === null || dates[ 0 ] < earliest ) ) {
			earliest = dates[ 0 ];
		}
	}
	return earliest;
};

/** @returns {Number} součet pole key dnů */
const sumOf = function ( /** @type {Array.<Array>} */ days, /** @type {String} */ key )
{
	return days.reduce( ( sum, [ , day ] ) => sum + ( Number( day?.[ key ] ) || 0 ), 0 );
};

// -----------------------------------------------------------------------------------------------------------------------------
// Dlaždice, graf, pruhy, tabulka

/**
* Dlaždice: popisek, hodnota a nepovinně změna proti předchozímu období (šipka + text, ne jen barva).
*
* @returns {HTMLElement}
*/
const tile = function ( /** @type {String} */ label, /** @type {String} */ value, /** @type {Object|null} */ delta = null )
{
	const content = [ element( 'span', classes.tileLabel, [ label ] ), element( 'span', classes.tileValue, [ value ] ) ];
	if ( delta ) {
		if ( delta.previous === null ) {
			content.push( element( 'span', classes.tileDelta, [ text( 'noPrevious' ) ] ) );
		} else {
			const change = delta.previous > 0 ? ( delta.current - delta.previous ) / delta.previous : ( delta.current > 0 ? 1 : 0 );
			const direction = delta.current > delta.previous ? 'up' : ( delta.current < delta.previous ? 'down' : 'same' );
			const arrow = { up: '▲', down: '▼', same: '■' }[ direction ];
			const icon = element( 'span', [], [ arrow + ' ' ] );
			icon.setAttribute( 'aria-hidden', 'true' );
			content.push( element( 'span', [ classes.tileDelta, 'is-' + direction ], [
				icon,
				formatNumber( change, { style: 'percent', maximumFractionDigits: 0, signDisplay: 'exceptZero' } ) + ' ' + text( 'previousPeriod', formatNumber( delta.days ) ),
			] ) );
		}
	}
	return element( 'div', classes.tile, content );
};

/** @returns {Number} „hezké“ číslo pro horní okraj osy (1, 2, 2,5, 5 × 10^n) */
const niceMax = function ( /** @type {Number} */ value )
{
	if ( value <= 0 ) {
		return 1;
	}
	const power = 10 ** Math.floor( Math.log10( value ) );
	for ( const step of [ 1, 1.5, 2, 3, 4, 5, 6, 8, 10 ] ) { // jemné kroky – nejvyšší sloupec zabere aspoň 3/4 výšky (s polovinou osy jako celé číslo)
		if ( value <= step * power ) {
			return step * power;
		}
	}
	return 10 * power;
};

/**
* Sloupcový graf jedné řady po dnech. Den bez uložených údajů nemá sloupec (prázdné místo), den s nulou má nulový.
* Sloupec je cíl pro najetí i fokus (Tab) – popisek ukáže hodnotu a den; stejné hodnoty jsou v tabulce pod grafem.
*
* @returns {HTMLElement}
*/
const columnChart = function ( /** @type {String} */ title, /** @type {Object} */ range, /** @type {Map<String, Number>} */ values, /** @type {Function} */ format = formatNumber )
{
	const dates = [];
	for ( let time = timeOfDate( range.since ); time <= timeOfDate( range.until ); time += DAY ) {
		dates.push( isoDate( time ) );
	}
	const max = niceMax( Math.max( 0, ...values.values() ) );
	const figure = element( 'figure', classes.chart );
	figure.append( element( 'figcaption', [], [ title ] ) );
	const axis = element( 'div', classes.chartAxis, [ element( 'span', [], [ format( max ) ] ), element( 'span', [], [ format( max / 2 ) ] ), element( 'span', [], [ format( 0 ) ] ) ] );
	axis.setAttribute( 'aria-hidden', 'true' );
	const bars = element( 'div', classes.chartBars );
	bars.setAttribute( 'role', 'list' );
	bars.style.setProperty( '--ddt-analytics-days', String( dates.length ) );
	const tooltip = element( 'div', classes.tooltip );
	tooltip.hidden = true;
	tooltip.setAttribute( 'aria-hidden', 'true' ); // stejný text má sloupec v aria-label
	const show = ( /** @type {HTMLElement} */ bar, /** @type {String} */ value, /** @type {String} */ label ) => {
		tooltip.replaceChildren( element( 'strong', [], [ value ] ), element( 'span', [], [ label ] ) );
		tooltip.hidden = false;
		const barBox = bar.getBoundingClientRect();
		const box = figure.getBoundingClientRect();
		tooltip.style.left = Math.max( 0, Math.min( box.width - tooltip.offsetWidth, barBox.left - box.left + barBox.width / 2 - tooltip.offsetWidth / 2 ) ) + 'px';
		tooltip.style.top = Math.max( 0, barBox.top - box.top - tooltip.offsetHeight - 6 ) + 'px';
	};
	const hide = () => {
		tooltip.hidden = true;
	};
	for ( const date of dates ) {
		const slot = element( 'div', [] );
		slot.setAttribute( 'role', 'listitem' );
		if ( values.has( date ) ) {
			const value = values.get( date );
			const label = date === range.until ? text( 'today' ) : formatDay( date );
			const bar = element( 'span', classes.chartBar );
			bar.style.height = ( max > 0 ? ( value / max ) * 100 : 0 ) + '%';
			bar.tabIndex = 0;
			bar.setAttribute( 'aria-label', text( 'barLabel', label, format( value ) ) );
			// cíl pro najetí je celý sloupec dne (i nad nízkým sloupcem), pro klávesnici sloupec sám
			slot.addEventListener( 'pointerenter', () => show( bar, format( value ), label ) );
			slot.addEventListener( 'pointerleave', hide );
			bar.addEventListener( 'focus', () => show( bar, format( value ), label ) );
			bar.addEventListener( 'blur', hide );
			slot.append( bar );
		}
		bars.append( slot );
	}
	const labels = element( 'div', classes.chartAxis + '-x', [ element( 'span', [], [ formatDay( dates[ 0 ], false ) ] ), element( 'span', [], [ text( 'today' ) ] ) ] );
	labels.setAttribute( 'aria-hidden', 'true' );
	figure.append( element( 'div', classes.chart + '-plot', [ axis, bars, element( 'span' ), labels ] ), tooltip ); // mřížka: osa | sloupce, pod nimi popisky dnů
	return figure;
};

/**
* Seřazené vodorovné pruhy: název, pruh, číslo (pruhy jedné barvy na společném začátku).
*
* @returns {HTMLElement}
*/
const ranking = function ( /** @type {Array.<Object>} */ items, /** @type {Function} */ format = formatNumber )
{
	const max = Math.max( 1, ...items.map( ( item ) => item.value ) );
	const list = element( 'ol', classes.ranking );
	for ( const item of items ) {
		const bar = element( 'span', [] );
		bar.style.width = ( item.value / max ) * 100 + '%';
		bar.setAttribute( 'aria-hidden', 'true' );
		list.append( element( 'li', [], [ element( 'span', [], [ item.label ] ), element( 'span', [], [ bar ] ), element( 'span', classes.number, [ format( item.value ) ] ) ] ) );
	}
	return list;
};

/** @returns {HTMLTableCellElement} */
const cell = function ( /** @type {String} */ tagName, /** @type {Array} */ content, /** @type {String} */ scope = '', /** @type {Boolean} */ numeric = false )
{
	const node = element( tagName, numeric ? classes.number : [], content );
	if ( scope ) {
		node.scope = scope;
	}
	return node;
};

/** @returns {HTMLTableElement} tabulka administrace: hlavička, řádky (první buňka = záhlaví řádku), nepovinně patička */
const table = function ( /** @type {String} */ caption, /** @type {Array.<String>} */ head, /** @type {Array.<Array>} */ rows, /** @type {Array|null} */ foot = null, /** @type {Array.<Number>} */ numericColumns = [] )
{
	const build = ( /** @type {Array} */ row ) => element( 'tr', [], row.map( ( value, index ) => cell( index === 0 ? 'th' : 'td', [ value ].flat(), index === 0 ? 'row' : '', numericColumns.includes( index ) ) ) );
	return element( 'table', [ ...classes.widefat, classes.table ], [
		element( 'caption', classes.screenReader, [ caption ] ),
		element( 'thead', [], [ element( 'tr', [], head.map( ( label, index ) => cell( 'th', [ label ], 'col', numericColumns.includes( index ) ) ) ) ] ),
		element( 'tbody', [], rows.map( build ) ),
		...( foot ? [ element( 'tfoot', [], [ build( foot ) ] ) ] : [] ),
	] );
};

/** @returns {HTMLDetailsElement} rozbalovací tabulka (zobrazení dat grafu bez najetí) */
const detailsTable = function ( /** @type {String} */ summary, /** @type {HTMLTableElement} */ tableElement )
{
	return element( 'details', [], [ element( 'summary', [], [ summary ] ), tableElement ] );
};

/** @returns {Array.<Object>} chyby částí odpovědi { path, error } (do hloubky 3) */
const sectionErrors = function ( /** @type {*} */ value, /** @type {String} */ path = '', /** @type {Number} */ depth = 0 )
{
	if ( !value || typeof value !== 'object' || depth > 3 ) {
		return [];
	}
	if ( value.error && typeof value.error === 'object' && typeof value.error.code === 'string' ) {
		return [ { path, error: value.error } ];
	}
	return Object.entries( value ).flatMap( ( [ key, child ] ) => Array.isArray( child ) ? [] : sectionErrors( child, path ? path + '.' + key : key, depth + 1 ) );
};

// -----------------------------------------------------------------------------------------------------------------------------
// Části výpisu

/** @type {Object} modul analytics-data.mjs */
let data = null;

/** @returns {Object|null} */
const recordOf = function ( /** @type {String} */ key )
{
	return data?.getRecord( settings.sources?.[ key ] ) ?? null;
};

/** @returns {Array.<HTMLElement>} obsah části Návštěvnost webu */
const trafficContent = function ()
{
	const traffic = recordOf( 'traffic' );
	const referrers = recordOf( 'referrers' );
	const range = rangeOf( period, earliestOf( [ [ traffic, 'days' ], [ referrers, 'http' ], [ referrers, 'webAnalytics' ] ] ) );
	const days = seriesIn( traffic, 'days', range );
	const previous = range.previous ? seriesIn( traffic, 'days', range.previous ) : [];
	const http = seriesIn( referrers, 'http', range );
	const rum = seriesIn( referrers, 'webAnalytics', range );
	if ( !days.length && !rum.length && !http.length ) {
		return [ note( text( 'noData' ) ) ];
	}
	const content = [];
	const tiles = element( 'div', classes.tiles );
	if ( days.length ) {
		const deltaOf = ( /** @type {String} */ key ) => ( { current: sumOf( days, key ), previous: range.previous && previous.length ? sumOf( previous, key ) : null, days: range.days } );
		tiles.append(
			tile( text( 'pageViews' ), formatTileNumber( sumOf( days, 'pageViews' ) ), range.previous ? deltaOf( 'pageViews' ) : null ),
			tile( text( 'requests' ), formatTileNumber( sumOf( days, 'requests' ) ), range.previous ? deltaOf( 'requests' ) : null ),
			tile( text( 'bytes' ), formatBytes( sumOf( days, 'bytes' ) ) ),
			tile( text( 'cached' ), formatShare( sumOf( days, 'cachedRequests' ), sumOf( days, 'requests' ) ) ),
		);
	}
	if ( http.length ) {
		const previousHttp = range.previous ? seriesIn( referrers, 'http', range.previous ) : [];
		tiles.append( tile( text( 'fromLinks' ), formatTileNumber( sumOf( http, 'fromLinks' ) ), range.previous ? { current: sumOf( http, 'fromLinks' ), previous: previousHttp.length ? sumOf( previousHttp, 'fromLinks' ) : null, days: range.days } : null ) );
	}
	if ( rum.length ) {
		tiles.append( tile( text( 'visits' ), formatTileNumber( sumOf( rum, 'visits' ) ) ) );
	}
	content.push( tiles );
	if ( days.length ) {
		if ( days.length < range.days ) {
			content.push( note( text( 'daysCovered', formatNumber( days.length ), formatNumber( range.days ), formatDay( days[ 0 ][ 0 ], false ) ) ) );
		}
		content.push( columnChart( text( 'trafficChart' ), range, new Map( days.map( ( [ date, day ] ) => [ date, Number( day.pageViews ) || 0 ] ) ) ) );
		content.push( note( text( 'trafficChartNote' ) ) );
		const rows = [ ...days ].reverse().map( ( [ date, day ] ) => [
			date === range.until ? text( 'today' ) : formatDay( date ),
			formatNumber( Number( day.pageViews ) || 0 ),
			formatNumber( Number( day.requests ) || 0 ),
			formatBytes( Number( day.bytes ) || 0 ),
			formatShare( Number( day.cachedRequests ) || 0, Number( day.requests ) || 0 ),
		] );
		content.push( detailsTable( text( 'showTable' ), table( text( 'trafficChart' ), [ text( 'dayColumn' ), text( 'pageViews' ), text( 'requests' ), text( 'bytes' ), text( 'cached' ) ], rows,
			[ text( 'total' ), formatNumber( sumOf( days, 'pageViews' ) ), formatNumber( sumOf( days, 'requests' ) ), formatBytes( sumOf( days, 'bytes' ) ), formatShare( sumOf( days, 'cachedRequests' ), sumOf( days, 'requests' ) ) ],
			[ 1, 2, 3, 4 ] ) ) );
	}
	return content;
};

/**
* Zpětné odkazy ze všech zdrojů za období: web → { host, http, rum, github, pingbacks: [], first, last }.
*
* @returns {Map<String, Object>}
*/
const collectReferrers = function ( /** @type {Object} */ range )
{
	const referrers = recordOf( 'referrers' );
	const github = recordOf( 'github' );
	const map = new Map();
	const itemOf = ( /** @type {String} */ host ) => {
		const key = host.toLowerCase();
		if ( !map.has( key ) ) {
			map.set( key, { host: key, http: 0, rum: 0, github: 0, pingbacks: [], first: null, last: null } );
		}
		return map.get( key );
	};
	const seen = ( /** @type {Object} */ item, /** @type {String} */ date ) => {
		item.first = item.first === null || date < item.first ? date : item.first;
		item.last = item.last === null || date > item.last ? date : item.last;
	};
	for ( const [ series, field ] of [ [ 'http', 'http' ], [ 'webAnalytics', 'rum' ] ] ) {
		for ( const [ date, day ] of seriesIn( referrers, series, range ) ) {
			for ( const [ host, count ] of Array.isArray( day?.hosts ) ? day.hosts : [] ) {
				const item = itemOf( String( host ) );
				item[ field ] += Number( count ) || 0;
				seen( item, date );
			}
		}
	}
	for ( const [ date, items ] of seriesIn( github, 'referrers', range ) ) {
		for ( const [ referrer, count ] of Array.isArray( items ) ? items : [] ) {
			const item = itemOf( String( referrer ) );
			item.github = Math.max( item.github, Number( count ) || 0 ); // každý záznam je součet 14 dní – nejvyšší je dolní odhad
			seen( item, date );
		}
	}
	for ( const ping of Array.isArray( settings.pingbacks ) ? settings.pingbacks : [] ) {
		const date = String( ping.date ?? '' ).slice( 0, 10 );
		if ( date < range.since || date > range.until || !ping.host ) {
			continue;
		}
		const item = itemOf( String( ping.host ) );
		item.pingbacks.push( ping );
		seen( item, date );
	}
	return map;
};

/** @returns {Array.<HTMLElement>} odznaky zdrojů zpětného odkazu */
const sourceBadges = function ( /** @type {Object} */ item )
{
	const badges = [];
	const badge = ( /** @type {String} */ label, /** @type {String} */ title ) => {
		const node = element( 'span', classes.badge, [ label ] );
		node.title = title;
		badges.push( node, ' ' );
	};
	if ( item.http ) {
		badge( text( 'sourceHttp' ), text( 'sourceHttpTitle' ) );
	}
	if ( item.rum ) {
		badge( text( 'sourceRum' ), text( 'sourceRumTitle' ) );
	}
	if ( item.github ) {
		badge( text( 'sourceGithub' ), text( 'sourceGithubTitle' ) );
	}
	if ( item.pingbacks.length ) {
		badge( item.pingbacks.some( ( ping ) => ping.type === 'trackback' ) ? text( 'sourceTrackback' ) : text( 'sourcePingback' ), plural( 'pingbacksCount', item.pingbacks.length ) );
	}
	return badges;
};

/** @type {Array.<String>} pořadí zdrojů pro řazení zpětných odkazů – počty různých zdrojů se nesčítají ani nemíchají (jiné jednotky) */
const METRICS = [ 'http', 'rum', 'github', 'pingbacks' ];

/** @returns {Number} počet webu podle zdroje */
const metricOf = function ( /** @type {Object} */ item, /** @type {String} */ metric )
{
	return metric === 'pingbacks' ? item.pingbacks.length : item[ metric ];
};

/**
* Weby seřazené podle prvního zdroje (požadavky z Cloudflare – úplné i pro weby bez JavaScriptu), při shodě podle dalšího
* (Web Analytics, GitHub, pingbacky), nakonec podle posledního výskytu.
*
* @returns {Object} { items, primary: zdroj prvního řazení, který něco má, nebo null }
*/
const sortedReferrers = function ( /** @type {Object} */ range )
{
	const items = [ ...collectReferrers( range ).values() ].sort( ( a, b ) => {
		for ( const metric of METRICS ) {
			const difference = metricOf( b, metric ) - metricOf( a, metric );
			if ( difference ) {
				return difference;
			}
		}
		return String( b.last ).localeCompare( String( a.last ) );
	} );
	return { items, primary: METRICS.find( ( metric ) => items.some( ( item ) => metricOf( item, metric ) > 0 ) ) ?? null };
};

/** @type {Object<String, String>} název zdroje (klíč textu) */
const METRIC_LABELS = { http: 'sourceHttp', rum: 'sourceRum', github: 'sourceGithub', pingbacks: 'sourcePingback' };

/** @returns {Array.<HTMLElement>} obsah části Zpětné odkazy */
const referrersContent = function ()
{
	const referrers = recordOf( 'referrers' );
	const range = rangeOf( period, earliestOf( [ [ referrers, 'http' ], [ referrers, 'webAnalytics' ], [ recordOf( 'github' ), 'referrers' ] ] ) );
	const { items, primary } = sortedReferrers( range );
	const content = [];
	const cloudflare = referrers?.report?.cloudflare;
	if ( cloudflare?.error ) {
		content.push( warning( codeText( cloudflare.error ) ) );
	} else {
		for ( const part of [ 'http', 'webAnalytics' ] ) {
			if ( cloudflare?.[ part ]?.error ) {
				content.push( note( ( part === 'http' ? text( 'sourceHttp' ) : text( 'sourceRum' ) ) + ': ' + codeText( cloudflare[ part ].error ) ) );
			}
		}
	}
	if ( !items.length ) {
		content.push( note( text( 'referrersEmpty' ) ) );
		return content;
	}
	if ( primary ) {
		content.push( subheading( text( 'referrersTitle' ) + ' – ' + text( METRIC_LABELS[ primary ] ) ) );
		content.push( ranking( items.filter( ( item ) => metricOf( item, primary ) > 0 ).slice( 0, 10 ).map( ( item ) => ( { label: item.host, value: metricOf( item, primary ) } ) ) ) );
	}
	const dateCell = ( /** @type {String|null} */ date ) => date ? formatDay( date, false ) : '–';
	const rows = items.slice( 0, settings.listLimit ?? 30 ).map( ( item ) => {
		const ping = item.pingbacks[ 0 ];
		const name = ping?.url ? externalLink( ping.url, item.host ) : item.host;
		return [
			[ name, ' ', ...sourceBadges( item ) ],
			item.http ? formatNumber( item.http ) : '–',
			item.rum ? formatNumber( item.rum ) : '–',
			item.github ? formatNumber( item.github ) : '–',
			item.pingbacks.length ? formatNumber( item.pingbacks.length ) : '–',
			dateCell( item.first ),
			dateCell( item.last ),
		];
	} );
	content.push( table( text( 'referrersTitle' ), [ text( 'referrerColumn' ), text( 'sourceHttp' ), text( 'sourceRum' ), text( 'sourceGithub' ), text( 'pingbackColumn' ), text( 'firstColumn' ), text( 'lastColumn' ) ], rows, null, [ 1, 2, 3, 4 ] ) );
	const notes = [ text( 'referrersNote' ) ];
	const http = cloudflare?.http;
	if ( http && !http.error ) {
		if ( http.sampled ) {
			notes.push( text( 'sampled' ) );
		}
		const filters = [ http.filters?.htmlOnly ? text( 'filterHtml' ) : null, http.filters?.eyeballOnly ? text( 'filterEyeball' ) : null ].filter( Boolean );
		if ( filters.length ) {
			notes.push( text( 'filtersNote', filters.join( ', ' ) ) );
		}
	}
	content.push( note( notes.join( ' ' ) ) );

	// Z posledního načtení (ne za období): celé adresy odkazů a cílové stránky
	const urls = [
		...( Array.isArray( http?.urls?.items ) ? http.urls.items.map( ( item ) => ( { label: item.url, value: Number( item.requests ) || 0 } ) ) : [] ),
		...( Array.isArray( cloudflare?.webAnalytics?.urls?.items ) ? cloudflare.webAnalytics.urls.items.map( ( item ) => ( { label: item.host + item.path, value: Number( item.visits ) || 0 } ) ) : [] ),
	].sort( ( a, b ) => b.value - a.value ).slice( 0, 10 );
	const pages = Array.isArray( http?.pages?.items ) ? http.pages.items.map( ( item ) => ( { label: item.path, value: Number( item.requests ) || 0 } ) ).slice( 0, 10 ) : [];
	const latestDays = cloudflare?.window?.days ?? 30;
	if ( urls.length ) {
		content.push( subheading( text( 'urlsTitle' ) ), ranking( urls ), note( text( 'latestNote', formatNumber( latestDays ) ) ) );
	}
	if ( pages.length ) {
		content.push( subheading( text( 'pagesTitle' ) ), ranking( pages ), note( text( 'latestNote', formatNumber( latestDays ) ) ) );
	}
	return content;
};

/** @returns {Array.<HTMLElement>} obsah části Repozitář na GitHubu */
const githubContent = function ()
{
	const record = recordOf( 'github' );
	const github = record?.report?.github;
	const content = [];
	if ( github?.error ) {
		content.push( warning( codeText( github.error ) ) );
	}
	const range = rangeOf( period, earliestOf( [ [ record, 'views' ] ] ) );
	const views = seriesIn( record, 'views', range );
	const clones = seriesIn( record, 'clones', range );
	const repository = github?.repository && !github.repository.error ? github.repository : null;
	if ( repository?.fullName ) {
		const facts = [ repository.private ? text( 'private' ) : text( 'public' ) ];
		if ( repository.pushedAt ) {
			facts.push( text( 'pushed', relativeTime( Date.parse( repository.pushedAt ) ) ) );
		}
		content.push( element( 'p', [], [ ...( repository.url ? [ externalLink( repository.url, text( 'repository', repository.fullName ) ) ] : [ text( 'repository', repository.fullName ) ] ), ' (' + facts.join( ', ' ) + ')' ] ) );
		if ( repository.description ) {
			content.push( note( repository.description ) );
		}
	} else if ( github?.repository?.error ) {
		content.push( note( codeText( github.repository.error ) ) );
	}
	if ( !views.length && !repository ) {
		if ( !github?.error ) {
			content.push( note( text( 'noData' ) ) );
		}
		return content;
	}
	const tiles = element( 'div', classes.tiles );
	if ( views.length ) {
		const previous = range.previous ? seriesIn( record, 'views', range.previous ) : [];
		tiles.append(
			tile( text( 'githubViews' ), formatTileNumber( sumOf( views, 'count' ) ), range.previous ? { current: sumOf( views, 'count' ), previous: previous.length ? sumOf( previous, 'count' ) : null, days: range.days } : null ),
			tile( text( 'githubUniques' ), formatTileNumber( sumOf( views, 'uniques' ) ) ),
		);
	}
	if ( clones.length ) {
		tiles.append( tile( text( 'githubClones' ), formatTileNumber( sumOf( clones, 'count' ) ) ) );
	}
	if ( repository ) {
		tiles.append( tile( text( 'githubStars' ), formatTileNumber( repository.stars ) ), tile( text( 'githubForks' ), formatTileNumber( repository.forks ) ), tile( text( 'githubWatchers' ), formatTileNumber( repository.watchers ) ) );
	}
	content.push( tiles );
	if ( views.length ) {
		content.push( columnChart( text( 'githubChart' ), range, new Map( views.map( ( [ date, day ] ) => [ date, Number( day.count ) || 0 ] ) ) ) );
		const clonesByDate = new Map( clones );
		content.push( detailsTable( text( 'showTable' ), table( text( 'githubChart' ), [ text( 'dayColumn' ), text( 'githubViews' ), text( 'githubUniques' ), text( 'githubClones' ) ],
			[ ...views ].reverse().map( ( [ date, day ] ) => [ date === range.until ? text( 'today' ) : formatDay( date ), formatNumber( Number( day.count ) || 0 ), formatNumber( Number( day.uniques ) || 0 ), formatNumber( Number( clonesByDate.get( date )?.count ) || 0 ) ] ),
			[ text( 'total' ), formatNumber( sumOf( views, 'count' ) ), formatNumber( sumOf( views, 'uniques' ) ), formatNumber( sumOf( clones, 'count' ) ) ], [ 1, 2, 3 ] ) ) );
	}
	content.push( note( text( 'githubNote' ) ) );
	for ( const [ part, title, labelOf ] of [ [ 'referrers', 'githubReferrers', ( item ) => item.referrer ], [ 'paths', 'githubPaths', ( item ) => item.title ? item.title + ' (' + item.path + ')' : item.path ] ] ) {
		const list = github?.[ part ];
		if ( list?.error ) {
			content.push( subheading( text( title ) ), note( codeText( list.error ) ) );
		} else if ( Array.isArray( list?.items ) && list.items.length ) {
			content.push( subheading( text( title ) ), ranking( list.items.map( ( item ) => ( { label: labelOf( item ), value: Number( item.count ) || 0 } ) ) ), note( text( 'latestNote', '14' ) ) );
		}
	}
	return content;
};

/** @type {Map<String, Object>} zdroj → { loading, error } – stav načítání pro část Zdroje údajů */
const sourceStates = new Map();

/** @returns {Array.<HTMLElement>} obsah části Zdroje údajů */
const sourcesContent = function ()
{
	const rows = data.getSources().map( ( source ) => {
		const record = data.getRecord( source.id );
		const state = sourceStates.get( source.id ) ?? {};
		const historyDays = Math.max( 0, ...Object.values( record?.history ?? {} ).map( ( series ) => series && typeof series === 'object' ? Object.keys( series ).length : 0 ) );
		let status;
		if ( source.problem ) {
			status = source.problem;
		} else if ( state.loading ) {
			status = text( 'loading' );
		} else if ( state.error ) {
			status = text( 'failed', state.error );
		} else if ( record ) {
			const errors = sectionErrors( record.report );
			status = errors.length ? text( 'partErrors', errors.map( ( item ) => item.path + ' – ' + codeText( item.error ) ).join( '; ' ) ) : text( 'stateOk' );
		} else {
			status = text( 'never' );
		}
		const reload = element( 'button', [ classes.button ], [ text( 'reloadSource' ) ] );
		reload.type = 'button';
		reload.disabled = Boolean( source.problem || state.loading );
		reload.addEventListener( 'click', () => loadSources( [ source.id ], true ) );
		return [ source.label, record ? [ savedTime( record.savedAt ) ] : text( 'never' ), historyDays ? plural( 'historyDays', historyDays ) : '–', status, [ reload ] ];
	} );
	return [ table( text( 'sourceName' ), [ text( 'sourceName' ), text( 'sourceSaved' ), text( 'sourceHistory' ), text( 'sourceState' ), '' ], rows ) ];
};

/** @returns {Array.<HTMLElement>} obsah widgetu na nástěnce */
const summaryContent = function ()
{
	const traffic = recordOf( 'traffic' );
	const referrers = recordOf( 'referrers' );
	const days = Number( settings.summaryPeriod ) || 7;
	const range = rangeOf( days );
	const content = [];
	const tiles = element( 'div', classes.tiles );
	const pageViews = seriesIn( traffic, 'days', range );
	if ( pageViews.length ) {
		const previous = seriesIn( traffic, 'days', range.previous );
		tiles.append( tile( text( 'pageViews' ), formatTileNumber( sumOf( pageViews, 'pageViews' ) ), { current: sumOf( pageViews, 'pageViews' ), previous: previous.length ? sumOf( previous, 'pageViews' ) : null, days } ) );
	}
	const http = seriesIn( referrers, 'http', range );
	if ( http.length ) {
		tiles.append( tile( text( 'fromLinks' ), formatTileNumber( sumOf( http, 'fromLinks' ) ) ) );
	}
	const rum = seriesIn( referrers, 'webAnalytics', range );
	if ( rum.length ) {
		tiles.append( tile( text( 'visits' ), formatTileNumber( sumOf( rum, 'visits' ) ) ) );
	}
	if ( tiles.childElementCount ) {
		content.push( tiles );
	} else {
		content.push( note( text( 'summaryNoSources' ) ) );
	}
	const { items, primary } = sortedReferrers( range );
	const top = primary ? items.filter( ( item ) => metricOf( item, primary ) > 0 ).slice( 0, Number( settings.summaryLimit ) || 5 ) : [];
	if ( top.length ) {
		content.push( subheading( text( 'summaryReferrers' ) + ' – ' + text( METRIC_LABELS[ primary ] ) ), ranking( top.map( ( item ) => ( { label: item.host, value: metricOf( item, primary ) } ) ) ) );
	}
	const pingbacks = Array.isArray( settings.pingbacks ) ? settings.pingbacks : [];
	const pingLink = element( 'a', [], [ plural( 'pingbacksCount', pingbacks.length ) ] );
	pingLink.href = settings.links?.pingbacks ?? '#';
	content.push( subheading( text( 'summaryPingbacks' ) ), element( 'p', [], [ pingLink, ...( pingbacks[ 0 ] ? [ ' · ', pingbacks[ 0 ].url ? externalLink( pingbacks[ 0 ].url, pingbacks[ 0 ].title || pingbacks[ 0 ].host ) : pingbacks[ 0 ].title ] : [] ) ] ) );
	return content; // odkaz „Všechna analytická data“ vypisuje PHP pod obsahem (funguje i bez JavaScriptu)
};

/** @type {Object<String, Object>} část → { build, sources: klíče settings.sources, na kterých závisí } */
const VIEW_BUILDERS = {
	[ VIEWS.TRAFFIC ]: { build: trafficContent, sources: [ 'traffic', 'referrers' ] },
	[ VIEWS.REFERRERS ]: { build: referrersContent, sources: [ 'referrers', 'github' ] },
	[ VIEWS.GITHUB ]: { build: githubContent, sources: [ 'github' ] },
	[ VIEWS.SOURCES ]: { build: sourcesContent, sources: [ 'traffic', 'referrers', 'github', 'cloudflare' ] },
	[ VIEWS.SUMMARY ]: { build: summaryContent, sources: [ 'traffic', 'referrers' ] },
};

// -----------------------------------------------------------------------------------------------------------------------------
// Vykreslení a načítání

/** @type {Array.<Object>} části ve stránce { name, root, status, content } */
const views = [ ...document.querySelectorAll( '[' + settings.attribute + ']' ) ].map( ( root ) => ( {
	name: root.getAttribute( settings.attribute ),
	root,
	status: root.querySelector( '[' + settings.attribute + '-status]' ),
	content: root.querySelector( '[' + settings.attribute + '-content]' ),
} ) ).filter( ( view ) => VIEW_BUILDERS[ view.name ] && view.content );

/** @returns {String[]} ID zdrojů, na kterých část závisí (jen ty, které jsou ve stránce) */
const sourceIdsOf = function ( /** @type {Object} */ view )
{
	return VIEW_BUILDERS[ view.name ].sources.map( ( key ) => settings.sources?.[ key ] ).filter( ( id ) => id && data.getSource( id ) );
};

/** Stav části: kdy se uložil nejnovější z jejích zdrojů, co se načítá, co selhalo. */
const renderStatus = function ( /** @type {Object} */ view )
{
	if ( !view.status || view.name === VIEWS.SOURCES ) {
		view.status?.replaceChildren();
		return;
	}
	const ids = sourceIdsOf( view );
	const records = ids.map( ( id ) => data.getRecord( id ) ).filter( Boolean );
	const loading = ids.some( ( id ) => sourceStates.get( id )?.loading );
	const failed = ids.map( ( id ) => sourceStates.get( id )?.error ).filter( Boolean );
	const problems = ids.map( ( id ) => data.getSource( id )?.problem ).filter( Boolean );
	const newest = records.length ? Math.max( ...records.map( ( record ) => Number( record.savedAt ) || 0 ) ) : 0;
	const parts = [];
	if ( newest ) {
		parts.push( ...( loading ? text( 'refreshing', '\u0000' ) : text( 'stored', '\u0000' ) ).split( '\u0000' ).flatMap( ( part, index ) => index ? [ savedTime( newest ), part ] : [ part ] ) );
	} else if ( loading ) {
		parts.push( text( 'loading' ) );
	} else if ( !failed.length && !problems.length ) {
		parts.push( text( 'never' ) );
	}
	for ( const message of [ ...new Set( failed ) ] ) {
		parts.push( ' ' + text( 'failed', message ) );
	}
	if ( !records.length && problems.length && view.name !== VIEWS.SUMMARY ) {
		parts.push( ' ' + text( 'unavailable', [ ...new Set( problems ) ].join( ' ' ) ) );
	}
	view.status.replaceChildren( ...parts );
	view.root.classList.toggle( classes.loading, loading && records.length > 0 ); // drží předchozí obsah, jen ztlumený
};

/** Překreslí části (všechny, nebo ty, které závisí na zdroji sourceId). */
const render = function ( /** @type {String|null} */ sourceId = null )
{
	for ( const view of views ) {
		if ( sourceId && !sourceIdsOf( view ).includes( sourceId ) && view.name !== VIEWS.SOURCES ) {
			continue;
		}
		try {
			view.content.replaceChildren( ...VIEW_BUILDERS[ view.name ].build() );
		} catch ( error ) {
			console.error( 'Analytická data, část ' + view.name + ':', error );
			view.content.replaceChildren( warning( String( error?.message ?? error ) ) );
		}
		renderStatus( view );
	}
};

/** Načte zdroje (starší než maxAge, s fresh všechny) a po každém překreslí, co na něm závisí. */
const loadSources = async function ( /** @type {String[]} */ ids, /** @type {Boolean} */ fresh )
{
	const wanted = ids.filter( ( id ) => !data.getSource( id )?.problem && ( fresh || data.isStale( id ) ) );
	for ( const id of wanted ) {
		sourceStates.set( id, { loading: true } );
	}
	render(); // stavy „načítám“
	await Promise.all( wanted.map( async ( id ) => {
		try {
			const result = await data.load( id, { fresh } );
			sourceStates.set( id, result.warning ? { error: result.warning } : {} );
		} catch ( error ) {
			sourceStates.set( id, { error: data.errorText( error ) } );
		}
		render( id );
	} ) );
};

/** @returns {Promise.<Object>} modul ověřený přes SRI podle názvu souboru (pravidlo 9, vzor importVerified() v admin-static-export.mjs) */
const importVerified = ( /** @type {String} */ fileName ) => new Promise( ( resolve, reject ) =>
{
	const script = [ ...document.querySelectorAll( 'script[type="module"][integrity]' ) ].find( ( node ) => new URL( node.src ).pathname.endsWith( '/' + fileName ) );
	const settle = () =>
	{
		if ( script.hasAttribute( FAILED_ATTRIBUTE ) ) {
			reject( new Error( 'Modul neprošel kontrolou integrity (SRI) nebo se nenačetl: ' + script.src ) );
		} else if ( script.hasAttribute( LOADED_ATTRIBUTE ) ) {
			resolve( import( script.src ) );
		} else {
			return false;
		}
		return true;
	};
	if ( !script ) {
		reject( new Error( 'Ve stránce chybí <script type="module" integrity> pro ' + fileName ) );
	} else if ( !settle() ) {
		script.addEventListener( 'load', settle, { once: true } );
		script.addEventListener( 'error', settle, { once: true } );
	}
} );

if ( views.length ) {
	importVerified( DATA_MODULE ).then( ( module ) => {
		data = module;
		const periodSelect = document.querySelector( '[' + settings.periodAttribute + ']' );
		if ( periodSelect ) {
			period = Number( periodSelect.value ) || 0;
			periodSelect.addEventListener( 'change', () => {
				period = Number( periodSelect.value ) || 0;
				render();
			} );
		}
		const allIds = [ ...new Set( views.flatMap( sourceIdsOf ) ) ];
		document.querySelector( '[' + settings.reloadAttribute + ']' )?.addEventListener( 'click', () => loadSources( allIds, true ) );
		render();
		loadSources( allIds, false );
	} ).catch( ( error ) => {
		console.error( 'Analytická data:', error );
		for ( const view of views ) {
			view.status?.replaceChildren( text( 'failed', String( error?.message ?? error ) ) );
		}
	} );
}
