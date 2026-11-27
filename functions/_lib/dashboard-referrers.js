/**
* [2026-11-27] Odkazující weby (zpětné odkazy) pro stránku Analytická data ve WordPressu (šablona domdocument-template:
* admin-pages/analyticka-data.php, js/modules/analytics-data.mjs, js/modules/admin-analytics.mjs). Trasa
* GET /api/dashboard/referrers je functions/api/dashboard/referrers.js, logika je tady (kvůli testům
* v .site-checks/dashboard-referrers.test.mjs). Token WordPressu, tajný API token DASHBOARD_API_TOKEN a CORS má společné
* s /api/dashboard (functions/_lib/dashboard.js), zóny podle vlastních domén projektu s /api/dashboard/traffic.
*
* Dva zdroje, každý může chybět (pak má místo dat { error }):
*   http          HTTP požadavky zóny (httpRequestsAdaptiveGroups) – jen stránky (HTML) od návštěvníků (requestSource
*                 eyeball), s hlavičkou Referer z jiného webu než vlastní domény projektu. Pole, která tarif zóny
*                 nedovolí (uzel settings, availableFields), se do dotazu nedávají; bez clientRefererHost není co
*                 počítat (FIELDS). Počty jsou odhad (adaptivní vzorkování, sampled). Počítají se i roboti, kteří
*                 Referer posílají.
*   webAnalytics  Cloudflare Web Analytics (rumPageloadEventsAdaptiveGroups) – jen prohlížeče se spuštěným JavaScriptem
*                 (bez robotů, bot = 0): návštěvy a zobrazení stránek podle odkazujícího webu. Web Analytics musí být
*                 pro web zapnuté a token potřebuje navíc oprávnění Account → Account Settings → Read (seznam webů
*                 Web Analytics, REST /accounts/{účet}/rum/site_info/list) – bez něj { error }.
*
* Odpověď (JSON, CORS pro všechny – bez cookies, bez platného tokenu nic nevydá):
*   settings    { apiToken }
*   cloudflare  { zones, window, http, webAnalytics }, nebo { error } (chybí token, účet, projekt, zóna…):
*     window    celé dny podle UTC { since, until, days } – posledních REFERRER_DAYS dní (nebo kolik dovolí tarif),
*               dnešek se ještě doplňuje. WordPress podle něj nahrazuje dny v uložené historii (dny bez odkazů = 0).
*     http      { days: [{ date, pageViews, fromLinks, hosts: [{ host, requests }] }], urls: [{ url, requests }],
*                 pages: [{ path, requests }], sampled, filters: { htmlOnly, eyeballOnly }, failedZones }
*     webAnalytics { site: { tag, host }, window, days: [{ date, visits, pageViews, hosts: [{ host, visits, pageViews }] }],
*                 urls: [{ host, path, visits }], pages: [{ path, visits, pageViews }], sampled }
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/functions/), export ho kopíruje do repozitáře
* statického webu – upravovat ho ve šabloně. Popis: functions/README.md, „Údaje pro nástěnku WordPressu“.
*/

import {
	ERRORS,
	SectionError,
	cloudflareApi,
	graphql,
	handleRequest,
	isoTime,
	numberOf,
	reachOf,
	section,
	shortText,
	stringOf,
	utcDayStart,
} from './dashboard.js';
import { zonesFromDomains } from './dashboard-traffic.js';

/** @type {Number} dní zpět (tarif může dovolit méně – uzel settings; od 2. 10. 2026 má i bezplatný tarif 31 dní) */
export const REFERRER_DAYS = 30;

/** @type {Number} skupin (den × odkazující web) v jednom dotazu */
export const HOSTS_LIMIT = 2000;

/** @type {Number} odkazujících webů na den v odpovědi (nejčastější) */
export const HOSTS_PER_DAY = 30;

/** @type {Number} celých adres odkazů a cílových stránek v odpovědi */
export const TOP_LIMIT = 30;

/** @type {Number} s – jak dlouho si instance funkce pamatuje odpověď (ochrana limitu 300 dotazů GraphQL za 5 minut) */
export const CACHE_SECONDS = 300;

/** @type {Number} s – jak dlouho si instance pamatuje, co tarif dovolí, a seznam webů Web Analytics */
const SETTINGS_CACHE_SECONDS = 3600;

/** @type {Object<String, String>} datové sady GraphQL Analytics API */
export const DATASETS = Object.freeze( {
	HTTP: 'httpRequestsAdaptiveGroups', // zóna
	RUM: 'rumPageloadEventsAdaptiveGroups', // účet (Web Analytics)
} );

/** @type {Object<String, String>} pole httpRequestsAdaptiveGroups, která dotaz používá */
export const HTTP_FIELDS = Object.freeze( {
	REFERER_HOST: 'clientRefererHost', // bez něj odkazy nejdou spočítat
	REFERER: 'clientRequestReferer', // celá adresa odkazu (prohlížeče ji z cizího webu často zkrátí na origin)
	PATH: 'clientRequestPath', // cílová stránka
	HOST: 'clientRequestHTTPHost', // jen vlastní domény projektu (zóna může mít i jiné weby)
	CONTENT_TYPE: 'edgeResponseContentTypeName', // jen stránky (html), ne obrázky a styly
	SOURCE: 'requestSource', // jen návštěvníci (eyeball), ne podpožadavky Workers
	DATE: 'date',
} );

/** @type {RegExp} ID zóny (zone_tag) a webu Web Analytics (site_tag) */
const TAG_PATTERN = /^[0-9a-f]{32}$/;

/** @type {Function} */
const now = function ()
{
	return Math.floor( Date.now() / 1000 );
};

/** @returns {String} RRRR-MM-DD v UTC */
const isoDate = function ( /** @type {Number} */ seconds )
{
	return isoTime( seconds ).slice( 0, 10 );
};

/** @returns {String} řetězec pro dotaz GraphQL */
const quote = function ( /** @type {*} */ value )
{
	return JSON.stringify( String( value ) );
};

/**
* Je pole v datové sadě dostupné? Uzel settings vrací seznam availableFields – prázdný nebo chybějící seznam = nevíme,
* zkusí se (chyba pak přijde u části dotazu). Názvy porovnává i jako konec cesty (dimensions.clientRefererHost).
*
* @returns {Boolean}
*/
export const hasField = function ( /** @type {Object|undefined} */ limits, /** @type {String} */ name )
{

	/** @type {*} */
	const available = limits?.availableFields;

	if ( !Array.isArray( available ) || available.length === 0 ) {
		return true;
	}
	return available.some( ( /** @type {*} */ field ) => {
		const text = String( field );
		return text === name || text.endsWith( '.' + name ) || text.endsWith( '/' + name );
	} );
};

/**
* Rozsah celých dnů podle UTC, který tarif dovolí: posledních `days` dní včetně dneška, nejstarší den celý (WordPress
* podle rozsahu nahrazuje dny v historii – neúplný první den by přepsal úplný).
*
* @returns {Object|null} { since: RRRR-MM-DD, until: RRRR-MM-DD, days, start: s } nebo null (tarif nedovolí ani dnešek)
*/
export const dayWindow = function ( /** @type {Object|undefined} */ limits, /** @type {Number} */ time, /** @type {Number} */ days = REFERRER_DAYS )
{

	/** @type {Number} */
	const dayStart = utcDayStart( time );

	/** @type {Number} */
	const earliest = time - reachOf( limits, days * 86400 );

	/** @type {Number} */
	let first = dayStart - ( days - 1 ) * 86400;

	while ( first < earliest && first < dayStart ) {
		first += 86400;
	}
	if ( first < earliest ) { // tarif nedovolí ani celý dnešek – od nejstaršího možného okamžiku
		first = earliest;
	}
	return { since: isoDate( first ), until: isoDate( dayStart ), days: Math.round( ( dayStart - utcDayStart( first ) ) / 86400 ) + 1, start: first };
};

/** @returns {String[]} dny rozsahu od nejstaršího (RRRR-MM-DD) */
export const datesOf = function ( /** @type {Object} */ window )
{

	/** @type {String[]} */
	const dates = [];

	for ( let day = Date.parse( window.since + 'T00:00:00Z' ) / 1000; isoDate( day ) <= window.until; day += 86400 ) {
		dates.push( isoDate( day ) );
	}
	return dates;
};

/** @returns {String} host bez tečky na konci, malými písmeny */
export const normalizeHost = function ( /** @type {*} */ value )
{
	return String( value ?? '' ).trim().toLowerCase().replace( /\.$/, '' );
};

/** @returns {String[]} vlastní domény projektu i s www. / bez www. (odkazy z nich nejsou zpětné odkazy) */
export const ownHostsOf = function ( /** @type {String[]} */ domains )
{

	/** @type {Set<String>} */
	const hosts = new Set();

	for ( const domain of domains ) {
		const host = normalizeHost( domain );
		if ( host === '' ) {
			continue;
		}
		hosts.add( host );
		hosts.add( host.startsWith( 'www.' ) ? host.slice( 4 ) : 'www.' + host );
	}
	return [ ...hosts ];
};

// -----------------------------------------------------------------------------------------------------------------------------
// Uzel settings (co tarif dovolí)

/** @type {Map<String, Object>} klíč → { expires, value } */
const settingsCache = new Map();

/** @returns {Promise<*>} hodnota z paměti instance, nebo nově načtená */
const cachedValue = async function ( /** @type {String} */ key, /** @type {Number} */ time, /** @type {Function} */ load )
{

	/** @type {Object|undefined} */
	const cached = settingsCache.get( key );

	if ( cached && cached.expires > time ) {
		return cached.value;
	}

	/** @type {*} */
	const value = await load();

	settingsCache.set( key, { expires: time + SETTINGS_CACHE_SECONDS, value } );
	return value;
};

/** @returns {Promise<Object>} { enabled, maxDuration, notOlderThan, maxPageSize, availableFields } httpRequestsAdaptiveGroups zóny */
const getZoneLimits = function ( /** @type {String} */ token, /** @type {String} */ zone, /** @type {Number} */ time )
{
	return cachedValue( 'zone\n' + zone, time, async () => {

		/** @type {Object} */
		let result;

		try {
			result = await graphql( token, `query DdtReferrersZoneSettings {
				viewer { zones(filter: { zoneTag: ${ quote( zone ) } }) { settings {
					${ DATASETS.HTTP } { enabled maxDuration notOlderThan maxPageSize availableFields }
				} } }
			}` );
		} catch ( error ) {
			if ( error instanceof SectionError && error.code === ERRORS.GRAPHQL ) {
				throw new SectionError( ERRORS.ZONE_ACCESS, error.message );
			}
			throw error;
		}

		/** @type {Object|undefined} */
		const limits = result.data?.viewer?.zones?.[ 0 ]?.settings?.[ DATASETS.HTTP ];

		if ( !limits ) {
			throw new SectionError( ERRORS.ZONE_ACCESS, shortText( result.errors[ 0 ]?.message || 'Token nemá přístup k údajům zóny (oprávnění Zone → Analytics → Read pro tuto zónu).' ) );
		}
		return limits;
	} );
};

/** @returns {Promise<Object>} { enabled, maxDuration, notOlderThan, maxPageSize } rumPageloadEventsAdaptiveGroups účtu */
const getRumLimits = function ( /** @type {String} */ token, /** @type {String} */ account, /** @type {Number} */ time )
{
	return cachedValue( 'rum\n' + account, time, async () => {

		/** @type {Object} */
		const result = await graphql( token, `query DdtReferrersRumSettings {
			viewer { accounts(filter: { accountTag: ${ quote( account ) } }) { settings {
				${ DATASETS.RUM } { enabled maxDuration notOlderThan maxPageSize }
			} } }
		}` );

		/** @type {Object|undefined} */
		const limits = result.data?.viewer?.accounts?.[ 0 ]?.settings?.[ DATASETS.RUM ];

		if ( !limits ) {
			throw new SectionError( ERRORS.GRAPHQL, shortText( result.errors[ 0 ]?.message || 'Token nemá přístup k údajům účtu (oprávnění Account Analytics → Read).' ) );
		}
		return limits;
	} );
};

// -----------------------------------------------------------------------------------------------------------------------------
// HTTP požadavky zóny

/**
* Dotaz na odkazy jedné zóny. Části dotazu (aliasy): hosts (den × odkazující web), urls (celé adresy odkazů), pages (cílové
* stránky), totals (všechna zobrazení stránek po dnech, i bez odkazu). Bez pole clientRefererHost → SectionError FIELDS.
*
* @returns {Promise<Object>} { window, filters, result: { data, errors } }
*/
export const readZoneReferrers = async function ( /** @type {String} */ token, /** @type {Object} */ zone, /** @type {Number} */ time = now() )
{

	/** @type {Object} */
	const limits = await getZoneLimits( token, zone.id, time );

	if ( limits.enabled !== true ) {
		throw new SectionError( ERRORS.DISABLED, `Datová sada ${ DATASETS.HTTP } není v této zóně dostupná.` );
	}
	if ( !hasField( limits, HTTP_FIELDS.REFERER_HOST ) || !hasField( limits, HTTP_FIELDS.DATE ) ) {
		throw new SectionError( ERRORS.FIELDS, `Tarif zóny nedovolí pole ${ HTTP_FIELDS.REFERER_HOST } (odkazující web) v datové sadě ${ DATASETS.HTTP }.` );
	}

	/** @type {Object} */
	const window = dayWindow( limits, time );

	/** @type {Object} */
	const filters = {
		htmlOnly: hasField( limits, HTTP_FIELDS.CONTENT_TYPE ),
		eyeballOnly: hasField( limits, HTTP_FIELDS.SOURCE ),
		ownHostsOnly: hasField( limits, HTTP_FIELDS.HOST ) && zone.domains.length > 0,
	};

	/** @type {String[]} */
	const base = [ `datetime_geq: ${ quote( isoTime( window.start ) ) }`, `datetime_leq: ${ quote( isoTime( time ) ) }` ];

	if ( filters.htmlOnly ) {
		base.push( `${ HTTP_FIELDS.CONTENT_TYPE }: "html"` );
	}
	if ( filters.eyeballOnly ) {
		base.push( `${ HTTP_FIELDS.SOURCE }: "eyeball"` );
	}
	if ( filters.ownHostsOnly ) {
		base.push( `${ HTTP_FIELDS.HOST }_in: ${ JSON.stringify( zone.domains.map( normalizeHost ) ) }` );
	}

	/** @type {String} jen odkazy z jiných webů */
	const external = [ ...base, `${ HTTP_FIELDS.REFERER_HOST }_neq: ""`, `${ HTTP_FIELDS.REFERER_HOST }_notin: ${ JSON.stringify( ownHostsOf( zone.domains ) ) }` ].join( ', ' );

	/** @type {Number} */
	const pageSize = Math.max( 1, numberOf( limits.maxPageSize ) || HOSTS_LIMIT );

	/** @type {Object<String, String>} */
	const parts = {
		hosts: `${ DATASETS.HTTP }(limit: ${ Math.min( HOSTS_LIMIT, pageSize ) }, filter: { ${ external } }, orderBy: [count_DESC]) { count avg { sampleInterval } dimensions { ${ HTTP_FIELDS.DATE } ${ HTTP_FIELDS.REFERER_HOST } } }`,
		totals: `${ DATASETS.HTTP }(limit: ${ window.days + 2 }, filter: { ${ base.join( ', ' ) } }, orderBy: [${ HTTP_FIELDS.DATE }_ASC]) { count dimensions { ${ HTTP_FIELDS.DATE } } }`,
	};

	if ( hasField( limits, HTTP_FIELDS.REFERER ) ) {
		parts.urls = `${ DATASETS.HTTP }(limit: ${ Math.min( TOP_LIMIT, pageSize ) }, filter: { ${ external } }, orderBy: [count_DESC]) { count dimensions { ${ HTTP_FIELDS.REFERER } } }`;
	}
	if ( hasField( limits, HTTP_FIELDS.PATH ) ) {
		parts.pages = `${ DATASETS.HTTP }(limit: ${ Math.min( TOP_LIMIT, pageSize ) }, filter: { ${ external } }, orderBy: [count_DESC]) { count dimensions { ${ HTTP_FIELDS.PATH } } }`;
	}

	/** @type {Object} */
	const result = await graphql( token, `query DdtReferrersZone {
		viewer { zones(filter: { zoneTag: ${ quote( zone.id ) } }) {
			${ Object.entries( parts ).map( ( [ alias, part ] ) => `${ alias }: ${ part }` ).join( '\n' ) }
		} }
	}` );

	return { window, filters, result };
};

/** @returns {Object[]|Object} řádky aliasu, nebo { error } (chyba jen této části dotazu) */
const rowsOf = function ( /** @type {Object} */ result, /** @type {String} */ alias, /** @type {String} */ node = 'zones' )
{

	/** @type {Object|null} */
	const data = result?.data?.viewer?.[ node ]?.[ 0 ] ?? null;

	/** @type {Object[]} */
	const errors = Array.isArray( result?.errors ) ? result.errors : [];

	/** @type {Object|null} */
	const error = errors.find( ( /** @type {Object} */ item ) => Array.isArray( item?.path ) && item.path.includes( alias ) ) ?? ( !data && errors.length ? errors[ 0 ] : null );

	if ( error || !Array.isArray( data?.[ alias ] ) ) {
		return { error: { code: ERRORS.GRAPHQL, message: shortText( error?.message || 'GraphQL API nevrátilo data.' ) } };
	}
	return data[ alias ];
};

/** @returns {Object[]} nejčastější položky mapy klíč → počty, seřazené podle field */
const topOf = function ( /** @type {Map<String, Object>} */ map, /** @type {String} */ field, /** @type {Number} */ limit )
{
	return [ ...map.values() ].sort( ( a, b ) => b[ field ] - a[ field ] || String( Object.values( a )[ 0 ] ).localeCompare( String( Object.values( b )[ 0 ] ) ) ).slice( 0, limit );
};

/**
* Odpovědi zón → část http (součet zón). Vyčleněné kvůli testům.
*
* @returns {Object} { days, urls, pages, sampled, filters, failedZones } nebo { error }
*/
export const shapeHttp = function ( /** @type {Object[]} */ zones, /** @type {Object} */ window )
{

	/** @type {Object[]} */
	const ok = zones.filter( ( zone ) => !zone.report.error );

	if ( !ok.length ) {
		return { error: zones[ 0 ]?.report?.error ?? { code: ERRORS.NO_ZONE, message: 'Žádná zóna.' } };
	}

	/** @type {Map<String, Object>} den → { date, pageViews, fromLinks, hosts: Map } */
	const days = new Map( datesOf( window ).map( ( date ) => [ date, { date, pageViews: 0, fromLinks: 0, hosts: new Map() } ] ) );

	/** @type {Map<String, Object>} */
	const urls = new Map();

	/** @type {Map<String, Object>} */
	const pages = new Map();

	/** @type {Object} */
	const errors = {};

	/** @type {Boolean} */
	let sampled = false;

	for ( const zone of ok ) {
		const result = zone.report.result;
		const hosts = rowsOf( result, 'hosts' );
		if ( hosts.error ) {
			errors.hosts ??= hosts.error;
		} else {
			for ( const row of hosts ) {
				const day = days.get( stringOf( row?.dimensions?.[ HTTP_FIELDS.DATE ] ) );
				const host = normalizeHost( row?.dimensions?.[ HTTP_FIELDS.REFERER_HOST ] );
				if ( !day || host === '' ) {
					continue;
				}
				const count = numberOf( row?.count );
				sampled ||= numberOf( row?.avg?.sampleInterval ) > 1;
				day.fromLinks += count;
				const item = day.hosts.get( host ) ?? { host, requests: 0 };
				item.requests += count;
				day.hosts.set( host, item );
			}
		}
		const totals = rowsOf( result, 'totals' );
		if ( !totals.error ) {
			for ( const row of totals ) {
				const day = days.get( stringOf( row?.dimensions?.[ HTTP_FIELDS.DATE ] ) );
				if ( day ) {
					day.pageViews += numberOf( row?.count );
				}
			}
		}
		for ( const [ alias, field, map, key ] of [ [ 'urls', HTTP_FIELDS.REFERER, urls, 'url' ], [ 'pages', HTTP_FIELDS.PATH, pages, 'path' ] ] ) {
			if ( !zone.report.parts?.includes( alias ) ) {
				continue;
			}
			const rows = rowsOf( result, alias );
			if ( rows.error ) {
				errors[ alias ] ??= rows.error;
				continue;
			}
			for ( const row of rows ) {
				const value = shortText( row?.dimensions?.[ field ] );
				if ( value === '' ) {
					continue;
				}
				const item = map.get( value ) ?? { [ key ]: value, requests: 0 };
				item.requests += numberOf( row?.count );
				map.set( value, item );
			}
		}
	}
	if ( errors.hosts && ok.every( ( zone ) => rowsOf( zone.report.result, 'hosts' ).error ) ) {
		return { error: errors.hosts };
	}

	/** @type {Function} */
	const listOrError = ( /** @type {String} */ alias, /** @type {Map} */ map ) => {
		if ( !ok.some( ( zone ) => zone.report.parts?.includes( alias ) ) ) {
			return { error: { code: ERRORS.FIELDS, message: `Tarif zóny nedovolí pole pro tuto část (${ alias }).` } };
		}
		return errors[ alias ] && !map.size ? { error: errors[ alias ] } : { items: topOf( map, 'requests', TOP_LIMIT ) };
	};

	return {
		days: [ ...days.values() ].reverse().map( ( day ) => ( {
			date: day.date,
			pageViews: day.pageViews,
			fromLinks: day.fromLinks,
			hosts: topOf( day.hosts, 'requests', HOSTS_PER_DAY ),
		} ) ),
		urls: listOrError( 'urls', urls ),
		pages: listOrError( 'pages', pages ),
		sampled,
		filters: ok[ 0 ].report.filters,
		failedZones: zones.length - ok.length,
	};
};

// -----------------------------------------------------------------------------------------------------------------------------
// Web Analytics

/**
* Web Web Analytics pro vlastní domény projektu: podle zóny pravidla (ruleset.zone_tag) nebo hostitele pravidla
* (rules[].host). Vyčleněné kvůli testům.
*
* @returns {Object|null} { tag, host }
*/
export const findRumSite = function ( /** @type {*} */ sites, /** @type {String[]} */ zoneIds, /** @type {String[]} */ domains )
{

	/** @type {String[]} */
	const hosts = ownHostsOf( domains );

	for ( const site of Array.isArray( sites ) ? sites : [] ) {
		const tag = stringOf( site?.site_tag ).toLowerCase();
		if ( !TAG_PATTERN.test( tag ) ) {
			continue;
		}
		const ruleHosts = ( Array.isArray( site?.rules ) ? site.rules : [] ).map( ( rule ) => normalizeHost( rule?.host ) ).filter( Boolean );
		const zoneTag = stringOf( site?.ruleset?.zone_tag ).toLowerCase();
		const matchedHost = ruleHosts.find( ( host ) => hosts.includes( host ) );
		if ( matchedHost || ( zoneTag !== '' && zoneIds.includes( zoneTag ) ) ) {
			return { tag, host: matchedHost ?? ( stringOf( site?.ruleset?.zone_name ) || ruleHosts[ 0 ] || null ) };
		}
	}
	return null;
};

/** @returns {Promise<Object>} část webAnalytics odpovědi, nebo { error } */
export const readWebAnalytics = async function ( /** @type {String} */ token, /** @type {String} */ account, /** @type {Object[]} */ zones, /** @type {Number} */ time = now() )
{

	/** @type {String[]} */
	const domains = zones.flatMap( ( zone ) => zone.domains );

	/** @type {*} */
	const sites = await cachedValue( 'sites\n' + account, time, () => cloudflareApi( token, `/accounts/${ account }/rum/site_info/list?per_page=100` ) );

	/** @type {Object|null} */
	const site = findRumSite( sites, zones.map( ( zone ) => zone.id ), domains );

	if ( !site ) {
		throw new SectionError( ERRORS.NO_SITE, 'Web Analytics nemá web pro vlastní domény projektu (zapněte ho v Cloudflare: Analytics & Logs → Web Analytics).' );
	}

	/** @type {Object} */
	const limits = await getRumLimits( token, account, time );

	if ( limits.enabled !== true ) {
		throw new SectionError( ERRORS.DISABLED, `Datová sada ${ DATASETS.RUM } není na tomto účtu dostupná.` );
	}

	/** @type {Object} */
	const window = dayWindow( limits, time );

	/** @type {String} */
	const base = [ `siteTag: ${ quote( site.tag ) }`, `datetime_geq: ${ quote( isoTime( window.start ) ) }`, `datetime_leq: ${ quote( isoTime( time ) ) }`, 'bot: 0' ].join( ', ' );

	/** @type {String} */
	const external = `${ base }, refererHost_neq: "", refererHost_notin: ${ JSON.stringify( ownHostsOf( domains ) ) }`;

	/** @type {Number} */
	const pageSize = Math.max( 1, numberOf( limits.maxPageSize ) || HOSTS_LIMIT );

	/** @type {Object} */
	const result = await graphql( token, `query DdtReferrersRum {
		viewer { accounts(filter: { accountTag: ${ quote( account ) } }) {
			totals: ${ DATASETS.RUM }(limit: ${ window.days + 2 }, filter: { ${ base } }, orderBy: [date_ASC]) { count sum { visits } dimensions { date } }
			hosts: ${ DATASETS.RUM }(limit: ${ Math.min( HOSTS_LIMIT, pageSize ) }, filter: { ${ external } }, orderBy: [count_DESC]) { count sum { visits } avg { sampleInterval } dimensions { date refererHost } }
			urls: ${ DATASETS.RUM }(limit: ${ Math.min( TOP_LIMIT, pageSize ) }, filter: { ${ external } }, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { refererHost refererPath } }
			pages: ${ DATASETS.RUM }(limit: ${ Math.min( TOP_LIMIT, pageSize ) }, filter: { ${ base } }, orderBy: [count_DESC]) { count sum { visits } dimensions { requestPath } }
		} }
	}` );

	return shapeWebAnalytics( result, site, window );
};

/**
* Odpověď GraphQL Web Analytics → část webAnalytics. Vyčleněné kvůli testům.
*
* @returns {Object}
*/
export const shapeWebAnalytics = function ( /** @type {Object} */ result, /** @type {Object} */ site, /** @type {Object} */ window )
{

	/** @type {Object[]|Object} */
	const hosts = rowsOf( result, 'hosts', 'accounts' );

	/** @type {Object[]|Object} */
	const totals = rowsOf( result, 'totals', 'accounts' );

	if ( hosts.error && totals.error ) {
		return { error: hosts.error };
	}

	/** @type {Map<String, Object>} */
	const days = new Map( datesOf( window ).map( ( date ) => [ date, { date, visits: 0, pageViews: 0, fromLinks: 0, hosts: new Map() } ] ) );

	/** @type {Boolean} */
	let sampled = false;

	for ( const row of totals.error ? [] : totals ) {
		const day = days.get( stringOf( row?.dimensions?.date ) );
		if ( day ) {
			day.visits += numberOf( row?.sum?.visits );
			day.pageViews += numberOf( row?.count );
		}
	}
	for ( const row of hosts.error ? [] : hosts ) {
		const day = days.get( stringOf( row?.dimensions?.date ) );
		const host = normalizeHost( row?.dimensions?.refererHost );
		if ( !day || host === '' ) {
			continue;
		}
		sampled ||= numberOf( row?.avg?.sampleInterval ) > 1;
		const item = day.hosts.get( host ) ?? { host, visits: 0, pageViews: 0 };
		item.visits += numberOf( row?.sum?.visits );
		item.pageViews += numberOf( row?.count );
		day.fromLinks += numberOf( row?.sum?.visits );
		day.hosts.set( host, item );
	}

	/** @type {Object[]|Object} */
	const urls = rowsOf( result, 'urls', 'accounts' );

	/** @type {Object[]|Object} */
	const pages = rowsOf( result, 'pages', 'accounts' );

	return {
		site,
		window: { since: window.since, until: window.until, days: window.days }, // vlastní rozsah (tarif účtu, ne zóny)
		days: [ ...days.values() ].reverse().map( ( day ) => ( { date: day.date, visits: day.visits, pageViews: day.pageViews, fromLinks: day.fromLinks, hosts: topOf( day.hosts, 'visits', HOSTS_PER_DAY ) } ) ),
		hostsError: hosts.error ?? null,
		urls: urls.error ? urls : { items: urls.map( ( row ) => ( { host: normalizeHost( row?.dimensions?.refererHost ), path: shortText( row?.dimensions?.refererPath ), visits: numberOf( row?.sum?.visits ) } ) ).filter( ( item ) => item.host !== '' ) },
		pages: pages.error ? pages : { items: pages.map( ( row ) => ( { path: shortText( row?.dimensions?.requestPath ), visits: numberOf( row?.sum?.visits ), pageViews: numberOf( row?.count ) } ) ).filter( ( item ) => item.path !== '' ) },
		sampled,
	};
};

// -----------------------------------------------------------------------------------------------------------------------------

/** @type {Map<String, Object>} účet a projekt → { expires, cachedAt, cloudflare } */
const reportCache = new Map();

/**
* Celá odpověď pro stránku Analytická data (část „Zpětné odkazy“).
*
* @returns {Promise<Object>}
*/
export const buildReferrersReport = async function ( /** @type {Object} */ env, /** @type {Object} */ claims, /** @type {Number} */ time = now() )
{

	/** @type {String} */
	const token = String( env.DASHBOARD_API_TOKEN ?? '' ).trim();

	/** @type {Object} */
	const report = {
		version: 1,
		generatedAt: isoTime( time ),
		target: { account: claims.account, project: claims.project },
		settings: { apiToken: token !== '' },
	};

	if ( token === '' ) {
		report.cloudflare = { error: { code: ERRORS.TOKEN_MISSING, message: 'Chybí tajná proměnná DASHBOARD_API_TOKEN (API token jen pro čtení).' } };
		return report;
	}
	if ( claims.account === '' || claims.project === '' ) {
		report.cloudflare = { error: { code: ERRORS.NOT_CONFIGURED, message: 'WordPress nemá vyplněné ID účtu Cloudflare nebo název projektu Pages – zónu API hledá podle vlastních domén projektu.' } };
		return report;
	}

	/** @type {String} */
	const cacheKey = claims.account + '\n' + claims.project;

	/** @type {Object|undefined} */
	const cached = reportCache.get( cacheKey );

	if ( cached && cached.expires > time ) {
		report.cloudflare = { ...cached.cloudflare, cachedAt: cached.cachedAt };
		return report;
	}

	/** @type {Object} */
	const found = await section( async () => zonesFromDomains( await cloudflareApi( token, `/accounts/${ claims.account }/pages/projects/${ claims.project }/domains` ) ) );

	if ( found.error ) {
		report.cloudflare = { error: found.error };
		return report;
	}
	if ( !found.zones.length ) {
		report.cloudflare = { error: { code: ERRORS.NO_ZONE, message: 'Projekt nemá vlastní doménu v zóně Cloudflare.', domains: found.external } };
		return report;
	}

	const [ zoneReports, webAnalytics ] = await Promise.all( [
		Promise.all( found.zones.map( async ( zone ) => {
			const zoneReport = await section( async () => {
				const read = await readZoneReferrers( token, zone, time );
				return { ...read, parts: Object.keys( read.result.data?.viewer?.zones?.[ 0 ] ?? {} ) };
			} );
			return { ...zone, report: zoneReport };
		} ) ),
		section( () => readWebAnalytics( token, claims.account, found.zones, time ) ),
	] );

	/** @type {Object|undefined} rozsah první zóny, která odpověděla (zóny jednoho účtu mívají stejný tarif) */
	const window = zoneReports.find( ( zone ) => !zone.report.error )?.report.window ?? dayWindow( undefined, time );

	/** @type {Object} */
	const cloudflare = {
		zones: {
			items: zoneReports.map( ( zone ) => ( { id: zone.id, domains: zone.domains, error: zone.report.error ?? null } ) ),
			external: found.external,
			skipped: found.skipped,
		},
		window: { since: window.since, until: window.until, days: window.days },
		http: shapeHttp( zoneReports, window ),
		webAnalytics: webAnalytics.error ? { error: webAnalytics.error } : webAnalytics,
	};

	reportCache.set( cacheKey, { expires: time + CACHE_SECONDS, cachedAt: isoTime( time ), cloudflare } );
	report.cloudflare = cloudflare;
	return report;
};

/** Vyprázdní paměť instance (testy). */
export const clearReferrersCaches = function ()
{
	reportCache.clear();
	settingsCache.clear();
};

/**
* Pages Function pro /api/dashboard/referrers (functions/api/dashboard/referrers.js).
*/
export const handleReferrersRequest = function ( /** @type {EventContext} */ context )
{
	return handleRequest( context, buildReferrersReport );
};
