/**
* [2026-11-27] Testy API pro widget „Cloudflare – provoz zóny“ na nástěnce WordPressu (functions/_lib/dashboard-traffic.js,
* trasa GET /api/dashboard/traffic): CORS a token (společné s /api/dashboard), zóny podle vlastních domén projektu,
* rozsahy podle tarifu zóny, součty provozu po dnech a za 24 hodin, třídění bezpečnostních událostí (zablokováno, výzva,
* ostatní; vzorky, limit událostí) a chyby jednotlivých zón. REST a GraphQL API Cloudflare jsou podvržené přes fetch.
*
* Spouští ho .site-checks/check-site.php (kontrola „testy-api“). Ručně: cd .site-checks && node --test dashboard-traffic.test.mjs
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/.site-checks/), upravovat ho ve šabloně.
*/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ERRORS, TOKEN_SCOPE, isoTime, utcDayStart } from '../functions/_lib/dashboard.js';
import {
	ACTION_KINDS,
	SECURITY_EVENTS_LIMIT,
	ZONE_DATASETS,
	actionKind,
	buildTrafficReport,
	clearTrafficCaches,
	handleTrafficRequest,
	shapeTraffic,
	trafficWindows,
	zonesFromDomains,
	daysFrom,
	MAX_TRAFFIC_DAYS,
	TRAFFIC_DAYS,
} from '../functions/_lib/dashboard-traffic.js';
import { toBase64Url } from '../functions/_lib/webauthn.js';

const ORIGIN = 'https://projekt.pages.dev';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const PROJECT = 'projekt';
const ZONE_A = 'a'.repeat( 32 );
const ZONE_B = 'b'.repeat( 32 );
const TIME = utcDayStart( 1_800_000_000 ) + 10 * 3600 + 1234; // 10:20:34 UTC
const DAY = 86400;
const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
const date = ( daysBack ) => isoTime( utcDayStart( TIME ) - daysBack * DAY ).slice( 0, 10 );
const hour = ( hoursBack ) => isoTime( TIME - ( TIME % 3600 ) - hoursBack * 3600 );

afterEach( () => {
	globalThis.fetch = originalFetch;
	clearTrafficCaches();
} );

const SETTINGS = Object.fromEntries( Object.values( ZONE_DATASETS ).map( ( name ) => [ name, { enabled: true, maxDuration: 2_678_400, notOlderThan: 2_678_400, maxPageSize: 10000 } ] ) );

const ok = ( result ) => new Response( JSON.stringify( { success: true, errors: [], result } ), { headers: { 'Content-Type': 'application/json' } } );
const denied = () => new Response( JSON.stringify( { success: false, errors: [ { code: 10000, message: 'Authentication error' } ] } ), { status: 403 } );
const graphqlResponse = ( data, errors = null ) => new Response( JSON.stringify( { data, errors } ) );
const traffic = ( requests, cachedRequests, bytes, cachedBytes, pageViews ) => ( { requests, cachedRequests, bytes, cachedBytes, pageViews } );

test( 'trasa: CORS, token a odpověď bez API tokenu', async () => {
	const keys = await crypto.subtle.generateKey( { name: 'Ed25519' }, true, [ 'sign', 'verify' ] );
	const publicKey = toBase64Url( await crypto.subtle.exportKey( 'raw', keys.publicKey ) );
	const time = Math.floor( Date.now() / 1000 );
	const encode = ( object ) => toBase64Url( encoder.encode( JSON.stringify( object ) ) );
	const input = encode( { alg: 'EdDSA', typ: 'JWT' } ) + '.' + encode( { iss: 'http://localhost', aud: ORIGIN, scope: TOKEN_SCOPE, sub: '1', iat: time, exp: time + 300, account: ACCOUNT, project: PROJECT, database: '' } );
	const token = input + '.' + toBase64Url( await crypto.subtle.sign( { name: 'Ed25519' }, keys.privateKey, encoder.encode( input ) ) );
	const call = ( method, headers = {}, env = { WORDPRESS_PUBLIC_KEY: publicKey } ) => handleTrafficRequest( { request: new Request( ORIGIN + '/api/dashboard/traffic', { method, headers } ), env } );

	const preflight = await call( 'OPTIONS' );
	assert.equal( preflight.status, 204 );
	assert.equal( preflight.headers.get( 'Access-Control-Allow-Origin' ), '*' );
	assert.equal( ( await call( 'DELETE' ) ).status, 405 );
	const anonymous = await call( 'GET' );
	assert.equal( anonymous.status, 401 );
	assert.equal( ( await anonymous.json() ).error, ERRORS.UNAUTHENTICATED );

	globalThis.fetch = async () => assert.fail( 'bez DASHBOARD_API_TOKEN se API Cloudflare nevolá' );
	const response = await call( 'GET', { Authorization: 'Bearer ' + token } );
	assert.equal( response.status, 200 );
	assert.equal( response.headers.get( 'Cache-Control' ), 'no-store' );
	const report = await response.json();
	assert.deepEqual( report.settings, { apiToken: false } );
	assert.deepEqual( report.target, { account: ACCOUNT, project: PROJECT } );
	assert.equal( report.cloudflare.error.code, ERRORS.TOKEN_MISSING );

	const notConfigured = await buildTrafficReport( { DASHBOARD_API_TOKEN: 'x' }, { account: '', project: PROJECT, database: '' }, TIME );
	assert.equal( notConfigured.cloudflare.error.code, ERRORS.NOT_CONFIGURED );
} );

test( 'zóny podle vlastních domén a třídění akcí bezpečnostních událostí', () => {
	assert.deepEqual( zonesFromDomains( [
		{ name: 'example.cz', zone_tag: ZONE_A.toUpperCase() },
		{ name: 'www.example.cz', zone_tag: ZONE_A },
		{ name: 'web.jinde.cz', zone_tag: '' },
		{ name: 'example.com', zone_tag: ZONE_B },
	] ), { zones: [ { id: ZONE_A, domains: [ 'example.cz', 'www.example.cz' ] }, { id: ZONE_B, domains: [ 'example.com' ] } ], external: [ 'web.jinde.cz' ], skipped: 0 } );
	assert.equal( zonesFromDomains( Array.from( { length: 7 }, ( item, index ) => ( { name: `d${ index }.cz`, zone_tag: String( index ).repeat( 32 ) } ) ) ).skipped, 2 );
	assert.deepEqual( zonesFromDomains( null ), { zones: [], external: [], skipped: 0 } );

	for ( const action of [ 'block', 'connection_close', 'connectionClose', 'challenge_failed', 'jschallengeFailed' ] ) {
		assert.equal( actionKind( action ), ACTION_KINDS.BLOCKED, action );
	}
	for ( const action of [ 'managed_challenge', 'managedChallenge', 'jschallenge', 'js_challenge', 'challenge' ] ) {
		assert.equal( actionKind( action ), ACTION_KINDS.CHALLENGED, action );
	}
	for ( const action of [ 'log', 'allow', 'skip', 'bypass', 'challenge_solved', 'managed_challenge_interactive_solved', 'managedChallengeBypassed', '', undefined ] ) {
		assert.equal( actionKind( action ), ACTION_KINDS.OTHER, String( action ) );
	}
} );

test( '[2026-11-27] počet dní z parametru ?days= (stránka Analytická data chce 30)', () => {
	assert.equal( daysFrom( undefined ), TRAFFIC_DAYS );
	assert.equal( daysFrom( new URL( ORIGIN + '/api/dashboard/traffic' ) ), TRAFFIC_DAYS );
	assert.equal( daysFrom( new URL( ORIGIN + '/api/dashboard/traffic?days=30' ) ), 30 );
	assert.equal( daysFrom( new URL( ORIGIN + '/api/dashboard/traffic?days=999' ) ), MAX_TRAFFIC_DAYS );
	assert.equal( daysFrom( new URL( ORIGIN + '/api/dashboard/traffic?days=0' ) ), 1 );
	assert.equal( daysFrom( new URL( ORIGIN + '/api/dashboard/traffic?days=abc' ) ), TRAFFIC_DAYS );
	const windows = trafficWindows( SETTINGS, TIME, 30 );
	assert.equal( windows.days.since, date( 29 ) );
} );

test( 'rozsahy podle tarifu zóny', () => {
	const full = trafficWindows( SETTINGS, TIME );
	assert.deepEqual( full.days, { since: date( 6 ), until: date( 0 ) } );
	assert.deepEqual( full.hours, { since: hour( 23 ), until: isoTime( TIME ) } );
	assert.deepEqual( full.security, { since: isoTime( TIME - 7 * DAY ), until: isoTime( TIME ), limit: SECURITY_EVENTS_LIMIT } );

	const limited = trafficWindows( {
		[ ZONE_DATASETS.DAYS ]: { enabled: true, maxDuration: 2_678_400, notOlderThan: 3 * DAY },
		[ ZONE_DATASETS.HOURS ]: { enabled: true, maxDuration: 6 * 3600, notOlderThan: 3 * DAY },
		[ ZONE_DATASETS.SECURITY ]: { enabled: true, maxDuration: DAY, notOlderThan: 2_678_400, maxPageSize: 100 },
	}, TIME );
	assert.deepEqual( limited.days, { since: date( 2 ), until: date( 0 ) } ); // dny, které celé leží v posledních 3 dnech
	assert.equal( limited.hours.since, hour( 5 ) );
	assert.deepEqual( limited.security, { since: isoTime( TIME - DAY ), until: isoTime( TIME ), limit: 100 } );

	assert.deepEqual( trafficWindows( { ...SETTINGS, [ ZONE_DATASETS.SECURITY ]: { enabled: false, maxDuration: 0, notOlderThan: 0, maxPageSize: 0 } }, TIME ).security, undefined );
} );

const zoneAData = {
	days: [
		{ dimensions: { date: date( 6 ) }, sum: traffic( 100, 40, 1_000_000, 300_000, 20 ) },
		{ dimensions: { date: date( 1 ) }, sum: traffic( 200, 100, 2_000_000, 1_000_000, 50 ) },
		{ dimensions: { date: date( 0 ) }, sum: traffic( 50, 10, 500_000, 100_000, 5 ) },
	],
	hours: [
		{ dimensions: { datetime: hour( 23 ) }, sum: traffic( 30, 10, 300_000, 100_000, 3 ) },
		{ dimensions: { datetime: hour( 0 ) }, sum: traffic( 20, 0, 200_000, 0, 2 ) },
	],
	security: [ // od nejnovější
		{ action: 'managed_challenge', source: 'securitylevel', datetime: isoTime( TIME - 600 ), sampleInterval: 1 },
		{ action: 'block', source: 'bic', datetime: isoTime( TIME - 3600 ), sampleInterval: 10 },
		{ action: 'log', source: 'firewallManaged', datetime: isoTime( TIME - 4000 ), sampleInterval: 1 },
		{ action: 'block', source: 'bic', datetime: isoTime( TIME - 2 * DAY ), sampleInterval: 1 },
		{ action: 'block', source: 'firewallCustom', datetime: isoTime( TIME - 3 * DAY ), sampleInterval: 1 },
	],
};

test( 's API tokenem: dvě zóny (jedna bez přístupu), součty, události a paměť instance', async () => {
	const requests = [];
	globalThis.fetch = async ( url, options = {} ) => {
		const path = String( url ).replace( 'https://api.cloudflare.com/client/v4', '' );
		requests.push( path );
		assert.equal( options.headers.Authorization, 'Bearer tajny-token' );
		if ( path === `/accounts/${ ACCOUNT }/pages/projects/${ PROJECT }/domains` ) {
			return ok( [ { name: 'example.cz', status: 'active', zone_tag: ZONE_A }, { name: 'www.example.cz', status: 'active', zone_tag: ZONE_A }, { name: 'cizi.cz', status: 'active', zone_tag: ZONE_B }, { name: 'web.jinde.cz', status: 'active' } ] );
		}
		if ( path === `/zones/${ ZONE_A }` ) {
			return ok( { name: 'example.cz', status: 'active', paused: false, plan: { name: 'Free Website' } } );
		}
		if ( path === `/zones/${ ZONE_B }` ) {
			return denied();
		}
		if ( path === '/graphql' ) {
			const query = JSON.parse( options.body ).query;
			if ( query.includes( ZONE_B ) ) {
				return graphqlResponse( null, [ { message: 'zone \'' + ZONE_B + '\' does not have access to the path' } ] );
			}
			if ( query.includes( 'DdtDashboardZoneSettings' ) ) {
				return graphqlResponse( { viewer: { zones: [ { settings: SETTINGS } ] } } );
			}
			assert.match( query, new RegExp( `date_geq: "${ date( 6 ) }", date_leq: "${ date( 0 ) }"` ) );
			assert.match( query, /orderBy: \[datetime_DESC\]\) \{ action source datetime sampleInterval \}/ );
			return graphqlResponse( { viewer: { zones: [ zoneAData ] } } );
		}
		return new Response( JSON.stringify( { success: false, errors: [ { code: 7003, message: 'No route' } ] } ), { status: 404 } );
	};
	const env = { DASHBOARD_API_TOKEN: 'tajny-token' };
	const claims = { account: ACCOUNT, project: PROJECT, database: '' };
	const report = await buildTrafficReport( env, claims, TIME );
	assert.equal( JSON.stringify( report ).includes( 'tajny-token' ), false );

	const { zones, traffic: shaped, security } = report.cloudflare;
	assert.deepEqual( zones.external, [ 'web.jinde.cz' ] );
	assert.deepEqual( zones.items[ 0 ], { id: ZONE_A, domains: [ 'example.cz', 'www.example.cz' ], name: 'example.cz', status: 'active', paused: false, plan: 'Free Website', error: null } );
	assert.equal( zones.items[ 1 ].name, null );
	assert.equal( zones.items[ 1 ].detailsError.status, 403 );
	assert.equal( zones.items[ 1 ].error.code, ERRORS.ZONE_ACCESS );
	assert.match( zones.items[ 1 ].error.message, /does not have access/ );

	assert.equal( shaped.days.since, date( 6 ) );
	assert.equal( shaped.days.failedZones, 1 );
	assert.deepEqual( shaped.days.items.map( ( item ) => [ item.date, item.requests ] ), [ [ date( 0 ), 50 ], [ date( 1 ), 200 ], [ date( 2 ), 0 ], [ date( 3 ), 0 ], [ date( 4 ), 0 ], [ date( 5 ), 0 ], [ date( 6 ), 100 ] ] ); // od nejnovějšího, dny bez provozu s nulou
	assert.deepEqual( shaped.days.total, traffic( 350, 150, 3_500_000, 1_400_000, 75 ) );
	assert.deepEqual( { ...shaped.hours, since: undefined, until: undefined }, { since: undefined, until: undefined, hours: 24, ...traffic( 50, 10, 500_000, 100_000, 5 ), failedZones: 1 } );

	assert.equal( security.sampled, true );
	assert.equal( security.truncated, false );
	assert.equal( security.blocked, 12 ); // vzorek s sampleInterval 10 zastupuje 10 událostí
	assert.equal( security.challenged, 1 );
	assert.equal( security.other, 1 );
	assert.deepEqual( security.lastDay, { since: isoTime( TIME - DAY ), blocked: 10, challenged: 1, complete: true } );
	assert.deepEqual( security.items.map( ( item ) => [ item.kind, item.action, item.source, item.count, item.last ] ), [
		[ ACTION_KINDS.CHALLENGED, 'managed_challenge', 'securitylevel', 1, isoTime( TIME - 600 ) ],
		[ ACTION_KINDS.BLOCKED, 'block', 'bic', 11, isoTime( TIME - 3600 ) ],
		[ ACTION_KINDS.BLOCKED, 'block', 'firewallCustom', 1, isoTime( TIME - 3 * DAY ) ],
	] );

	const count = requests.length;
	const again = await buildTrafficReport( env, claims, TIME + 30 );
	assert.equal( requests.length, count ); // do minuty z paměti instance
	assert.equal( again.cloudflare.cachedAt, isoTime( TIME ) );
} );

test( 's API tokenem: projekt bez zóny a chyba REST API', async () => {
	globalThis.fetch = async ( url ) => String( url ).endsWith( '/domains' ) ? ok( [ { name: 'web.jinde.cz', status: 'active', zone_tag: '' } ] ) : assert.fail( 'bez zóny se dál nic nevolá' );
	const report = await buildTrafficReport( { DASHBOARD_API_TOKEN: 'x' }, { account: ACCOUNT, project: PROJECT, database: '' }, TIME );
	assert.deepEqual( report.cloudflare.error, { code: ERRORS.NO_ZONE, message: report.cloudflare.error.message, domains: [ 'web.jinde.cz' ] } );

	clearTrafficCaches();
	globalThis.fetch = async () => denied();
	const failed = await buildTrafficReport( { DASHBOARD_API_TOKEN: 'x' }, { account: ACCOUNT, project: PROJECT, database: '' }, TIME );
	assert.deepEqual( failed.cloudflare.error, { code: ERRORS.CLOUDFLARE_API, message: 'Authentication error', status: 403, cloudflareCode: 10000 } );
} );

test( 'události: limit (počty „nejméně“), nedostupná datová sada a chyba části dotazu', () => {
	const limit = 3;
	const windows = { ...trafficWindows( SETTINGS, TIME ), security: { since: isoTime( TIME - 7 * DAY ), until: isoTime( TIME ), limit } };
	const zone = ( data, settings = SETTINGS, errors = [] ) => ( { id: ZONE_A, domains: [], details: {}, report: { settings, windows, result: { data: { viewer: { zones: [ data ] } }, errors } } } );
	const truncated = shapeTraffic( [ zone( { ...zoneAData, security: zoneAData.security.slice( 0, limit ) } ) ], TIME );
	assert.equal( truncated.security.truncated, true );
	assert.equal( truncated.security.completeSince, isoTime( TIME - 4000 ) ); // nejstarší vrácená událost
	assert.equal( truncated.security.lastDay.complete, false );

	const disabled = shapeTraffic( [ zone( { days: zoneAData.days }, { ...SETTINGS, [ ZONE_DATASETS.HOURS ]: { enabled: false }, [ ZONE_DATASETS.SECURITY ]: { enabled: false } } ) ], TIME );
	assert.equal( disabled.traffic.hours.error.code, ERRORS.DISABLED );
	assert.equal( disabled.security.error.code, ERRORS.DISABLED );
	assert.equal( disabled.traffic.days.total.requests, 350 );

	const partial = shapeTraffic( [ zone( { ...zoneAData, security: null }, SETTINGS, [ { message: 'not authorized for firewallEventsAdaptive', path: [ 'viewer', 'zones', 0, 'security' ] } ] ) ], TIME );
	assert.equal( partial.security.error.code, ERRORS.GRAPHQL );
	assert.match( partial.security.error.message, /not authorized/ );
	assert.equal( partial.traffic.hours.requests, 50 );

	const empty = shapeTraffic( [ zone( { days: [], hours: [], security: [] } ) ], TIME );
	assert.deepEqual( { blocked: empty.security.blocked, challenged: empty.security.challenged, items: empty.security.items, sampled: empty.security.sampled }, { blocked: 0, challenged: 0, items: [], sampled: false } );
	assert.equal( empty.traffic.days.items.length, 7 );
	assert.equal( empty.traffic.hours.requests, 0 );
} );
