/**
* [2026-11-25] Testy tokenu pro přihlášení do WordPressu (functions/_lib/sso-token.js): podpis EdDSA, načtení klíče
* SSO_PRIVATE_KEY a odmítnutí chybného klíče. Stejný token ověřuje WordPress (\FUNCTIONS\PASSKEY\verifyToken()).
*
* Spouští ho .site-checks/check-site.php (kontrola „testy-api“). Ručně: cd .site-checks && node --test sso-token.test.mjs
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/.site-checks/), upravovat ho ve šabloně.
*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SsoKeyError, createSsoToken, importSsoPrivateKey, verifySsoToken } from '../functions/_lib/sso-token.js';
import { fromBase64Url } from '../functions/_lib/webauthn.js';

const generate = async () => {
	const keys = await crypto.subtle.generateKey( { name: 'Ed25519' }, true, [ 'sign', 'verify' ] );
	return crypto.subtle.exportKey( 'jwk', keys.privateKey );
};

test( 'token: podpis EdDSA, hlavička, údaje a ověření veřejným klíčem', async () => {
	const jwk = await generate();
	const { privateKey, publicJwk } = await importSsoPrivateKey( JSON.stringify( jwk ) );
	assert.deepEqual( publicJwk, { kty: 'OKP', crv: 'Ed25519', x: jwk.x } );
	const claims = { aud: 'http://localhost', sub: 'A'.repeat( 43 ), name: 'Jana „Ž“ <b>', nonce: 'stav-1234567890abcdef', iat: 1, exp: 121 };
	const token = await createSsoToken( privateKey, claims );
	const [ header, payload, signature ] = token.split( '.' );
	assert.deepEqual( JSON.parse( new TextDecoder().decode( fromBase64Url( header ) ) ), { alg: 'EdDSA', typ: 'JWT' } );
	assert.deepEqual( JSON.parse( new TextDecoder().decode( fromBase64Url( payload ) ) ), claims );
	assert.equal( fromBase64Url( signature ).length, 64 );
	assert.deepEqual( await verifySsoToken( token, publicJwk ), claims );
	const tampered = header + '.' + payload.slice( 0, -2 ) + ( payload.endsWith( 'A' ) ? 'B' : 'A' ) + payload.slice( -1 ) + '.' + signature;
	assert.equal( await verifySsoToken( tampered, publicJwk ), null );
	const other = await importSsoPrivateKey( await generate() );
	assert.equal( await verifySsoToken( token, other.publicJwk ), null );
} );

test( 'SSO_PRIVATE_KEY: chybějící, neplatný a nesourodý klíč skončí SsoKeyError', async () => {
	await assert.rejects( importSsoPrivateKey( undefined ), SsoKeyError );
	await assert.rejects( importSsoPrivateKey( '{' ), SsoKeyError );
	await assert.rejects( importSsoPrivateKey( '{"kty":"EC","crv":"P-256","d":"x","x":"y"}' ), SsoKeyError );
	const first = await generate();
	const second = await generate();
	await assert.rejects( importSsoPrivateKey( { ...first, x: second.x } ), SsoKeyError ); // d a x z jiných klíčů
	await assert.rejects( importSsoPrivateKey( { ...first, d: 'neplatné' } ), SsoKeyError );
} );
