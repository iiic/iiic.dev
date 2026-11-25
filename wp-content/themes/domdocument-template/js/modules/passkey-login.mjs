/**
* [2026-11-25] Widget „Přihlášení přístupovým klíčem (i na statickém webu)“ (\WIDGET\PasskeyLogin ve functions.php).
*
* Přihlášení bez hesla přes WebAuthn (navigator.credentials, přístupové klíče / passkeys). Účty a relace drží API
* na Cloudflare Pages Functions s databází D1 (static-export/repository/functions/api/auth/), takže přihlášení funguje
* i na statickém webu. HTML widgetu (formuláře, tlačítka, šablona položky seznamu klíčů) vypisuje PHP přes DOMDocument,
* tento modul jen přepíná stavy a volá API. Texty (hlášky, chyby) jsou přeložené v PHP a přichází v JSON
* <script type="application/json" data-passkey-texts>.
*
* - Bez JavaScriptu nebo bez podpory WebAuthn zůstane widget skrytý (atribut hidden).
* - Cookie relace je HttpOnly (JavaScript ji nevidí). Modul si proto v localStorage pamatuje jen jméno přihlášeného
*   uživatele: nepřihlášený návštěvník API vůbec nevolá, přihlášenému se jméno ukáže hned a API ho pak potvrdí.
* - Signal API (PublicKeyCredential.signal…(), Chrome 132+) oznámí správci hesel změnu jména, odebrané klíče
*   a smazaný účet. Prohlížeč bez něj to přeskočí.
*
* Adresa API: atribut data-passkey-login (prázdný = DEFAULT_API na adrese stránky). Funguje i na jiné adrese ve stejné
* doméně (např. web WordPressu na http://localhost a `wrangler pages dev` na http://localhost:8788): fetch posílá cookie
* (credentials: 'include') a API musí adresu stránky povolit v ALLOWED_ORIGINS.
*
* [2026-11-25] Jeden účet všude: na stránce „Přihlášení přístupovým klíčem“ (atribut data-passkey-sso, stránku
* vykresluje passkey-sso.php šablony) přichází z WordPressu parametry return (kam se vrátit) a state. Po přihlášení
* modul vyžádá od API podepsaný token (POST sso/token) a přesměruje zpět do WordPressu, který token ověří a přihlásí
* propojený účet. Kdo je už přihlášený, pokračuje tlačítkem (souhlas s přihlášením do cizího webu).
*/

/** @type {Object<String, String>} */
const ATTRIBUTES = Object.freeze( { // \VARS\PASSKEY_LOGIN ve functions.php
	ROOT: 'data-passkey-login',
	STATE: 'data-passkey-state',
	ACTION: 'data-passkey-action',
	FIELD: 'data-passkey-field',
	LIST: 'data-passkey-list',
	ITEM: 'data-passkey-item',
	STATUS: 'data-passkey-status',
	TEXTS: 'data-passkey-texts',
	SSO: 'data-passkey-sso', // [2026-11-25] kořen widgetu na stránce přihlášení do WordPressu
	SSO_PANEL: 'data-passkey-sso-panel', // žádost o přihlášení (skrytá bez platných parametrů)
} );

/** @type {Object<String, String>} */
const STATES = Object.freeze( {
	ANONYMOUS: 'anonymous',
	USER: 'user',
} );

/** @type {Object<String, String>} */
const ACTIONS = Object.freeze( {
	LOGIN: 'login',
	REGISTER: 'register',
	LOGOUT: 'logout',
	PROFILE: 'profile',
	ADD_PASSKEY: 'add-passkey',
	REMOVE_PASSKEY: 'remove-passkey',
	DELETE_ACCOUNT: 'delete-account',
	SSO_CONTINUE: 'sso-continue', // [2026-11-25] pokračovat do WordPressu
	SSO_CANCEL: 'sso-cancel', // vrátit se do WordPressu bez přihlášení
} );

/** @type {Object<String, String>} */
const FIELDS = Object.freeze( {
	DISPLAY_NAME: 'displayName', // text i pole formuláře profilu (name="displayName")
	SUMMARY: 'summary', // popis klíče v položce seznamu
	SSO_TARGET: 'ssoTarget', // [2026-11-25] adresa webu, který o přihlášení žádá
} );

/** @type {Object} */
const SSO = Object.freeze( { // [2026-11-25] parametry přihlášení do WordPressu (\VARS\PASSKEY_LOGIN ve functions.php)
	RETURN_PARAMETER: 'return', // adresa ve WordPressu, kam se vrátit (API ji povolí jen z ALLOWED_ORIGINS)
	STATE_PARAMETER: 'state', // náhodná hodnota z cookie WordPressu, vrací se v tokenu
	ERROR_PARAMETER: 'ddt_passkey_error', // návrat bez přihlášení
	CANCELLED: 'cancelled',
	STATE_PATTERN: /^[A-Za-z0-9_-]{16,128}$/, // stejné jako SSO_STATE_PATTERN v API
} );

/** @type {String} */
const ERROR_CLASS = 'passkey-login-error'; // \CSS\CLASS_NAMES\PASSKEY_LOGIN::ERROR

/** @type {String} */
const DEFAULT_API = '/api/auth/'; // \WIDGET\PasskeyLogin::DEFAULT_API

/** @type {String} */
const STORAGE_PREFIX = 'ddtPasskeyLogin:'; // + adresa API → { displayName } přihlášeného uživatele

/**
* Chyba z API ({ error: kód, message }).
*/
class ApiError extends Error {

	constructor ( /** @type {String} */ code, /** @type {String} */ message, /** @type {Number} */ status )
	{
		super( message );
		this.code = code;
		this.status = status;
	}

}

/** @type {Function} */
const toBase64Url = function ( /** @type {ArrayBuffer|Uint8Array} */ buffer )
{

	/** @type {String} */
	let binary = '';

	for ( const byte of new Uint8Array( buffer ) ) {
		binary += String.fromCharCode( byte );
	}
	return btoa( binary ).replaceAll( '+', '-' ).replaceAll( '/', '_' ).replace( /=+$/, '' );
};

/** @type {Function} */
const fromBase64Url = function ( /** @type {String} */ text )
{
	return Uint8Array.from( atob( text.replaceAll( '-', '+' ).replaceAll( '_', '/' ) + '==='.slice( ( text.length + 3 ) % 4 ) ), ( /** @type {String} */ character ) => character.charCodeAt( 0 ) );
};

/**
* Volby z API (JSON, binární hodnoty v base64url) → volby pro navigator.credentials.create().
* PublicKeyCredential.parseCreationOptionsFromJSON() by to uměl taky, ale ne všude (a rozšíření správců hesel, která
* navigator.credentials nahrazují, ho často nemají).
*/
const decodeCreationOptions = function ( /** @type {Object} */ options )
{
	return {
		...options,
		challenge: fromBase64Url( options.challenge ),
		user: { ...options.user, id: fromBase64Url( options.user.id ) },
		excludeCredentials: ( options.excludeCredentials ?? [] ).map( ( /** @type {Object} */ credential ) => ( { ...credential, id: fromBase64Url( credential.id ) } ) ),
	};
};

/** @type {Function} */
const decodeRequestOptions = function ( /** @type {Object} */ options )
{
	return {
		...options,
		challenge: fromBase64Url( options.challenge ),
		allowCredentials: ( options.allowCredentials ?? [] ).map( ( /** @type {Object} */ credential ) => ( { ...credential, id: fromBase64Url( credential.id ) } ) ),
	};
};

/**
* PublicKeyCredential → JSON pro API (jako PublicKeyCredential.toJSON(), viz decodeCreationOptions()).
*/
const encodeCredential = function ( /** @type {PublicKeyCredential} */ credential )
{

	/** @type {AuthenticatorResponse} */
	const source = credential.response;

	/** @type {Object} */
	const response = { clientDataJSON: toBase64Url( source.clientDataJSON ) };

	if ( source.attestationObject ) { // registrace (AuthenticatorAttestationResponse)
		response.attestationObject = toBase64Url( source.attestationObject );
		response.transports = typeof source.getTransports === 'function' ? source.getTransports() : [];
	} else { // přihlášení (AuthenticatorAssertionResponse)
		response.authenticatorData = toBase64Url( source.authenticatorData );
		response.signature = toBase64Url( source.signature );
		response.userHandle = source.userHandle ? toBase64Url( source.userHandle ) : null;
	}
	return {
		id: credential.id,
		rawId: toBase64Url( credential.rawId ),
		type: credential.type,
		authenticatorAttachment: credential.authenticatorAttachment ?? null,
		response,
		clientExtensionResults: typeof credential.getClientExtensionResults === 'function' ? credential.getClientExtensionResults() : {},
	};
};

/**
* Signal API – oznámení správci hesel (Chrome 132+). Bez podpory nebo při chybě se nic nestane.
*/
const signal = function ( /** @type {String} */ method, /** @type {Object} */ details )
{
	try {

		/** @type {Promise|undefined} */
		const result = window.PublicKeyCredential?.[ method ]?.( details );

		result?.catch?.( () => {} );
	} catch {
		// nepodporovaný tvar volání – nevadí
	}
};

/** @type {Function} */
const format = function ( /** @type {String} */ text, /** @type {...String} */ ...values )
{

	/** @type {Number} */
	let index = 0;

	return String( text ?? '' ).replace( /%(?:(\d+)\$)?s/g, ( /** @type {String} */ match, /** @type {String|undefined} */ position ) => String( values[ position ? Number( position ) - 1 : index++ ] ?? '' ) );
};

class PasskeyLogin {

	/** @type {HTMLElement} */
	root;

	/** @type {URL} */
	api;

	/** @type {Object} */
	texts = {};

	/** @type {Boolean} */
	busy = false;

	/** @type {Object|null} */
	account = null; // poslední odpověď API s uživatelem ({ rpId, user, passkeys })

	/** @type {Object|null} */
	sso = null; // [2026-11-25] žádost o přihlášení do WordPressu: { returnUrl, state, target } nebo { invalid: true }, null = není

	constructor ( /** @type {HTMLElement} */ root )
	{
		this.root = root;
		this.api = new URL( root.getAttribute( ATTRIBUTES.ROOT ) || DEFAULT_API, location.href );
		if ( !this.api.pathname.endsWith( '/' ) ) {
			this.api.pathname += '/';
		}
		try {
			this.texts = JSON.parse( root.querySelector( `script[${ ATTRIBUTES.TEXTS }]` )?.textContent || '{}' );
		} catch {
			this.texts = {};
		}
		if ( root.hasAttribute( ATTRIBUTES.SSO ) ) {
			this.sso = PasskeyLogin.readSsoRequest();
		}
	}

	static readSsoRequest () // [2026-11-25] parametry z WordPressu v adrese stránky
	{

		/** @type {URLSearchParams} */
		const parameters = new URLSearchParams( location.search );

		/** @type {String|null} */
		const returnUrl = parameters.get( SSO.RETURN_PARAMETER );

		/** @type {String|null} */
		const state = parameters.get( SSO.STATE_PARAMETER );

		if ( returnUrl === null && state === null ) {
			return null; // stránka otevřená přímo – slouží jako stránka účtu
		}
		try {

			/** @type {URL} */
			const target = new URL( returnUrl ?? '' );

			if ( [ 'http:', 'https:' ].includes( target.protocol ) && SSO.STATE_PATTERN.test( state ?? '' ) ) {
				return { returnUrl: target.href, state, target: target.host };
			}
		} catch {
			// neplatná adresa
		}
		return { invalid: true };
	}

	get storageKey ()
	{
		return STORAGE_PREFIX + this.api.href;
	}

	static isSupported ()
	{
		return window.isSecureContext && typeof window.PublicKeyCredential === 'function' && typeof navigator.credentials?.create === 'function';
	}

	start ()
	{
		if ( !PasskeyLogin.isSupported() ) {
			return; // widget zůstane skrytý
		}
		this.root.addEventListener( 'click', ( /** @type {MouseEvent} */ event ) => {

			/** @type {HTMLButtonElement|null} */
			const button = event.target instanceof Element ? event.target.closest( `button[${ ATTRIBUTES.ACTION }]` ) : null;

			if ( button && this.root.contains( button ) ) {
				this.run( button.getAttribute( ATTRIBUTES.ACTION ), button );
			}
		} );
		this.root.addEventListener( 'submit', ( /** @type {SubmitEvent} */ event ) => {
			if ( event.target instanceof HTMLFormElement && event.target.hasAttribute( ATTRIBUTES.ACTION ) ) {
				event.preventDefault();
				this.run( event.target.getAttribute( ATTRIBUTES.ACTION ), event.target );
			}
		} );
		window.addEventListener( 'storage', ( /** @type {StorageEvent} */ event ) => { // přihlášení nebo odhlášení v jiné záložce
			if ( event.key === this.storageKey && !this.busy ) {
				this.restore();
			}
		} );
		window.addEventListener( 'pageshow', ( /** @type {PageTransitionEvent} */ event ) => { // stránka z back/forward cache
			if ( event.persisted && !this.busy ) {
				this.restore();
			}
		} );
		this.restore();
		this.root.hidden = false;
		if ( this.sso?.invalid ) {
			this.say( this.texts.errors?.ssoInvalid, true );
		}
	}

	restore ()
	{

		/** @type {Object|null} */
		const remembered = this.readRemembered();

		if ( remembered ) {
			this.render( { user: remembered, passkeys: this.account?.passkeys ?? [] } ); // hned, API ho potvrdí
			this.refresh();
		} else {
			this.account = null;
			this.render( null );
		}
	}

	async refresh ()
	{
		try {
			this.setAccount( await this.request( 'GET', 'me' ) );
		} catch ( error ) {
			this.say( this.messageFor( error ), true );
		}
	}

	readRemembered ()
	{
		try {

			/** @type {*} */
			const value = JSON.parse( localStorage.getItem( this.storageKey ) ?? 'null' );

			return value && typeof value.displayName === 'string' ? { displayName: value.displayName } : null;
		} catch {
			return null;
		}
	}

	remember ( /** @type {Object|null} */ user )
	{
		try {
			if ( user ) {
				localStorage.setItem( this.storageKey, JSON.stringify( { displayName: user.displayName } ) );
			} else {
				localStorage.removeItem( this.storageKey );
			}
		} catch {
			// localStorage zakázaný – stav se pak zjistí až kliknutím
		}
	}

	async request ( /** @type {String} */ method, /** @type {String} */ path, /** @type {Object|undefined} */ body = undefined )
	{

		/** @type {Response} */
		const response = await fetch( new URL( path, this.api ), {
			method,
			credentials: 'include', // cookie relace i na jiné adrese API (jen ve stejné doméně, cookie je SameSite=Strict)
			cache: 'no-store',
			headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify( body ),
		} );

		/** @type {Object} */
		let data = {};

		try {
			data = await response.json();
		} catch {
			data = {};
		}
		if ( !response.ok ) {
			throw new ApiError( data.error ?? 'server-error', data.message ?? '', response.status );
		}
		return data;
	}

	setAccount ( /** @type {Object} */ data )
	{
		this.account = data?.user ? data : null;
		this.remember( this.account?.user ?? null );
		this.render( this.account );
	}

	render ( /** @type {Object|null} */ account )
	{
		for ( const element of this.root.querySelectorAll( `[${ ATTRIBUTES.STATE }]` ) ) {
			element.hidden = element.getAttribute( ATTRIBUTES.STATE ) !== ( account?.user ? STATES.USER : STATES.ANONYMOUS );
		}
		this.renderSso( account );
		if ( !account?.user ) {
			return;
		}
		for ( const element of this.root.querySelectorAll( `[${ ATTRIBUTES.FIELD }="${ FIELDS.DISPLAY_NAME }"]` ) ) {
			if ( element instanceof HTMLInputElement ) {
				if ( document.activeElement !== element ) {
					element.value = account.user.displayName;
				}
			} else {
				element.textContent = account.user.displayName;
			}
		}
		this.renderPasskeys( account.passkeys ?? [] );
	}

	renderSso ( /** @type {Object|null} */ account ) // [2026-11-25] žádost o přihlášení do WordPressu
	{

		/** @type {Boolean} */
		const active = Boolean( this.sso && !this.sso.invalid );

		for ( const panel of this.root.querySelectorAll( `[${ ATTRIBUTES.SSO_PANEL }]` ) ) {
			panel.hidden = !active;
		}
		if ( !active ) {
			return;
		}
		for ( const element of this.root.querySelectorAll( `[${ ATTRIBUTES.FIELD }="${ FIELDS.SSO_TARGET }"]` ) ) {
			element.textContent = this.sso.target;
		}
		for ( const button of this.root.querySelectorAll( `button[${ ATTRIBUTES.ACTION }="${ ACTIONS.SSO_CONTINUE }"]` ) ) {
			button.hidden = !account?.user || !account.user.id; // jméno z localStorage ještě nestačí, API musí přihlášení potvrdit
		}
	}

	renderPasskeys ( /** @type {Object[]} */ passkeys )
	{

		/** @type {HTMLElement|null} */
		const list = this.root.querySelector( `[${ ATTRIBUTES.LIST }]` );

		/** @type {HTMLTemplateElement|null} */
		const template = this.root.querySelector( `template[${ ATTRIBUTES.ITEM }]` );

		if ( !list || !template?.content.firstElementChild ) {
			return;
		}

		/** @type {Intl.DateTimeFormat} */
		const dateFormat = new Intl.DateTimeFormat( document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' } );

		/** @type {Function} */
		const date = ( /** @type {Number} */ seconds ) => dateFormat.format( new Date( seconds * 1000 ) );

		/** @type {Object} */
		const texts = this.texts.passkey ?? {};

		list.replaceChildren( ...passkeys.map( ( /** @type {Object} */ passkey, /** @type {Number} */ index ) => {

			/** @type {HTMLElement} */
			const item = template.content.firstElementChild.cloneNode( true );

			/** @type {String[]} */
			const parts = [ format( texts.created, String( index + 1 ), date( passkey.createdAt ) ) ];

			if ( passkey.lastUsedAt ) {
				parts.push( format( texts.lastUsed, date( passkey.lastUsedAt ) ) );
			}
			if ( passkey.backupEligible ) {
				parts.push( texts.synced );
			}
			if ( passkey.current ) {
				parts.push( texts.current );
			}

			/** @type {HTMLElement|null} */
			const summary = item.querySelector( `[${ ATTRIBUTES.FIELD }="${ FIELDS.SUMMARY }"]` );

			if ( summary ) {
				summary.textContent = parts.filter( Boolean ).join( ', ' );
			}

			/** @type {HTMLButtonElement|null} */
			const remove = item.querySelector( `button[${ ATTRIBUTES.ACTION }="${ ACTIONS.REMOVE_PASSKEY }"]` );

			if ( remove ) {
				remove.value = passkey.id;
				remove.hidden = passkeys.length < 2; // poslední klíč odebrat nejde (API by to odmítlo)
			}
			return item;
		} ) );
	}

	say ( /** @type {String} */ message, /** @type {Boolean} */ isError = false )
	{

		/** @type {HTMLElement|null} */
		const status = this.root.querySelector( `[${ ATTRIBUTES.STATUS }]` );

		if ( status ) {
			status.textContent = message ?? '';
			status.classList.toggle( ERROR_CLASS, isError );
		}
	}

	messageFor ( /** @type {*} */ error )
	{

		/** @type {Object} */
		const errors = this.texts.errors ?? {};

		if ( error instanceof ApiError ) {
			return errors[ error.code ] || error.message || errors.default;
		}
		if ( error instanceof DOMException ) {
			switch ( error.name ) {
				case 'NotAllowedError': // zavřený dialog, vypršel čas, nebo prohlížeč akci nepovolil
				case 'AbortError':
					return errors.cancelled;
				case 'InvalidStateError': // klíč z excludeCredentials – v tomto autentizátoru už pro účet klíč je
					return errors.exists;
				case 'SecurityError': // RP ID nepatří k adrese stránky
					return errors.security;
				case 'NotSupportedError':
					return errors.unsupported;
			}
		}
		if ( error instanceof TypeError ) { // fetch() bez odpovědi (síť, CORS)
			return errors.network;
		}
		return errors.default;
	}

	setBusy ( /** @type {Boolean} */ busy )
	{
		this.busy = busy;
		this.root.setAttribute( 'aria-busy', String( busy ) );
		for ( const control of this.root.querySelectorAll( 'button, input' ) ) {
			control.disabled = busy;
		}
	}

	async run ( /** @type {String} */ action, /** @type {HTMLElement} */ source )
	{
		if ( this.busy ) {
			return;
		}

		/** @type {Object} */
		const messages = this.texts.messages ?? {};

		/** @type {Object} */
		const confirmations = this.texts.confirm ?? {};

		if ( action === ACTIONS.DELETE_ACCOUNT && !confirm( confirmations.deleteAccount ) ) {
			return;
		}
		if ( action === ACTIONS.REMOVE_PASSKEY && !confirm( confirmations.removePasskey ) ) {
			return;
		}

		/** @type {FormData|null} */
		const formData = source instanceof HTMLFormElement ? new FormData( source ) : null; // před setBusy(), zakázaná pole FormData vynechá

		this.setBusy( true );
		this.say( '' );
		try {
			switch ( action ) {
				case ACTIONS.LOGIN:
					await this.login();
					this.say( messages.loggedIn );
					await this.continueSso( true ); // [2026-11-25] na stránce přihlášení do WordPressu rovnou zpět
					break;
				case ACTIONS.REGISTER:
					await this.register( String( formData?.get( FIELDS.DISPLAY_NAME ) ?? '' ) );
					source.reset();
					this.say( messages.registered );
					await this.continueSso( true );
					break;
				case ACTIONS.SSO_CONTINUE: // [2026-11-25]
					await this.continueSso( false );
					break;
				case ACTIONS.SSO_CANCEL:
					this.cancelSso();
					break;
				case ACTIONS.LOGOUT:
					this.setAccount( await this.request( 'POST', 'logout' ) );
					this.say( messages.loggedOut );
					break;
				case ACTIONS.PROFILE:
					this.setAccount( await this.request( 'PATCH', 'me', { displayName: String( formData?.get( FIELDS.DISPLAY_NAME ) ?? '' ) } ) );
					this.signalAccount();
					this.say( messages.profileSaved );
					break;
				case ACTIONS.ADD_PASSKEY:
					await this.addPasskey();
					this.say( messages.passkeyAdded );
					break;
				case ACTIONS.REMOVE_PASSKEY:
					this.setAccount( await this.request( 'DELETE', 'passkeys/' + encodeURIComponent( source.value ) ) );
					this.signalAccount();
					this.say( messages.passkeyRemoved );
					break;
				case ACTIONS.DELETE_ACCOUNT: {

					/** @type {Object} */
					const result = await this.request( 'DELETE', 'me' );

					for ( const credentialId of result.deletedPasskeys ?? [] ) {
						signal( 'signalUnknownCredential', { rpId: result.rpId, credentialId } );
					}
					this.setAccount( result );
					this.say( messages.accountDeleted );
					break;
				}
			}
		} catch ( error ) {
			if ( error instanceof ApiError && error.code === 'unauthenticated' ) { // relace mezitím vypršela
				this.setAccount( null );
			}
			this.say( this.messageFor( error ), true );
		} finally {
			this.setBusy( false );
		}
	}

	async login ()
	{

		/** @type {Object} */
		const options = await this.request( 'POST', 'login/options', {} );

		this.say( this.texts.messages?.waiting );

		/** @type {PublicKeyCredential} */
		const credential = await navigator.credentials.get( { publicKey: decodeRequestOptions( options ) } );

		try {
			this.setAccount( await this.request( 'POST', 'login', { credential: encodeCredential( credential ) } ) );
		} catch ( error ) {
			if ( error instanceof ApiError && error.code === 'unknown-credential' ) { // účet je smazaný, klíč v zařízení zůstal
				signal( 'signalUnknownCredential', { rpId: options.rpId, credentialId: credential.id } );
			}
			throw error;
		}
		this.signalAccount();
	}

	async register ( /** @type {String} */ displayName )
	{

		/** @type {Object} */
		const options = await this.request( 'POST', 'register/options', { displayName } );

		this.say( this.texts.messages?.waiting );

		/** @type {PublicKeyCredential} */
		const credential = await navigator.credentials.create( { publicKey: decodeCreationOptions( options ) } );

		this.setAccount( await this.request( 'POST', 'register', { credential: encodeCredential( credential ) } ) );
	}

	async addPasskey ()
	{

		/** @type {Object} */
		const options = await this.request( 'POST', 'passkeys/options', {} );

		this.say( this.texts.messages?.waiting );

		/** @type {PublicKeyCredential} */
		const credential = await navigator.credentials.create( { publicKey: decodeCreationOptions( options ) } );

		this.setAccount( await this.request( 'POST', 'passkeys', { credential: encodeCredential( credential ) } ) );
		this.signalAccount();
	}

	async continueSso ( /** @type {Boolean} */ onlyWhenRequested ) // [2026-11-25] token pro WordPress a návrat do něj
	{
		if ( !this.sso || this.sso.invalid ) {
			if ( !onlyWhenRequested ) {
				this.say( this.texts.errors?.ssoInvalid, true );
			}
			return;
		}
		this.say( format( this.texts.messages?.ssoRedirecting, this.sso.target ) );

		/** @type {Object} */
		const result = await this.request( 'POST', 'sso/token', { returnUrl: this.sso.returnUrl, state: this.sso.state } );

		location.assign( result.redirect );
	}

	cancelSso () // [2026-11-25] zpět do WordPressu bez přihlášení
	{
		if ( !this.sso || this.sso.invalid ) {
			return;
		}

		/** @type {URL} */
		const target = new URL( this.sso.returnUrl );

		target.searchParams.set( SSO.ERROR_PARAMETER, SSO.CANCELLED );
		location.assign( target.href );
	}

	signalAccount () // správce hesel si aktualizuje jméno a zapomene klíče, které účet už nemá
	{
		if ( !this.account?.user ) {
			return;
		}

		/** @type {Object} */
		const { rpId, user, passkeys } = this.account;

		signal( 'signalAllAcceptedCredentials', { rpId, userId: user.id, allAcceptedCredentialIds: passkeys.map( ( /** @type {Object} */ passkey ) => passkey.id ) } );
		signal( 'signalCurrentUserDetails', { rpId, userId: user.id, name: user.displayName, displayName: user.displayName } );
	}

}

for ( const root of document.querySelectorAll( `[${ ATTRIBUTES.ROOT }]` ) ) {
	new PasskeyLogin( root ).start();
}
