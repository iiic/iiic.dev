/**
* [2026-11-27] Testy API pro stránku Analytická data ve WordPressu – odkazující weby (functions/_lib/dashboard-referrers.js,
* trasa GET /api/dashboard/referrers): rozsah celých dnů podle tarifu, pole podle availableFields, vlastní domény se
* nepočítají, součty zón po dnech, Web Analytics (hledání webu, chybějící oprávnění) a paměť instance. REST a GraphQL
* API Cloudflare jsou podvržené přes fetch.
*
* Spouští ho .site-checks/check-site.php (kontrola „testy-api“). Ručně: cd .site-checks && node --test dashboard-referrers.test.mjs
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/.site-checks/), upravovat ho ve šabloně.
*/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ERRORS, isoTime, utcDayStart } from '../functions/_lib/dashboard.js';
import {
	HOSTS_PER_DAY,
	REFERRER_DAYS,
	buildReferrersReport,
	clearReferrersCaches,
	dayWindow,
	findRumSite,
	hasField,
	ownHostsOf,
	shapeHttp,
} from '../functions/_lib/dashboard-referrers.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const PROJECT = 'projekt';
const ZONE = 'a'.repeat( 32 );
const SITE = 'c'.repeat( 32 );
const TIME = utcDayStart( 1_800_000_000 ) + 10 * 3600; // 10:00 UTC
const DAY = 86400;
const originalFetch = globalThis.fetch;
const date = ( daysBack ) => isoTime( utcDayStart( TIME ) - daysBack * DAY ).slice( 0, 10 );
const CLAIMS = { account: ACCOUNT, project: PROJECT, database: '', repository: '' };

afterEach( () => {
	globalThis.fetch = originalFetch;
	clearReferrersCaches();
} );

const ok = ( result ) => new Response( JSON.stringify( { success: true, errors: [], result } ) );
const denied = () => new Response( JSON.stringify( { success: false, errors: [ { code: 10000, message: 'Authentication error' } ] } ), { status: 403 } );
const graphqlResponse = ( data, errors = null ) => new Response( JSON.stringify( { data, errors } ) );

test( 'rozsah celých dnů, pole podle tarifu a vlastní domény', () => {
	const wide = dayWindow( { maxDuration: 31 * DAY, notOlderThan: 31 * DAY }, TIME );
	assert.deepEqual( [ wide.since, wide.until, wide.days ], [ date( REFERRER_DAYS - 1 ), date( 0 ), REFERRER_DAYS ] );
	assert.equal( wide.start, utcDayStart( TIME ) - ( REFERRER_DAYS - 1 ) * DAY ); // nejstarší den celý

	const narrow = dayWindow( { maxDuration: 3 * DAY, notOlderThan: 8 * DAY }, TIME ); // 3 dny zpět od 10:00 → celé jen předevčírem a dál
	assert.deepEqual( [ narrow.since, narrow.days ], [ date( 2 ), 3 ] );
	assert.ok( TIME - narrow.start <= 3 * DAY );

	const tiny = dayWindow( { maxDuration: 3600, notOlderThan: 3600 }, TIME ); // ani celý dnešek
	assert.deepEqual( [ tiny.since, tiny.days, tiny.start ], [ date( 0 ), 1, TIME - 3600 ] );

	assert.equal( hasField( { availableFields: [] }, 'clientRefererHost' ), true ); // nevíme → zkusit
	assert.equal( hasField( { availableFields: [ 'dimensions.clientRefererHost' ] }, 'clientRefererHost' ), true );
	assert.equal( hasField( { availableFields: [ 'clientRequestPath' ] }, 'clientRefererHost' ), false );

	assert.deepEqual( ownHostsOf( [ 'Example.cz.', 'www.web.cz' ] ).sort(), [ 'example.cz', 'web.cz', 'www.example.cz', 'www.web.cz' ] );
} );

test( 'Web Analytics: web podle zóny nebo hostitele pravidla', () => {
	const sites = [
		{ site_tag: 'x'.repeat( 32 ) }, // neplatné ID
		{ site_tag: 'b'.repeat( 32 ), ruleset: { zone_tag: 'f'.repeat( 32 ) }, rules: [ { host: 'jiny.cz' } ] },
		{ site_tag: SITE, ruleset: { zone_tag: '', zone_name: '' }, rules: [ { host: 'WWW.Example.cz' } ] },
	];
	assert.deepEqual( findRumSite( sites, [ ZONE ], [ 'example.cz' ] ), { tag: SITE, host: 'www.example.cz' } );
	assert.deepEqual( findRumSite( [ { site_tag: SITE.toUpperCase(), ruleset: { zone_tag: ZONE, zone_name: 'example.cz' } } ], [ ZONE ], [] ), { tag: SITE, host: 'example.cz' } );
	assert.equal( findRumSite( sites, [ ZONE ], [ 'nic.cz' ] ), null );
} );

test( 'součty zón po dnech: dny bez odkazů s nulou, nejčastější weby, chyba části', () => {
	const window = { since: date( 2 ), until: date( 0 ), days: 3 };
	const zoneData = ( hosts, totals, urls ) => ( { data: { viewer: { zones: [ { hosts, totals, ...( urls ? { urls } : {} ) } ] } }, errors: [] } );
	const zones = [
		{ id: ZONE, domains: [ 'example.cz' ], report: { window, filters: { htmlOnly: true, eyeballOnly: true, ownHostsOnly: true }, parts: [ 'hosts', 'totals', 'urls' ], result: zoneData(
			[
				{ count: 5, avg: { sampleInterval: 1 }, dimensions: { date: date( 0 ), clientRefererHost: 'www.google.com' } },
				{ count: 2, avg: { sampleInterval: 10 }, dimensions: { date: date( 0 ), clientRefererHost: 'Seznam.cz' } },
				{ count: 1, avg: { sampleInterval: 1 }, dimensions: { date: date( 2 ), clientRefererHost: 'www.google.com' } },
				{ count: 9, dimensions: { date: date( 9 ), clientRefererHost: 'mimo.cz' } }, // mimo rozsah
				{ count: 4, dimensions: { date: date( 0 ), clientRefererHost: '' } },
			],
			[ { count: 40, dimensions: { date: date( 2 ) } }, { count: 70, dimensions: { date: date( 0 ) } } ],
			[ { count: 3, dimensions: { clientRequestReferer: 'https://www.google.com/' } } ],
		) } },
		{ id: 'b'.repeat( 32 ), domains: [ 'b.cz' ], report: { error: { code: ERRORS.ZONE_ACCESS, message: 'x' } } },
	];
	const http = shapeHttp( zones, window );
	assert.equal( http.failedZones, 1 );
	assert.equal( http.sampled, true );
	assert.deepEqual( http.days.map( ( day ) => [ day.date, day.pageViews, day.fromLinks ] ), [ [ date( 0 ), 70, 7 ], [ date( 1 ), 0, 0 ], [ date( 2 ), 40, 1 ] ] );
	assert.deepEqual( http.days[ 0 ].hosts, [ { host: 'www.google.com', requests: 5 }, { host: 'seznam.cz', requests: 2 } ] );
	assert.deepEqual( http.urls.items, [ { url: 'https://www.google.com/', requests: 3 } ] );
	assert.equal( http.pages.error.code, ERRORS.FIELDS ); // pole tarif nedovolil → část v dotazu nebyla

	const many = { ...zones[ 0 ], report: { ...zones[ 0 ].report, result: zoneData( Array.from( { length: HOSTS_PER_DAY + 5 }, ( _, index ) => ( { count: index + 1, dimensions: { date: date( 0 ), clientRefererHost: 'web' + index + '.cz' } } ) ), [] ) } };
	assert.equal( shapeHttp( [ many ], window ).days[ 0 ].hosts.length, HOSTS_PER_DAY );

	const broken = { ...zones[ 0 ], report: { ...zones[ 0 ].report, result: { data: { viewer: { zones: [ { totals: [] } ] } }, errors: [ { message: 'unknown field clientRefererHost', path: [ 'viewer', 'zones', 0, 'hosts' ] } ] } } };
	assert.equal( shapeHttp( [ broken ], window ).error.code, ERRORS.GRAPHQL );
} );

test( 's API tokenem: dotaz bez vlastních domén, Web Analytics bez oprávnění a paměť instance', async () => {
	const calls = [];
	const queries = [];
	globalThis.fetch = async ( input, init = {} ) => {
		const url = String( input );
		calls.push( url );
		assert.equal( new Headers( init.headers ).get( 'Authorization' ), 'Bearer token' );
		if ( url.endsWith( `/accounts/${ ACCOUNT }/pages/projects/${ PROJECT }/domains` ) ) {
			return ok( [ { name: 'example.cz', zone_tag: ZONE }, { name: 'jinde.net', zone_tag: '' } ] );
		}
		if ( url.includes( '/rum/site_info/list' ) ) {
			return denied();
		}
		if ( url.endsWith( '/graphql' ) ) {
			const query = JSON.parse( init.body ).query;
			queries.push( query );
			if ( query.includes( 'DdtReferrersZoneSettings' ) ) {
				return graphqlResponse( { viewer: { zones: [ { settings: { httpRequestsAdaptiveGroups: { enabled: true, maxDuration: 31 * DAY, notOlderThan: 31 * DAY, maxPageSize: 10000, availableFields: [ 'clientRefererHost', 'clientRequestReferer', 'date', 'clientRequestHTTPHost', 'requestSource' ] } } } ] } } );
			}
			if ( query.includes( 'DdtReferrersZone' ) ) {
				return graphqlResponse( { viewer: { zones: [ {
					hosts: [ { count: 3, avg: { sampleInterval: 1 }, dimensions: { date: date( 1 ), clientRefererHost: 'odkaz.cz' } } ],
					totals: [ { count: 12, dimensions: { date: date( 1 ) } } ],
					urls: [ { count: 3, dimensions: { clientRequestReferer: 'https://odkaz.cz/clanek' } } ],
				} ] } } );
			}
		}
		assert.fail( 'nečekaný požadavek ' + url );
	};

	const report = await buildReferrersReport( { DASHBOARD_API_TOKEN: 'token' }, CLAIMS, TIME );
	assert.deepEqual( report.settings, { apiToken: true } );
	const cloudflare = report.cloudflare;
	assert.deepEqual( cloudflare.zones.external, [ 'jinde.net' ] );
	assert.deepEqual( cloudflare.window, { since: date( REFERRER_DAYS - 1 ), until: date( 0 ), days: REFERRER_DAYS } );
	assert.equal( cloudflare.http.days.length, REFERRER_DAYS );
	assert.deepEqual( cloudflare.http.days[ 1 ], { date: date( 1 ), pageViews: 12, fromLinks: 3, hosts: [ { host: 'odkaz.cz', requests: 3 } ] } );
	assert.deepEqual( cloudflare.http.filters, { htmlOnly: false, eyeballOnly: true, ownHostsOnly: true } );
	assert.equal( cloudflare.http.pages.error.code, ERRORS.FIELDS );
	assert.equal( cloudflare.webAnalytics.error.code, ERRORS.CLOUDFLARE_API );
	assert.equal( cloudflare.webAnalytics.error.status, 403 );

	const zoneQuery = queries.find( ( query ) => query.includes( 'query DdtReferrersZone {' ) );
	assert.match( zoneQuery, /clientRefererHost_notin: \["example\.cz","www\.example\.cz"\]/ );
	assert.match( zoneQuery, /clientRequestHTTPHost_in: \["example\.cz"\]/ );
	assert.match( zoneQuery, /requestSource: "eyeball"/ );
	assert.doesNotMatch( zoneQuery, /edgeResponseContentTypeName/ ); // tarif pole nedovolil
	assert.doesNotMatch( zoneQuery, /pages:/ );

	const count = calls.length;
	const again = await buildReferrersReport( { DASHBOARD_API_TOKEN: 'token' }, CLAIMS, TIME + 10 );
	assert.equal( calls.length, count ); // paměť instance
	assert.ok( again.cloudflare.cachedAt );
} );

test( 's API tokenem: zóna bez pole odkazů, Web Analytics s webem', async () => {
	globalThis.fetch = async ( input, init = {} ) => {
		const url = String( input );
		if ( url.endsWith( '/domains' ) ) {
			return ok( [ { name: 'example.cz', zone_tag: ZONE } ] );
		}
		if ( url.includes( '/rum/site_info/list' ) ) {
			return ok( [ { site_tag: SITE, ruleset: { zone_tag: ZONE, zone_name: 'example.cz' } } ] );
		}
		const query = JSON.parse( init.body ).query;
		if ( query.includes( 'DdtReferrersZoneSettings' ) ) {
			return graphqlResponse( { viewer: { zones: [ { settings: { httpRequestsAdaptiveGroups: { enabled: true, maxDuration: DAY, notOlderThan: 3 * DAY, availableFields: [ 'date', 'clientRequestPath' ] } } } ] } } );
		}
		if ( query.includes( 'DdtReferrersRumSettings' ) ) {
			return graphqlResponse( { viewer: { accounts: [ { settings: { rumPageloadEventsAdaptiveGroups: { enabled: true, maxDuration: 31 * DAY, notOlderThan: 31 * DAY, maxPageSize: 10000 } } } ] } } );
		}
		if ( query.includes( 'DdtReferrersRum' ) ) {
			assert.match( query, new RegExp( `siteTag: "${ SITE }"` ) );
			assert.match( query, /bot: 0/ );
			return graphqlResponse( { viewer: { accounts: [ {
				totals: [ { count: 30, sum: { visits: 20 }, dimensions: { date: date( 0 ) } } ],
				hosts: [ { count: 4, sum: { visits: 3 }, avg: { sampleInterval: 1 }, dimensions: { date: date( 0 ), refererHost: 'Seznam.cz' } } ],
				urls: [ { sum: { visits: 3 }, dimensions: { refererHost: 'seznam.cz', refererPath: '/hledej' } } ],
				pages: [ { count: 25, sum: { visits: 18 }, dimensions: { requestPath: '/' } } ],
			} ] } } );
		}
		assert.fail( 'nečekaný dotaz ' + url );
	};

	const report = await buildReferrersReport( { DASHBOARD_API_TOKEN: 'token' }, CLAIMS, TIME );
	assert.equal( report.cloudflare.http.error.code, ERRORS.FIELDS );
	const rum = report.cloudflare.webAnalytics;
	assert.deepEqual( rum.site, { tag: SITE, host: 'example.cz' } );
	assert.equal( rum.window.days, REFERRER_DAYS );
	assert.deepEqual( rum.days[ 0 ], { date: date( 0 ), visits: 20, pageViews: 30, fromLinks: 3, hosts: [ { host: 'seznam.cz', visits: 3, pageViews: 4 } ] } );
	assert.deepEqual( rum.urls.items, [ { host: 'seznam.cz', path: '/hledej', visits: 3 } ] );
	assert.deepEqual( rum.pages.items, [ { path: '/', visits: 18, pageViews: 25 } ] );
	assert.equal( report.cloudflare.window.days, REFERRER_DAYS ); // zóna nevrátila rozsah → výchozí
} );

test( 'bez tokenu, bez účtu a bez zóny', async () => {
	globalThis.fetch = async () => assert.fail( 'bez tokenu se API nevolá' );
	assert.equal( ( await buildReferrersReport( {}, CLAIMS, TIME ) ).cloudflare.error.code, ERRORS.TOKEN_MISSING );
	assert.equal( ( await buildReferrersReport( { DASHBOARD_API_TOKEN: 'x' }, { ...CLAIMS, account: '' }, TIME ) ).cloudflare.error.code, ERRORS.NOT_CONFIGURED );
	globalThis.fetch = async () => ok( [ { name: 'web.pages.dev', zone_tag: '' } ] );
	const report = await buildReferrersReport( { DASHBOARD_API_TOKEN: 'x' }, CLAIMS, TIME );
	assert.equal( report.cloudflare.error.code, ERRORS.NO_ZONE );
} );
