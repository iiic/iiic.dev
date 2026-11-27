/**
* [2026-11-27] HTTP provoz zóny pro widget „Cloudflare – provoz zóny“ na nástěnce WordPressu (šablona domdocument-template:
* dashboard-widgets/cloudflare-provoz.php, js/modules/admin-dashboard-cloudflare.mjs). Trasa GET /api/dashboard/traffic je
* functions/api/dashboard/traffic.js, logika je tady (kvůli testům v .site-checks/dashboard-traffic.test.mjs). Token
* WordPressu, tajný API token DASHBOARD_API_TOKEN a CORS má společné s /api/dashboard (functions/_lib/dashboard.js).
*
* Zóna: API ji najde samo podle vlastních domén projektu Pages (zone_tag u domény – doména, jejíž DNS spravuje Cloudflare).
* Provoz na <projekt>.pages.dev Cloudflare jako provoz zóny nepočítá. Domény ve víc zónách = součet (nejvýš MAX_ZONES zón).
* Údaje o provozu platí pro celou zónu (všechny její subdomény), ne jen pro statický web.
*
* Odpověď (JSON, CORS pro všechny – bez cookies, bez platného tokenu nic nevydá):
*   settings    { apiToken } – jestli je nastavená tajná proměnná DASHBOARD_API_TOKEN
*   cloudflare  { zones, traffic, security }, nebo { error } (chybí token, účet, projekt, zóna…):
*     zones     zóny vlastních domén: ID, název, stav a tarif (REST /zones/{id} – oprávnění Zone → Zone → Read, nepovinné),
*               domény projektu v zóně; external = domény bez zóny na tomto účtu
*     traffic   přesné součty (ne vzorky) z httpRequests1dGroups a httpRequests1hGroups: požadavky, z toho z cache,
*               přenesená data, z toho z cache, zobrazení stránek –
*               days  posledních TRAFFIC_DAYS dní podle UTC (dnešek se ještě doplňuje), od nejnovějšího; [2026-11-27] jiný
*                     počet dní (1 až MAX_TRAFFIC_DAYS) parametrem ?days= – stránka Analytická data chce 30 dní do historie,
*               hours posledních SUMMARY_HOURS hodin (hodinové souhrny),
*     security  bezpečnostní události z firewallEventsAdaptive za posledních SECURITY_DAYS dní (nebo kolik dovolí tarif):
*               zablokované požadavky a výzvy k ověření podle akce a zdroje (pravidla WAF, kontrola prohlížeče…) – počet
*               a poslední výskyt. Pole threats z httpRequests1dGroups je v API zastaralé – náhradou jsou právě tyto události.
*               Na bezplatném tarifu jsou to vzorky (sampleInterval), počty jsou pak odhad.
* Část, která selže (chybí oprávnění, datovou sadu tarif nemá…), má místo dat { error: { code, message } }.
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

/** @type {Number} dní v tabulce provozu (dnešek a dny před ním) */
export const TRAFFIC_DAYS = 7;

/** @type {Number} [2026-11-27] nejvíc dní, které jde chtít parametrem ?days= (víc tarif zóny stejně nedovolí – httpRequests1dGroups) */
export const MAX_TRAFFIC_DAYS = 31;

/** @type {Number} hodin v souhrnu „posledních 24 hodin“ */
export const SUMMARY_HOURS = 24;

/** @type {Number} dní bezpečnostních událostí (tarif může dovolit méně – uzel settings GraphQL API) */
export const SECURITY_DAYS = 7;

/** @type {Number} nejvýš tolik nejnovějších událostí na zónu – při víc jsou počty „nejméně“ (údaje úplné jen od nejstarší vrácené) */
export const SECURITY_EVENTS_LIMIT = 1000;

/** @type {Number} zón (vlastní domény projektu ve víc zónách) */
export const MAX_ZONES = 5;

/** @type {Number} s – jak dlouho si instance funkce pamatuje odpověď (ochrana limitu 300 dotazů GraphQL za 5 minut) */
export const CACHE_SECONDS = 60;

/** @type {Number} s – jak dlouho si instance pamatuje, co tarif zóny u datových sad dovolí */
const SETTINGS_CACHE_SECONDS = 3600;

/** @type {Object<String, String>} datové sady GraphQL Analytics API (zóna) */
export const ZONE_DATASETS = Object.freeze( {
	DAYS: 'httpRequests1dGroups',
	HOURS: 'httpRequests1hGroups',
	SECURITY: 'firewallEventsAdaptive',
} );

/** @type {Object<String, String>} co bezpečnostní událost znamenala pro požadavek */
export const ACTION_KINDS = Object.freeze( {
	BLOCKED: 'blocked', // požadavek nedostal odpověď webu
	CHALLENGED: 'challenged', // návštěvník dostal výzvu k ověření (člověk ji může vyřešit)
	OTHER: 'other', // jen zaznamenáno, povoleno, přeskočeno, vyřešená výzva…
} );

/**
* Akce bezpečnostních událostí po normalizeCode(): GraphQL API je vrací v různém zápisu (managed_challenge, jschallenge,
* connectionClose…), dokumentace se liší – porovnává se proto bez velikosti písmen a oddělovačů.
*
* @type {String[]}
*/
const BLOCKED_ACTIONS = [ 'block', 'connectionclose', 'forceconnectionclose', 'challengefailed', 'jschallengefailed', 'managedchallengefailed' ];

/** @type {String[]} */
const CHALLENGED_ACTIONS = [ 'challenge', 'jschallenge', 'managedchallenge' ];

/** @type {RegExp} ID zóny (zone_tag) */
const ZONE_PATTERN = /^[0-9a-f]{32}$/;

/** @type {String} součty provozu v httpRequests1dGroups / httpRequests1hGroups */
const TRAFFIC_FIELDS = 'sum { requests cachedRequests bytes cachedBytes pageViews }';

/** @type {String[]} */
const TRAFFIC_KEYS = [ 'requests', 'cachedRequests', 'bytes', 'cachedBytes', 'pageViews' ];

/** @type {Function} */
const now = function ()
{
	return Math.floor( Date.now() / 1000 );
};

/** @returns {String} RRRR-MM-DD v UTC (typ Date v GraphQL API) */
const isoDate = function ( /** @type {Number} */ seconds )
{
	return isoTime( seconds ).slice( 0, 10 );
};

/** @returns {String} kód bez velikosti písmen a oddělovačů (managed_challenge → managedchallenge) */
export const normalizeCode = function ( /** @type {*} */ value )
{
	return String( value ?? '' ).toLowerCase().replace( /[^a-z0-9]/g, '' );
};

/** @returns {String} ACTION_KINDS podle akce bezpečnostní události */
export const actionKind = function ( /** @type {*} */ action )
{

	/** @type {String} */
	const key = normalizeCode( action );

	if ( BLOCKED_ACTIONS.includes( key ) ) {
		return ACTION_KINDS.BLOCKED;
	}
	return CHALLENGED_ACTIONS.includes( key ) ? ACTION_KINDS.CHALLENGED : ACTION_KINDS.OTHER;
};

/**
* Zóny vlastních domén projektu Pages (REST /accounts/{účet}/pages/projects/{projekt}/domains, pole zone_tag).
*
* @returns {Object} { zones: [{ id, domains }], external: [názvy domén bez zóny], skipped: zón nad MAX_ZONES }
*/
export const zonesFromDomains = function ( /** @type {*} */ domains )
{

	/** @type {Map<String, Object>} */
	const zones = new Map();

	/** @type {String[]} */
	const external = [];

	for ( const domain of Array.isArray( domains ) ? domains : [] ) {

		/** @type {String} */
		const name = stringOf( domain?.name );

		/** @type {String} */
		const zone = stringOf( domain?.zone_tag ).toLowerCase();

		if ( !ZONE_PATTERN.test( zone ) ) {
			if ( name !== '' ) {
				external.push( name );
			}
			continue;
		}

		/** @type {Object} */
		const item = zones.get( zone ) ?? { id: zone, domains: [] };

		if ( name !== '' ) {
			item.domains.push( name );
		}
		zones.set( zone, item );
	}

	/** @type {Object[]} */
	const list = [ ...zones.values() ];

	return { zones: list.slice( 0, MAX_ZONES ), external, skipped: Math.max( 0, list.length - MAX_ZONES ) };
};

/** @returns {Object} zóna z REST /zones/{id} zkrácená na to, co nástěnka ukazuje */
export const zoneSummary = function ( /** @type {*} */ zone )
{
	return {
		name: stringOf( zone?.name ) || null,
		status: stringOf( zone?.status ) || null, // active | pending | initializing | moved | deleted | deactivated
		paused: zone?.paused === true, // pozastavená zóna: provoz jde mimo Cloudflare (jen DNS)
		plan: stringOf( zone?.plan?.name ) || null, // Free Website, Pro Website…
	};
};

/**
* Rozsahy dotazů podle tarifu zóny (uzel settings): tabulka po dnech, souhrn za posledních 24 hodin a bezpečnostní události.
* Datová sada, kterou tarif nemá, rozsah nedostane.
*
* @returns {Object} { days: { since, until }, hours: { since, until }, security: { since, until, limit } }
*/
export const trafficWindows = function ( /** @type {Object} */ settings, /** @type {Number} */ time, /** @type {Number} */ days = TRAFFIC_DAYS )
{

	/** @type {Number} */
	const dayStart = utcDayStart( time );

	/** @type {Object} */
	const windows = {};

	if ( settings?.[ ZONE_DATASETS.DAYS ]?.enabled === true ) {

		/** @type {Number} */
		const earliest = time - reachOf( settings[ ZONE_DATASETS.DAYS ], days * 86400 );

		/** @type {Number} */
		let first = dayStart - ( days - 1 ) * 86400;

		while ( first < earliest && first < dayStart ) {
			first += 86400;
		}
		windows.days = { since: isoDate( first ), until: isoDate( dayStart ) };
	}
	if ( settings?.[ ZONE_DATASETS.HOURS ]?.enabled === true ) {

		/** @type {Number} */
		const hourStart = time - ( time % 3600 );

		/** @type {Number} */
		const earliest = time - reachOf( settings[ ZONE_DATASETS.HOURS ], SUMMARY_HOURS * 3600 );

		/** @type {Number} */
		let since = hourStart - ( SUMMARY_HOURS - 1 ) * 3600; // 23 celých hodin a rozpracovaná

		while ( since < earliest && since < hourStart ) {
			since += 3600;
		}
		windows.hours = { since: isoTime( since ), until: isoTime( time ) };
	}
	if ( settings?.[ ZONE_DATASETS.SECURITY ]?.enabled === true ) {

		/** @type {Object} */
		const limits = settings[ ZONE_DATASETS.SECURITY ];

		windows.security = {
			since: isoTime( time - reachOf( limits, SECURITY_DAYS * 86400 ) ),
			until: isoTime( time ),
			limit: Math.max( 1, Math.min( SECURITY_EVENTS_LIMIT, numberOf( limits.maxPageSize ) || SECURITY_EVENTS_LIMIT ) ),
		};
	}
	return windows;
};

/** @type {Map<String, Object>} ID zóny → { expires, settings } */
const zoneSettingsCache = new Map();

/** @returns {Promise<Object>} datová sada → { enabled, maxDuration, notOlderThan, maxPageSize } podle tarifu zóny */
const getZoneSettings = async function ( /** @type {String} */ token, /** @type {String} */ zone, /** @type {Number} */ time )
{

	/** @type {Object|undefined} */
	const cached = zoneSettingsCache.get( zone );

	if ( cached && cached.expires > time ) {
		return cached.settings;
	}

	/** @type {Object} */
	let result;

	try {
		result = await graphql( token, `query DdtDashboardZoneSettings {
			viewer { zones(filter: { zoneTag: ${ JSON.stringify( zone ) } }) { settings {
				${ Object.values( ZONE_DATASETS ).map( ( /** @type {String} */ name ) => `${ name } { enabled maxDuration notOlderThan maxPageSize }` ).join( '\n' ) }
			} } }
		}` );
	} catch ( error ) {
		if ( error instanceof SectionError && error.code === ERRORS.GRAPHQL ) { // bez dat = zóna, ke které token nemá přístup
			throw new SectionError( ERRORS.ZONE_ACCESS, error.message );
		}
		throw error;
	}

	/** @type {Object|undefined} */
	const settings = result.data?.viewer?.zones?.[ 0 ]?.settings;

	if ( !settings ) {
		throw new SectionError( ERRORS.ZONE_ACCESS, shortText( result.errors[ 0 ]?.message || 'Token nemá přístup k údajům zóny (oprávnění Zone → Analytics → Read pro tuto zónu).' ) );
	}
	zoneSettingsCache.set( zone, { expires: time + SETTINGS_CACHE_SECONDS, settings } );
	return settings;
};

/**
* Provoz a bezpečnostní události jedné zóny. Dotaz se skládá jen z datových sad, které tarif zóny dovolí.
*
* @returns {Promise<Object>} { settings, windows, result: { data, errors } }
*/
export const readZone = async function ( /** @type {String} */ token, /** @type {String} */ zone, /** @type {Number} */ time = now(), /** @type {Number} */ days = TRAFFIC_DAYS )
{

	/** @type {Object} */
	const settings = await getZoneSettings( token, zone, time );

	/** @type {Object} */
	const windows = trafficWindows( settings, time, days );

	/** @type {Object<String, String>} alias → část dotazu */
	const parts = {};

	if ( windows.days ) {
		parts.days = `${ ZONE_DATASETS.DAYS }(limit: ${ days + 2 }, filter: { date_geq: ${ JSON.stringify( windows.days.since ) }, date_leq: ${ JSON.stringify( windows.days.until ) } }, orderBy: [date_ASC]) { dimensions { date } ${ TRAFFIC_FIELDS } }`;
	}
	if ( windows.hours ) {
		parts.hours = `${ ZONE_DATASETS.HOURS }(limit: ${ SUMMARY_HOURS + 2 }, filter: { datetime_geq: ${ JSON.stringify( windows.hours.since ) }, datetime_leq: ${ JSON.stringify( windows.hours.until ) } }, orderBy: [datetime_ASC]) { dimensions { datetime } ${ TRAFFIC_FIELDS } }`;
	}
	if ( windows.security ) {
		parts.security = `${ ZONE_DATASETS.SECURITY }(limit: ${ windows.security.limit }, filter: { datetime_geq: ${ JSON.stringify( windows.security.since ) }, datetime_leq: ${ JSON.stringify( windows.security.until ) } }, orderBy: [datetime_DESC]) { action source datetime sampleInterval }`;
	}

	/** @type {Object} */
	let result = { data: null, errors: [] };

	if ( Object.keys( parts ).length ) {
		result = await graphql( token, `query DdtDashboardTraffic {
			viewer { zones(filter: { zoneTag: ${ JSON.stringify( zone ) } }) {
				${ Object.entries( parts ).map( ( [ alias, part ] ) => `${ alias }: ${ part }` ).join( '\n' ) }
			} }
		}` );
	}
	return { settings, windows, result };
};

/** @returns {Object} součty provozu (všechny nulové) */
const emptyTraffic = function ()
{
	return Object.fromEntries( TRAFFIC_KEYS.map( ( key ) => [ key, 0 ] ) );
};

/** @returns {Object} k součtům přičte řádek httpRequests1dGroups / httpRequests1hGroups */
const addTraffic = function ( /** @type {Object} */ sums, /** @type {*} */ row )
{
	for ( const key of TRAFFIC_KEYS ) {
		sums[ key ] += numberOf( row?.sum?.[ key ] );
	}
	return sums;
};

/**
* Odpovědi zón → { traffic, security } pro nástěnku (součet zón). Vyčleněné kvůli testům.
*
* @returns {Object}
*/
export const shapeTraffic = function ( /** @type {Object[]} */ zones, /** @type {Number} */ time, /** @type {Number} */ wantedDays = TRAFFIC_DAYS )
{

	/** @type {Function} řádky aliasu jedné zóny, nebo { error } */
	const partOf = ( /** @type {Object} */ zone, /** @type {String} */ alias, /** @type {String} */ dataset ) => {
		if ( zone.report?.error ) {
			return { error: zone.report.error };
		}
		if ( zone.report?.settings?.[ dataset ]?.enabled !== true ) {
			return { error: { code: ERRORS.DISABLED, message: `Datová sada ${ dataset } není v této zóně dostupná.` } };
		}

		/** @type {Object|null} */
		const node = zone.report.result?.data?.viewer?.zones?.[ 0 ] ?? null;

		/** @type {Object[]} */
		const errors = zone.report.result?.errors ?? [];

		/** @type {Object|null} */
		const error = errors.find( ( /** @type {Object} */ item ) => Array.isArray( item?.path ) && item.path.includes( alias ) ) ?? ( !node && errors.length ? errors[ 0 ] : null );

		if ( error || !Array.isArray( node?.[ alias ] ) ) {
			return { error: { code: node ? ERRORS.GRAPHQL : ERRORS.ZONE_ACCESS, message: shortText( error?.message || 'GraphQL API nevrátilo data.' ) } };
		}
		return { rows: node[ alias ], window: zone.report.windows[ alias ] };
	};

	/** @type {Function} části zón, které se povedly, nebo { error } první zóny, když se nepovedla žádná */
	const partsOf = ( /** @type {String} */ alias, /** @type {String} */ dataset ) => {

		/** @type {Object[]} */
		const parts = zones.map( ( zone ) => partOf( zone, alias, dataset ) );

		/** @type {Object[]} */
		const ok = parts.filter( ( part ) => !part.error );

		return ok.length ? { parts: ok, failed: parts.length - ok.length } : { error: parts[ 0 ]?.error ?? { code: ERRORS.NO_ZONE, message: 'Žádná zóna.' } };
	};

	/** @type {Function} nejpozdější začátek rozsahu (zóny s různým tarifem – počítá se jen to, co mají všechny) */
	const latestSince = ( /** @type {Object[]} */ parts ) => parts.map( ( part ) => part.window.since ).sort().at( -1 );

	/** @type {Object} */
	const traffic = {};

	// Po dnech (od nejnovějšího, dny bez provozu s nulami)
	{
		const { parts, failed, error } = partsOf( 'days', ZONE_DATASETS.DAYS );

		if ( error ) {
			traffic.days = { error };
		} else {

			/** @type {String} */
			const since = latestSince( parts );

			/** @type {String} */
			const until = isoDate( utcDayStart( time ) );

			/** @type {Map<String, Object>} */
			const days = new Map();

			for ( let day = Date.parse( since + 'T00:00:00Z' ) / 1000; isoDate( day ) <= until; day += 86400 ) {
				days.set( isoDate( day ), { date: isoDate( day ), ...emptyTraffic() } );
			}
			for ( const part of parts ) {
				for ( const row of part.rows ) {

					/** @type {Object|undefined} */
					const day = days.get( stringOf( row?.dimensions?.date ) );

					if ( day ) {
						addTraffic( day, row );
					}
				}
			}

			/** @type {Object[]} */
			const items = [ ...days.values() ].reverse();

			traffic.days = {
				since,
				until,
				wanted: wantedDays,
				items,
				total: items.reduce( ( sums, item ) => addTraffic( sums, { sum: item } ), emptyTraffic() ),
				failedZones: failed,
			};
		}
	}

	// Posledních 24 hodin
	{
		const { parts, failed, error } = partsOf( 'hours', ZONE_DATASETS.HOURS );

		if ( error ) {
			traffic.hours = { error };
		} else {

			/** @type {String} */
			const since = latestSince( parts );

			/** @type {Object} */
			const sums = emptyTraffic();

			for ( const part of parts ) {
				for ( const row of part.rows ) {
					if ( stringOf( row?.dimensions?.datetime ) >= since ) {
						addTraffic( sums, row );
					}
				}
			}
			traffic.hours = { since, until: isoTime( time ), hours: SUMMARY_HOURS, ...sums, failedZones: failed };
		}
	}

	// Bezpečnostní události: zablokované a výzvy podle akce a zdroje
	/** @type {Object} */
	let security;

	{
		const { parts, failed, error } = partsOf( 'security', ZONE_DATASETS.SECURITY );

		if ( error ) {
			security = { error };
		} else {

			/** @type {String} */
			const since = latestSince( parts );

			/** @type {String} od kdy jsou události úplné (zóna s víc událostmi než limit vrátí jen nejnovější) */
			let completeSince = since;

			/** @type {Boolean} */
			let truncated = false;

			/** @type {Object[]} */
			const events = [];

			for ( const part of parts ) {
				if ( part.rows.length >= part.window.limit ) {
					truncated = true;

					/** @type {String} */
					const oldest = part.rows.map( ( row ) => stringOf( row?.datetime ) ).filter( Boolean ).sort()[ 0 ] ?? since;

					completeSince = oldest > completeSince ? oldest : completeSince;
				}
				events.push( ...part.rows.filter( ( row ) => stringOf( row?.datetime ) >= since ) );
			}

			/** @type {String} */
			const daySince = isoTime( time - 86400 );

			/** @type {Object} */
			const totals = { [ ACTION_KINDS.BLOCKED ]: 0, [ ACTION_KINDS.CHALLENGED ]: 0, [ ACTION_KINDS.OTHER ]: 0 };

			/** @type {Object} */
			const lastDay = { [ ACTION_KINDS.BLOCKED ]: 0, [ ACTION_KINDS.CHALLENGED ]: 0 };

			/** @type {Map<String, Object>} */
			const items = new Map();

			/** @type {Boolean} */
			let sampled = false;

			for ( const event of events ) {

				/** @type {Number} kolik událostí vzorek zastupuje */
				const weight = Math.max( 1, numberOf( event?.sampleInterval ) );

				/** @type {String} */
				const kind = actionKind( event?.action );

				/** @type {String} */
				const datetime = stringOf( event?.datetime );

				sampled ||= weight > 1;
				totals[ kind ] += weight;
				if ( kind === ACTION_KINDS.OTHER ) {
					continue;
				}
				if ( datetime >= daySince ) {
					lastDay[ kind ] += weight;
				}

				/** @type {String} */
				const key = [ kind, normalizeCode( event?.action ), normalizeCode( event?.source ) ].join( '\n' );

				/** @type {Object} */
				const item = items.get( key ) ?? { kind, action: shortText( event?.action ), source: shortText( event?.source ), count: 0, last: null };

				item.count += weight;
				if ( datetime !== '' && ( item.last === null || datetime > item.last ) ) {
					item.last = datetime;
				}
				items.set( key, item );
			}
			security = {
				since,
				until: isoTime( time ),
				days: SECURITY_DAYS,
				sampled,
				truncated,
				completeSince,
				blocked: totals[ ACTION_KINDS.BLOCKED ],
				challenged: totals[ ACTION_KINDS.CHALLENGED ],
				other: totals[ ACTION_KINDS.OTHER ],
				lastDay: { // posledních 24 hodin (souhrn widgetu); complete = rozsah i limit událostí pokrývají celých 24 hodin
					since: daySince,
					...lastDay,
					complete: since <= daySince && completeSince <= daySince,
				},
				items: [ ...items.values() ].sort( ( a, b ) => String( b.last ?? '' ).localeCompare( String( a.last ?? '' ) ) || b.count - a.count ),
				failedZones: failed,
			};
		}
	}
	return { traffic, security };
};

// -----------------------------------------------------------------------------------------------------------------------------
// Odpověď

/** @type {Map<String, Object>} účet a projekt → { expires, cachedAt, cloudflare } */
const reportCache = new Map();

/** @returns {Number} [2026-11-27] počet dní tabulky po dnech z parametru ?days= (1 až MAX_TRAFFIC_DAYS), jinak TRAFFIC_DAYS */
export const daysFrom = function ( /** @type {URL|undefined} */ url )
{

	/** @type {Number} */
	const days = Number.parseInt( url?.searchParams?.get( 'days' ) ?? '', 10 );

	return Number.isInteger( days ) ? Math.min( MAX_TRAFFIC_DAYS, Math.max( 1, days ) ) : TRAFFIC_DAYS;
};

/**
* Celá odpověď pro widget „Cloudflare – provoz zóny“ a [2026-11-27] stránku Analytická data (ta chce ?days=30).
*
* @returns {Promise<Object>}
*/
export const buildTrafficReport = async function ( /** @type {Object} */ env, /** @type {Object} */ claims, /** @type {Number} */ time = now(), /** @type {URL|undefined} */ url = undefined )
{

	/** @type {Number} */
	const days = daysFrom( url );

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
	const cacheKey = claims.account + '\n' + claims.project + '\n' + days;

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

	/** @type {Object[]} */
	const zones = await Promise.all( found.zones.map( async ( zone ) => {
		const [ details, zoneReport ] = await Promise.all( [
			section( async () => zoneSummary( await cloudflareApi( token, `/zones/${ zone.id }` ) ) ),
			section( () => readZone( token, zone.id, time, days ) ),
		] );

		return { ...zone, details, report: zoneReport };
	} ) );

	const { traffic, security } = shapeTraffic( zones, time, days );

	/** @type {Object} */
	const cloudflare = {
		zones: {
			items: zones.map( ( zone ) => ( {
				id: zone.id,
				domains: zone.domains,
				...( zone.details.error ? { name: null, status: null, paused: false, plan: null, detailsError: zone.details.error } : zone.details ),
				error: zone.report.error ?? null, // zóna, ke které token nemá přístup (údaje o provozu chybí)
			} ) ),
			external: found.external,
			skipped: found.skipped,
		},
		traffic,
		security,
	};

	reportCache.set( cacheKey, { expires: time + CACHE_SECONDS, cachedAt: isoTime( time ), cloudflare } );
	report.cloudflare = cloudflare;
	return report;
};

/** Vyprázdní paměť instance (testy). */
export const clearTrafficCaches = function ()
{
	reportCache.clear();
	zoneSettingsCache.clear();
};

/**
* Pages Function pro /api/dashboard/traffic (functions/api/dashboard/traffic.js).
*/
export const handleTrafficRequest = function ( /** @type {EventContext} */ context )
{
	return handleRequest( context, buildTrafficReport );
};
