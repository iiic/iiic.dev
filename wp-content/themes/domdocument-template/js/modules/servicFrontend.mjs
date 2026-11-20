// @ts-nocheck
/**
* @private
* @module ServicFrontendPrivate
* @classdesc @todo … description
* @author ic < ic.czech@gmail.com >
* @see https://iiic.dev/…
* @license https://creativecommons.org/licenses/by-sa/4.0/legalcode.cs CC BY-SA 4.0
* @since Q2 2020
* @version 0.1
* @readonly
*/
const ServicFrontendPrivate = class
{

	static INPUT = 'input';
	static CHANGE_EVENT = 'change';
	static CLICK_EVENT = 'click';

	/**
	 * @public
	 * @type {Object}
	 * @description default settings… can be overwritten
	 */
	settings = {
		publicKey: null,
		domainsAllowList: [ 'iiic.dev' ],
		snippetElements: {
			offlineToggle: document.querySelector( '#action-offline-toggle ' + ServicFrontendPrivate.INPUT ),
			pushSubscription: document.querySelector( '#push-subscription-toggle ' + ServicFrontendPrivate.INPUT ),
			installApp: document.querySelector( '#install-app' ),
		},
		push: {
			subscribeApiEndpoint: '/api/push-subscription-endpoint/',
			unsubscribeApiEndpoint: '/api/push-unsubscribe/',
		},
		modulesImportPath: 'https://iiic.dev/js/modules',
		autoRun: true,
	};

	/**
	* @public
	* @type {ServiceWorkerContainer}
	*/
	swc = navigator.serviceWorker;

	/**
	* @public
	* @type {ServiceWorkerRegistration}
	*/
	registration;

	/**
	* @public
	* @type {ServiceWorker}
	*/
	sw;

	/**
	 * @public
	 * @type {Function}
	 */
	importWithIntegrity;


	async initImportWithIntegrity ( /** @type {Object} */ settings = null )
	{

		console.groupCollapsed( '%c' + this.constructor.name + '%c initImportWithIntegrity %c(' + ( settings === null ? 'without settings' : 'with settings' ) + ')',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME,
			ServicFrontend.CONSOLE.INTEREST_PARAMETER
		);
		console.debug( { arguments } );
		console.groupEnd();

		return new Promise( ( /** @type { Function } */ resolve ) =>
		{
			const ip = settings && settings.modulesImportPath ? settings.modulesImportPath : this.settings.modulesImportPath;
			// @ts-ignore
			import( ip + '/importWithIntegrity.mjs' ).then( ( /** @type {Module} */ module ) =>
			{
				/** @type {Function} */
				this.importWithIntegrity = module.importWithIntegrity;
				resolve( true );
			} ).catch( () =>
			{
				const SKIP_SECURITY_URL = '#skip-security-test-only'
				if ( window.location.hash === SKIP_SECURITY_URL ) {
					console.warn( '%c' + this.constructor.name + '%c initImportWithIntegrity %c without security!',
						ServicFrontend.CONSOLE.CLASS_NAME,
						ServicFrontend.CONSOLE.METHOD_NAME,
						ServicFrontend.CONSOLE.WARNING
					);
					this.importWithIntegrity = (/** @type {String} */ path ) =>
					{
						return new Promise( ( /** @type {Function} */ resolve ) =>
						{
							// @ts-ignore
							import( path ).then( ( /** @type {Module} */ module ) =>
							{
								resolve( module );
							} );
						} );
					};
					resolve( true );
				} else {
					throw 'Security Error : Import with integrity module is missing! You can try to skip this error by adding ' + SKIP_SECURITY_URL + ' hash into website URL';
				}
			} );
		} );
	}

	async afterServiceWorkerRegistration ()
	{
		console.debug( '%c' + this.constructor.name + '%c afterServiceWorkerRegistration',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME
		);

		return this.swc.ready.then( ( /** @type {ServiceWorkerRegistration} */ registration ) =>
		{
			this.registration = registration;
			this.sw = registration.installing || registration.waiting || registration.active;
			return true;
		} );
	}

	activateElement = ( /** @type {HTMLInputElement} */ input ) =>
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c activateElement',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME
		);
		console.debug( { input } );

		input.disabled = false;
		if ( document.activeElement === document.body ) {
			input.focus();
		}

		console.groupEnd();

	}

	actionSubscribe ( /** @type {HTMLInputElement} */ pushSubscriptionToggle )
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c actionSubscribe',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME
		);
		console.debug( { arguments } );

		const options = {
			applicationServerKey: ServicFrontend.urlB64ToUint8Array( this.settings.publicKey ),
			userVisibleOnly: true
		};
		this.registration.pushManager.subscribe( options ).then( ( /** @type {PushSubscription} */ subscription ) =>
		{
			fetch( this.settings.push.subscribeApiEndpoint, {
				method: 'POST',
				mode: 'cors',
				cache: 'no-cache',
				credentials: 'same-origin',
				headers: {
					'Content-Type': 'application/json'
				},
				redirect: 'manual',
				referrerPolicy: 'same-origin',
				body: JSON.stringify( subscription )
			} ).then( ( /** @type {Response} */ response ) =>
			{
				return response.text();
			} ).then( ( /** @type {String} */ data ) =>
			{
				if ( data === 'ok' ) {
					this.activateElement( pushSubscriptionToggle );
					//@ts-ignore
					new Notific(
						'Push notifikace přihlášeny na tomto zařízení :)',
						{ body: document.body.title }
					);
				}
			} );
		} ).catch( ( /** @type {DOMException} */ ) =>
		{
			pushSubscriptionToggle.checked = false;
			this.activateElement( pushSubscriptionToggle );
			//@ts-ignore
			new Notific(
				'Push notifikace se nepodařilo přihlásit kvůli odmítnutí ze strany prohlížeče',
				{ body: document.body.title }
			);
		} );

		console.groupEnd();

	}

	initOfflineToggleMessages ( /** @type {HTMLInputElement} */ offlineToggle )
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c initOfflineToggleMessages',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME
		);
		console.debug( { arguments } );
		console.groupEnd();

		this.swc.addEventListener( 'message', ( /** @type {MessageEvent} */ event ) =>
		{
			console.groupCollapsed( '%c' + this.constructor.name + '%c message' + '%c event' + ' %c(' + event.data.actionResponse + ')',
				ServicFrontend.CONSOLE.CLASS_NAME,
				ServicFrontend.CONSOLE.METHOD_NAME,
				ServicFrontend.CONSOLE.EVENT_TEXT,
				ServicFrontend.CONSOLE.INTEREST_PARAMETER
			);
			console.debug( { event } );
			console.groupEnd();

			if ( event.data.url === window.location.href ) {
				if ( event.data.actionResponse === ServicFrontend.IS_CACHED_BY ) {
					offlineToggle.checked = event.data.response;
				} else if ( event.data.actionResponse === ServicFrontend.ADD_INTO_CACHE ) {
					//@ts-ignore
					new Notific(
						( event.data.response === true ) ? 'stránka bude nyní dostupná offline' : 'přidání stránky do offline cache selhalo :(',
						{ body: document.body.title }
					);
				} else if ( event.data.actionResponse === ServicFrontend.REMOVE_FROM_CACHE ) {
					//@ts-ignore
					new Notific(
						( event.data.response === true ) ? 'stránka byla odebrána z offline cache' : 'odebírání stránky z offline cache selhalo :(',
						{ body: document.body.title }
					);
				}

				/** @type {HTMLInputElement} */
				const responseToggle = ( document.querySelector( '#' + event.data.parentId + ' ' + ServicFrontendPrivate.INPUT ) );

				if ( responseToggle ) {
					responseToggle.disabled = false;
					if ( event.data.actionResponse === ServicFrontend.ADD_INTO_CACHE || event.data.actionResponse === ServicFrontend.REMOVE_FROM_CACHE ) {
						this.activateElement( offlineToggle );
					}
				}
			}
			if ( event.data.actionResponse === ServicFrontend.CONNECTION_LOST ) {
				//@ts-ignore
				new Notific( 'ajaj, připojení k internetu se ztratilo :(' );
			} else if ( event.data.actionResponse === ServicFrontend.CONNECTION_REPAIRED ) {
				//@ts-ignore
				new Notific( 'hurá, už mám zase připojení k internetu' );
			} else if ( event.data.actionResponse === ServicFrontend.NOTIFIC_FROM_WORKER ) {
				//@ts-ignore
				new Notific( event.data.message, event.data.notification );
			}
		}, false );
	}

	actionUnsubscribe ( /** @type {HTMLInputElement} */ pushSubscriptionToggle )
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c actionUnsubscribe',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME
		);
		console.debug( { arguments } );

		this.registration.pushManager.getSubscription().then( ( /** @type {PushSubscription | null} */ subscription ) =>
		{
			console.debug( { subscription } );
			if ( subscription ) {
				subscription.unsubscribe().then( ( /** @type {Boolean} */ result ) =>
				{
					if ( result ) {
						fetch( this.settings.push.unsubscribeApiEndpoint, {
							method: 'POST',
							mode: 'cors',
							cache: 'no-cache',
							credentials: 'same-origin',
							headers: {
								'Content-Type': 'application/json'
							},
							redirect: 'manual',
							referrerPolicy: 'same-origin',
							body: JSON.stringify( subscription )
						} ).then( ( /** @type {Response} */ response ) =>
						{
							return response.text();
						} ).then( ( /** @type {String} */ data ) =>
						{
							if ( data === 'ok' ) {
								this.activateElement( pushSubscriptionToggle );
								//@ts-ignore
								new Notific(
									'Zrušil jsi odběr push notifikací',
									{ body: document.body.title }
								);
							}
						} );
					}
				} );
			} else {
				this.activateElement( pushSubscriptionToggle );
			}
		} );

		console.groupEnd();

	}

	messageToServiceWorker ( /** @type {Object} */ data )
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c messageToServiceWorker',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME,
		);
		console.debug( { data } );
		console.groupEnd();

		this.sw.postMessage( data );
	}

	propagateSubscriptionStatus ( /** @type {HTMLInputElement} */ pushSubscriptionToggle )
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c propagateSubscriptionStatus',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME,
		);
		console.debug( { arguments } );
		console.groupEnd();

		this.registration.pushManager.getSubscription().then( ( /** @type {PushSubscription | null} */ subscription ) =>
		{
			pushSubscriptionToggle.checked = subscription ? true : false;
		} );
	}

} // ServicFrontendPrivate

/**
* @public
* @module ServicFrontend
* @classdesc @todo … description
* @author ic < ic.czech@gmail.com >
* @see https://iiic.dev/…
* @license https://creativecommons.org/licenses/by-sa/4.0/legalcode.cs CC BY-SA 4.0
* @since Q2 2020
* @version 0.1
*/
export class ServicFrontend
{

	static IS_CACHED_BY = 1;
	static ADD_INTO_CACHE = 2;
	static REMOVE_FROM_CACHE = 3;
	static CONNECTION_LOST = 4;
	static CONNECTION_REPAIRED = 5;
	static NOTIFIC_FROM_WORKER = 6;

	static CONSOLE = {
		CLASS_NAME: 'color: gray',
		METHOD_NAME: 'font-weight: normal; color: green',
		INTEREST_PARAMETER: 'font-weight: normal; font-size: x-small; color: blue',
		EVENT_TEXT: 'color: orange',
		WARNING: 'color: red',
	};

	/**
	 * @private
	 * @description '#private' is not currently supported by Firefox, so that's why '_private'
	 */
	_private;


	constructor (
		/** @type {String | null} */ publicKey = null,
		/** @type {Object | null} */ settings = null
	)
	{
		console.groupCollapsed( '%c' + this.constructor.name,
			ServicFrontend.CONSOLE.CLASS_NAME
		);
		console.debug( '%c' + 'constructor',
			ServicFrontend.CONSOLE.METHOD_NAME,
			[ { arguments } ],
		);

		this._private = new ServicFrontendPrivate;

		this._private.initImportWithIntegrity( settings ).then( () =>
		{
			this.settings.publicKey = publicKey;
			if ( settings ) {
				this.setSettings( settings ).then( () =>
				{
					if ( this.settings.autoRun ) {
						this.run();
					}
				} );
			} else if ( this.settings.autoRun ) {
				this.run();
			}
		} );

		console.groupEnd();

	}


	/**
	 * @description : get script settings
	 * @returns {Object} settings of self
	 */
	get settings ()
	{
		return this._private.settings;
	}

	set settings ( /** @type {Object} */ inObject )
	{
		Object.assign( this._private.settings, inObject );
	}

	/**
	 * @description : Get dynamic Import function
	 * @returns {Function}
	 */
	get importWithIntegrity ()
	{
		return this._private.importWithIntegrity;
	}


	async setSettings ( /** @type {Object} */ inObject )
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c setSettings',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME
		);
		console.debug( { arguments } );
		console.groupEnd();

		return new Promise( ( /** @type {Function} */ resolve ) =>
		{
			if ( inObject.modulesImportPath ) {
				this.settings.modulesImportPath = inObject.modulesImportPath;
			}
			this.importWithIntegrity(
				this.settings.modulesImportPath + '/object/deepAssign.mjs',
				'sha256-qv6PwXwb5wOy4BdBQVGgGUXAdHKXMtY7HELWvcvag34='
				// @ts-ignore
			).then( ( /** @type {Module} */ deepAssign ) =>
			{
				new deepAssign.append( Object );
				// @ts-ignore
				this._private.settings = Object.deepAssign( this.settings, inObject ); // multi level assign
				resolve( true );
			} ).catch( () =>
			{
				Object.assign( this._private.settings, inObject ); // single level assign
				resolve( true );
			} );
		} );
	}

	static urlB64ToUint8Array ( /** @type {String} */ base64String )
	{
		console.debug( '%c' + this.constructor.name + '%c urlB64ToUint8Array %c( ' + base64String + ' )',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME,
			ServicFrontend.CONSOLE.INTEREST_PARAMETER
		);

		const padding = '='.repeat( ( 4 - ( base64String.length % 4 ) ) % 4 );
		const base64 = ( base64String + padding ).replace( /\-/g, '+' ).replace( /_/g, '/' );
		const rawData = atob( base64 );
		const outputArray = new Uint8Array( rawData.length );
		for ( let i = 0; i < rawData.length; ++i ) {
			outputArray[ i ] = rawData.charCodeAt( i );
		}
		return outputArray;
	}

	registerServiceWorker ()
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c registerServiceWorker',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME
		);
		console.debug( { arguments } );
		console.groupEnd();

		navigator.serviceWorker.register(
			// @ts-ignore
			trustedTypes.defaultPolicy.createScriptURL( '/sw.js' )
		).then( ( /** @type {ServiceWorkerRegistration} */ swgs ) =>
		{
			/** @type {ServiceWorker} */
			const sw = swgs.installing || swgs.waiting || swgs.active;

			if ( sw ) {
				sw.addEventListener( 'statechange', ( /** @type {Event} */ event ) =>
				{
					// @ts-ignore
					console.groupCollapsed( '%c' + this.constructor.name + ' %c' + event.type + '%c event %c(' + event.currentTarget.state + ')',
						ServicFrontend.CONSOLE.CLASS_NAME,
						ServicFrontend.CONSOLE.METHOD_NAME,
						ServicFrontend.CONSOLE.EVENT_TEXT,
						ServicFrontend.CONSOLE.INTEREST_PARAMETER
					);
					console.debug( event );
					console.groupEnd();
					/* redundant state zní dobře, dá se tam jen po odebrání service workeru */
				} );
			}
		} );

	}

	async afterServiceWorkerRegistration ()
	{
		console.debug( '%c' + this.constructor.name + '%c afterServiceWorkerRegistration',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME
		);

		return this._private.afterServiceWorkerRegistration();
	}

	initPushSubscriptions ()
	{

		console.debug( '%c' + this.constructor.name + '%c initPushSubscriptions',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME
		);

		/** @type {HTMLInputElement} */
		const pushSubscriptionToggle = ( this.settings.snippetElements.pushSubscription );

		if ( pushSubscriptionToggle && this.settings.publicKey ) {
			pushSubscriptionToggle.disabled = false;
			this._private.propagateSubscriptionStatus( pushSubscriptionToggle );

			pushSubscriptionToggle.addEventListener( ServicFrontendPrivate.CHANGE_EVENT, ( /** @type {MouseEvent} */ event ) =>
			{
				event.preventDefault();
				event.stopPropagation();
				if ( event.isTrusted ) {

					/** @type {HTMLInputElement} */
					const pushSubscriptionToggle = ( event.target );

					pushSubscriptionToggle.disabled = true;
					if ( pushSubscriptionToggle.checked ) {
						this._private.actionSubscribe( pushSubscriptionToggle );
					} else {
						this._private.actionUnsubscribe( pushSubscriptionToggle );
					}
				}
			}, false );
		}
	}

	initInstallApp ()
	{
		console.debug( '%c' + this.constructor.name + '%c initInstallApp',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME
		);

		/** @type {HTMLButtonElement} */
		const button = this.settings.snippetElements.installApp;

		if ( window.matchMedia( '(display-mode: standalone)' ).matches ) {
			button.lastChild.textContent = button.getAttribute( 'data-toggle-text' );
		}

		window.addEventListener( 'beforeinstallprompt', ( /** @type {BeforeInstallPromptEvent} */ event ) =>
		{
			console.groupCollapsed( '%c' + this.constructor.name + '%c beforeinstallprompt' + '%c event',
				ServicFrontend.CONSOLE.CLASS_NAME,
				ServicFrontend.CONSOLE.METHOD_NAME,
				ServicFrontend.CONSOLE.EVENT_TEXT
			);
			console.debug( { event } );
			console.groupEnd();

			/** @type {Array} */
			const platforms = event.platforms;

			if ( platforms.includes( 'android' ) ) {
				button.lastChild.textContent = button.getAttribute( 'data-text-android' );
				event.preventDefault();
			}

			let deferredPrompt = event;
			button.disabled = false;
			button.addEventListener( ServicFrontendPrivate.CLICK_EVENT, ( /** @type {MouseEvent} */ event ) =>
			{

				console.groupCollapsed( '%c' + this.constructor.name + '%c click' + '%c event',
					ServicFrontend.CONSOLE.CLASS_NAME,
					ServicFrontend.CONSOLE.METHOD_NAME,
					ServicFrontend.CONSOLE.EVENT_TEXT
				);
				console.debug( { event } );
				console.groupEnd();

				button.disabled = true;
				deferredPrompt.prompt(); // cancel will cause recursion call of beforeinstallprompt event
			}, { once: true, capture: false } );

			deferredPrompt.userChoice.then( ( /** @type {Object} */ choiceResult ) =>
			{
				//if ( choiceResult.outcome === 'accepted' ) {}
				button.lastChild.textContent = button.getAttribute( 'data-toggle-text' );
				deferredPrompt = null;
			} );

		} );
	}

	initOfflineToggle ()
	{

		console.debug( '%c' + this.constructor.name + '%c initOfflineToggle',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME
		);

		/** @type {HTMLInputElement} */
		const offlineToggle = ( this.settings.snippetElements.offlineToggle );

		if ( offlineToggle ) {

			if ( navigator.onLine === false ) {
				offlineToggle.checked = true;
			}

			this._private.initOfflineToggleMessages( offlineToggle );

			this._private.messageToServiceWorker( {
				action: ServicFrontend.IS_CACHED_BY,
				url: window.location.href,
				parentId: offlineToggle.parentElement.id,
				isHtmlDocument: true
			} );

			window.addEventListener( 'offline', ( /** @type {Event} */ event ) =>
			{
				console.groupCollapsed( '%c' + this.constructor.name + '%c offline' + '%c event',
					ServicFrontend.CONSOLE.CLASS_NAME,
					ServicFrontend.CONSOLE.METHOD_NAME,
					ServicFrontend.CONSOLE.EVENT_TEXT
				);
				console.debug( { event } );
				console.groupEnd();

				if ( event.isTrusted ) {
					this._private.messageToServiceWorker( { action: ServicFrontend.CONNECTION_LOST } );
				}
			} );

			window.addEventListener( 'online', ( /** @type {Event} */ event ) =>
			{
				console.groupCollapsed( '%c' + this.constructor.name + '%c online' + '%c event',
					ServicFrontend.CONSOLE.CLASS_NAME,
					ServicFrontend.CONSOLE.METHOD_NAME,
					ServicFrontend.CONSOLE.EVENT_TEXT
				);
				console.debug( { event } );
				console.groupEnd();

				if ( event.isTrusted ) {
					this._private.messageToServiceWorker( { action: ServicFrontend.CONNECTION_REPAIRED } );
				}
			} );

			offlineToggle.addEventListener( ServicFrontendPrivate.CHANGE_EVENT, ( /** @type {MouseEvent} */ event ) =>
			{
				if ( event.isTrusted ) {

					/** @type {HTMLInputElement} */
					const offlineToggle = ( event.target );

					offlineToggle.disabled = true;
					const actionStatus = offlineToggle.checked ? ServicFrontend.ADD_INTO_CACHE : ServicFrontend.REMOVE_FROM_CACHE;
					this._private.messageToServiceWorker( {
						action: actionStatus,
						url: window.location.href,
						parentId: offlineToggle.parentElement.id,
						isHtmlDocument: true
					} );
				}
			}, false );
		}
	}

	prepareNotific ()
	{
		console.debug( '%c' + this.constructor.name + '%c prepareNotific',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME
		);

		const NOTIFIC_FUNCTION_NAME = 'Notific';

		if ( !( NOTIFIC_FUNCTION_NAME in window ) && 'Notification' in window ) {
			Object.defineProperty( window, NOTIFIC_FUNCTION_NAME, {
				value: Notification,
				writable: false,
				configurable: true,
				enumerable: false,
			} );
		}
	}

	run ()
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c run',
			ServicFrontend.CONSOLE.CLASS_NAME,
			ServicFrontend.CONSOLE.METHOD_NAME
		);

		this.registerServiceWorker();
		this.prepareNotific();
		this.afterServiceWorkerRegistration().then( () =>
		{
			this.initInstallApp();
			this.initPushSubscriptions();
			this.initOfflineToggle();
		} );

		console.groupEnd();

		return true;
	}

}
