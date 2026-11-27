/**
* [2026-11-27] Testy API pro stránku Analytická data ve WordPressu – provoz repozitáře na GitHubu
* (functions/_lib/dashboard-github.js, trasa GET /api/dashboard/github): token WordPressu s repozitářem, hlavičky pro
* GitHub, dny bez návštěv s nulou, chyby jednotlivých částí a paměť instance. API GitHubu je podvržené přes fetch.
*
* Spouští ho .site-checks/check-site.php (kontrola „testy-api“). Ručně: cd .site-checks && node --test dashboard-github.test.mjs
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/.site-checks/), upravovat ho ve šabloně.
*/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ERRORS, TOKEN_SCOPE, isoTime, utcDayStart } from '../functions/_lib/dashboard.js';
import { API_VERSION, TRAFFIC_DAYS, buildGithubReport, clearGithubCaches, dailySummary, githubWindow, handleGithubRequest } from '../functions/_lib/dashboard-github.js';
import { toBase64Url } from '../functions/_lib/webauthn.js';

const ORIGIN = 'https://projekt.pages.dev';
const REPOSITORY = 'uzivatel/web.cz';
const TIME = utcDayStart( 1_800_000_000 ) + 15 * 3600;
const DAY = 86400;
const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
const date = ( daysBack ) => isoTime( utcDayStart( TIME ) - daysBack * DAY ).slice( 0, 10 );
const CLAIMS = { account: '', project: 'projekt', database: '', repository: REPOSITORY };
const json = ( data, status = 200 ) => new Response( JSON.stringify( data ), { status } );

afterEach( () => {
	globalThis.fetch = originalFetch;
	clearGithubCaches();
} );

test( 'trasa: repozitář z tokenu WordPressu, neplatný repozitář odmítne', async () => {
	const keys = await crypto.subtle.generateKey( { name: 'Ed25519' }, true, [ 'sign', 'verify' ] );
	const publicKey = toBase64Url( await crypto.subtle.exportKey( 'raw', keys.publicKey ) );
	const time = Math.floor( Date.now() / 1000 );
	const encode = ( object ) => toBase64Url( encoder.encode( JSON.stringify( object ) ) );
	const tokenFor = async ( repository ) => {
		const input = encode( { alg: 'EdDSA', typ: 'JWT' } ) + '.' + encode( { iss: 'http://localhost', aud: ORIGIN, scope: TOKEN_SCOPE, sub: '1', iat: time, exp: time + 300, account: '', project: 'projekt', database: '', repository } );
		return input + '.' + toBase64Url( await crypto.subtle.sign( { name: 'Ed25519' }, keys.privateKey, encoder.encode( input ) ) );
	};
	const call = async ( repository, env ) => handleGithubRequest( { request: new Request( ORIGIN + '/api/dashboard/github', { headers: { Authorization: 'Bearer ' + await tokenFor( repository ) } } ), env: { WORDPRESS_PUBLIC_KEY: publicKey, ...env } } );

	globalThis.fetch = async () => assert.fail( 'bez DASHBOARD_GITHUB_TOKEN se GitHub nevolá' );
	const response = await call( REPOSITORY, {} );
	assert.equal( response.status, 200 );
	const report = await response.json();
	assert.deepEqual( report.target, { repository: REPOSITORY } );
	assert.deepEqual( report.settings, { githubToken: false } );
	assert.equal( report.github.error.code, ERRORS.GITHUB_TOKEN_MISSING );

	const invalid = await call( '../etc', { DASHBOARD_GITHUB_TOKEN: 'x' } );
	assert.equal( invalid.status, 401 );
	assert.equal( ( await invalid.json() ).error, ERRORS.INVALID_TOKEN );

	const noRepository = await buildGithubReport( { DASHBOARD_GITHUB_TOKEN: 'x' }, { ...CLAIMS, repository: '' }, TIME );
	assert.equal( noRepository.github.error.code, ERRORS.NO_REPOSITORY );
} );

test( 'dny: posledních 14 dní, dny bez záznamu s nulou, od nejnovějšího', () => {
	const window = githubWindow( TIME );
	assert.deepEqual( window, { since: date( TRAFFIC_DAYS - 1 ), until: date( 0 ), days: TRAFFIC_DAYS } );
	const summary = dailySummary( { count: 7, uniques: 3, views: [ { timestamp: date( 0 ) + 'T00:00:00Z', count: 5, uniques: 2 }, { timestamp: date( 3 ) + 'T00:00:00Z', count: 2, uniques: 1 }, { timestamp: date( 20 ) + 'T00:00:00Z', count: 9, uniques: 9 } ] }, 'views', window );
	assert.equal( summary.days.length, TRAFFIC_DAYS );
	assert.deepEqual( summary.days[ 0 ], { date: date( 0 ), count: 5, uniques: 2 } );
	assert.deepEqual( summary.days[ 1 ], { date: date( 1 ), count: 0, uniques: 0 } );
	assert.deepEqual( summary.days[ 3 ], { date: date( 3 ), count: 2, uniques: 1 } );
	assert.deepEqual( [ summary.count, summary.uniques ], [ 7, 3 ] );
} );

test( 's tokenem: hlavičky, části odpovědi, chyba oprávnění a paměť instance', async () => {
	const calls = [];
	globalThis.fetch = async ( input, init = {} ) => {
		const url = new URL( String( input ) );
		const headers = new Headers( init.headers );
		calls.push( url.pathname + url.search );
		assert.equal( headers.get( 'Authorization' ), 'Bearer github' );
		assert.equal( headers.get( 'X-GitHub-Api-Version' ), API_VERSION );
		assert.ok( headers.get( 'User-Agent' ) );
		assert.ok( url.pathname.startsWith( '/repos/uzivatel/web.cz' ) );
		switch ( url.pathname.slice( '/repos/uzivatel/web.cz'.length ) ) {
			case '':
				return json( { full_name: REPOSITORY, html_url: 'https://github.com/' + REPOSITORY, description: 'Web', private: false, stargazers_count: 4, forks_count: 1, subscribers_count: 2, watchers_count: 4, open_issues_count: 0, default_branch: 'main', pushed_at: '2027-01-01T00:00:00Z', has_pages: true } );
			case '/traffic/views':
				assert.equal( url.searchParams.get( 'per' ), 'day' );
				return json( { count: 3, uniques: 2, views: [ { timestamp: date( 1 ) + 'T00:00:00Z', count: 3, uniques: 2 } ] } );
			case '/traffic/clones':
				return json( { message: 'Resource not accessible by personal access token' }, 403 );
			case '/traffic/popular/referrers':
				return json( [ { referrer: 'iiic.dev', count: 2, uniques: 1 }, { referrer: '', count: 1, uniques: 1 } ] );
			case '/traffic/popular/paths':
				return json( [ { path: '/uzivatel/web.cz', title: 'Web', count: 3, uniques: 2 } ] );
		}
		assert.fail( 'nečekaný požadavek ' + url );
	};

	const report = await buildGithubReport( { DASHBOARD_GITHUB_TOKEN: 'github' }, CLAIMS, TIME );
	const github = report.github;
	assert.deepEqual( report.settings, { githubToken: true } );
	assert.equal( github.repository.stars, 4 );
	assert.equal( github.repository.watchers, 2 ); // subscribers_count, ne watchers_count (= hvězdy)
	assert.deepEqual( github.views.days[ 1 ], { date: date( 1 ), count: 3, uniques: 2 } );
	assert.equal( github.clones.error.code, ERRORS.GITHUB_API );
	assert.equal( github.clones.error.status, 403 );
	assert.deepEqual( github.referrers.items, [ { referrer: 'iiic.dev', count: 2, uniques: 1 } ] );
	assert.equal( github.paths.items[ 0 ].title, 'Web' );

	const count = calls.length;
	await buildGithubReport( { DASHBOARD_GITHUB_TOKEN: 'github' }, CLAIMS, TIME + 60 );
	assert.equal( calls.length, count ); // paměť instance
} );

test( 's tokenem: všechno selže (špatný token) – do paměti instance nejde', async () => {
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return json( { message: 'Bad credentials' }, 401 );
	};
	const report = await buildGithubReport( { DASHBOARD_GITHUB_TOKEN: 'spatny' }, CLAIMS, TIME );
	assert.equal( report.github.repository.error.message, 'Bad credentials' );
	await buildGithubReport( { DASHBOARD_GITHUB_TOKEN: 'spatny' }, CLAIMS, TIME + 1 );
	assert.equal( calls, 10 );
} );
