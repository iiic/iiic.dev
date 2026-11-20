/**
* @private
* @module ServicWorkerPrivate
* @classdesc @todo … description
* @author ic < ic.czech@gmail.com >
* @see https://iiic.dev/…
* @license https://creativecommons.org/licenses/by-sa/4.0/legalcode.cs CC BY-SA 4.0
* @since Q2 2020
* @version 0.1
* @readonly
*/
const ServicWorkerPrivate = class
{

	/**
	 * @public
	 * @type {Object}
	 * @description default settings… can be overwritten
	 */
	settings = {
		hostname: null,
		cacheDefaultUrls: [ '/' ], // cannot add 404 files
		offlinePage: '/offline.html',
		notFoundPage: '/e404.html',
		debugIntoConsole: false,
		imageExtensions: [
			'jpg',
			'jpeg',
			'png',
			'gif',
			'bmp',
			'tif',
			'tiff',
			'webp',
		],
		cspNonce: {
			bypass: true,
			html: {
				identifierStart: ' nonce="',
				identifierEnd: '"',
			},
		},
		tempMaxItems: 20,
		cacheInvalidatorLength: 7, // in chars
		serverDrivenTemp: false,
		autoCache: false,
		autoRun: true,
	};

	/**
	* @public
	* @type {ServiceWorkerGlobalScope}
	*/
	swgs;

	/**
	* @public
	* @type {Object}
	*/
	tempData = new Object;

	getFileExtensionFrom ( /** @type {String} */ path ) // tohle asi není dobrý postup
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c getFileExtensionFrom %c(' + path + ')',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME,
			ServicWorker.CONSOLE.INTEREST_PARAMETER
		);
		console.debug( { arguments } );
		console.groupEnd();

		const safePath = path.split( '?' )[ 0 ];
		return safePath.slice( ( safePath.lastIndexOf( '.' ) - 1 >>> 0 ) + 2 );
	}

	isImageBy ( /** @type {String} */ path ) // tohle asi není dobrý postup
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c isImageBy %c(' + path + ')',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME,
			ServicWorker.CONSOLE.INTEREST_PARAMETER
		);
		console.debug( { arguments } );
		console.groupEnd();

		return this.settings.imageExtensions.includes( this.getFileExtensionFrom( path ) );
	}

	temp = {
		put: ( /** @type {String} */ path, /** @type {Object.<Request, Response>} */ pair ) =>
		{

			/** @type {String} */
			const safePath = this.getSafePathFrom( path, pair.request.destination );

			console.groupCollapsed( '%c' + this.constructor.name + '%c temp.put %c(' + safePath + ')',
				ServicWorker.CONSOLE.CLASS_NAME,
				ServicWorker.CONSOLE.METHOD_NAME,
				ServicWorker.CONSOLE.INTEREST_PARAMETER
			);
			console.debug( path, pair );
			console.groupEnd();

			if ( this.tempData[ safePath ] ) {
				return true;
			}

			Object.assign( pair, { timestamp: Date.now() } );

			if ( this.settings.cspNonce.bypass && pair.response.headers.get( ServicWorker.CSP_HTTP_HEADER ) ) {

				/** @type {Response} */
				const response = pair.response.clone();

				response.blob().then( ( /** @type {Blob} */ blob ) =>
				{
					blob.text().then( ( /** @type {String} */ blobText ) =>
					{
						pair.response = new Response( blob, {
							status: response.status,
							statusText: response.statusText,
							headers: this.cloneHeadersFrom( response.headers, blobText )
						} );
						Object.assign( this.tempData, { [ safePath ]: pair } );
					} );
				} );
			} else {
				Object.assign( this.tempData, { [ safePath ]: pair } );
			}

			while ( Object.keys( this.tempData ).length > this.settings.tempMaxItems ) {

				/** @type {Array.<String>} */
				const tempKeys = Object.keys( this.tempData );

				const oldestItem = { key: tempKeys[ 0 ], timestamp: this.tempData[ tempKeys[ 0 ] ].timestamp };
				tempKeys.forEach( ( /** @type {String} */ key ) =>
				{
					if ( oldestItem.timestamp > this.tempData[ key ].timestamp ) {
						oldestItem.key = key;
						oldestItem.timestamp = this.tempData[ key ].timestamp;
					}
				} );
				delete this.tempData[ oldestItem.key ];
			}
			//console.log( 'v tempu máme ' + Object.keys( this.tempData ).length + ' položek' );
		}
	};

	create404SVGResponse ( /** @type {Request} */ eventRequest ) // asi async… zjistit
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c create404SVGResponse',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);
		console.debug( { arguments } );
		console.groupEnd();

		const DIVIDER = ' ; ';

		/** @type {String} */
		const dest = eventRequest.destination;

		let picText = new String;
		if ( dest ) {
			picText += dest + DIVIDER;
		}
		picText += eventRequest.url;
		const dpr = eventRequest.headers.get( 'dpr' );
		if ( dpr ) {
			picText += DIVIDER + 'DPR: ' + dpr;
		}

		return new Response( '<svg xmlns="http://www.w3.org/2000/svg" width="350" height="250" viewBox="0 0 350 250" preserveAspectRatio="none"><rect width="350" height="250" fill="#eee"/><text text-anchor="middle" x="175" y="125" style="fill:#aaa;font-weight:bold;font-size:12px;font-family:Arial,Helvetica,sans-serif;dominant-baseline:central">' + picText + '</text></svg>', {
			status: 200,
			statusText: 'OK',
			headers: new Headers( {
				'Content-Type': 'image/svg+xml'
			} )
		} );
	}

	cloneHeadersFrom (/** @type {Headers} */ nativeHeaders, /** @type {String} */ blobText = null )
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c cloneHeadersFrom',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);
		console.debug( { arguments } );
		console.groupEnd();

		const CSP_NONCE_PREFIX = "'nonce-";
		const CSP_NONCE_SUFFIX = "'";

		const is = this.settings.cspNonce.html.identifierStart;

		let nonce = '';
		const startNoncePosition = blobText.indexOf( is );
		if ( startNoncePosition > 0 ) {
			const endNoncePosition = blobText.indexOf( this.settings.cspNonce.html.identifierEnd, startNoncePosition + is.length );
			if ( endNoncePosition > 0 ) {
				nonce = blobText.substring( startNoncePosition + is.length, endNoncePosition );
			}
		}

		if ( nonce ) {
			const regexp = new RegExp( CSP_NONCE_PREFIX + "(.+?)" + CSP_NONCE_SUFFIX, 'i' );

			const headers = new Headers;
			nativeHeaders.forEach( ( /** @type {String} */ value, /** @type {String} */ key ) =>
			{
				if ( key === ServicWorker.CSP_HTTP_HEADER ) {
					headers.append( key, value.replace( regexp, CSP_NONCE_PREFIX + nonce + CSP_NONCE_SUFFIX ) );
				} else {
					headers.append( key, value ); // headers.append will join duplicate headers and remove set-cookie
				}
			} );
			return headers;
		}
		return nativeHeaders;
	}

	async manageHtmlDocument (
		/** @type {Request} */ eventRequest,
		/** @type {Response} */ response,
		/** @type {Response} */ clonedResponse
	)
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c manageHtmlDocument',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);
		console.debug( { arguments } );
		console.groupEnd();

		this.temp.put( eventRequest.url, {
			request: eventRequest,
			response: clonedResponse
		} );
		return new Promise( ( /** @type {Function} */ resolve ) =>
		{
			if ( this.settings.cspNonce.bypass && response.headers.get( ServicWorker.CSP_HTTP_HEADER ) ) {
				return response.blob().then( ( /** @type {Blob} */ blob ) =>
				{
					return blob.text().then( ( /** @type {String} */ blobText ) =>
					{
						resolve( new Response( blob, {
							status: response.status,
							statusText: response.statusText,
							headers: this.cloneHeadersFrom( response.headers, blobText )
						} ) );
					} );
				} );
			} else {
				return response;
			}
		} );
	}

	manageNonHtmlRequest (
		/** @type {Request} */ eventRequest,
		/** @type {Request} */ nativeEventRequest,
		/** @type {Response} */ response,
		/** @type {Response} */ clonedResponse
	)
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c manageNonHtmlRequest',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);
		console.debug( { arguments } );
		console.groupEnd();

		if (
			response.type === ServicWorker.BASIC_RESPONSE_TYPE
			&& response.status === 404
			&& nativeEventRequest.mode !== ServicWorker.NAVIGATE_REQUEST_MODE
			&& ( nativeEventRequest.destination === ServicWorker.IMAGE_REQUEST_DESTINATION
				|| this.isImageBy( eventRequest.url )
			)
		) {
			return this.create404SVGResponse( nativeEventRequest );
		}
		if ( eventRequest.cache !== ServicWorker.REQUEST_NO_CACHE && this.settings.autoCache ) {
			caches.open( this.settings.hostname ).then( ( /** @type { Cache } */ cache ) =>
			{
				cache.put( this.getSafePathFrom( eventRequest.url, eventRequest.destination ), clonedResponse );
			} );
		}
	}

	async isCachedBy ( /** @type {String} */ path, /** @type {Boolean} */ withErrorHttpStatus = false, /** @type {Boolean} */ isHtmlDocument = false )
	{

		/** @type {String} */
		const safePath = this.getSafePathFrom( path, isHtmlDocument ? ServicWorker.DOCUMENT_REQUEST_DESTINATION : '' );

		console.groupCollapsed( '%c' + this.constructor.name + '%c isCachedBy %c(' + safePath + ')',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME,
			ServicWorker.CONSOLE.INTEREST_PARAMETER
		);
		console.debug( { arguments } );
		console.groupEnd();

		/** @type {CacheStorage} */
		const caches = ( this.swgs.caches );

		return caches.open( this.settings.hostname ).then( ( /** @type {Cache} */ cache ) =>
		{
			return cache.match( safePath ).then( ( /** @type {Response} */ response ) =>
			{
				return typeof response !== 'undefined' && response.ok === !withErrorHttpStatus;
			} );
		} );
	}

	async getOfflineResponseBy ( /** @type {TypeError | Error} */ error )
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c getOfflineResponseBy',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);
		console.debug( { arguments } );
		console.groupEnd();

		const serviceUnavailable = () =>
		{
			return new Response( '<h1>Service Unavailable</h1>', {
				status: 503,
				statusText: 'Service Unavailable',
				headers: new Headers( {
					'Content-Type': 'text/html'
				} )
			} );
		}

		return new Promise( ( /** @type {Function} */ resolve ) =>
		{
			if ( navigator.onLine ) {
				this.isCachedBy( this.settings.notFoundPage, true ).then( ( /** @type {Boolean} */ status ) =>
				{
					console.log( 'výsledek', status );
					if ( status ) {
						resolve( caches.match( this.settings.notFoundPage ) );
					} else {
						resolve( serviceUnavailable() );
					}
				} );
			} else {
				this.isCachedBy( this.settings.offlinePage ).then( ( /** @type {Boolean} */ status ) =>
				{
					if ( status ) {
						resolve( caches.match( this.settings.offlinePage ) );
					} else {
						resolve( serviceUnavailable() );
					}
				} );
			}
		} );
	}

	getSafePathFrom ( /** @type {String} */ path, /** @type {String} */ eventRequestDestination )
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c getSafePathFrom %c(' + path + ')',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME,
			ServicWorker.CONSOLE.INTEREST_PARAMETER
		);
		console.debug( { arguments } );
		console.groupEnd();

		const POSSIBLE_PROTOCOLS = [ 'https://', 'http://' ];
		const SLASH = '/';
		const QUESTION_MARK = '?';

		let safePath = path;

		let crossDomain = false;
		if ( path.substring( 0, this.settings.hostname.length ) === this.settings.hostname ) {
			POSSIBLE_PROTOCOLS.forEach( ( /** @type {String} */ possibleProtocol ) =>
			{
				if ( safePath.substr( 0, possibleProtocol.length ) === possibleProtocol ) {
					safePath = safePath.replace( possibleProtocol, '' );
					if ( safePath.indexOf( SLASH ) !== -1 ) {
						safePath = safePath.substring( safePath.indexOf( SLASH ) )
						crossDomain = true;
					}
				}
			} );
			if ( safePath.substr( 0, SLASH.length ) !== SLASH ) {
				safePath = SLASH + safePath;
			}
		}

		let cacheInvalidatorString = false;
		if ( safePath.includes( QUESTION_MARK ) ) {
			const qsaString = safePath.substring( safePath.indexOf( QUESTION_MARK ) );
			if ( qsaString.length === this.settings.cacheInvalidatorLength ) {
				cacheInvalidatorString = true;
			}
		}

		if (
			eventRequestDestination !== ServicWorker.DOCUMENT_REQUEST_DESTINATION
			&& cacheInvalidatorString
			&& !crossDomain
		) {
			safePath = safePath.slice( 0, -this.settings.cacheInvalidatorLength );
		}

		return safePath;
	}

	async manageFetchBy ( /** @type {Boolean} */ trusted, /** @type {Request} */ eventRequest, /** @type {Request} */ nativeEventRequest )
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c manageFetchBy',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);
		console.debug( { arguments } );
		console.groupEnd();

		return fetch( eventRequest ).then( ( /** @type {Response | null} */ response ) =>
		{
			if ( eventRequest.method === 'GET' && response && this.settings.autoCache ) {

				/** @type {Response} */
				const clonedResponse = response.clone();

				if ( this.isHtmlDocument( trusted, eventRequest, response ) ) {
					return this.manageHtmlDocument( eventRequest, response, clonedResponse );
				} else {
					const image404response = this.manageNonHtmlRequest( eventRequest, nativeEventRequest, response, clonedResponse );
					if ( image404response ) {
						return image404response;
					}
				}
			}
			return response;
		} ).catch( ( /** @type {TypeError | Error} */ error ) =>
		{
			return this.getOfflineResponseBy( error );
		} );
	}

	isHtmlDocument (/** @type {Boolean} */ trusted, /** @type {Request} */ eventRequest, /** @type {Response} */ response )
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c isHtmlDocument %c(' + eventRequest.url + ')',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME,
			ServicWorker.CONSOLE.INTEREST_PARAMETER
		);
		console.debug( { arguments } );
		console.groupEnd();

		if (
			trusted
			&& response.type === ServicWorker.BASIC_RESPONSE_TYPE
			&& response.status >= 200
			&& response.status < 400
			&& eventRequest.mode === ServicWorker.NAVIGATE_REQUEST_MODE
			&& eventRequest.destination === ServicWorker.DOCUMENT_REQUEST_DESTINATION
		) {
			return true;
		}
		return false;
	}

	async checkNewestVersionOf ( /** @type {Boolean} */ trusted, /** @type {Request} */ eventRequest, /** @type {Request} */ nativeEventRequest, /** @type {Response} */ nativeResponse )
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c checkNewestVersionOf',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);
		console.debug( { arguments } );
		console.groupEnd();

		const LAST_MODIFIED_HEADER_NAME = 'Last-Modified';
		return new Promise( ( /** @type {Function} */ resolve ) =>
		{
			if ( this.isHtmlDocument( trusted, eventRequest, nativeResponse ) ) {
				const nativeLastModif = Date.parse( nativeResponse.headers.get( LAST_MODIFIED_HEADER_NAME ) );
				if ( nativeLastModif ) {
					fetch( nativeResponse.url ).then( ( /** @type {Response} */ response ) =>
					{
						const lastModif = Date.parse( response.headers.get( LAST_MODIFIED_HEADER_NAME ) );
						if ( lastModif && lastModif > nativeLastModif ) {

							/** @type {CacheStorage} */
							const caches = ( this.swgs.caches );

							caches.open( this.settings.hostname ).then( ( /** @type { Cache } */ cache ) =>
							{
								cache.put( this.getSafePathFrom( eventRequest.url, eventRequest.destination ), response );
								/// @todo zkontrolovat, jestli tam nejsou vadné hlavičky
								console.log( 'narazil jsem na novější verzi dokumentu… vkládám do cache' );
								resolve( true );
							} );
						} else {
							resolve( null );
						}
					} );
				}
			}
		} );
	}

	async cacheResource ( /** @type {String} */ path, /** @type {Number} */ action, /** @type {Boolean} */ isHtmlDocument = false )
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c cacheResource',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);
		console.debug( { arguments } );
		console.groupEnd();

		/** @type {CacheStorage} */
		const caches = ( this.swgs.caches );

		/** @type {String} */
		const safePath = this.getSafePathFrom( path );

		return caches.open( this.settings.hostname ).then( ( /** @type { Cache } */ cache ) =>
		{

			if ( action === ServicWorker.ADD_INTO_CACHE ) {

				/** @type {Object | null} */
				const resourceInTemp = this.tempData[ safePath ];

				if ( resourceInTemp ) {
					return cache.put( this.getSafePathFrom( resourceInTemp.request.url, resourceInTemp.request.destination ), resourceInTemp.response.clone() ).then( () =>
					{
						return true;
					} );
				} else {
					return cache.add( safePath ).then( () =>
					{
						return true;
					} );
				}
			} else if ( action === ServicWorker.REMOVE_FROM_CACHE ) {
				return cache.delete( safePath ).then( ( /** @type {Boolean} */ status ) =>
				{
					return status;
				} );
			}
		} );
	} // async cacheResource
} // ServicWorkerPrivate

/**
* @public
* @module ServicWorker
* @classdesc @todo … description
* @author ic < ic.czech@gmail.com >
* @see https://iiic.dev/…
* @license https://creativecommons.org/licenses/by-sa/4.0/legalcode.cs CC BY-SA 4.0
* @since Q2 2020
* @version 0.1
*/
const ServicWorker = class
{

	/**
	 * @private
	 * @description '#private' is not currently supported by Firefox, so that's why '_private'
	 */
	_private;

	/* client x server messaging */
	static IS_CACHED_BY = 1;
	static ADD_INTO_CACHE = 2;
	static REMOVE_FROM_CACHE = 3;
	static CONNECTION_LOST = 4;
	static CONNECTION_REPAIRED = 5;
	static NOTIFIC_FROM_WORKER = 6;

	static REQUEST_NO_CACHE = 'no-cache';
	static BASIC_RESPONSE_TYPE = 'basic';
	static IMAGE_REQUEST_DESTINATION = 'image';
	static NAVIGATE_REQUEST_MODE = 'navigate';
	static DOCUMENT_REQUEST_DESTINATION = 'document';
	static CSP_HTTP_HEADER = 'content-security-policy';

	static CONSOLE = {
		CLASS_NAME: 'color: gray',
		METHOD_NAME: 'font-weight: normal; color: green',
		INTEREST_PARAMETER: 'font-weight: normal; font-size: x-small; color: blue',
		EVENT_TEXT: 'color: orange',
		WARNING: 'color: red',
	};

	constructor (
		/** @type {ServiceWorkerGlobalScope} */ swgs,
		/** @type {String} */ hostname,
		/** @type {Object | null} */ settings = null
	)
	{
		this._private = new ServicWorkerPrivate;

		this.swgs = swgs;
		if ( settings ) {
			Object.assign( this._private.settings, settings ); // single level assign
		}

		if ( !this.settings.debugIntoConsole ) {
			const methods = [
				'debug',
				'groupCollapsed',
				'groupEnd',
				'log',
			];
			methods.forEach( function ( /** @type {String} */ methodName )
			{
				console[ methodName ] = function () { };
			} );
		}

		console.groupCollapsed( '%c' + this.constructor.name + '%c constructor',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);
		console.debug( { arguments } );

		this.setHostname( hostname );
		if ( this.settings.autoRun ) {
			this.run();
		}

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

	set swgs ( /** @type {ServiceWorkerGlobalScope} */ swgs )
	{
		this._private.swgs = swgs;
	}

	/**
	 * @returns {ServiceWorkerGlobalScope}
	 */
	get swgs ()
	{
		return this._private.swgs;
	}

	/**
	 * @description : @todo
	 * @returns {Object}
	 */
	get tempData ()
	{
		return this._private.tempData;
	}


	initActivateEventListener ()
	{
		console.debug( '%c' + this.constructor.name + '%c initActivateEventListener',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		this.swgs.addEventListener( 'activate', ( /** @type {ExtendableEvent} */ event ) =>
		{
			/** @type {ServiceWorkerGlobalScope} */
			const swgs = ( event.target );

			/** @type {Clients} */
			const clients = swgs.clients;

			/** @type {ServiceWorkerRegistration} */
			const registration = swgs.registration;

			// event.waitUntil( clients.claim() );
		} );
	}

	setHostname ( /** @type {String} */ hostname )
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c setHostname %c(' + hostname + ')',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME,
			ServicWorker.CONSOLE.INTEREST_PARAMETER
		);
		console.debug( { arguments } );

		const SLASH = '/';

		if ( hostname.slice( -SLASH.length ) === SLASH ) {
			this.settings.hostname = hostname.substring( 0, hostname.length - SLASH.length );
		} else {
			this.settings.hostname = hostname;
		}
		console.debug( this.settings.hostname );
		console.groupEnd();
	}

	initErrorEventListener ()
	{
		console.debug( '%c' + this.constructor.name + '%c initErrorEventListener',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		this.swgs.addEventListener( 'error', ( /** @type {ErrorEvent} */ event ) =>
		{
			console.log( 'sw: error event', event );
			// @todo : log error to GA
		} );
	}

	async initFetchEventListener ()
	{
		console.debug( '%c' + this.constructor.name + '%c initFetchEventListener',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		this.swgs.addEventListener( 'fetch', ( /** @type {FetchEvent} */ event ) =>
		{

			/** @type {ServiceWorkerGlobalScope} */
			const swgs = ( event.target );

			/** @type {CacheStorage} */
			const caches = ( swgs.caches ); // redundant, can work magically

			/** @type {Request} */
			let eventRequest = event.request;

			/** @type {Request} */
			let nativeEventRequest = null;

			// if ( eventRequest.destination !== ServicWorker.DOCUMENT_REQUEST_DESTINATION ) { // not a HTML document
			nativeEventRequest = eventRequest;
			// 	eventRequest = new Request( eventRequest, { // anonymous Request
			// 		credentials: 'omit'
			// 	} );
			// }

			event.respondWith(
				caches.match(
					this._private.getSafePathFrom( eventRequest.url, eventRequest.destination )
				).then( ( /** @type {Response | undefined} */ response ) =>
				{
					if ( response ) { // already cached
						this._private.checkNewestVersionOf( event.isTrusted, eventRequest, nativeEventRequest, response );
						return response;
					}
					return this._private.manageFetchBy( event.isTrusted, eventRequest, nativeEventRequest );
				} )
			);
		} );
	}

	async initInstallEventListener ()
	{
		console.debug( '%c' + this.constructor.name + '%c initInstallEventListener',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		return new Promise( ( /** @type {Function} */ resolve ) =>
		{
			// @ts-ignore
			this.swgs.addEventListener( 'install', ( /** @type {InstallEvent} */ event ) =>
			{

				/** @type {ServiceWorkerGlobalScope} */
				const swgs = ( event.target );

				if ( this.settings.autoCache ) {

					/** @type {CacheStorage} */
					const caches = ( swgs.caches ); // variable "caches" can also appear magically

					event.waitUntil(
						caches.open( this.settings.hostname ).then( ( /** @type {Cache} */ cache ) =>
						{
							return cache.addAll( this.settings.cacheDefaultUrls ).then( () =>
							{
								swgs.skipWaiting();
								resolve( true );
							} );
						} )
					);
				} else {
					swgs.skipWaiting();
				}
			} );
		} );
	}

	initLoadEventListener ()
	{
		console.debug( '%c' + this.constructor.name + '%c initLoadEventListener',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		this.swgs.addEventListener( 'load', ( event ) =>
		{
			console.log( 'sw: load event', event );
		} );
	}

	async messageToFrontend ( /** @type {Object} */ message, /** @type {ExtendableMessageEvent | PushEvent} */ event, /** @type {String | null} */ matchByWcUrl )
	{
		console.debug( '%c' + this.constructor.name + '%c messageToFrontend' + ' %c(' + event.data.action + ')',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME,
			ServicWorker.CONSOLE.INTEREST_PARAMETER
		);

		/** @type {ServiceWorkerGlobalScope} */
		const swgs = ( event.target );

		/** @type {Clients} */
		const clients = swgs.clients;

		if ( event.data.action ) {
			message.actionResponse = event.data.action;
		}

		if ( event.data.url ) {
			message.url = event.data.url;
		}

		if ( event.data.parentId ) {
			message.parentId = event.data.parentId;
		}

		clients.matchAll( {
			includeUncontrolled: true
		} ).then( ( /** @type {Array} */ windowClients ) =>
		{
			windowClients.forEach( ( /** @type {WindowClient} */ wc ) =>
			{
				if ( matchByWcUrl ) {
					if ( wc.url === matchByWcUrl ) { // only if match url
						wc.postMessage( message );
					}
				} else {
					wc.postMessage( message );
				}
			} );
		} );
	}

	initMessageEventListener ()
	{
		console.debug( '%c' + this.constructor.name + '%c initMessageEventListener',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		this.swgs.addEventListener( 'message', ( /** @type {ExtendableMessageEvent} */ event ) =>
		{
			console.groupCollapsed( '%c' + this.constructor.name + '%c message' + '%c event %c(' + event.data.action + ')',
				ServicWorker.CONSOLE.CLASS_NAME,
				ServicWorker.CONSOLE.METHOD_NAME,
				ServicWorker.CONSOLE.EVENT_TEXT,
				ServicWorker.CONSOLE.INTEREST_PARAMETER
			);
			console.debug( { arguments } );

			if ( event.isTrusted && event.data ) {

				/** @type {ServiceWorkerGlobalScope} */
				const swgs = ( event.target );

				/** @type {Clients} */
				const clients = swgs.clients;

				console.debug( event.data );

				if ( event.data.action === ServicWorker.IS_CACHED_BY ) {
					this._private.isCachedBy( event.data.url, false, event.data.isHtmlDocument ).then( ( /** @type {Boolean} */ isResourceCached ) =>
					{
						this.messageToFrontend( {
							response: isResourceCached,
						}, event, event.data.url );
					} );
				} else if ( event.data.action === ServicWorker.ADD_INTO_CACHE || event.data.action === ServicWorker.REMOVE_FROM_CACHE ) {
					this._private.cacheResource( event.data.url, event.data.action, event.data.isHtmlDocument ).then( ( /** @type {Boolean} */ result ) =>
					{
						this.messageToFrontend( {
							response: result,
						}, event, event.data.url );
					} );
				} else if ( event.data.action === ServicWorker.CONNECTION_LOST ) {
					// @todo : dočasně uložit všechno z tempu do cache a nějak to označit
					this.messageToFrontend( { response: true }, event );
				} else if ( event.data.action === ServicWorker.CONNECTION_REPAIRED ) {
					// @todo : dropnout všechno z cache, co je nějak označené jako dočasné v případě nečekaného výpadku internetu
					this.messageToFrontend( { response: true }, event );
				}
			}

			console.groupEnd();

		} );
	}

	initPushEventListener ()
	{
		console.debug( '%c' + this.constructor.name + '%c initPushEventListener',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		this.swgs.addEventListener( 'push', ( /** @type {PushEvent} */ event ) =>
		{
			console.groupCollapsed( '%c' + this.constructor.name + '%c push' + '%c event',
				ServicWorker.CONSOLE.CLASS_NAME,
				ServicWorker.CONSOLE.METHOD_NAME,
				ServicWorker.CONSOLE.EVENT_TEXT
			);
			console.debug( { arguments } );

			const NOTIFICATION_GRANTED = 'granted';

			/** @type {ServiceWorkerGlobalScope} */
			const swgs = ( event.target );

			/** @type {PushMessageData} */
			const pmd = event.data;

			/** @type {String} */
			const message = pmd.text();

			console.debug( message );
			console.groupEnd();

			/** @type {ServiceWorkerRegistration} */
			const registration = swgs.registration;

			/** @type {Clients} */
			const clients = swgs.clients;

			clients.matchAll( {
				includeUncontrolled: true
			} ).then( ( /** @type {Array} */ windowClients ) =>
			{
				if ( windowClients.length >= 1 ) {
					let i = 0;
					windowClients.forEach( ( /** @type {WindowClient} */ wc ) =>
					{
						i++;
						if ( wc.focused || i === windowClients.length ) {
							wc.postMessage( { message: message, actionResponse: ServicWorker.NOTIFIC_FROM_WORKER } );
						}
					} );
				} else if ( Notification.permission === NOTIFICATION_GRANTED ) { // 0 opened tabs
					registration.showNotification( message );
				}
			} );
		} );
	}

	initSyncEventListener ()
	{
		console.debug( '%c' + this.constructor.name + '%c initSyncEventListener',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		this.swgs.addEventListener( 'sync', ( /** @type {SyncEvent} */ event ) =>
		{

			/** @type {String} */
			const tagText = event.tag;

		} );
	}

	initCloseEventListener ()
	{
		console.debug( '%c' + this.constructor.name + '%c initCloseEventListener',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		this.swgs.addEventListener( 'close', ( event ) =>
		{
			console.log( 'sw: close event', event );
		} );
	}

	initNotificationclickEventListener ()
	{
		console.debug( '%c' + this.constructor.name + '%c initNotificationclickEventListener',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		this.swgs.addEventListener( 'notificationclick', ( event ) =>
		{
			console.log( 'sw: notificationclick event', event );
		} );
	}

	initNotificationcloseEventListener ()
	{
		console.debug( '%c' + this.constructor.name + '%c initNotificationcloseEventListener',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		this.swgs.addEventListener( 'notificationclose', ( event ) =>
		{
			console.log( 'sw: notificationclose event', event );
		} );
	}

	initPushsubscriptionchangeEventListener ()
	{
		console.debug( '%c' + this.constructor.name + '%c initPushsubscriptionchangeEventListener',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		this.swgs.addEventListener( 'pushsubscriptionchange', ( event ) =>
		{
			console.log( 'sw: pushsubscriptionchange event', event );
		} );
	}

	checkDefaultCacheUrls ()
	{
		console.debug( '%c' + this.constructor.name + '%c checkDefaultCacheUrls',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		// @todo : zkontrolovat metodou HEAD, jestli to existuje
		// @todo : odebrat ze začátku řetězce this.settings.hostname, pokud tam existuje a pokud je to vlastní doména
		// https://stackoverflow.com/questions/18837735/check-if-image-exists-on-server-using-javascript/18837818#answer-56196999
	}

	checkInitData ()
	{
		console.debug( '%c' + this.constructor.name + '%c checkInitData',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		if ( !this.swgs ) {
			throw 'Critical error : ServiceWorkerGlobalScope in unreachable';
		}
		if ( !this.settings.hostname ) {
			throw 'Critical error : Hostname is not set';
		}
	}

	async storeOfflinePage ()
	{
		console.debug( '%c' + this.constructor.name + '%c storeOfflinePage',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		return new Promise( ( /** @type {Function} */ resolve ) =>
		{
			if ( this.settings.autoCache ) {
				this._private.isCachedBy( this.settings.offlinePage ).then( ( /** @type {Boolean} */ status ) =>
				{
					if ( !status ) {

						/** @type {CacheStorage} */
						const caches = ( this.swgs.caches );

						caches.open( this.settings.hostname ).then( ( /** @type { Cache } */ cache ) =>
						{
							cache.add( this.settings.offlinePage );
							resolve( true );
						} );
					}
				} ).catch( () =>
				{
					resolve( false );
				} );
			} else {
				resolve( true );
			}

		} );
	}

	async storeNotFoundPage ()
	{
		console.debug( '%c' + this.constructor.name + '%c storeNotFoundPage',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);
		return new Promise( ( /** @type {Function} */ resolve ) =>
		{
			if ( this.settings.autoCache ) {
				this._private.isCachedBy( this.settings.notFoundPage ).then( ( /** @type {Boolean} */ status ) =>
				{
					if ( !status ) {

						/** @type {CacheStorage} */
						const caches = ( this.swgs.caches );

						caches.open( this.settings.hostname ).then( ( /** @type { Cache } */ cache ) =>
						{
							const request = new Request( this.settings.notFoundPage );
							return fetch( request ).then( ( response ) =>
							{
								caches.open( this.settings.hostname ).then( ( /** @type { Cache } */ cache ) =>
								{
									cache.put( this._private.getSafePathFrom( request.url, request.destination ), response );
									resolve( true );
								} );
							} );
						} );
					}
				} ).catch( () =>
				{
					resolve( false );
				} );
			} else {
				resolve( true );
			}
		} );
	}

	run ()
	{
		console.groupCollapsed( '%c' + this.constructor.name + '%c run',
			ServicWorker.CONSOLE.CLASS_NAME,
			ServicWorker.CONSOLE.METHOD_NAME
		);

		this.checkInitData();
		this.checkDefaultCacheUrls();
		this.initInstallEventListener().then( () =>
		{
			this.storeOfflinePage();
			this.storeNotFoundPage();
		} );
		this.initActivateEventListener();
		this.initErrorEventListener();
		this.initFetchEventListener();
		this.initLoadEventListener();
		this.initMessageEventListener();
		this.initPushEventListener();
		this.initSyncEventListener();
		this.initCloseEventListener();
		this.initNotificationclickEventListener();
		this.initNotificationcloseEventListener();
		this.initPushsubscriptionchangeEventListener();

		console.groupEnd();

		return true;
	}

}
