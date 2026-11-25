/**
* [2026-11-25] Ověření odpovědí WebAuthn (přístupové klíče, passkeys) pro API přihlašování v functions/api/auth/.
*
* Bez knihoven, jen Web Crypto API (crypto.subtle), které mají Cloudflare Workers i Node.js – modul jde proto testovat
* i mimo Cloudflare. Postup podle specifikace https://www.w3.org/TR/webauthn-3/ (kapitoly 7.1 registrace a 7.2
* přihlášení), zjednodušený tím, že server atestaci nepožaduje (attestation: 'none'): o výrobci autentizátoru nic
* nezjišťuje, a obsah attStmt proto neověřuje. Ověřuje vše ostatní: typ, výzvu a původ v clientDataJSON, hash RP ID,
* příznaky přítomnosti a ověření uživatele, ID klíče a podpis.
*
* Podporované algoritmy (COSE): EdDSA (Ed25519), ES256 (ECDSA P-256 + SHA-256) a RS256 (RSASSA-PKCS1-v1_5 + SHA-256).
* Veřejný klíč se ukládá jako JWK – Web Crypto ho tak načte přímo.
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/functions/), export „Vygenerovat statické
* soubory“ ho kopíruje do repozitáře statického webu – upravovat ho ve šabloně.
*/

/** @type {Object<String, Number>} */
export const COSE_ALGORITHMS = Object.freeze( {
	EdDSA: -8,
	ES256: -7,
	RS256: -257,
} );

/** @type {Number[]} */
export const SUPPORTED_ALGORITHMS = Object.freeze( [ COSE_ALGORITHMS.EdDSA, COSE_ALGORITHMS.ES256, COSE_ALGORITHMS.RS256 ] ); // pořadí = preference serveru

/** @type {Object<String, String>} */
export const CLIENT_DATA_TYPES = Object.freeze( {
	CREATE: 'webauthn.create',
	GET: 'webauthn.get',
} );

/** @type {String[]} */
const KNOWN_TRANSPORTS = [ 'ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb' ]; // AuthenticatorTransport

/** @type {Number} */
const MAX_CREDENTIAL_ID_LENGTH = 1023; // B, WebAuthn L3 – delší ID klíče se má odmítnout

/** @type {Number} */
const MAX_CBOR_DEPTH = 16;

/** @type {Object<String, Number>} */
const FLAGS = Object.freeze( { // bity příznaků v datech autentizátoru (authenticatorData)
	USER_PRESENT: 0x01,
	USER_VERIFIED: 0x04,
	BACKUP_ELIGIBLE: 0x08,
	BACKED_UP: 0x10,
	ATTESTED_CREDENTIAL_DATA: 0x40,
	EXTENSION_DATA: 0x80,
} );

/** @type {Object<Number, Object>} */
const IMPORT_PARAMETERS = Object.freeze( {
	[ COSE_ALGORITHMS.EdDSA ]: { name: 'Ed25519' },
	[ COSE_ALGORITHMS.ES256 ]: { name: 'ECDSA', namedCurve: 'P-256' },
	[ COSE_ALGORITHMS.RS256 ]: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
} );

/** @type {Object<Number, Object>} */
const VERIFY_PARAMETERS = Object.freeze( {
	[ COSE_ALGORITHMS.EdDSA ]: { name: 'Ed25519' },
	[ COSE_ALGORITHMS.ES256 ]: { name: 'ECDSA', hash: 'SHA-256' },
	[ COSE_ALGORITHMS.RS256 ]: { name: 'RSASSA-PKCS1-v1_5' },
} );

/** @type {TextEncoder} */
const textEncoder = new TextEncoder();

/** @type {TextDecoder} */
const textDecoder = new TextDecoder( 'utf-8', { fatal: true } );

/**
* Odpověď autentizátoru neprošla ověřením (nebo má chybný tvar). API ji vrací jako HTTP 400.
*/
export class WebAuthnError extends Error {}

/** @type {Function} */
export const toBase64Url = function ( /** @type {Uint8Array|ArrayBuffer} */ bytes )
{

	/** @type {String} */
	let binary = '';

	for ( const byte of new Uint8Array( bytes ) ) {
		binary += String.fromCharCode( byte );
	}
	return btoa( binary ).replaceAll( '+', '-' ).replaceAll( '/', '_' ).replace( /=+$/, '' );
};

/** @type {Function} */
export const fromBase64Url = function ( /** @type {String} */ text )
{
	if ( typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test( text ) || text.length % 4 === 1 ) {
		throw new WebAuthnError( 'Hodnota není platný zápis base64url.' );
	}

	/** @type {String} */
	const binary = atob( text.replaceAll( '-', '+' ).replaceAll( '_', '/' ) + '==='.slice( ( text.length + 3 ) % 4 ) );

	return Uint8Array.from( binary, ( /** @type {String} */ character ) => character.charCodeAt( 0 ) );
};

/** @type {Function} */
export const randomBase64Url = function ( /** @type {Number} */ length = 32 )
{
	return toBase64Url( crypto.getRandomValues( new Uint8Array( length ) ) );
};

/** @type {Function} */
export const sha256 = async function ( /** @type {String|Uint8Array} */ data )
{
	return new Uint8Array( await crypto.subtle.digest( 'SHA-256', typeof data === 'string' ? textEncoder.encode( data ) : data ) );
};

/** @type {Function} */
const equalBytes = function ( /** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b )
{
	return a.length === b.length && a.every( ( /** @type {Number} */ byte, /** @type {Number} */ index ) => byte === b[ index ] );
};

/** @type {Function} */
const concatBytes = function ( /** @type {Uint8Array[]} */ ...parts )
{

	/** @type {Uint8Array} */
	const result = new Uint8Array( parts.reduce( ( /** @type {Number} */ sum, /** @type {Uint8Array} */ part ) => sum + part.length, 0 ) );

	/** @type {Number} */
	let offset = 0;

	for ( const part of parts ) {
		result.set( part, offset );
		offset += part.length;
	}
	return result;
};

/**
* Minimální dekodér CBOR (RFC 8949) pro attestationObject a klíč COSE: celá čísla, bajty, text, pole, mapy, true/false/null.
* Mapy vrací jako Map (klíče COSE jsou čísla). Neurčitou délku, štítky a desetinná čísla odmítne – autentizátory je
* v těchto strukturách nepoužívají.
*
* @returns {Array} [ hodnota, pozice za hodnotou ]
*/
export const decodeCbor = function ( /** @type {Uint8Array} */ bytes, /** @type {Number} */ offset = 0, /** @type {Number} */ depth = 0 )
{
	if ( depth > MAX_CBOR_DEPTH ) {
		throw new WebAuthnError( 'CBOR: příliš hluboké vnoření.' );
	}
	if ( offset >= bytes.length ) {
		throw new WebAuthnError( 'CBOR: neočekávaný konec dat.' );
	}

	/** @type {Number} */
	const initial = bytes[ offset++ ];

	/** @type {Number} */
	const major = initial >> 5;

	/** @type {Number} */
	const info = initial & 0x1f;

	/** @type {Number} */
	let argument = info;

	if ( info >= 24 && info <= 27 ) {

		/** @type {Number} */
		const size = 1 << ( info - 24 ); // 1, 2, 4 nebo 8 bajtů

		if ( offset + size > bytes.length ) {
			throw new WebAuthnError( 'CBOR: neočekávaný konec dat.' );
		}
		argument = 0;
		for ( let index = 0; index < size; index++ ) {
			argument = argument * 256 + bytes[ offset++ ];
		}
		if ( !Number.isSafeInteger( argument ) ) {
			throw new WebAuthnError( 'CBOR: číslo je příliš velké.' );
		}
	} else if ( info > 27 ) {
		throw new WebAuthnError( 'CBOR: neurčitá délka ani vyhrazené hodnoty nejsou podporované.' );
	}

	/** @type {Function} */
	const take = function ( /** @type {Number} */ length )
	{
		if ( offset + length > bytes.length ) {
			throw new WebAuthnError( 'CBOR: neočekávaný konec dat.' );
		}

		/** @type {Uint8Array} */
		const part = bytes.slice( offset, offset + length );

		offset += length;
		return part;
	};

	switch ( major ) {
		case 0:
			return [ argument, offset ];
		case 1:
			return [ -1 - argument, offset ];
		case 2:
			return [ take( argument ), offset ];
		case 3:
			try {
				return [ textDecoder.decode( take( argument ) ), offset ];
			} catch ( error ) {
				if ( error instanceof WebAuthnError ) {
					throw error;
				}
				throw new WebAuthnError( 'CBOR: text není platné UTF-8.' );
			}
		case 4: {

			/** @type {Array} */
			const items = [];

			for ( let index = 0; index < argument; index++ ) {

				/** @type {*} */
				let item;

				[ item, offset ] = decodeCbor( bytes, offset, depth + 1 );
				items.push( item );
			}
			return [ items, offset ];
		}
		case 5: {

			/** @type {Map} */
			const map = new Map();

			for ( let index = 0; index < argument; index++ ) {

				/** @type {*} */
				let key;

				/** @type {*} */
				let value;

				[ key, offset ] = decodeCbor( bytes, offset, depth + 1 );
				if ( typeof key !== 'number' && typeof key !== 'string' ) {
					throw new WebAuthnError( 'CBOR: klíč mapy musí být číslo nebo text.' );
				}
				if ( map.has( key ) ) {
					throw new WebAuthnError( 'CBOR: klíč mapy se opakuje.' );
				}
				[ value, offset ] = decodeCbor( bytes, offset, depth + 1 );
				map.set( key, value );
			}
			return [ map, offset ];
		}
		case 7:
			switch ( info ) {
				case 20:
					return [ false, offset ];
				case 21:
					return [ true, offset ];
				case 22:
					return [ null, offset ];
			}
			break;
	}
	throw new WebAuthnError( 'CBOR: nepodporovaný typ hodnoty.' );
};

/**
* Data autentizátoru (WebAuthn L3, 6.1): hash RP ID, příznaky, počítadlo podpisů, u registrace i nový klíč.
*/
export const parseAuthenticatorData = function ( /** @type {Uint8Array} */ bytes )
{
	if ( bytes.length < 37 ) {
		throw new WebAuthnError( 'Data autentizátoru jsou příliš krátká.' );
	}

	/** @type {Number} */
	const flags = bytes[ 32 ];

	/** @type {Object} */
	const result = {
		rpIdHash: bytes.slice( 0, 32 ),
		userPresent: Boolean( flags & FLAGS.USER_PRESENT ),
		userVerified: Boolean( flags & FLAGS.USER_VERIFIED ),
		backupEligible: Boolean( flags & FLAGS.BACKUP_ELIGIBLE ),
		backedUp: Boolean( flags & FLAGS.BACKED_UP ),
		signCount: new DataView( bytes.buffer, bytes.byteOffset + 33, 4 ).getUint32( 0 ),
		credentialId: null,
		credentialPublicKey: null,
	};

	/** @type {Number} */
	let offset = 37;

	if ( result.backedUp && !result.backupEligible ) {
		throw new WebAuthnError( 'Data autentizátoru: klíč je zálohovaný, ale zálohovat se nesmí (příznaky BE/BS).' );
	}
	if ( flags & FLAGS.ATTESTED_CREDENTIAL_DATA ) {
		if ( bytes.length < offset + 18 ) {
			throw new WebAuthnError( 'Data autentizátoru: chybí údaje o novém klíči.' );
		}
		offset += 16; // AAGUID (model autentizátoru) – bez atestace se mu nedá věřit, nepoužívá se

		/** @type {Number} */
		const idLength = ( bytes[ offset ] << 8 ) | bytes[ offset + 1 ];

		offset += 2;
		if ( idLength === 0 || idLength > MAX_CREDENTIAL_ID_LENGTH || bytes.length < offset + idLength ) {
			throw new WebAuthnError( 'Data autentizátoru: neplatná délka ID klíče.' );
		}
		result.credentialId = bytes.slice( offset, offset + idLength );
		offset += idLength;
		[ result.credentialPublicKey, offset ] = decodeCbor( bytes, offset );
		if ( !( result.credentialPublicKey instanceof Map ) ) {
			throw new WebAuthnError( 'Data autentizátoru: veřejný klíč není klíč COSE.' );
		}
	}
	if ( flags & FLAGS.EXTENSION_DATA ) {
		[ , offset ] = decodeCbor( bytes, offset ); // výstupy rozšíření se nepoužívají, jen se přeskočí
	}
	if ( offset !== bytes.length ) {
		throw new WebAuthnError( 'Data autentizátoru mají na konci nečekané bajty.' );
	}
	return result;
};

/**
* Klíč COSE (RFC 9053) → JWK pro crypto.subtle.importKey().
*
* @returns {Object} { jwk, algorithm }
*/
export const coseKeyToJwk = function ( /** @type {Map} */ coseKey )
{

	/** @type {Function} */
	const bytesOf = function ( /** @type {Number} */ label, /** @type {Number|null} */ length = null )
	{

		/** @type {*} */
		const value = coseKey.get( label );

		if ( !( value instanceof Uint8Array ) || ( length !== null && value.length !== length ) ) {
			throw new WebAuthnError( 'Klíč COSE má neplatný parametr ' + label + '.' );
		}
		return toBase64Url( value );
	};

	/** @type {*} */
	const keyType = coseKey.get( 1 );

	/** @type {*} */
	const algorithm = coseKey.get( 3 );

	/** @type {*} */
	const curve = coseKey.get( -1 );

	if ( algorithm === COSE_ALGORITHMS.ES256 && keyType === 2 && curve === 1 ) { // EC2, P-256
		return { jwk: { kty: 'EC', crv: 'P-256', x: bytesOf( -2, 32 ), y: bytesOf( -3, 32 ) }, algorithm };
	}
	if ( algorithm === COSE_ALGORITHMS.EdDSA && keyType === 1 && curve === 6 ) { // OKP, Ed25519
		return { jwk: { kty: 'OKP', crv: 'Ed25519', x: bytesOf( -2, 32 ) }, algorithm };
	}
	if ( algorithm === COSE_ALGORITHMS.RS256 && keyType === 3 ) {

		/** @type {String} */
		const modulus = bytesOf( -1 );

		if ( fromBase64Url( modulus ).length < 256 ) {
			throw new WebAuthnError( 'Klíč RSA je kratší než 2048 bitů.' );
		}
		return { jwk: { kty: 'RSA', n: modulus, e: bytesOf( -2 ) }, algorithm };
	}
	throw new WebAuthnError( 'Nepodporovaný typ klíče nebo algoritmus (podporované jsou EdDSA, ES256 a RS256).' );
};

/** @type {Function} */
export const importPublicKey = async function ( /** @type {Object} */ jwk, /** @type {Number} */ algorithm )
{
	if ( !IMPORT_PARAMETERS[ algorithm ] ) {
		throw new WebAuthnError( 'Nepodporovaný algoritmus klíče.' );
	}
	try {
		return await crypto.subtle.importKey( 'jwk', jwk, IMPORT_PARAMETERS[ algorithm ], false, [ 'verify' ] );
	} catch {
		throw new WebAuthnError( 'Veřejný klíč nejde načíst.' );
	}
};

/**
* Podpis ECDSA z autentizátoru je v ASN.1 DER (SEQUENCE { INTEGER r, INTEGER s }), Web Crypto chce r ‖ s (2 × 32 B).
*/
export const derToRawEcdsaSignature = function ( /** @type {Uint8Array} */ der, /** @type {Number} */ size = 32 )
{

	/** @type {Number} */
	let offset = 0;

	/** @type {Function} */
	const fail = function ()
	{
		throw new WebAuthnError( 'Podpis ECDSA nemá platný tvar DER.' );
	};

	if ( der[ offset++ ] !== 0x30 ) {
		fail();
	}

	/** @type {Number} */
	let sequenceLength = der[ offset++ ];

	if ( sequenceLength === 0x81 ) {
		sequenceLength = der[ offset++ ];
	} else if ( sequenceLength & 0x80 ) {
		fail();
	}
	if ( offset + sequenceLength !== der.length ) {
		fail();
	}

	/** @type {Function} */
	const readInteger = function ()
	{
		if ( der[ offset++ ] !== 0x02 ) {
			fail();
		}

		/** @type {Number} */
		const length = der[ offset++ ];

		if ( !length || length > size + 1 || offset + length > der.length ) {
			fail();
		}

		/** @type {Uint8Array} */
		let integer = der.subarray( offset, offset + length );

		offset += length;
		while ( integer.length > size && integer[ 0 ] === 0 ) {
			integer = integer.subarray( 1 );
		}
		if ( integer.length > size ) {
			fail();
		}

		/** @type {Uint8Array} */
		const padded = new Uint8Array( size );

		padded.set( integer, size - integer.length );
		return padded;
	};

	/** @type {Uint8Array} */
	const r = readInteger();

	/** @type {Uint8Array} */
	const s = readInteger();

	if ( offset !== der.length ) {
		fail();
	}
	return concatBytes( r, s );
};

/**
* Tvar odpovědi z prohlížeče (PublicKeyCredential převedený na JSON v js/modules/passkey-login.mjs šablony).
*
* @returns {Uint8Array} rawId
*/
const checkCredentialShape = function ( /** @type {Object} */ credential, /** @type {String[]} */ responseFields )
{
	if ( !credential || typeof credential !== 'object' || credential.type !== 'public-key' || typeof credential.id !== 'string' || !credential.response || typeof credential.response !== 'object' ) {
		throw new WebAuthnError( 'Odpověď autentizátoru nemá očekávaný tvar.' );
	}
	for ( const field of responseFields ) {
		if ( typeof credential.response[ field ] !== 'string' ) {
			throw new WebAuthnError( 'Odpovědi autentizátoru chybí ' + field + '.' );
		}
	}

	/** @type {Uint8Array} */
	const rawId = fromBase64Url( credential.rawId ?? credential.id );

	if ( !rawId.length || rawId.length > MAX_CREDENTIAL_ID_LENGTH || toBase64Url( rawId ) !== credential.id ) {
		throw new WebAuthnError( 'ID klíče v odpovědi nesouhlasí.' );
	}
	return rawId;
};

/**
* Přečte clientDataJSON bez ověření – API podle výzvy (challenge) najde, k čemu odpověď patří. Ověření pak dělá
* verifyRegistrationResponse() / verifyAuthenticationResponse().
*
* @returns {Object} { type, challenge, origin, crossOrigin?, topOrigin? }
*/
export const readClientData = function ( /** @type {Object} */ credential, /** @type {String} */ expectedType )
{
	checkCredentialShape( credential, [ 'clientDataJSON' ] );

	/** @type {Object} */
	let clientData;

	try {
		clientData = JSON.parse( textDecoder.decode( fromBase64Url( credential.response.clientDataJSON ) ) );
	} catch {
		throw new WebAuthnError( 'clientDataJSON není platný JSON.' );
	}
	if ( !clientData || typeof clientData !== 'object' || clientData.type !== expectedType || typeof clientData.challenge !== 'string' || typeof clientData.origin !== 'string' ) {
		throw new WebAuthnError( 'clientDataJSON nemá očekávaný typ ani tvar.' );
	}
	return clientData;
};

/** @type {Function} */
const verifyClientData = function ( /** @type {Object} */ clientData, /** @type {Object} */ expected )
{
	if ( clientData.challenge !== expected.challenge ) {
		throw new WebAuthnError( 'Výzva v odpovědi nesouhlasí.' );
	}
	if ( !expected.origins.includes( clientData.origin ) ) {
		throw new WebAuthnError( 'Odpověď pochází z nepovolené adresy ' + clientData.origin + '.' );
	}
	if ( clientData.crossOrigin === true || clientData.topOrigin !== undefined ) {
		throw new WebAuthnError( 'Přihlášení z cizího rámu (iframe) není povolené.' );
	}
};

/** @type {Function} */
const verifyAuthenticatorFlags = async function ( /** @type {Object} */ authenticatorData, /** @type {Object} */ expected )
{
	if ( !equalBytes( authenticatorData.rpIdHash, await sha256( expected.rpId ) ) ) {
		throw new WebAuthnError( 'Klíč patří jinému webu (RP ID nesouhlasí).' );
	}
	if ( !authenticatorData.userPresent ) {
		throw new WebAuthnError( 'Autentizátor nepotvrdil přítomnost uživatele.' );
	}
	if ( expected.requireUserVerification && !authenticatorData.userVerified ) {
		throw new WebAuthnError( 'Autentizátor neověřil uživatele (PIN, biometrie).' );
	}
};

/**
* Registrace nového klíče (WebAuthn L3, 7.1).
*
* @param {Object} credential odpověď navigator.credentials.create() převedená na JSON
* @param {Object} expected { challenge, origins: String[], rpId, requireUserVerification }
* @returns {Object} údaje klíče k uložení
*/
export const verifyRegistrationResponse = async function ( credential, expected )
{

	/** @type {Uint8Array} */
	const rawId = checkCredentialShape( credential, [ 'clientDataJSON', 'attestationObject' ] );

	verifyClientData( readClientData( credential, CLIENT_DATA_TYPES.CREATE ), expected );

	/** @type {Uint8Array} */
	const attestationBytes = fromBase64Url( credential.response.attestationObject );

	const [ attestation, end ] = decodeCbor( attestationBytes );

	if ( end !== attestationBytes.length || !( attestation instanceof Map ) || typeof attestation.get( 'fmt' ) !== 'string' || !( attestation.get( 'authData' ) instanceof Uint8Array ) ) {
		throw new WebAuthnError( 'attestationObject nemá očekávaný tvar.' );
	}

	/** @type {Object} */
	const authenticatorData = parseAuthenticatorData( attestation.get( 'authData' ) );

	await verifyAuthenticatorFlags( authenticatorData, expected );
	if ( !authenticatorData.credentialId ) {
		throw new WebAuthnError( 'Odpověď neobsahuje nový klíč.' );
	}
	if ( !equalBytes( authenticatorData.credentialId, rawId ) ) {
		throw new WebAuthnError( 'ID klíče v datech autentizátoru nesouhlasí.' );
	}

	const { jwk, algorithm } = coseKeyToJwk( authenticatorData.credentialPublicKey );

	if ( !SUPPORTED_ALGORITHMS.includes( algorithm ) ) {
		throw new WebAuthnError( 'Algoritmus klíče server nenabídl.' );
	}
	await importPublicKey( jwk, algorithm ); // ověří, že klíč jde použít (např. bod leží na křivce)

	/** @type {String[]} */
	const transports = Array.isArray( credential.response.transports ) ? credential.response.transports.filter( ( /** @type {*} */ transport ) => KNOWN_TRANSPORTS.includes( transport ) ) : [];

	return {
		credentialId: credential.id,
		publicKey: jwk,
		algorithm,
		signCount: authenticatorData.signCount,
		transports: [ ...new Set( transports ) ].sort(),
		backupEligible: authenticatorData.backupEligible,
		backedUp: authenticatorData.backedUp,
		userVerified: authenticatorData.userVerified,
	};
};

/**
* Přihlášení existujícím klíčem (WebAuthn L3, 7.2).
*
* @param {Object} credential odpověď navigator.credentials.get() převedená na JSON
* @param {Object} expected { challenge, origins: String[], rpId, requireUserVerification, publicKey: JWK, algorithm, signCount }
* @returns {Object} { signCount, backedUp, userVerified }
*/
export const verifyAuthenticationResponse = async function ( credential, expected )
{
	checkCredentialShape( credential, [ 'clientDataJSON', 'authenticatorData', 'signature' ] );
	verifyClientData( readClientData( credential, CLIENT_DATA_TYPES.GET ), expected );

	/** @type {Uint8Array} */
	const authenticatorDataBytes = fromBase64Url( credential.response.authenticatorData );

	/** @type {Object} */
	const authenticatorData = parseAuthenticatorData( authenticatorDataBytes );

	await verifyAuthenticatorFlags( authenticatorData, expected );

	/** @type {CryptoKey} */
	const key = await importPublicKey( expected.publicKey, expected.algorithm );

	/** @type {Uint8Array} */
	let signature = fromBase64Url( credential.response.signature );

	if ( expected.algorithm === COSE_ALGORITHMS.ES256 ) {
		signature = derToRawEcdsaSignature( signature );
	}

	/** @type {Uint8Array} */
	const signedData = concatBytes( authenticatorDataBytes, await sha256( fromBase64Url( credential.response.clientDataJSON ) ) );

	if ( !await crypto.subtle.verify( VERIFY_PARAMETERS[ expected.algorithm ], key, signature, signedData ) ) {
		throw new WebAuthnError( 'Podpis nesouhlasí.' );
	}

	/** @type {Number} */
	const storedSignCount = Number( expected.signCount ) || 0;

	// Synchronizované přístupové klíče počítadlo nepoužívají (vždy 0). Když ho klíč používá a hodnota neroste, může jít
	// o kopii klíče – specifikace nechává rozhodnutí na serveru, tady se přihlášení odmítne.
	if ( ( authenticatorData.signCount !== 0 || storedSignCount !== 0 ) && authenticatorData.signCount <= storedSignCount ) {
		throw new WebAuthnError( 'Počítadlo podpisů klíče neroste – klíč mohl být zkopírován.' );
	}
	return {
		signCount: authenticatorData.signCount,
		backedUp: authenticatorData.backedUp,
		userVerified: authenticatorData.userVerified,
	};
};
