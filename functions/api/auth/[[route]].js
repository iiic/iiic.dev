/**
* [2026-11-25] API přihlašování přístupovými klíči (WebAuthn, passkeys) – Cloudflare Pages Function pro /api/auth/*.
* Účty jsou v databázi Cloudflare D1 (vazba DB, schéma v migrations/). Volá ho widget „Přihlášení přístupovým klíčem“
* šablony domdocument-template (js/modules/passkey-login.mjs) na statickém webu.
* [2026-11-25] Jeden účet všude: D1 je jediný zdroj účtů. WordPress přihlašuje přes stránku „Přihlášení přístupovým
* klíčem“ na statickém webu – ta si od API vyžádá podepsaný token (POST sso/token) a vrátí ho WordPressu, který ho ověří
* veřejným klíčem (GET sso/public-key) a přihlásí propojený účet WordPressu.
*
*   POST   /api/auth/register/options  { displayName }  → volby pro navigator.credentials.create() (nový účet)
*   POST   /api/auth/register          { credential }   → založí účet a přihlásí (cookie)
*   POST   /api/auth/login/options     {}               → volby pro navigator.credentials.get() (klíč vybere uživatel)
*   POST   /api/auth/login             { credential }   → přihlásí (cookie)
*   POST   /api/auth/logout                             → odhlásí (smaže relaci i cookie)
*   GET    /api/auth/me                                 → přihlášený uživatel a jeho klíče, nebo { user: null }
*   PATCH  /api/auth/me                { displayName }  → změna jména v profilu
*   DELETE /api/auth/me                                 → smaže účet, jeho klíče a relace
*   POST   /api/auth/passkeys/options  {}               → volby pro přidání dalšího klíče k účtu
*   POST   /api/auth/passkeys          { credential }   → přidá klíč
*   DELETE /api/auth/passkeys/{id}                      → odebere klíč (ne poslední)
*   GET    /api/auth/sso/public-key                     → veřejný klíč pro ověření tokenů (JWKS, veřejné, CORS pro všechny)
*   POST   /api/auth/sso/token     { returnUrl, state } → podepsaný token pro přihlášení do webu z ALLOWED_ORIGINS
*                                                         (WordPress), vrátí { redirect } = returnUrl s tokenem
*
* Odpověď je vždy JSON. Chyba: { error: kód z ERRORS, message: popis } – widget podle kódu zobrazí přeložený text.
*
* Nastavení (proměnné prostředí Pages, wrangler.toml [vars] nebo `wrangler pages dev --binding KLÍČ=hodnota`):
*   RP_ID            doména, ke které patří přístupové klíče; výchozí = doména, na které API běží
*   RP_NAME          název webu v dialogu prohlížeče; výchozí = RP_ID
*   ALLOWED_ORIGINS  další adresy (origin) oddělené čárkou, ze kterých smí stránky API volat (CORS s cookies)
*                    a do kterých smí API vydat token pro přihlášení (web WordPressu, např. http://localhost);
*                    adresa, na které API běží, je povolená vždy
*   SSO_PRIVATE_KEY  tajná proměnná: soukromý klíč Ed25519 (JWK) pro podpis tokenů pro WordPress (functions/README.md)
*
* Ochrana: cookie relace je __Host-, HttpOnly, Secure, SameSite=Strict, v databázi je jen její hash; požadavky, které
* mění data, musí mít hlavičku Origin z povolených adres; těla jsou jen application/json (cizí stránka je bez CORS
* nepošle); výzvy jsou jednorázové s omezenou platností.
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/functions/), export „Vygenerovat statické
* soubory“ ho kopíruje do repozitáře statického webu – upravovat ho ve šabloně. Popis: functions/README.md.
*/

import {
	CLIENT_DATA_TYPES,
	SUPPORTED_ALGORITHMS,
	WebAuthnError,
	fromBase64Url,
	randomBase64Url,
	readClientData,
	sha256,
	toBase64Url,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from '../../_lib/webauthn.js';
import { SsoKeyError, createSsoToken, importSsoPrivateKey } from '../../_lib/sso-token.js';

/** @type {String} */
const SESSION_COOKIE = '__Host-ddt-session'; // __Host-: jen Secure, Path=/, bez Domain – cookie nejde podvrhnout ze subdomény

/** @type {Number} */
const SESSION_TTL = 30 * 24 * 60 * 60; // s

/** @type {Number} */
const CEREMONY_TIMEOUT = 5 * 60 * 1000; // ms – jak dlouho prohlížeč čeká na autentizátor

/** @type {Number} */
const CHALLENGE_TTL = CEREMONY_TIMEOUT / 1000 + 60; // s – platnost výzvy (timeout + rezerva na síť)

/** @type {Number} */
const MAX_BODY_LENGTH = 16 * 1024; // znaků JSON (odpověď s klíčem RSA má ~2 kB)

/** @type {Number} */
const MAX_DISPLAY_NAME_LENGTH = 64; // znaků

/** @type {Number} */
const MAX_PASSKEYS = 20; // klíčů na jeden účet

/** @type {String} */
const USER_VERIFICATION = 'preferred'; // PIN / biometrie, když ji autentizátor umí; bezpečnostní klíč bez PINu stačí potvrdit dotykem

/** @type {Object<String, String>} */
/** @type {Number} */
const SSO_TOKEN_TTL = 120; // s – platnost tokenu pro WordPress (přesměrování zpět trvá chvilku; \VARS\PASSKEY_LOGIN::TOKEN_MAX_AGE je delší)

/** @type {String} */
const SSO_TOKEN_PARAMETER = 'ddt_passkey_token'; // parametr adresy s tokenem; \VARS\PASSKEY_LOGIN::TOKEN_PARAMETER

/** @type {RegExp} */
const SSO_STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/; // náhodná hodnota od WordPressu, vrací se v tokenu jako nonce

/** @type {String[]} */
const PUBLIC_ROUTES = [ 'GET sso/public-key' ]; // bez kontroly hlavičky Origin a s CORS pro všechny (nic tajného)

/** @type {Object<String, String>} */
const PURPOSES = Object.freeze( { // k čemu je výzva (tabulka challenges)
	REGISTER: 'register',
	LOGIN: 'login',
	ADD_PASSKEY: 'add-passkey',
} );

/** @type {Object<String, String>} */
const ERRORS = Object.freeze( { // kódy chyb – stejné klíče má widget v textech (\WIDGET\PasskeyLogin::getTexts())
	INVALID_REQUEST: 'invalid-request',
	INVALID_NAME: 'invalid-name',
	UNSUPPORTED_MEDIA_TYPE: 'unsupported-media-type',
	PAYLOAD_TOO_LARGE: 'payload-too-large',
	FORBIDDEN_ORIGIN: 'forbidden-origin',
	NOT_FOUND: 'not-found',
	METHOD_NOT_ALLOWED: 'method-not-allowed',
	CHALLENGE_EXPIRED: 'challenge-expired',
	VERIFICATION_FAILED: 'verification-failed',
	UNKNOWN_CREDENTIAL: 'unknown-credential',
	PASSKEY_EXISTS: 'passkey-exists',
	UNAUTHENTICATED: 'unauthenticated',
	LAST_PASSKEY: 'last-passkey',
	TOO_MANY_PASSKEYS: 'too-many-passkeys',
	INVALID_RETURN_URL: 'invalid-return-url', // [2026-11-25] web, do kterého se má přihlásit, není v ALLOWED_ORIGINS
	SERVER_MISCONFIGURED: 'server-misconfigured',
	SERVER_ERROR: 'server-error',
} );

/**
* Očekávaná chyba s HTTP stavem a kódem pro widget.
*/
class HttpError extends Error {

	constructor ( /** @type {Number} */ status, /** @type {String} */ code, /** @type {String} */ message, /** @type {Object} */ headers = {} )
	{
		super( message );
		this.status = status;
		this.code = code;
		this.headers = headers;
	}

}

/** @type {Function} */
const now = function ()
{
	return Math.floor( Date.now() / 1000 );
};

/** @type {Function} */
const json = function ( /** @type {Object} */ data, /** @type {Number} */ status = 200, /** @type {Object} */ headers = {} )
{
	return new Response( JSON.stringify( data ), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
			...headers,
		},
	} );
};

/** @type {Function} */
const toOrigin = function ( /** @type {String} */ address )
{
	try {

		/** @type {String} */
		const origin = new URL( address ).origin;

		return origin === 'null' ? null : origin;
	} catch {
		return null;
	}
};

/** @type {Function} */
const getConfig = function ( /** @type {Request} */ request, /** @type {Object} */ env )
{

	/** @type {URL} */
	const url = new URL( request.url );

	/** @type {String[]} */
	const extraOrigins = String( env.ALLOWED_ORIGINS ?? '' ).split( /[\s,]+/ ).filter( Boolean ).map( toOrigin ).filter( Boolean );

	/** @type {String} */
	const rpId = String( env.RP_ID || url.hostname ).toLowerCase();

	return {
		origin: url.origin,
		allowedOrigins: [ ...new Set( [ url.origin, ...extraOrigins ] ) ],
		rpId,
		rpName: String( env.RP_NAME || rpId ),
	};
};

/** @type {Function} */
const corsHeaders = function ( /** @type {String|null} */ origin, /** @type {Object} */ config )
{
	if ( !origin || origin === config.origin || !config.allowedOrigins.includes( origin ) ) {
		return {};
	}
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Credentials': 'true',
	};
};

/** @type {Function} */
const readJson = async function ( /** @type {Request} */ request )
{
	if ( !( request.headers.get( 'Content-Type' ) ?? '' ).toLowerCase().startsWith( 'application/json' ) ) {
		throw new HttpError( 415, ERRORS.UNSUPPORTED_MEDIA_TYPE, 'Tělo požadavku musí být application/json.' );
	}

	/** @type {String} */
	const text = await request.text();

	if ( text.length > MAX_BODY_LENGTH ) {
		throw new HttpError( 413, ERRORS.PAYLOAD_TOO_LARGE, 'Požadavek je příliš velký.' );
	}

	/** @type {*} */
	let data;

	try {
		data = JSON.parse( text );
	} catch {
		data = null;
	}
	if ( !data || typeof data !== 'object' || Array.isArray( data ) ) {
		throw new HttpError( 400, ERRORS.INVALID_REQUEST, 'Tělo požadavku není objekt JSON.' );
	}
	return data;
};

/** @type {Function} */
const cleanDisplayName = function ( /** @type {*} */ value )
{

	/** @type {String} */
	const name = typeof value === 'string' ? value.normalize( 'NFC' ).replace( /\s+/gu, ' ' ).trim() : '';

	// řídicí znaky a přepínače směru textu (dají se zneužít k podvržení zobrazeného jména)
	if ( name === '' || [ ...name ].length > MAX_DISPLAY_NAME_LENGTH || /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test( name ) ) {
		throw new HttpError( 400, ERRORS.INVALID_NAME, `Jméno musí mít 1 až ${ MAX_DISPLAY_NAME_LENGTH } znaků bez řídicích znaků.` );
	}
	return name;
};

/** @type {Function} */
const readCookie = function ( /** @type {Request} */ request, /** @type {String} */ name )
{
	for ( const part of ( request.headers.get( 'Cookie' ) ?? '' ).split( ';' ) ) {

		/** @type {Number} */
		const index = part.indexOf( '=' );

		if ( index > -1 && part.slice( 0, index ).trim() === name ) {
			return part.slice( index + 1 ).trim();
		}
	}
	return null;
};

/** @type {Function} */
const sessionCookie = function ( /** @type {String} */ token, /** @type {Number} */ maxAge = SESSION_TTL )
{
	return `${ SESSION_COOKIE }=${ token }; Path=/; Max-Age=${ maxAge }; HttpOnly; Secure; SameSite=Strict`;
};

/** @type {Function} */
const getSession = async function ( /** @type {Request} */ request, /** @type {Object} */ env )
{

	/** @type {String|null} */
	const token = readCookie( request, SESSION_COOKIE );

	if ( !token || !/^[A-Za-z0-9_-]{43}$/.test( token ) ) {
		return null;
	}

	/** @type {String} */
	const tokenHash = toBase64Url( await sha256( token ) );

	/** @type {Object|null} */
	const row = await env.DB.prepare(
		'SELECT s.credential_id, u.id, u.display_name, u.created_at FROM sessions AS s JOIN users AS u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'
	).bind( tokenHash, now() ).first();

	return row ? { tokenHash, credentialId: row.credential_id, user: { id: row.id, displayName: row.display_name, createdAt: row.created_at } } : null;
};

/** @type {Function} */
const requireSession = async function ( /** @type {Request} */ request, /** @type {Object} */ env )
{

	/** @type {Object|null} */
	const session = await getSession( request, env );

	if ( !session ) {
		throw new HttpError( 401, ERRORS.UNAUTHENTICATED, 'Nejste přihlášeni nebo přihlášení vypršelo.', readCookie( request, SESSION_COOKIE ) === null ? {} : { 'Set-Cookie': sessionCookie( '', 0 ) } );
	}
	return session;
};

/**
* Nová relace: příkazy pro env.DB.batch() (spolu se zápisem účtu nebo klíče v jedné transakci) a token pro cookie.
*/
const newSession = async function ( /** @type {Object} */ env, /** @type {String} */ userId, /** @type {String} */ credentialId )
{

	/** @type {String} */
	const token = randomBase64Url( 32 );

	/** @type {Number} */
	const time = now();

	return {
		token,
		statements: [
			env.DB.prepare( 'DELETE FROM sessions WHERE expires_at <= ?' ).bind( time ),
			env.DB.prepare( 'INSERT INTO sessions ( token_hash, user_id, credential_id, created_at, expires_at ) VALUES ( ?, ?, ?, ?, ? )' ).bind( toBase64Url( await sha256( token ) ), userId, credentialId, time, time + SESSION_TTL ),
		],
	};
};

/** @type {Function} */
const createChallenge = async function ( /** @type {Object} */ env, /** @type {String} */ purpose, /** @type {String|null} */ userId = null, /** @type {String|null} */ displayName = null )
{

	/** @type {String} */
	const challenge = randomBase64Url( 32 );

	/** @type {Number} */
	const time = now();

	await env.DB.batch( [
		env.DB.prepare( 'DELETE FROM challenges WHERE expires_at <= ?' ).bind( time ),
		env.DB.prepare( 'INSERT INTO challenges ( challenge, purpose, user_id, display_name, expires_at ) VALUES ( ?, ?, ?, ?, ? )' ).bind( challenge, purpose, userId, displayName, time + CHALLENGE_TTL ),
	] );
	return challenge;
};

/**
* Výzvu z odpovědi autentizátoru smaže a vrátí její záznam – každá výzva jde použít jen jednou.
*/
const consumeChallenge = async function ( /** @type {Object} */ env, /** @type {String} */ challenge, /** @type {String} */ purpose )
{

	/** @type {Object|null} */
	const row = challenge.length <= 128 ? await env.DB.prepare(
		'DELETE FROM challenges WHERE challenge = ? AND purpose = ? RETURNING user_id, display_name, expires_at'
	).bind( challenge, purpose ).first() : null;

	if ( !row || row.expires_at <= now() ) {
		throw new HttpError( 400, ERRORS.CHALLENGE_EXPIRED, 'Výzva neexistuje, už byla použita nebo vypršela.' );
	}
	return row;
};

/** @type {Function} */
const expectedFor = function ( /** @type {Object} */ config, /** @type {String} */ challenge )
{
	return {
		challenge,
		origins: config.allowedOrigins,
		rpId: config.rpId,
		requireUserVerification: USER_VERIFICATION === 'required',
	};
};

/** @type {Function} */
const parseTransports = function ( /** @type {String} */ value )
{
	try {

		/** @type {*} */
		const transports = JSON.parse( value );

		return Array.isArray( transports ) ? transports : [];
	} catch {
		return [];
	}
};

/** @type {Function} */
const listPasskeys = async function ( /** @type {Object} */ env, /** @type {String} */ userId )
{

	/** @type {Object} */
	const { results } = await env.DB.prepare(
		'SELECT id, transports, backup_eligible, backed_up, created_at, last_used_at FROM credentials WHERE user_id = ? ORDER BY rowid' // pořadí přidání (created_at má jen sekundy)
	).bind( userId ).all();

	return results.map( ( /** @type {Object} */ row ) => ( {
		id: row.id,
		transports: parseTransports( row.transports ),
		backupEligible: Boolean( row.backup_eligible ),
		backedUp: Boolean( row.backed_up ),
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
	} ) );
};

/**
* Odpověď s přihlášeným uživatelem: { rpId, user, passkeys } – rpId potřebuje prohlížeč pro Signal API
* (PublicKeyCredential.signal…(), správce hesel si podle něj aktualizuje jméno a smazané klíče).
*/
const accountResponse = async function ( /** @type {Object} */ env, /** @type {Object} */ config, /** @type {Object} */ user, /** @type {String|null} */ currentCredentialId, /** @type {Number} */ status = 200, /** @type {Object} */ headers = {} )
{

	/** @type {Object[]} */
	const passkeys = ( await listPasskeys( env, user.id ) ).map( ( /** @type {Object} */ passkey ) => ( { ...passkey, current: passkey.id === currentCredentialId } ) );

	return json( { rpId: config.rpId, user, passkeys }, status, headers );
};

/** @type {Function} */
const creationOptions = function ( /** @type {Object} */ config, /** @type {String} */ challenge, /** @type {Object} */ user, /** @type {Object[]} */ existingPasskeys = [] )
{
	return { // PublicKeyCredentialCreationOptionsJSON
		challenge,
		rp: { id: config.rpId, name: config.rpName },
		user: { id: user.id, name: user.displayName, displayName: user.displayName },
		pubKeyCredParams: SUPPORTED_ALGORITHMS.map( ( /** @type {Number} */ alg ) => ( { type: 'public-key', alg } ) ),
		timeout: CEREMONY_TIMEOUT,
		excludeCredentials: existingPasskeys.map( ( /** @type {Object} */ passkey ) => ( { type: 'public-key', id: passkey.id, transports: passkey.transports } ) ),
		authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: USER_VERIFICATION },
		attestation: 'none',
		extensions: { credProps: true },
	};
};

/** @type {Function} */
const credentialExists = async function ( /** @type {Object} */ env, /** @type {String} */ credentialId )
{
	return Boolean( await env.DB.prepare( 'SELECT 1 AS found FROM credentials WHERE id = ?' ).bind( credentialId ).first() );
};

/** @type {Function} */
const insertCredentialStatement = function ( /** @type {Object} */ env, /** @type {String} */ userId, /** @type {Object} */ passkey, /** @type {Boolean} */ usedToLogIn )
{

	/** @type {Number} */
	const time = now();

	return env.DB.prepare(
		'INSERT INTO credentials ( id, user_id, public_key, algorithm, sign_count, transports, backup_eligible, backed_up, created_at, last_used_at ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ?, ? )'
	).bind( passkey.credentialId, userId, JSON.stringify( passkey.publicKey ), passkey.algorithm, passkey.signCount, JSON.stringify( passkey.transports ), passkey.backupEligible ? 1 : 0, passkey.backedUp ? 1 : 0, time, usedToLogIn ? time : null );
};

/** @type {Object<String, Function>} */
const handlers = {

	'POST register/options': async function ( { request, env, config } )
	{

		/** @type {String} */
		const displayName = cleanDisplayName( ( await readJson( request ) ).displayName );

		/** @type {String} */
		const userId = randomBase64Url( 32 );

		return json( creationOptions( config, await createChallenge( env, PURPOSES.REGISTER, userId, displayName ), { id: userId, displayName } ) );
	},

	'POST register': async function ( { request, env, config } )
	{

		/** @type {Object} */
		const { credential } = await readJson( request );

		/** @type {Object} */
		const clientData = readClientData( credential, CLIENT_DATA_TYPES.CREATE );

		/** @type {Object} */
		const challenge = await consumeChallenge( env, clientData.challenge, PURPOSES.REGISTER );

		/** @type {Object} */
		const passkey = await verifyRegistrationResponse( credential, expectedFor( config, clientData.challenge ) );

		if ( await credentialExists( env, passkey.credentialId ) ) {
			throw new HttpError( 409, ERRORS.PASSKEY_EXISTS, 'Tento přístupový klíč už je u účtu uložený.' );
		}

		/** @type {Object} */
		const user = { id: challenge.user_id, displayName: challenge.display_name, createdAt: now() };

		/** @type {Object} */
		const session = await newSession( env, user.id, passkey.credentialId );

		await env.DB.batch( [
			env.DB.prepare( 'INSERT INTO users ( id, display_name, created_at ) VALUES ( ?, ?, ? )' ).bind( user.id, user.displayName, user.createdAt ),
			insertCredentialStatement( env, user.id, passkey, true ), // registrací se uživatel rovnou přihlásí
			...session.statements,
		] );
		return accountResponse( env, config, user, passkey.credentialId, 201, { 'Set-Cookie': sessionCookie( session.token ) } );
	},

	'POST login/options': async function ( { request, env, config } )
	{
		await readJson( request );
		return json( { // PublicKeyCredentialRequestOptionsJSON – bez allowCredentials: prohlížeč nabídne klíče uložené pro tento web
			challenge: await createChallenge( env, PURPOSES.LOGIN ),
			rpId: config.rpId,
			timeout: CEREMONY_TIMEOUT,
			userVerification: USER_VERIFICATION,
			allowCredentials: [],
		} );
	},

	'POST login': async function ( { request, env, config } )
	{

		/** @type {Object} */
		const { credential } = await readJson( request );

		/** @type {Object} */
		const clientData = readClientData( credential, CLIENT_DATA_TYPES.GET );

		await consumeChallenge( env, clientData.challenge, PURPOSES.LOGIN );

		/** @type {Object|null} */
		const stored = await env.DB.prepare(
			'SELECT c.id, c.user_id, c.public_key, c.algorithm, c.sign_count, u.display_name, u.created_at FROM credentials AS c JOIN users AS u ON u.id = c.user_id WHERE c.id = ?'
		).bind( credential.id ).first();

		if ( !stored ) { // účet byl smazaný (klíč v zařízení zůstal) – widget to oznámí správci hesel (signalUnknownCredential)
			throw new HttpError( 404, ERRORS.UNKNOWN_CREDENTIAL, 'Tento přístupový klíč nepatří k žádnému účtu.' );
		}
		if ( credential.response.userHandle != null && credential.response.userHandle !== stored.user_id ) {
			throw new HttpError( 400, ERRORS.VERIFICATION_FAILED, 'Přístupový klíč patří jinému uživateli.' );
		}

		/** @type {Object} */
		const result = await verifyAuthenticationResponse( credential, {
			...expectedFor( config, clientData.challenge ),
			publicKey: JSON.parse( stored.public_key ),
			algorithm: stored.algorithm,
			signCount: stored.sign_count,
		} );

		/** @type {Object} */
		const session = await newSession( env, stored.user_id, stored.id );

		await env.DB.batch( [
			env.DB.prepare( 'UPDATE credentials SET sign_count = ?, backed_up = ?, last_used_at = ? WHERE id = ?' ).bind( result.signCount, result.backedUp ? 1 : 0, now(), stored.id ),
			...session.statements,
		] );
		return accountResponse( env, config, { id: stored.user_id, displayName: stored.display_name, createdAt: stored.created_at }, stored.id, 200, { 'Set-Cookie': sessionCookie( session.token ) } );
	},

	'POST logout': async function ( { request, env } )
	{

		/** @type {Object|null} */
		const session = await getSession( request, env );

		if ( session ) {
			await env.DB.prepare( 'DELETE FROM sessions WHERE token_hash = ?' ).bind( session.tokenHash ).run();
		}
		return json( { user: null, passkeys: [] }, 200, { 'Set-Cookie': sessionCookie( '', 0 ) } );
	},

	'GET me': async function ( { request, env, config } )
	{

		/** @type {Object|null} */
		const session = await getSession( request, env );

		if ( !session ) { // neplatná nebo prošlá cookie se smaže
			return json( { rpId: config.rpId, user: null, passkeys: [] }, 200, readCookie( request, SESSION_COOKIE ) === null ? {} : { 'Set-Cookie': sessionCookie( '', 0 ) } );
		}
		return accountResponse( env, config, session.user, session.credentialId );
	},

	'PATCH me': async function ( { request, env, config } )
	{

		/** @type {Object} */
		const session = await requireSession( request, env );

		/** @type {String} */
		const displayName = cleanDisplayName( ( await readJson( request ) ).displayName );

		await env.DB.prepare( 'UPDATE users SET display_name = ? WHERE id = ?' ).bind( displayName, session.user.id ).run();
		return accountResponse( env, config, { ...session.user, displayName }, session.credentialId );
	},

	'DELETE me': async function ( { request, env, config } )
	{

		/** @type {Object} */
		const session = await requireSession( request, env );

		/** @type {String[]} */
		const deletedPasskeys = ( await listPasskeys( env, session.user.id ) ).map( ( /** @type {Object} */ passkey ) => passkey.id );

		await env.DB.batch( [ // ON DELETE CASCADE by stačil, výslovné mazání nespoléhá na PRAGMA foreign_keys
			env.DB.prepare( 'DELETE FROM sessions WHERE user_id = ?' ).bind( session.user.id ),
			env.DB.prepare( 'DELETE FROM challenges WHERE user_id = ?' ).bind( session.user.id ),
			env.DB.prepare( 'DELETE FROM credentials WHERE user_id = ?' ).bind( session.user.id ),
			env.DB.prepare( 'DELETE FROM users WHERE id = ?' ).bind( session.user.id ),
		] );
		return json( { rpId: config.rpId, user: null, passkeys: [], deletedPasskeys }, 200, { 'Set-Cookie': sessionCookie( '', 0 ) } );
	},

	'POST passkeys/options': async function ( { request, env, config } )
	{

		/** @type {Object} */
		const session = await requireSession( request, env );

		await readJson( request );

		/** @type {Object[]} */
		const passkeys = await listPasskeys( env, session.user.id );

		if ( passkeys.length >= MAX_PASSKEYS ) {
			throw new HttpError( 409, ERRORS.TOO_MANY_PASSKEYS, `Účet může mít nejvýš ${ MAX_PASSKEYS } přístupových klíčů.` );
		}
		return json( creationOptions( config, await createChallenge( env, PURPOSES.ADD_PASSKEY, session.user.id ), session.user, passkeys ) );
	},

	'POST passkeys': async function ( { request, env, config } )
	{

		/** @type {Object} */
		const session = await requireSession( request, env );

		/** @type {Object} */
		const { credential } = await readJson( request );

		/** @type {Object} */
		const clientData = readClientData( credential, CLIENT_DATA_TYPES.CREATE );

		/** @type {Object} */
		const challenge = await consumeChallenge( env, clientData.challenge, PURPOSES.ADD_PASSKEY );

		if ( challenge.user_id !== session.user.id ) {
			throw new HttpError( 400, ERRORS.CHALLENGE_EXPIRED, 'Výzva patří jinému účtu.' );
		}

		/** @type {Object} */
		const passkey = await verifyRegistrationResponse( credential, expectedFor( config, clientData.challenge ) );

		if ( await credentialExists( env, passkey.credentialId ) ) {
			throw new HttpError( 409, ERRORS.PASSKEY_EXISTS, 'Tento přístupový klíč už je u účtu uložený.' );
		}
		await insertCredentialStatement( env, session.user.id, passkey, false ).run(); // naposledy použit = až po přihlášení tímto klíčem
		return accountResponse( env, config, session.user, session.credentialId, 201 );
	},

	'DELETE passkeys/*': async function ( { request, env, config, id } )
	{

		/** @type {Object} */
		const session = await requireSession( request, env );

		/** @type {Object[]} */
		const passkeys = await listPasskeys( env, session.user.id );

		if ( !passkeys.some( ( /** @type {Object} */ passkey ) => passkey.id === id ) ) {
			throw new HttpError( 404, ERRORS.NOT_FOUND, 'Účet takový přístupový klíč nemá.' );
		}
		if ( passkeys.length <= 1 ) {
			throw new HttpError( 409, ERRORS.LAST_PASSKEY, 'Poslední přístupový klíč odebrat nejde, bez něj by se k účtu nedalo přihlásit.' );
		}
		await env.DB.batch( [ // relace přihlášené odebraným klíčem (např. ze ztraceného zařízení) se ukončí, kromě té, ze které se klíč odebírá
			env.DB.prepare( 'DELETE FROM credentials WHERE id = ? AND user_id = ?' ).bind( id, session.user.id ),
			env.DB.prepare( 'DELETE FROM sessions WHERE credential_id = ? AND user_id = ? AND token_hash <> ?' ).bind( id, session.user.id, session.tokenHash ),
		] );
		return accountResponse( env, config, session.user, session.credentialId );
	},

	// [2026-11-25] Jeden účet všude – přihlášení do WordPressu (sso-token.js, functions/README.md „Přihlášení do WordPressu“).

	'GET sso/public-key': async function ( { env } )
	{

		const { publicJwk } = await getSsoKey( env );

		return json( { keys: [ { ...publicJwk, alg: 'EdDSA', use: 'sig' } ] }, 200, { // JWKS
			'Cache-Control': 'public, max-age=300',
			'Access-Control-Allow-Origin': '*', // veřejný klíč smí číst kdokoli (např. stránka nastavení WordPressu)
		} );
	},

	'POST sso/token': async function ( { request, env, config } )
	{

		/** @type {Object} */
		const session = await requireSession( request, env );

		const { returnUrl, state } = await readJson( request );

		/** @type {URL|null} */
		let target = null;

		try {
			target = typeof returnUrl === 'string' ? new URL( returnUrl ) : null;
		} catch {
			target = null;
		}
		if ( !target || ![ 'http:', 'https:' ].includes( target.protocol ) || target.username || target.password || !config.allowedOrigins.includes( target.origin ) ) {
			throw new HttpError( 400, ERRORS.INVALID_RETURN_URL, `Do webu ${ target?.origin ?? String( returnUrl ) } se odsud přihlásit nejde – jeho adresa není v ALLOWED_ORIGINS.` );
		}
		if ( typeof state !== 'string' || !SSO_STATE_PATTERN.test( state ) ) {
			throw new HttpError( 400, ERRORS.INVALID_REQUEST, 'Chybí nebo je neplatný parametr state.' );
		}

		const { privateKey } = await getSsoKey( env );

		/** @type {Number} */
		const time = now();

		target.searchParams.set( SSO_TOKEN_PARAMETER, await createSsoToken( privateKey, {
			iss: config.origin,
			aud: target.origin, // WordPress ověří, že token je pro něj
			sub: session.user.id, // ID účtu v D1 (user handle) – WordPress podle něj najde propojený účet
			name: session.user.displayName,
			nonce: state, // WordPress ho porovná se svou cookie – token nejde použít v jiném prohlížeči
			iat: time,
			exp: time + SSO_TOKEN_TTL,
		} ) );
		target.hash = '';
		return json( { redirect: target.href, audience: target.origin } );
	},

};

/** @type {Map<String, Promise>} */
const ssoKeys = new Map(); // SSO_PRIVATE_KEY → načtený klíč (v jedné instanci Workeru se klíč načte jen jednou)

/** @type {Function} */
const getSsoKey = async function ( /** @type {Object} */ env )
{

	/** @type {String} */
	const value = String( env.SSO_PRIVATE_KEY ?? '' );

	if ( !ssoKeys.has( value ) ) {
		ssoKeys.set( value, importSsoPrivateKey( value ) );
	}
	try {
		return await ssoKeys.get( value );
	} catch ( error ) {
		ssoKeys.delete( value );
		if ( error instanceof SsoKeyError ) {
			throw new HttpError( 500, ERRORS.SERVER_MISCONFIGURED, error.message );
		}
		throw error;
	}
};

/** @type {Function} */
const findHandler = function ( /** @type {String} */ method, /** @type {String[]} */ segments )
{

	/** @type {String} */
	const path = segments.join( '/' );

	/** @type {String|null} */
	let id = null;

	/** @type {String} */
	let pattern = path;

	if ( segments.length === 2 && segments[ 0 ] === 'passkeys' && segments[ 1 ] !== 'options' ) { // passkeys/{id}
		id = segments[ 1 ];
		pattern = 'passkeys/*';
		try {
			fromBase64Url( id );
		} catch {
			return { allowed: [] };
		}
	}

	/** @type {String[]} */
	const allowed = Object.keys( handlers ).filter( ( /** @type {String} */ key ) => key.endsWith( ' ' + pattern ) ).map( ( /** @type {String} */ key ) => key.split( ' ' )[ 0 ] );

	return { handler: handlers[ `${ method } ${ pattern }` ] ?? null, allowed, id, isPublic: PUBLIC_ROUTES.includes( `${ method } ${ pattern }` ) };
};

export const onRequest = async function ( /** @type {EventContext} */ context )
{

	/** @type {Request} */
	const request = context.request;

	/** @type {Object} */
	const config = getConfig( request, context.env );

	/** @type {String|null} */
	const origin = request.headers.get( 'Origin' );

	/** @type {Object} */
	const cors = corsHeaders( origin, config );

	/** @type {Response} */
	let response;

	/** @type {Boolean} [2026-11-26] veřejná adresa (PUBLIC_ROUTES) – CORS pro všechny i u chybové odpovědi */
	let isPublicRoute = false;

	try {

		/** @type {String[]} */
		const segments = [ context.params.route ?? [] ].flat().filter( Boolean );

		const { handler, allowed, id, isPublic } = findHandler( request.method, segments );
		isPublicRoute = isPublic;

		if ( !isPublic && origin !== null && !config.allowedOrigins.includes( origin ) ) {
			throw new HttpError( 403, ERRORS.FORBIDDEN_ORIGIN, `Stránky z adresy ${ origin } toto API volat nesmí (ALLOWED_ORIGINS).` );
		}
		if ( request.method === 'OPTIONS' ) { // předběžný dotaz CORS (jiná adresa, PATCH, DELETE, Content-Type: application/json)
			response = new Response( null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE',
					'Access-Control-Allow-Headers': 'Content-Type',
					'Access-Control-Max-Age': '600',
				},
			} );
		} else {
			if ( origin === null && ![ 'GET', 'HEAD' ].includes( request.method ) ) { // prohlížeč hlavičku Origin u fetch() s POST/PATCH/DELETE posílá vždy
				throw new HttpError( 403, ERRORS.FORBIDDEN_ORIGIN, 'Požadavek nemá hlavičku Origin.' );
			}
			if ( !handler ) {
				throw allowed.length ? new HttpError( 405, ERRORS.METHOD_NOT_ALLOWED, 'Metoda není povolená.', { Allow: allowed.join( ', ' ) } ) : new HttpError( 404, ERRORS.NOT_FOUND, 'Neznámá adresa API.' );
			}
			if ( !context.env.DB ) {
				throw new HttpError( 500, ERRORS.SERVER_MISCONFIGURED, 'Chybí vazba DB na databázi D1 (wrangler.toml, viz functions/README.md).' );
			}
			response = await handler( { request, env: context.env, config, id } );
		}
	} catch ( error ) {
		if ( error instanceof HttpError ) {
			response = json( { error: error.code, message: error.message }, error.status, error.headers );
		} else if ( error instanceof WebAuthnError ) {
			response = json( { error: ERRORS.VERIFICATION_FAILED, message: error.message }, 400 );
		} else {
			console.error( error );
			response = json( { error: ERRORS.SERVER_ERROR, message: 'Chyba serveru.' }, 500 );
		}
	}
	response = new Response( response.body, response ); // hlavičky odpovědi jde měnit jen u kopie
	for ( const [ name, value ] of Object.entries( cors ) ) {
		response.headers.set( name, value );
	}
	// [2026-11-26] Chybu veřejné adresy (např. chybějící SSO_PRIVATE_KEY u sso/public-key) smí přečíst kdokoli, stejně jako
	// úspěšnou odpověď – ukazuje ji nástroj „Nasazení statického webu“ v administraci WordPressu. Dřív měla hlavičku CORS jen
	// úspěšná odpověď a prohlížeč z jiné adresy viděl u chyby jen „Failed to fetch“. Nic tajného v chybě není (stejný text
	// dostane každý požadavek bez Origin).
	if ( isPublicRoute && !response.headers.has( 'Access-Control-Allow-Origin' ) ) {
		response.headers.set( 'Access-Control-Allow-Origin', '*' );
	}
	response.headers.append( 'Vary', 'Origin' );
	return response;
};
