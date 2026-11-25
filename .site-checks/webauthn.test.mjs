/**
* [2026-11-25] Testy ověřování WebAuthn v API přihlašování (functions/_lib/webauthn.js) – softwarový autentizátor
* v testu vytvoří klíč a podepíše výzvu stejně jako skutečný (ES256, EdDSA, RS256), test pak zkouší i podvržené
* a poškozené odpovědi. Bez knihoven a bez sítě, jen Node.js (node:test, Web Crypto).
*
* Spouští ho .site-checks/check-site.php (kontrola „funkce-api“), tedy pre-commit hook i workflow na GitHubu. Ručně:
*   node --test .site-checks/
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/.site-checks/), upravovat ho ve šabloně.
*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	COSE_ALGORITHMS,
	WebAuthnError,
	decodeCbor,
	derToRawEcdsaSignature,
	fromBase64Url,
	readClientData,
	toBase64Url,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from '../functions/_lib/webauthn.js';

const RP_ID = 'example.cz';
const ORIGIN = 'https://example.cz';
const encoder = new TextEncoder();

/* ---------- minimální kodér CBOR (jen pro test) ---------- */

const cborHead = ( major, value ) => {
	if ( value < 24 ) {
		return [ ( major << 5 ) | value ];
	}
	if ( value < 0x100 ) {
		return [ ( major << 5 ) | 24, value ];
	}
	if ( value < 0x10000 ) {
		return [ ( major << 5 ) | 25, value >> 8, value & 0xff ];
	}
	return [ ( major << 5 ) | 26, ( value >>> 24 ) & 0xff, ( value >> 16 ) & 0xff, ( value >> 8 ) & 0xff, value & 0xff ];
};

const encodeCbor = ( value ) => {
	if ( typeof value === 'number' ) {
		return Uint8Array.from( value >= 0 ? cborHead( 0, value ) : cborHead( 1, -1 - value ) );
	}
	if ( typeof value === 'string' ) {
		const bytes = encoder.encode( value );
		return concat( Uint8Array.from( cborHead( 3, bytes.length ) ), bytes );
	}
	if ( value instanceof Uint8Array ) {
		return concat( Uint8Array.from( cborHead( 2, value.length ) ), value );
	}
	if ( value instanceof Map ) {
		const parts = [ Uint8Array.from( cborHead( 5, value.size ) ) ];
		for ( const [ key, item ] of value ) {
			parts.push( encodeCbor( key ), encodeCbor( item ) );
		}
		return concat( ...parts );
	}
	throw new Error( 'encodeCbor: nepodporovaný typ' );
};

const concat = ( ...parts ) => {
	const result = new Uint8Array( parts.reduce( ( sum, part ) => sum + part.length, 0 ) );
	let offset = 0;
	for ( const part of parts ) {
		result.set( part, offset );
		offset += part.length;
	}
	return result;
};

const sha256 = async ( data ) => new Uint8Array( await crypto.subtle.digest( 'SHA-256', typeof data === 'string' ? encoder.encode( data ) : data ) );

/* ---------- softwarový autentizátor ---------- */

const ALGORITHMS = {
	ES256: { cose: COSE_ALGORITHMS.ES256, generate: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } },
	EdDSA: { cose: COSE_ALGORITHMS.EdDSA, generate: { name: 'Ed25519' }, sign: { name: 'Ed25519' } },
	RS256: { cose: COSE_ALGORITHMS.RS256, generate: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array( [ 1, 0, 1 ] ), hash: 'SHA-256' }, sign: { name: 'RSASSA-PKCS1-v1_5' } },
};

const rawEcdsaToDer = ( raw ) => { // r ‖ s → SEQUENCE { INTEGER r, INTEGER s } (jako skutečný autentizátor)
	const integer = ( bytes ) => {
		let start = 0;
		while ( start < bytes.length - 1 && bytes[ start ] === 0 ) {
			start++;
		}
		let value = bytes.slice( start );
		if ( value[ 0 ] & 0x80 ) {
			value = concat( Uint8Array.of( 0 ), value );
		}
		return concat( Uint8Array.of( 0x02, value.length ), value );
	};
	const body = concat( integer( raw.slice( 0, 32 ) ), integer( raw.slice( 32 ) ) );
	return concat( Uint8Array.of( 0x30, body.length ), body );
};

const createAuthenticator = async ( algorithmName ) => {
	const algorithm = ALGORITHMS[ algorithmName ];
	const keys = await crypto.subtle.generateKey( algorithm.generate, true, [ 'sign', 'verify' ] );
	const jwk = await crypto.subtle.exportKey( 'jwk', keys.publicKey );
	const credentialId = crypto.getRandomValues( new Uint8Array( 16 ) );
	let coseKey;
	if ( algorithmName === 'ES256' ) {
		coseKey = new Map( [ [ 1, 2 ], [ 3, algorithm.cose ], [ -1, 1 ], [ -2, fromBase64Url( jwk.x ) ], [ -3, fromBase64Url( jwk.y ) ] ] );
	} else if ( algorithmName === 'EdDSA' ) {
		coseKey = new Map( [ [ 1, 1 ], [ 3, algorithm.cose ], [ -1, 6 ], [ -2, fromBase64Url( jwk.x ) ] ] );
	} else {
		coseKey = new Map( [ [ 1, 3 ], [ 3, algorithm.cose ], [ -1, fromBase64Url( jwk.n ) ], [ -2, fromBase64Url( jwk.e ) ] ] );
	}
	return { algorithmName, algorithm, keys, credentialId, coseKey, signCount: 0 };
};

const authenticatorData = async ( { rpId = RP_ID, flags = 0x05, signCount = 0, attested = null } = {} ) => {
	const counter = new Uint8Array( 4 );
	new DataView( counter.buffer ).setUint32( 0, signCount );
	const parts = [ await sha256( rpId ), Uint8Array.of( flags | ( attested ? 0x40 : 0 ) ), counter ];
	if ( attested ) {
		parts.push( new Uint8Array( 16 ), Uint8Array.of( attested.credentialId.length >> 8, attested.credentialId.length & 0xff ), attested.credentialId, encodeCbor( attested.coseKey ) );
	}
	return concat( ...parts );
};

const clientDataJson = ( { type, challenge, origin = ORIGIN, extra = {} } ) => encoder.encode( JSON.stringify( { type, challenge, origin, crossOrigin: false, ...extra } ) );

const register = async ( authenticator, challenge, options = {} ) => {
	const authData = await authenticatorData( { attested: authenticator, rpId: options.rpId, flags: options.flags ?? 0x05 } );
	const attestationObject = encodeCbor( new Map( [ [ 'fmt', 'none' ], [ 'attStmt', new Map() ], [ 'authData', authData ] ] ) );
	return {
		id: toBase64Url( authenticator.credentialId ),
		rawId: toBase64Url( authenticator.credentialId ),
		type: 'public-key',
		response: {
			clientDataJSON: toBase64Url( clientDataJson( { type: 'webauthn.create', challenge, origin: options.origin } ) ),
			attestationObject: toBase64Url( attestationObject ),
			transports: [ 'internal', 'hybrid', 'neznámý' ],
		},
	};
};

const authenticate = async ( authenticator, challenge, options = {} ) => {
	authenticator.signCount += options.counterStep ?? 1;
	const authData = await authenticatorData( { rpId: options.rpId, flags: options.flags ?? 0x05, signCount: options.signCount ?? authenticator.signCount } );
	const clientData = clientDataJson( { type: options.type ?? 'webauthn.get', challenge, origin: options.origin } );
	let signature = new Uint8Array( await crypto.subtle.sign( authenticator.algorithm.sign, authenticator.keys.privateKey, concat( authData, await sha256( clientData ) ) ) );
	if ( authenticator.algorithmName === 'ES256' ) {
		signature = rawEcdsaToDer( signature );
	}
	return {
		id: toBase64Url( authenticator.credentialId ),
		rawId: toBase64Url( authenticator.credentialId ),
		type: 'public-key',
		response: {
			clientDataJSON: toBase64Url( options.clientDataOverride ?? clientData ),
			authenticatorData: toBase64Url( authData ),
			signature: toBase64Url( signature ),
			userHandle: null,
		},
	};
};

const expected = ( challenge, extra = {} ) => ( { challenge, origins: [ ORIGIN ], rpId: RP_ID, requireUserVerification: false, ...extra } );

/* ---------- testy ---------- */

for ( const algorithmName of Object.keys( ALGORITHMS ) ) {
	test( `${ algorithmName }: registrace a přihlášení projdou, uložený klíč funguje`, async () => {
		const authenticator = await createAuthenticator( algorithmName );
		const registration = await verifyRegistrationResponse( await register( authenticator, 'vyzva-1' ), expected( 'vyzva-1' ) );
		assert.equal( registration.algorithm, ALGORITHMS[ algorithmName ].cose );
		assert.equal( registration.credentialId, toBase64Url( authenticator.credentialId ) );
		assert.deepEqual( registration.transports, [ 'hybrid', 'internal' ] ); // neznámé hodnoty vyřazené, seřazené
		const stored = JSON.parse( JSON.stringify( registration.publicKey ) ); // jak se uloží do D1

		const result = await verifyAuthenticationResponse( await authenticate( authenticator, 'vyzva-2' ), expected( 'vyzva-2', { publicKey: stored, algorithm: registration.algorithm, signCount: 0 } ) );
		assert.equal( result.signCount, 1 );
		assert.equal( result.userVerified, true );

		const tampered = await authenticate( authenticator, 'vyzva-3' );
		tampered.response.signature = toBase64Url( fromBase64Url( tampered.response.signature ).map( ( byte, index ) => index === 10 ? byte ^ 1 : byte ) );
		await assert.rejects( verifyAuthenticationResponse( tampered, expected( 'vyzva-3', { publicKey: stored, algorithm: registration.algorithm, signCount: 1 } ) ), WebAuthnError );
	} );
}

test( 'registrace: odmítne jinou výzvu, adresu, RP ID, chybějící přítomnost uživatele a jiné ID klíče', async () => {
	const authenticator = await createAuthenticator( 'ES256' );
	await assert.rejects( verifyRegistrationResponse( await register( authenticator, 'jina' ), expected( 'vyzva' ) ), /Výzva/ );
	await assert.rejects( verifyRegistrationResponse( await register( authenticator, 'vyzva', { origin: 'https://evil.example' } ), expected( 'vyzva' ) ), /nepovolené adresy/ );
	await assert.rejects( verifyRegistrationResponse( await register( authenticator, 'vyzva', { rpId: 'evil.example' } ), expected( 'vyzva' ) ), /RP ID/ );
	await assert.rejects( verifyRegistrationResponse( await register( authenticator, 'vyzva', { flags: 0x04 } ), expected( 'vyzva' ) ), /přítomnost/ );
	await assert.rejects( verifyRegistrationResponse( await register( authenticator, 'vyzva', { flags: 0x01 } ), expected( 'vyzva', { requireUserVerification: true } ) ), /neověřil/ );
	const otherId = await register( authenticator, 'vyzva' );
	otherId.id = otherId.rawId = toBase64Url( crypto.getRandomValues( new Uint8Array( 16 ) ) );
	await assert.rejects( verifyRegistrationResponse( otherId, expected( 'vyzva' ) ), /ID klíče/ );
	const wrongType = await register( authenticator, 'vyzva' );
	wrongType.response.clientDataJSON = toBase64Url( clientDataJson( { type: 'webauthn.get', challenge: 'vyzva' } ) );
	await assert.rejects( verifyRegistrationResponse( wrongType, expected( 'vyzva' ) ), /typ/ );
	const framed = await register( authenticator, 'vyzva' );
	framed.response.clientDataJSON = toBase64Url( clientDataJson( { type: 'webauthn.create', challenge: 'vyzva', extra: { crossOrigin: true } } ) );
	await assert.rejects( verifyRegistrationResponse( framed, expected( 'vyzva' ) ), /iframe/ );
} );

test( 'registrace: odmítne nepodporovaný algoritmus a krátký klíč RSA', async () => {
	const authenticator = await createAuthenticator( 'ES256' );
	authenticator.coseKey.set( 3, -35 ); // ES384
	await assert.rejects( verifyRegistrationResponse( await register( authenticator, 'vyzva' ), expected( 'vyzva' ) ), /Nepodporovaný/ );
	const rsa = await createAuthenticator( 'RS256' );
	rsa.coseKey.set( -1, rsa.coseKey.get( -1 ).slice( 0, 128 ) );
	await assert.rejects( verifyRegistrationResponse( await register( rsa, 'vyzva' ), expected( 'vyzva' ) ), /2048/ );
} );

test( 'přihlášení: odmítne jinou výzvu, adresu, RP ID, typ, podvržená data klienta a počítadlo, které neroste', async () => {
	const authenticator = await createAuthenticator( 'ES256' );
	const registration = await verifyRegistrationResponse( await register( authenticator, 'r' ), expected( 'r' ) );
	const stored = ( challenge, signCount = 0 ) => expected( challenge, { publicKey: registration.publicKey, algorithm: registration.algorithm, signCount } );
	await assert.rejects( verifyAuthenticationResponse( await authenticate( authenticator, 'jina' ), stored( 'vyzva' ) ), /Výzva/ );
	await assert.rejects( verifyAuthenticationResponse( await authenticate( authenticator, 'vyzva', { origin: 'https://evil.example' } ), stored( 'vyzva' ) ), /nepovolené adresy/ );
	await assert.rejects( verifyAuthenticationResponse( await authenticate( authenticator, 'vyzva', { rpId: 'evil.example' } ), stored( 'vyzva' ) ), /RP ID/ );
	await assert.rejects( verifyAuthenticationResponse( await authenticate( authenticator, 'vyzva', { type: 'webauthn.create' } ), stored( 'vyzva' ) ), /typ/ );
	await assert.rejects( verifyAuthenticationResponse( await authenticate( authenticator, 'vyzva', { flags: 0x00 } ), stored( 'vyzva' ) ), /přítomnost/ );
	const swapped = await authenticate( authenticator, 'vyzva', { clientDataOverride: clientDataJson( { type: 'webauthn.get', challenge: 'vyzva', extra: { pozn: 'podvrženo' } } ) } );
	await assert.rejects( verifyAuthenticationResponse( swapped, stored( 'vyzva' ) ), /Podpis/ );
	await assert.rejects( verifyAuthenticationResponse( await authenticate( authenticator, 'vyzva', { signCount: 5 } ), stored( 'vyzva', 5 ) ), /Počítadlo/ );
	const synced = await authenticate( authenticator, 'vyzva', { signCount: 0 } ); // synchronizovaný klíč: počítadlo stále 0
	assert.equal( ( await verifyAuthenticationResponse( synced, stored( 'vyzva', 0 ) ) ).signCount, 0 );
} );

test( 'CBOR, base64url a DER: poškozená data skončí WebAuthnError, ne jinou výjimkou', () => {
	assert.throws( () => decodeCbor( Uint8Array.of( 0x9f ) ), WebAuthnError ); // neurčitá délka
	assert.throws( () => decodeCbor( Uint8Array.of( 0x5a, 0, 0, 0, 9, 1 ) ), WebAuthnError ); // bajty za koncem
	assert.throws( () => decodeCbor( Uint8Array.of( 0xa2, 0x01, 0x01, 0x01, 0x02 ) ), WebAuthnError ); // opakovaný klíč mapy
	assert.throws( () => decodeCbor( Uint8Array.of( 0x62, 0xff, 0xfe ) ), WebAuthnError ); // neplatné UTF-8
	assert.throws( () => fromBase64Url( 'abc+' ), WebAuthnError );
	assert.throws( () => fromBase64Url( 'abcde' ), WebAuthnError );
	assert.throws( () => derToRawEcdsaSignature( Uint8Array.of( 0x30, 0x02, 0x02, 0x00 ) ), WebAuthnError );
	assert.throws( () => readClientData( { type: 'public-key', id: 'AA', response: { clientDataJSON: toBase64Url( encoder.encode( '{' ) ) } }, 'webauthn.get' ), WebAuthnError );
	assert.throws( () => readClientData( { type: 'public-key', id: 'AA', rawId: 'AB', response: { clientDataJSON: '' } }, 'webauthn.get' ), WebAuthnError );
	assert.deepEqual( fromBase64Url( toBase64Url( Uint8Array.of( 251, 255, 0 ) ) ), Uint8Array.of( 251, 255, 0 ) );
} );
