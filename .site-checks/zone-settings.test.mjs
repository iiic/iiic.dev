/**
* [2026-11-27] Testy API pro nástroj „Nastavení Cloudflare“ ve WordPressu (functions/_lib/zone-settings.js, trasa GET a POST
* /api/zone-settings): CORS, token se scope pro nastavení zóny (token nástěnky neplatí), stav voleb ve zónách vlastních
* domén, změna jen podle údaje change v tokenu a jen povolených voleb a hodnot, zóna mimo projekt, pravidla WAF proti
* pingbackům (založení, zapnutí, vypnutí bez přepsání upraveného výrazu), bot management bez ztráty ostatních polí, vyčištění
* cache a chyby API. REST API Cloudflare je podvržené přes fetch.
*
* Spouští ho .site-checks/check-site.php (kontrola „testy-api“). Ručně: cd .site-checks && node --test zone-settings.test.mjs
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/.site-checks/), upravovat ho ve šabloně.
*/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ERRORS, TOKEN_SCOPE as DASHBOARD_SCOPE } from '../functions/_lib/dashboard.js';
import {
	API_TOKEN_SECRET,
	CUSTOM_RULES,
	CUSTOM_RULES_PHASE,
	KINDS,
	OFF,
	ON,
	SETTINGS,
	TOKEN_SCOPE,
	ZONE_ERRORS,
	buildZoneSettingsReport,
	changeOf,
	handleZoneSettingsRequest,
	shapeValues,
} from '../functions/_lib/zone-settings.js';
import { toBase64Url } from '../functions/_lib/webauthn.js';

const ORIGIN = 'https://projekt.pages.dev';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const PROJECT = 'projekt';
const ZONE = 'a'.repeat( 32 );
const OTHER_ZONE = 'b'.repeat( 32 );
const RULESET = 'c'.repeat( 32 );
const API = 'https://api.cloudflare.com/client/v4';
const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;

afterEach( () => {
	globalThis.fetch = originalFetch;
} );

const keys = await crypto.subtle.generateKey( { name: 'Ed25519' }, true, [ 'sign', 'verify' ] );
const publicKey = toBase64Url( await crypto.subtle.exportKey( 'raw', keys.publicKey ) );
const encode = ( object ) => toBase64Url( encoder.encode( JSON.stringify( object ) ) );

const sign = async ( claims ) => {
	const input = encode( { alg: 'EdDSA', typ: 'JWT' } ) + '.' + encode( claims );
	return input + '.' + toBase64Url( await crypto.subtle.sign( { name: 'Ed25519' }, keys.privateKey, encoder.encode( input ) ) );
};

const claimsOf = ( extra = {} ) => {
	const time = Math.floor( Date.now() / 1000 );
	return { iss: 'http://localhost', aud: ORIGIN, scope: TOKEN_SCOPE, sub: '1', iat: time, exp: time + 120, account: ACCOUNT, project: PROJECT, database: '', ...extra };
};

const call = async ( method, claims = null, env = {} ) => handleZoneSettingsRequest( {
	request: new Request( ORIGIN + '/api/zone-settings', { method, headers: claims ? { Authorization: 'Bearer ' + await sign( claims ) } : {} } ),
	env: { WORDPRESS_PUBLIC_KEY: publicKey, [ API_TOKEN_SECRET ]: 'tajny-token', ...env },
} );

const ok = ( result ) => new Response( JSON.stringify( { success: true, errors: [], result } ), { headers: { 'Content-Type': 'application/json' } } );
const failure = ( status, message, code = 10000 ) => new Response( JSON.stringify( { success: false, errors: [ { code, message } ], result: null } ), { status } );

/**
* Podvržené API Cloudflare: routes = { 'METODA /cesta': ( body, url ) => Response }. Volání se zapisují do calls.
*/
const mockApi = ( routes ) => {
	const calls = [];
	globalThis.fetch = async ( input, init = {} ) => {
		const url = new URL( typeof input === 'string' ? input : input.url );
		assert.ok( url.href.startsWith( API ), 'jen API Cloudflare: ' + url.href );
		assert.equal( new Headers( init.headers ).get( 'Authorization' ), 'Bearer tajny-token' );
		const method = init.method ?? 'GET';
		const key = method + ' ' + url.pathname.slice( '/client/v4'.length );
		const body = init.body ? JSON.parse( init.body ) : null;
		calls.push( { key, body } );
		const route = routes[ key ];
		assert.ok( route, 'nečekané volání API: ' + key );
		return route( body, url );
	};
	return calls;
};

const domains = () => ok( [ { name: 'example.cz', zone_tag: ZONE }, { name: 'web.jinde.cz', zone_tag: '' } ] );
const DOMAINS_ROUTE = `GET /accounts/${ ACCOUNT }/pages/projects/${ PROJECT }/domains`;

test( 'trasa: CORS, metody, token se scope pro nastavení zóny', async () => {
	globalThis.fetch = async () => assert.fail( 'bez platného tokenu se API Cloudflare nevolá' );

	const preflight = await call( 'OPTIONS' );
	assert.equal( preflight.status, 204 );
	assert.equal( preflight.headers.get( 'Access-Control-Allow-Origin' ), '*' );
	assert.match( preflight.headers.get( 'Access-Control-Allow-Methods' ), /POST/ );
	assert.equal( ( await call( 'DELETE' ) ).status, 405 );

	const anonymous = await call( 'GET' );
	assert.equal( anonymous.status, 401 );
	assert.equal( ( await anonymous.json() ).error, ERRORS.UNAUTHENTICATED );

	const dashboardToken = await call( 'GET', claimsOf( { scope: DASHBOARD_SCOPE } ) ); // token nástěnky (jen čtení) tu neplatí
	assert.equal( dashboardToken.status, 401 );
	assert.equal( ( await dashboardToken.json() ).error, ERRORS.INVALID_TOKEN );

	const otherAudience = await call( 'GET', claimsOf( { aud: 'https://jiny.pages.dev' } ) );
	assert.equal( otherAudience.status, 401 );

	const withoutSecret = await call( 'GET', claimsOf(), { [ API_TOKEN_SECRET ]: '' } );
	assert.equal( withoutSecret.status, 200 );
	const report = await withoutSecret.json();
	assert.deepEqual( report.settings, { apiToken: false } );
	assert.equal( report.cloudflare.error.code, ZONE_ERRORS.TOKEN_MISSING );

	const changeWithoutSecret = await call( 'POST', claimsOf( { change: { zone: ZONE, setting: 'browser_check', value: ON } } ), { [ API_TOKEN_SECRET ]: '' } );
	assert.equal( changeWithoutSecret.status, 500 );
	assert.equal( ( await changeWithoutSecret.json() ).error, ZONE_ERRORS.TOKEN_MISSING );

	const notConfigured = await buildZoneSettingsReport( { [ API_TOKEN_SECRET ]: 'x' }, { account: '', project: PROJECT }, 1_800_000_000 );
	assert.equal( notConfigured.cloudflare.error.code, ERRORS.NOT_CONFIGURED );
} );

test( 'údaj change v tokenu', () => {
	const iat = 1_800_000_000;
	assert.deepEqual( changeOf( { iat, exp: iat + 120, jti: 'abc-123', change: { zone: ZONE, setting: 'security_level', value: 'under_attack' } } ), { zone: ZONE, setting: 'security_level', value: 'under_attack', jti: 'abc-123' } );
	assert.equal( changeOf( { iat, exp: iat + 120, jti: '<script>', change: { zone: ZONE, setting: 'x', value: '' } } ).jti, '' );
	for ( const payload of [
		{ iat, exp: iat + 120 },
		{ iat, exp: iat + 120, change: [] },
		{ iat, exp: iat + 120, change: { zone: 'zona', setting: 'browser_check', value: ON } },
		{ iat, exp: iat + 120, change: { zone: ZONE, setting: '', value: ON } },
		{ iat, exp: iat + 120, change: { zone: ZONE, setting: 'browser_check', value: true } },
	] ) {
		assert.throws( () => changeOf( payload ), ( error ) => error.code === ZONE_ERRORS.NO_CHANGE, JSON.stringify( payload ) );
	}
	assert.throws( () => changeOf( { iat, exp: iat + 600, change: { zone: ZONE, setting: 'browser_check', value: ON } } ), ( error ) => error.code === ERRORS.INVALID_TOKEN ); // token pro změnu nejvýš 5 minut
} );

test( 'GET: stav voleb zóny', async () => {
	const calls = mockApi( {
		[ DOMAINS_ROUTE ]: domains,
		[ `GET /zones/${ ZONE }` ]: () => ok( { name: 'example.cz', status: 'active', paused: false, plan: { name: 'Free Website' } } ),
		[ `GET /zones/${ ZONE }/settings` ]: () => ok( [
			{ id: 'security_level', value: 'under_attack', editable: true, modified_on: '2026-11-27T10:00:00Z' },
			{ id: 'development_mode', value: 'on', editable: true, time_remaining: 3500 },
			{ id: 'challenge_ttl', value: 1800, editable: true },
			{ id: 'ssl', value: 'full', editable: true },
			{ id: 'rocket_loader', value: 'off', editable: false },
		] ),
		[ `GET /zones/${ ZONE }/bot_management` ]: () => ok( { fight_mode: true, enable_js: true, ai_bots_protection: 'block' } ),
		[ `GET /zones/${ ZONE }/rulesets/phases/${ CUSTOM_RULES_PHASE }/entrypoint` ]: () => ok( { id: RULESET, rules: [
			{ id: 'r1', ref: CUSTOM_RULES.block_xmlrpc.ref, enabled: false, expression: CUSTOM_RULES.block_xmlrpc.expression, last_updated: '2026-11-26T08:00:00Z' },
			{ id: 'r2', ref: CUSTOM_RULES.block_pingback_verification.ref, enabled: true, expression: '(http.user_agent contains "pingback")' },
			{ id: 'r3', ref: 'cizi-pravidlo', enabled: true, expression: 'true' },
		] } ),
	} );

	const response = await call( 'GET', claimsOf() );
	assert.equal( response.status, 200 );
	assert.equal( response.headers.get( 'Cache-Control' ), 'no-store' );
	const report = await response.json();
	assert.deepEqual( report.settings, { apiToken: true } );
	assert.deepEqual( report.cloudflare.zones.external, [ 'web.jinde.cz' ] );
	const zone = report.cloudflare.zones.items[ 0 ];
	assert.equal( zone.id, ZONE );
	assert.equal( zone.name, 'example.cz' );
	assert.equal( zone.plan, 'Free Website' );
	assert.deepEqual( zone.customRules, { total: 3 } );
	assert.deepEqual( zone.values.security_level, { value: 'under_attack', editable: true, modifiedOn: '2026-11-27T10:00:00Z', timeRemaining: null } );
	assert.equal( zone.values.development_mode.timeRemaining, 3500 );
	assert.equal( zone.values.challenge_ttl.value, '1800' ); // číslo jako text (hodnota výběru)
	assert.equal( zone.values.ssl.value, 'full' );
	assert.equal( zone.values.ssl.editable, false ); // jen ke čtení
	assert.equal( zone.values.rocket_loader.editable, false ); // Cloudflare ji nedovolí změnit
	assert.equal( zone.values.browser_check.error.code, ZONE_ERRORS.UNAVAILABLE ); // zóna volbu nevrátila
	assert.equal( zone.values.bot_fight_mode.value, ON );
	assert.equal( zone.values.ai_bots_protection.value, 'block' );
	assert.equal( zone.values.crawler_protection.error.code, ZONE_ERRORS.UNAVAILABLE );
	assert.deepEqual( zone.values.block_xmlrpc, { value: OFF, editable: true, modifiedOn: '2026-11-26T08:00:00Z', timeRemaining: null, exists: true, customized: false } );
	assert.equal( zone.values.block_pingback_verification.value, ON );
	assert.equal( zone.values.block_pingback_verification.customized, true );
	assert.equal( zone.values.purge_cache.editable, true );
	assert.equal( calls.filter( ( item ) => !item.key.startsWith( 'GET ' ) ).length, 0, 'GET nic nemění' );
} );

test( 'GET: zóna bez vlastních pravidel (404) a chybějící oprávnění jedné části', async () => {
	mockApi( {
		[ DOMAINS_ROUTE ]: domains,
		[ `GET /zones/${ ZONE }` ]: () => failure( 403, 'Authentication error' ),
		[ `GET /zones/${ ZONE }/settings` ]: () => ok( [ { id: 'browser_check', value: 'on', editable: true } ] ),
		[ `GET /zones/${ ZONE }/bot_management` ]: () => failure( 403, 'Authentication error' ),
		[ `GET /zones/${ ZONE }/rulesets/phases/${ CUSTOM_RULES_PHASE }/entrypoint` ]: () => failure( 404, 'Could not find entrypoint ruleset in the http_request_firewall_custom phase' ),
	} );
	const report = await ( await call( 'GET', claimsOf() ) ).json();
	const zone = report.cloudflare.zones.items[ 0 ];
	assert.equal( zone.name, null );
	assert.equal( zone.detailsError.code, ERRORS.CLOUDFLARE_API );
	assert.equal( zone.values.browser_check.value, ON );
	assert.equal( zone.values.bot_fight_mode.error.message, 'Authentication error' );
	assert.deepEqual( zone.customRules, { total: 0 } );
	assert.equal( zone.values.block_xmlrpc.exists, false );
	assert.equal( zone.values.block_xmlrpc.value, OFF );

	mockApi( { [ DOMAINS_ROUTE ]: () => ok( [ { name: 'web.jinde.cz', zone_tag: '' } ] ) } );
	const noZone = await ( await call( 'GET', claimsOf() ) ).json();
	assert.equal( noZone.cloudflare.error.code, ERRORS.NO_ZONE );
	assert.deepEqual( noZone.cloudflare.error.domains, [ 'web.jinde.cz' ] );
} );

test( 'POST: změní jen volbu z tokenu, jen povolené hodnoty a jen zónu projektu', async () => {
	const calls = mockApi( {
		[ DOMAINS_ROUTE ]: domains,
		[ `GET /zones/${ ZONE }/settings/security_level` ]: () => ok( { id: 'security_level', value: 'medium' } ),
		[ `PATCH /zones/${ ZONE }/settings/security_level` ]: ( body ) => ok( { id: 'security_level', value: body.value, modified_on: '2026-11-27T12:00:00Z' } ),
		[ `GET /zones/${ ZONE }/settings/challenge_ttl` ]: () => ok( { id: 'challenge_ttl', value: 1800 } ),
		[ `PATCH /zones/${ ZONE }/settings/challenge_ttl` ]: ( body ) => ok( { id: 'challenge_ttl', value: body.value } ),
	} );

	const response = await call( 'POST', claimsOf( { jti: 'zaznam1', change: { zone: ZONE, setting: 'security_level', value: 'under_attack' } } ) );
	assert.equal( response.status, 200 );
	const data = await response.json();
	assert.deepEqual( data.change, { zone: ZONE, setting: 'security_level', value: 'under_attack', jti: 'zaznam1' } );
	assert.deepEqual( data.result, { before: 'medium', after: 'under_attack', modifiedOn: '2026-11-27T12:00:00Z', timeRemaining: null, created: false } );
	assert.deepEqual( calls.find( ( item ) => item.key.startsWith( 'PATCH' ) ).body, { value: 'under_attack' } );

	const ttl = await ( await call( 'POST', claimsOf( { change: { zone: ZONE, setting: 'challenge_ttl', value: '3600' } } ) ) ).json();
	assert.deepEqual( calls.at( -1 ).body, { value: 3600 } ); // v API číslo
	assert.equal( ttl.result.after, '3600' );

	const before = calls.length;
	for ( const [ setting, value ] of [ [ 'security_level', 'off' ], [ 'ssl', 'flexible' ], [ 'browser_check', 'maybe' ], [ 'neznama', ON ], [ 'toString', ON ], [ '__proto__', ON ] ] ) {
		const refused = await call( 'POST', claimsOf( { change: { zone: ZONE, setting, value } } ) );
		assert.equal( refused.status, 400, setting );
		assert.equal( ( await refused.json() ).error, ZONE_ERRORS.NOT_ALLOWED, setting );
	}
	assert.equal( calls.length, before, 'nepovolená změna API nevolá' );

	const foreign = await call( 'POST', claimsOf( { change: { zone: OTHER_ZONE, setting: 'browser_check', value: ON } } ) );
	assert.equal( foreign.status, 403 );
	assert.equal( ( await foreign.json() ).error, ZONE_ERRORS.FOREIGN_ZONE );
	assert.ok( !calls.some( ( item ) => item.key.includes( OTHER_ZONE ) ), 'cizí zóny se nedotkne' );

	const withoutChange = await call( 'POST', claimsOf() ); // token pro čtení
	assert.equal( withoutChange.status, 400 );
	assert.equal( ( await withoutChange.json() ).error, ZONE_ERRORS.NO_CHANGE );
} );

test( 'POST: chyba API Cloudflare', async () => {
	mockApi( {
		[ DOMAINS_ROUTE ]: domains,
		[ `GET /zones/${ ZONE }/settings/browser_check` ]: () => ok( { id: 'browser_check', value: 'off' } ),
		[ `PATCH /zones/${ ZONE }/settings/browser_check` ]: () => failure( 403, 'Authentication error' ),
	} );
	const response = await call( 'POST', claimsOf( { change: { zone: ZONE, setting: 'browser_check', value: ON } } ) );
	assert.equal( response.status, 502 );
	assert.deepEqual( await response.json(), { error: ERRORS.CLOUDFLARE_API, message: 'Authentication error' } );
} );

test( 'POST: pravidla WAF proti pingbackům – založení, zapnutí a vypnutí', async () => {
	const entrypoint = `/zones/${ ZONE }/rulesets/phases/${ CUSTOM_RULES_PHASE }/entrypoint`;

	// zóna vlastní pravidla nemá → sada vznikne s jediným pravidlem
	let calls = mockApi( {
		[ DOMAINS_ROUTE ]: domains,
		[ 'GET ' + entrypoint ]: () => failure( 404, 'Could not find entrypoint ruleset' ),
		[ 'PUT ' + entrypoint ]: ( body ) => ok( { id: RULESET, rules: body.rules } ),
	} );
	let data = await ( await call( 'POST', claimsOf( { change: { zone: ZONE, setting: 'block_xmlrpc', value: ON } } ) ) ).json();
	assert.deepEqual( data.result, { before: OFF, after: ON, modifiedOn: null, timeRemaining: null, created: true } );
	assert.deepEqual( calls.at( -1 ).body, { rules: [ { ...CUSTOM_RULES.block_xmlrpc, enabled: true } ] } );

	// sada existuje bez pravidla → přidá se na konec (ostatní pravidla zůstanou)
	calls = mockApi( {
		[ DOMAINS_ROUTE ]: domains,
		[ 'GET ' + entrypoint ]: () => ok( { id: RULESET, rules: [ { id: 'r9', ref: 'cizi', enabled: true, expression: 'true', action: 'log' } ] } ),
		[ `POST /zones/${ ZONE }/rulesets/${ RULESET }/rules` ]: () => ok( { id: RULESET } ),
	} );
	data = await ( await call( 'POST', claimsOf( { change: { zone: ZONE, setting: 'block_pingback_verification', value: ON } } ) ) ).json();
	assert.equal( data.result.created, true );
	assert.deepEqual( calls.at( -1 ).body, { ...CUSTOM_RULES.block_pingback_verification, enabled: true } );
	assert.ok( !calls.some( ( item ) => item.key.startsWith( 'PUT' ) ), 'sadu pravidel nepřepíše' );

	// pravidlo existuje → jen enabled; výraz upravený v administraci Cloudflare zůstane
	const customized = { id: 'r1', ref: CUSTOM_RULES.block_xmlrpc.ref, enabled: true, action: 'managed_challenge', expression: '(http.request.uri.path eq "/xmlrpc.php")', description: 'upraveno', version: '3', last_updated: 'x' };
	calls = mockApi( {
		[ DOMAINS_ROUTE ]: domains,
		[ 'GET ' + entrypoint ]: () => ok( { id: RULESET, rules: [ customized ] } ),
		[ `PATCH /zones/${ ZONE }/rulesets/${ RULESET }/rules/r1` ]: () => ok( { id: RULESET } ),
	} );
	data = await ( await call( 'POST', claimsOf( { change: { zone: ZONE, setting: 'block_xmlrpc', value: OFF } } ) ) ).json();
	assert.deepEqual( data.result, { before: ON, after: OFF, modifiedOn: null, timeRemaining: null, created: false } );
	assert.deepEqual( calls.at( -1 ).body, { enabled: false, action: 'managed_challenge', expression: customized.expression, description: 'upraveno', ref: customized.ref } );

	// už vypnuté / neexistující pravidlo vypnout = nic se nevolá
	calls = mockApi( {
		[ DOMAINS_ROUTE ]: domains,
		[ 'GET ' + entrypoint ]: () => ok( { id: RULESET, rules: [ { ...customized, enabled: false } ] } ),
	} );
	data = await ( await call( 'POST', claimsOf( { change: { zone: ZONE, setting: 'block_xmlrpc', value: OFF } } ) ) ).json();
	assert.equal( data.result.after, OFF );
	assert.equal( calls.length, 2 );
	calls = mockApi( {
		[ DOMAINS_ROUTE ]: domains,
		[ 'GET ' + entrypoint ]: () => failure( 404, 'Could not find entrypoint ruleset' ),
	} );
	data = await ( await call( 'POST', claimsOf( { change: { zone: ZONE, setting: 'block_pingback_verification', value: OFF } } ) ) ).json();
	assert.equal( data.result.created, false );
	assert.equal( calls.length, 2 );
} );

test( 'POST: bot management pošle i ostatní pole, vyčištění cache', async () => {
	const calls = mockApi( {
		[ DOMAINS_ROUTE ]: domains,
		[ `GET /zones/${ ZONE }/bot_management` ]: () => ok( { fight_mode: false, enable_js: true, ai_bots_protection: 'block', crawler_protection: 'disabled', using_latest_model: true, stale_zone_configuration: { x: 1 } } ),
		[ `PUT /zones/${ ZONE }/bot_management` ]: ( body ) => ok( { ...body, using_latest_model: true } ),
		[ `POST /zones/${ ZONE }/purge_cache` ]: () => ok( { id: ZONE } ),
	} );
	const data = await ( await call( 'POST', claimsOf( { change: { zone: ZONE, setting: 'bot_fight_mode', value: ON } } ) ) ).json();
	assert.deepEqual( calls.at( -1 ).body, { fight_mode: true, enable_js: true, ai_bots_protection: 'block', crawler_protection: 'disabled' } ); // jen zapisovatelná pole
	assert.equal( data.result.before, OFF );
	assert.equal( data.result.after, ON );

	const purge = await ( await call( 'POST', claimsOf( { change: { zone: ZONE, setting: 'purge_cache', value: 'everything' } } ) ) ).json();
	assert.deepEqual( calls.at( -1 ), { key: `POST /zones/${ ZONE }/purge_cache`, body: { purge_everything: true } } );
	assert.equal( purge.result.after, 'everything' );
} );

test( 'seznam voleb: každá má druh, pravidla WAF mají definici', () => {
	for ( const [ id, definition ] of Object.entries( SETTINGS ) ) {
		assert.ok( Object.values( KINDS ).includes( definition.kind ), id );
		assert.ok( Array.isArray( definition.values ), id );
		if ( definition.kind === KINDS.CUSTOM_RULE ) {
			assert.ok( CUSTOM_RULES[ id ]?.ref.startsWith( 'ddt-' ), id );
			assert.equal( CUSTOM_RULES[ id ].action, 'block', id );
		}
	}
	assert.ok( !SETTINGS.security_level.values.includes( 'off' ), 'off je jen pro Enterprise' );
	assert.deepEqual( SETTINGS.ssl.values, [] );
	const values = shapeValues( { settings: { error: { code: 'x', message: 'y' } }, bots: { config: {} }, rules: { rules: [] } } );
	assert.equal( values.security_level.error.code, 'x' );
} );
