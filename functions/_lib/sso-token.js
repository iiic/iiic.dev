/**
* [2026-11-25] Přihlášení do WordPressu účtem z D1 (jeden účet všude): API po přihlášení přístupovým klíčem podepíše
* krátkodobý token (JWT s podpisem EdDSA / Ed25519) pro web, který o přihlášení požádal (WordPress). WordPress token
* ověří veřejným klíčem bez spojení s API (\FUNCTIONS\PASSKEY\verifyToken() šablony domdocument-template).
*
* Soukromý klíč je v tajné proměnné SSO_PRIVATE_KEY (JWK, jak ho vypíše příkaz ve functions/README.md), veřejný klíč
* vrací GET /api/auth/sso/public-key a vkládá se do nastavení WordPressu.
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/functions/), export ho kopíruje do repozitáře
* statického webu – upravovat ho ve šabloně.
*/

import { fromBase64Url, toBase64Url } from './webauthn.js';

/** @type {String} */
export const SSO_ALGORITHM = 'EdDSA'; // hlavička JWT; \VARS\PASSKEY_LOGIN::TOKEN_ALGORITHM

/** @type {TextEncoder} */
const textEncoder = new TextEncoder();

/**
* Chybí nebo je chybný klíč SSO_PRIVATE_KEY (API ho vrací jako chybu nastavení serveru).
*/
export class SsoKeyError extends Error {}

/**
* SSO_PRIVATE_KEY (JWK Ed25519 se soukromou částí d) → { privateKey, publicJwk }. Soukromou a veřejnou část ověří
* zkušebním podpisem, jinak by chybně zkopírovaný klíč vydával tokeny, které WordPress odmítne bez jasné příčiny.
*/
export const importSsoPrivateKey = async function ( /** @type {String|Object|undefined} */ value )
{
	if ( !value ) {
		throw new SsoKeyError( 'Chybí tajná proměnná SSO_PRIVATE_KEY (functions/README.md, „Přihlášení do WordPressu“).' );
	}

	/** @type {*} */
	let jwk;

	try {
		jwk = typeof value === 'string' ? JSON.parse( value ) : value;
	} catch {
		jwk = null;
	}
	if ( !jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string' || typeof jwk.x !== 'string' ) {
		throw new SsoKeyError( 'SSO_PRIVATE_KEY není soukromý klíč Ed25519 ve tvaru JWK ({"kty":"OKP","crv":"Ed25519","d":…,"x":…}).' );
	}

	/** @type {Object} */
	const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: jwk.x };

	try {

		/** @type {CryptoKey} */
		const privateKey = await crypto.subtle.importKey( 'jwk', { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x }, { name: 'Ed25519' }, false, [ 'sign' ] );

		/** @type {CryptoKey} */
		const publicKey = await crypto.subtle.importKey( 'jwk', publicJwk, { name: 'Ed25519' }, false, [ 'verify' ] );

		/** @type {Uint8Array} */
		const probe = textEncoder.encode( 'ddt-sso-key-check' );

		if ( !await crypto.subtle.verify( { name: 'Ed25519' }, publicKey, await crypto.subtle.sign( { name: 'Ed25519' }, privateKey, probe ), probe ) ) {
			throw new Error( 'mismatch' );
		}
		return { privateKey, publicJwk };
	} catch {
		throw new SsoKeyError( 'SSO_PRIVATE_KEY nejde načíst nebo soukromá a veřejná část (d, x) k sobě nepatří.' );
	}
};

/**
* JWT (kompaktní JWS) s podpisem EdDSA: base64url(hlavička).base64url(údaje).base64url(podpis).
*/
export const createSsoToken = async function ( /** @type {CryptoKey} */ privateKey, /** @type {Object} */ claims )
{

	/** @type {Function} */
	const encode = ( /** @type {Object} */ object ) => toBase64Url( textEncoder.encode( JSON.stringify( object ) ) );

	/** @type {String} */
	const signingInput = encode( { alg: SSO_ALGORITHM, typ: 'JWT' } ) + '.' + encode( claims );

	return signingInput + '.' + toBase64Url( await crypto.subtle.sign( { name: 'Ed25519' }, privateKey, textEncoder.encode( signingInput ) ) );
};

/**
* Ověření tokenu veřejným klíčem – stejně jako ve WordPressu (pro testy a pro případné další weby v JavaScriptu).
*
* @returns {Object|null} údaje tokenu, nebo null (neplatný tvar nebo podpis)
*/
export const verifySsoToken = async function ( /** @type {String} */ token, /** @type {Object} */ publicJwk )
{
	try {

		/** @type {String[]} */
		const parts = token.split( '.' );

		if ( parts.length !== 3 || JSON.parse( new TextDecoder().decode( fromBase64Url( parts[ 0 ] ) ) ).alg !== SSO_ALGORITHM ) {
			return null;
		}

		/** @type {CryptoKey} */
		const publicKey = await crypto.subtle.importKey( 'jwk', publicJwk, { name: 'Ed25519' }, false, [ 'verify' ] );

		if ( !await crypto.subtle.verify( { name: 'Ed25519' }, publicKey, fromBase64Url( parts[ 2 ] ), textEncoder.encode( parts[ 0 ] + '.' + parts[ 1 ] ) ) ) {
			return null;
		}
		return JSON.parse( new TextDecoder().decode( fromBase64Url( parts[ 1 ] ) ) );
	} catch {
		return null;
	}
};
