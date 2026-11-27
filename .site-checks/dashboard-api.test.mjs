/**
* [2026-11-27] Testy API pro nástěnku WordPressu (functions/_lib/dashboard.js, trasa GET /api/dashboard): ověření tokenu
* WordPressu, CORS, odpověď bez API tokenu (jen nastavení a databáze) a s API tokenem (REST a GraphQL API Cloudflare
* podvržené přes fetch) včetně chyb jednotlivých částí. Stejný token podepisuje WordPress
* (\FUNCTIONS\ANALYTICS\createToken(), do 27. 11. 2026 \FUNCTIONS\DASHBOARD\createCloudflareToken()).
*
* Spouští ho .site-checks/check-site.php (kontrola „testy-api“). Ručně: cd .site-checks && node --test dashboard-api.test.mjs
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/.site-checks/), upravovat ho ve šabloně.
*/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
	DATASETS,
	ERRORS,
	HttpError,
	KEY_STATES,
	TOKEN_SCOPE,
	buildReport,
	clearCaches,
	handleDashboardRequest,
	isoTime,
	shapeAnalytics,
	utcDayStart,
	verifyWordpressToken,
} from '../functions/_lib/dashboard.js';
import { toBase64Url } from '../functions/_lib/webauthn.js';

const ORIGIN = 'https://projekt.pages.dev';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const PROJECT = 'projekt';
const DATABASE = '01234567-89ab-cdef-0123-456789abcdef';
const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;

afterEach( () => {
	globalThis.fetch = originalFetch;
	clearCaches();
} );

const keyPair = async () => {
	const keys = await crypto.subtle.generateKey( { name: 'Ed25519' }, true, [ 'sign', 'verify' ] );
	return { privateKey: keys.privateKey, publicKey: toBase64Url( await crypto.subtle.exportKey( 'raw', keys.publicKey ) ) };
};

const sign = async ( privateKey, claims, header = { alg: 'EdDSA', typ: 'JWT' } ) => {
	const encode = ( object ) => toBase64Url( encoder.encode( JSON.stringify( object ) ) );
	const input = encode( header ) + '.' + encode( claims );
	return input + '.' + toBase64Url( await crypto.subtle.sign( { name: 'Ed25519' }, privateKey, encoder.encode( input ) ) );
};

const claimsAt = ( time, extra = {} ) => ( { iss: 'http://localhost', aud: ORIGIN, scope: TOKEN_SCOPE, sub: '1', iat: time, exp: time + 300, account: ACCOUNT, project: PROJECT, database: DATABASE, ...extra } );

const fakeDatabase = ( { failing = false } = {} ) => {
	const statement = ( sql ) => ( {
		sql,
		bind () {
			return this;
		},
		async first () {
			if ( sql.includes( 'd1_migrations' ) ) {
				return { name: '0001_ddt_auth.sql', applied_at: '2026-11-25 10:11:12' };
			}
			return null;
		},
	} );
	return {
		prepare: statement,
		async batch ( statements ) {
			if ( failing ) {
				throw new Error( 'D1_ERROR: no such table: users' );
			}
			return statements.map( ( item, index ) => ( { results: [ { count: [ 3, 5, 2 ][ index ] } ], meta: { size_after: 61440 } } ) );
		},
	};
};

test( 'token WordPressu: platný, podvržený, cizí klíč, jiný příjemce, účel, platnost a hodnoty', async () => {
	const { privateKey, publicKey } = await keyPair();
	const other = await keyPair();
	const time = 1_800_000_000;
	const token = await sign( privateKey, claimsAt( time ) );
	assert.deepEqual( await verifyWordpressToken( token, publicKey, ORIGIN, time ), { account: ACCOUNT, project: PROJECT, database: DATABASE, repository: '', subject: '1', issuer: 'http://localhost' } ); // [2026-11-27] repository: starší token ho nemá
	const rejects = async ( promise, code, status = 401 ) => assert.rejects( promise, ( error ) => error instanceof HttpError && error.code === code && error.status === status );
	const [ header, payload, signature ] = token.split( '.' );
	await rejects( verifyWordpressToken( header + '.' + toBase64Url( encoder.encode( JSON.stringify( claimsAt( time, { account: 'f'.repeat( 32 ) } ) ) ) ) + '.' + signature, publicKey, ORIGIN, time ), ERRORS.INVALID_TOKEN );
	await rejects( verifyWordpressToken( token, other.publicKey, ORIGIN, time ), ERRORS.INVALID_TOKEN );
	await rejects( verifyWordpressToken( token, publicKey, 'https://jiny.pages.dev', time ), ERRORS.INVALID_TOKEN );
	await rejects( verifyWordpressToken( await sign( privateKey, claimsAt( time, { scope: 'jiny' } ) ), publicKey, ORIGIN, time ), ERRORS.INVALID_TOKEN );
	await rejects( verifyWordpressToken( await sign( privateKey, claimsAt( time, { alg: 'none' } ), { alg: 'none' } ), publicKey, ORIGIN, time ), ERRORS.INVALID_TOKEN );
	await rejects( verifyWordpressToken( token, publicKey, ORIGIN, time + 300 + 61 ), ERRORS.EXPIRED_TOKEN );
	await verifyWordpressToken( token, publicKey, ORIGIN, time + 300 + 59 ); // rezerva na hodiny
	await rejects( verifyWordpressToken( token, publicKey, ORIGIN, time - 61 ), ERRORS.INVALID_TOKEN ); // vydaný v budoucnosti
	await rejects( verifyWordpressToken( await sign( privateKey, claimsAt( time, { exp: time + 3600 } ) ), publicKey, ORIGIN, time ), ERRORS.INVALID_TOKEN ); // příliš dlouhá platnost
	await rejects( verifyWordpressToken( await sign( privateKey, claimsAt( time, { project: 'Neplatný projekt' } ) ), publicKey, ORIGIN, time ), ERRORS.INVALID_TOKEN );
	await rejects( verifyWordpressToken( 'a.b', publicKey, ORIGIN, time ), ERRORS.INVALID_TOKEN );
	await rejects( verifyWordpressToken( token, '', ORIGIN, time ), ERRORS.SERVER_MISCONFIGURED, 500 );
	await rejects( verifyWordpressToken( token, 'neplatny-klic', ORIGIN, time ), ERRORS.SERVER_MISCONFIGURED, 500 );
	assert.equal( ( await verifyWordpressToken( await sign( privateKey, claimsAt( time, { account: '', database: '' } ) ), publicKey, ORIGIN, time ) ).account, '' ); // bez účtu: jen nastavení a databáze
	assert.equal( payload.length > 0, true );
} );

test( 'trasa: CORS, metody, chybějící a neplatný token, odpověď bez API tokenu', async () => {
	const { privateKey, publicKey } = await keyPair();
	const env = { WORDPRESS_PUBLIC_KEY: publicKey, DB: fakeDatabase(), ALLOWED_ORIGINS: 'http://localhost, https://example.cz', RP_ID: 'example.cz' };
	const call = ( method, headers = {} ) => handleDashboardRequest( { request: new Request( ORIGIN + '/api/dashboard', { method, headers } ), env } );

	const preflight = await call( 'OPTIONS', { Origin: 'http://localhost', 'Access-Control-Request-Headers': 'authorization' } );
	assert.equal( preflight.status, 204 );
	assert.equal( preflight.headers.get( 'Access-Control-Allow-Origin' ), '*' );
	assert.match( preflight.headers.get( 'Access-Control-Allow-Headers' ), /Authorization/ );

	const post = await call( 'POST' );
	assert.equal( post.status, 405 );
	assert.equal( ( await post.json() ).error, ERRORS.METHOD_NOT_ALLOWED );

	const anonymous = await call( 'GET' );
	assert.equal( anonymous.status, 401 );
	assert.equal( anonymous.headers.get( 'Access-Control-Allow-Origin' ), '*' ); // chybu přečte i modul nástěnky
	assert.equal( ( await anonymous.json() ).error, ERRORS.UNAUTHENTICATED );

	const forged = await call( 'GET', { Authorization: 'Bearer ' + await sign( ( await keyPair() ).privateKey, claimsAt( Math.floor( Date.now() / 1000 ) ) ) } );
	assert.equal( forged.status, 401 );
	assert.equal( ( await forged.json() ).error, ERRORS.INVALID_TOKEN );

	globalThis.fetch = async () => assert.fail( 'bez DASHBOARD_API_TOKEN se API Cloudflare nevolá' );
	const response = await call( 'GET', { Authorization: 'Bearer ' + await sign( privateKey, claimsAt( Math.floor( Date.now() / 1000 ) ) ) } );
	assert.equal( response.status, 200 );
	assert.equal( response.headers.get( 'Access-Control-Allow-Origin' ), '*' );
	assert.equal( response.headers.get( 'Cache-Control' ), 'no-store' );
	const report = await response.json();
	assert.deepEqual( report.settings, { database: true, ssoPrivateKey: KEY_STATES.MISSING, ssoMessage: report.settings.ssoMessage, allowedOrigins: [ 'http://localhost', 'https://example.cz' ], rpId: 'example.cz', rpName: null, apiToken: false } );
	assert.match( report.settings.ssoMessage, /SSO_PRIVATE_KEY/ );
	assert.deepEqual( report.database, { sizeBytes: 61440, users: 3, credentials: 5, sessions: 2, lastMigration: { name: '0001_ddt_auth.sql', appliedAt: '2026-11-25 10:11:12' } } );
	assert.equal( report.cloudflare.error.code, ERRORS.TOKEN_MISSING );
	assert.deepEqual( report.target, { account: ACCOUNT, project: PROJECT, database: DATABASE } );
	assert.equal( JSON.stringify( report ).includes( publicKey ), false ); // klíče ani tajné hodnoty odpověď neobsahuje

	const missingKey = await handleDashboardRequest( { request: new Request( ORIGIN + '/api/dashboard', { headers: { Authorization: 'Bearer a.b.c' } } ), env: {} } );
	assert.equal( missingKey.status, 500 );
	assert.equal( ( await missingKey.json() ).error, ERRORS.SERVER_MISCONFIGURED );
} );

test( 'databáze: chybějící vazba a chyba dotazu', async () => {
	const report = await buildReport( {}, { account: '', project: '', database: '' } );
	assert.equal( report.database.error.code, ERRORS.NOT_CONFIGURED );
	assert.equal( report.settings.database, false );
	const failing = await buildReport( { DB: fakeDatabase( { failing: true } ) }, { account: '', project: '', database: '' } );
	assert.equal( failing.database.error.code, ERRORS.DATABASE );
	assert.match( failing.database.error.message, /no such table/ );
} );

const SETTINGS = Object.fromEntries( Object.values( DATASETS ).map( ( name ) => [ name, { enabled: true, maxDuration: 2_678_400, notOlderThan: 2_678_400 } ] ) );

const deployment = ( id, status, commit, environment = 'production', created = '2026-11-27T10:00:00Z' ) => ( {
	id, short_id: id.slice( 0, 8 ), url: `https://${ id.slice( 0, 8 ) }.projekt.pages.dev`, environment, created_on: created, is_skipped: false,
	latest_stage: { name: 'deploy', status, ended_on: created },
	deployment_trigger: { type: 'ad_hoc', metadata: { branch: 'main', commit_hash: commit, commit_message: 'Export webu\n\nPodrobnosti', commit_dirty: false } },
} );

const graphqlData = {
	pagesToday: [ { sum: { requests: 1200, errors: 3 }, dimensions: { scriptName: 'pages-worker--1' } } ],
	workersToday: [ { sum: { requests: 300, errors: 0 }, dimensions: { scriptName: 'jiny-worker' } } ],
	d1Today: [
		{ sum: { rowsRead: 5000, rowsWritten: 40, readQueries: 900, writeQueries: 20 }, dimensions: { databaseId: DATABASE } },
		{ sum: { rowsRead: 100, rowsWritten: 1, readQueries: 10, writeQueries: 1 }, dimensions: { databaseId: 'ffffffff-89ab-cdef-0123-456789abcdef' } },
	],
	d1Storage: [ { max: { databaseSizeBytes: 61440 }, dimensions: { databaseId: DATABASE } }, { max: { databaseSizeBytes: 4096 }, dimensions: { databaseId: 'ffffffff-89ab-cdef-0123-456789abcdef' } } ],
	pagesErrorCounts: [
		{ sum: { requests: 2 }, dimensions: { status: 'scriptThrewException', scriptName: 'pages-worker--1' } },
		{ sum: { requests: 1 }, dimensions: { status: 'exceededResources', scriptName: 'pages-worker--1' } },
	],
	pagesErrorLast: [
		{ sum: { requests: 1 }, dimensions: { status: 'exceededResources', scriptName: 'pages-worker--1', datetimeMinute: '2026-11-27T09:30:00Z' } },
		{ sum: { requests: 1 }, dimensions: { status: 'scriptThrewException', scriptName: 'pages-worker--1', datetimeMinute: '2026-11-27T08:15:00Z' } },
		{ sum: { requests: 1 }, dimensions: { status: 'scriptThrewException', scriptName: 'pages-worker--1', datetimeMinute: '2026-11-26T08:15:00Z' } },
	],
	d1ErrorCounts: [ { count: 4, dimensions: { error: 'D1_ERROR: no such table: foo' } } ],
	d1ErrorLast: [ { count: 1, dimensions: { error: 'D1_ERROR: no such table: foo', datetimeMinute: '2026-11-25T12:00:00Z' } } ],
};

test( 's API tokenem: projekt, domény, nasazení, čerpání a chyby; paměť instance', async () => {
	const { privateKey, publicKey } = await keyPair();
	const requests = [];
	globalThis.fetch = async ( url, options = {} ) => {
		requests.push( { url: String( url ), options } );
		assert.equal( options.headers.Authorization, 'Bearer tajny-token' );
		const path = String( url ).replace( 'https://api.cloudflare.com/client/v4', '' );
		const ok = ( result ) => new Response( JSON.stringify( { success: true, errors: [], result } ), { headers: { 'Content-Type': 'application/json' } } );
		if ( path === `/accounts/${ ACCOUNT }/pages/projects/${ PROJECT }` ) {
			return ok( { name: PROJECT, subdomain: 'projekt.pages.dev', production_branch: 'main', created_on: '2026-11-25T00:00:00Z', domains: [ 'projekt.pages.dev', 'example.cz' ], canonical_deployment: deployment( 'aaaaaaaa-1', 'success', 'a'.repeat( 40 ) ), latest_deployment: deployment( 'bbbbbbbb-2', 'failure', 'b'.repeat( 40 ) ) } );
		}
		if ( path.endsWith( '/domains' ) ) {
			return ok( [ { name: 'example.cz', status: 'pending', verification_data: { status: 'pending', error_message: 'CNAME record not set' } } ] );
		}
		if ( path.includes( '/deployments?per_page=' ) ) {
			return ok( [ deployment( 'bbbbbbbb-2', 'failure', 'b'.repeat( 40 ) ), deployment( 'aaaaaaaa-1', 'success', 'a'.repeat( 40 ) ), deployment( 'cccccccc-3', 'success', 'c'.repeat( 40 ), 'preview' ) ] );
		}
		if ( path === '/graphql' ) {
			const query = JSON.parse( options.body ).query;
			if ( query.includes( 'DdtDashboardSettings' ) ) {
				return new Response( JSON.stringify( { data: { viewer: { accounts: [ { settings: SETTINGS } ] } }, errors: null } ) );
			}
			assert.match( query, new RegExp( `accountTag: "${ ACCOUNT }"` ) );
			assert.match( query, /status_neq: "success"/ );
			assert.match( query, new RegExp( `databaseId: "${ DATABASE }"` ) );
			return new Response( JSON.stringify( { data: { viewer: { accounts: [ graphqlData ] } }, errors: null } ) );
		}
		return new Response( JSON.stringify( { success: false, errors: [ { code: 7003, message: 'No route' } ] } ), { status: 404 } );
	};
	const env = { WORDPRESS_PUBLIC_KEY: publicKey, DB: fakeDatabase(), DASHBOARD_API_TOKEN: 'tajny-token' };
	const call = async () => handleDashboardRequest( { request: new Request( ORIGIN + '/api/dashboard', { headers: { Authorization: 'Bearer ' + await sign( privateKey, claimsAt( Math.floor( Date.now() / 1000 ) ) ) } } ), env } );
	const report = await ( await call() ).json();

	assert.equal( report.settings.apiToken, true );
	assert.equal( JSON.stringify( report ).includes( 'tajny-token' ), false );
	const { project, domains, deployments, usage, errors } = report.cloudflare;
	assert.equal( project.productionBranch, 'main' );
	assert.equal( project.canonical.commitHash, 'a'.repeat( 40 ) );
	assert.equal( project.canonical.commitMessage, 'Export webu' ); // jen první řádek
	assert.equal( project.latest.status, 'failure' );
	assert.deepEqual( domains.items, [ { name: 'example.cz', status: 'pending', error: 'CNAME record not set' } ] );
	assert.deepEqual( deployments.items.map( ( item ) => [ item.shortId, item.environment, item.status ] ), [ [ 'bbbbbbbb', 'production', 'failure' ], [ 'aaaaaaaa', 'production', 'success' ], [ 'cccccccc', 'preview', 'success' ] ] );
	assert.equal( usage.pagesFunctions.requests, 1200 );
	assert.equal( usage.workers.requests, 300 );
	assert.deepEqual( usage.d1.database, { rowsRead: 5000, rowsWritten: 40, readQueries: 900, writeQueries: 20 } );
	assert.equal( usage.d1.rowsRead, 5100 ); // limit bezplatného tarifu je na účet
	assert.deepEqual( usage.d1Storage, { accountBytes: 65536, databaseBytes: 61440, databases: 2 } );
	assert.equal( usage.dayStart, isoTime( utcDayStart( Math.floor( Date.now() / 1000 ) ) ) );
	assert.equal( errors.pagesFunctions.total, 3 );
	assert.deepEqual( errors.pagesFunctions.items.map( ( item ) => [ item.status, item.count, item.last ] ), [ [ 'exceededResources', 1, '2026-11-27T09:30:00Z' ], [ 'scriptThrewException', 2, '2026-11-27T08:15:00Z' ] ] );
	assert.deepEqual( errors.d1.items, [ { error: 'D1_ERROR: no such table: foo', count: 4, last: '2026-11-25T12:00:00Z' } ] );

	const count = requests.length;
	const again = await ( await call() ).json();
	assert.equal( requests.length, count ); // druhý dotaz do minuty z paměti instance
	assert.ok( again.cloudflare.cachedAt );
} );

test( 's API tokenem: chybějící oprávnění a nedostupná datová sada nezastaví ostatní části', async () => {
	globalThis.fetch = async ( url, options = {} ) => {
		const path = String( url ).replace( 'https://api.cloudflare.com/client/v4', '' );
		if ( path === '/graphql' ) {
			const query = JSON.parse( options.body ).query;
			if ( query.includes( 'DdtDashboardSettings' ) ) {
				return new Response( JSON.stringify( { data: { viewer: { accounts: [ { settings: { ...SETTINGS, [ DATASETS.WORKERS ]: { enabled: false, maxDuration: 0, notOlderThan: 0 } } } ] } } } ) );
			}
			assert.equal( query.includes( DATASETS.WORKERS ), false ); // nedostupná sada se do dotazu nedává
			return new Response( JSON.stringify( { data: { viewer: { accounts: [ { ...graphqlData, d1Today: null } ] } }, errors: [ { message: 'not authorized for that account', path: [ 'viewer', 'accounts', 0, 'd1Today' ] } ] } ) );
		}
		return new Response( JSON.stringify( { success: false, errors: [ { code: 10000, message: 'Authentication error' } ] } ), { status: 403 } );
	};
	const report = await buildReport( { DB: fakeDatabase(), DASHBOARD_API_TOKEN: 'x' }, { account: ACCOUNT, project: PROJECT, database: DATABASE } );
	assert.deepEqual( report.cloudflare.project.error, { code: ERRORS.CLOUDFLARE_API, message: 'Authentication error', status: 403, cloudflareCode: 10000 } );
	assert.equal( report.cloudflare.deployments.error.code, ERRORS.CLOUDFLARE_API );
	assert.equal( report.cloudflare.usage.workers.error.code, ERRORS.DISABLED );
	assert.equal( report.cloudflare.usage.d1.error.code, ERRORS.GRAPHQL );
	assert.match( report.cloudflare.usage.d1.error.message, /not authorized/ );
	assert.equal( report.cloudflare.usage.pagesFunctions.requests, 1200 );
	assert.equal( report.database.users, 3 );
} );

test( 'čerpání: bez chyb, bez databáze a omezený rozsah tarifu', () => {
	const time = utcDayStart( 1_800_000_000 ) + 3600;
	const settings = { ...SETTINGS, [ DATASETS.PAGES ]: { enabled: true, maxDuration: 86400, notOlderThan: 259200 } };
	const shaped = shapeAnalytics( { data: { viewer: { accounts: [ { ...graphqlData, pagesErrorCounts: [], pagesErrorLast: [] } ] } }, errors: [] }, {
		settings, claims: { account: ACCOUNT, project: PROJECT, database: '' }, time, dayStart: utcDayStart( time ), errorSince: { pages: time - 86400 },
	} );
	assert.deepEqual( shaped.errors.pagesFunctions, { since: isoTime( time - 86400 ), total: 0, items: [] } );
	assert.equal( shaped.errors.d1.error.code, ERRORS.NOT_CONFIGURED );
	assert.equal( shaped.usage.d1.database, null );
	assert.equal( shaped.usage.d1Storage.databaseBytes, null );
} );
