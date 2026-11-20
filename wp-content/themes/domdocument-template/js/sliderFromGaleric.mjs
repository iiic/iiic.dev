/**
* @private
* @module SliderFromGalericPrivate
* @classdesc Privátní část…
* @author ic < ic.czech@gmail.com >
* @see https://iiic.dev/slider-from-galeric
* @license https://creativecommons.org/licenses/by-sa/4.0/legalcode.cs CC BY-SA 4.0
* @since Q1 2021
* @version 0.1
* @readonly
*/
const SliderFromGalericPrivate = class
{

	static TYPE_STRING = 'String';

	/**
	 * @public
	 * @type {Object}
	 * @description default settings… can be overwritten
	 */
	settings = {
		rootElementQuerySelector: '.wp-block-gallery',
		CSSStyleSheets: [
			{ href: '/slider-from-galeric.css', integrity: 'sha256-lfgpqXdtFKh9UaPKsVCNh+YT8FMR6ZUwh22SQ297PZQ=' } // [2026-11-20] hash nově založeného css/slider-from-galeric.css (dříve sha256-jG+KXqX… – soubor neexistoval a hash patřil jinému souboru)
		],
		movedCssClassName: 'moved',
		singleSlideWidth: null,
		slidingInterval: 12000, // in ms
		rewindIntervalBase: 100, // in ms
		preloadImages: [], // can be used if css contains images
		modulesImportPath: 'https://iiic.dev/js/modules',
		autoRun: true,
	};

	/**
	 * @public
	 * @type {HTMLElement}
	 */
	rootElement = HTMLElement;

	/**
	* @public
	* @type {Number}
	*/
	sliderInterval = null;


	async initImportWithIntegrity ( /** @type {Object} */ settings = null )
	{

		console.groupCollapsed( '%c SliderFromGalericPrivate %c initImportWithIntegrity %c(' + ( settings === null ? 'without settings' : 'with settings' ) + ')',
			SliderFromGaleric.CONSOLE.CLASS_NAME,
			SliderFromGaleric.CONSOLE.METHOD_NAME,
			SliderFromGaleric.CONSOLE.INTEREST_PARAMETER
		);
		console.debug( { arguments } );
		console.groupEnd();

		return new Promise( ( /** @type { Function } */ resolve ) =>
		{
			const ip = settings && settings.modulesImportPath ? settings.modulesImportPath : this.settings.modulesImportPath;
			import( ip + '/importWithIntegrity.mjs' ).then( ( /** @type {Module} */ module ) =>
			{
				/** @type {Function} */
				this.importWithIntegrity = module.importWithIntegrity;
				resolve( true );
			} ).catch( () =>
			{
				const SKIP_SECURITY_URL = '#skip-security-test-only'
				if ( window.location.hash === SKIP_SECURITY_URL ) {
					console.warn( '%c SliderFromGalericPrivate %c initImportWithIntegrity %c without security!',
						SliderFromGaleric.CONSOLE.CLASS_NAME,
						SliderFromGaleric.CONSOLE.METHOD_NAME,
						SliderFromGaleric.CONSOLE.WARNING
					);
					this.importWithIntegrity = (/** @type {String} */ path ) =>
					{
						return new Promise( ( /** @type {Function} */ resolve ) =>
						{
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

	elCreator = {
		br: () =>
		{
			return new Promise( ( /** @type {Function} */ resolve ) =>
			{
				if ( this.settings.resultSnippetBehaviour.allowLineBreak ) {
					this.rootElement.appendChild( document.createElement( 'BR' ) );
				}
				resolve( true );
			} );
		}
	}

}

/**
* @public
* @module SliderFromGaleric
* @classdesc …
* @author ic < ic.czech@gmail.com >
* @see https://iiic.dev/slider-from-galeric
* @license https://creativecommons.org/licenses/by-sa/4.0/legalcode.cs CC BY-SA 4.0
* @since Q1 2021
* @version 0.1
*/
export class SliderFromGaleric
{

	/**
	 * @private
	 * @description '#private' is not currently supported by Firefox, so that's why '_private'
	 */
	_private;

	/**
	* @public
	* @description colors used for browser's console output
	*/
	static CONSOLE = {
		CLASS_NAME: 'color: gray',
		METHOD_NAME: 'font-weight: normal; color: green',
		INTEREST_PARAMETER: 'font-weight: normal; font-size: x-small; color: blue',
		EVENT_TEXT: 'color: orange',
		WARNING: 'color: red',
	};


	constructor ( /** @type {HTMLScriptElement | null} */ settingsElement = null )
	{
		console.groupCollapsed( '%c SliderFromGaleric',
			SliderFromGaleric.CONSOLE.CLASS_NAME
		);
		console.debug( '%c' + 'constructor',
			SliderFromGaleric.CONSOLE.METHOD_NAME,
			[ { arguments } ]
		);

		this._private = new SliderFromGalericPrivate;

		/** @type {Object} */
		const settings = settingsElement && settingsElement.text ? JSON.parse( settingsElement.text ) : {};

		this._private.initImportWithIntegrity( settings ).then( () =>
		{
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


	set rootElement ( /** @type {HTMLElement} */ htmlElement )
	{
		this._private.rootElement = htmlElement;
	}

	/**
	 * @description : get root element
	 * @returns {HTMLElement} root element
	 */
	get rootElement ()
	{
		return this._private.rootElement;
	}

	/**
	 * @description : get script settings
	 * @returns {Object} settings of self
	 */
	get settings ()
	{
		return this._private.settings;
	}

	/**
	 * @description : Get dynamic Import function
	 * @returns {Function}
	 */
	get importWithIntegrity ()
	{
		return this._private.importWithIntegrity;
	}

	get elCreator ()
	{
		return this._private.elCreator;
	}

	/**
	 * @returns {Number}
	 */
	get sliderInterval ()
	{
		return this._private.sliderInterval;
	}

	set sliderInterval ( /** @type {Number} */ sliderInterval )
	{
		this._private.sliderInterval = sliderInterval;
	}


	async setSettings ( /** @type {Object} */ inObject )
	{
		console.groupCollapsed( '%c SliderFromGaleric %c setSettings',
			SliderFromGaleric.CONSOLE.CLASS_NAME,
			SliderFromGaleric.CONSOLE.METHOD_NAME
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
			).then( ( /** @type {Module} */ deepAssign ) =>
			{
				new deepAssign.append( Object );
				this._private.settings = Object.deepAssign( this.settings, inObject ); // multi level assign
				resolve( true );
			} ).catch( () =>
			{
				Object.assign( this._private.settings, inObject ); // single level assign
				resolve( true );
			} );
		} );
	}

	checkRequirements ()
	{
		console.debug( '%c SliderFromGaleric %c checkRequirements',
			SliderFromGaleric.CONSOLE.CLASS_NAME,
			SliderFromGaleric.CONSOLE.METHOD_NAME
		);


	}

	preloadImages ()
	{
		console.groupCollapsed( '%c SliderFromGaleric %c preloadImages',
			SliderFromGaleric.CONSOLE.CLASS_NAME,
			SliderFromGaleric.CONSOLE.METHOD_NAME
		);
		console.debug( this.settings.preloadImages );

		this.settings.preloadImages.forEach( ( /** @type {URL|String} */ url ) =>
		{

			/** @type {String} */
			const href = ( url.constructor.name === SliderFromGalericPrivate.TYPE_STRING ) ? url : url.href;

			/** @type {HTMLLinkElement} */
			const link = document.createElement( SliderFromGalericPrivate.LINK_NODE_NAME );

			link.rel = 'preload';
			link.href = href;
			link.as = 'image';
			// link.setAttribute( 'crossorigin', 'anonymous' ); // cannot be anonymous !
			document.head.appendChild( link );
		} );

		console.groupEnd();
	}

	initRootElement ()
	{
		console.debug( '%c SliderFromGaleric %c initRootElement',
			SliderFromGaleric.CONSOLE.CLASS_NAME,
			SliderFromGaleric.CONSOLE.METHOD_NAME
		);

		this.rootElement = document.querySelector( this.settings.rootElementQuerySelector );
	}

	async addCSSStyleSheets ()
	{
		console.debug( '%c SliderFromGaleric %c addCSSStyleSheets',
			SliderFromGaleric.CONSOLE.CLASS_NAME,
			SliderFromGaleric.CONSOLE.METHOD_NAME
		);

		return new Promise( ( /** @type {Function} */ resolve ) =>
		{
			const usedStyleSheets = new Set();
			[ ...document.styleSheets ].forEach( ( /** @type {CSSStyleSheet} */ css ) =>
			{
				if ( css.disabled === false ) {
					usedStyleSheets.add( css.href );
				}
			} );
			this.settings.CSSStyleSheets.forEach( ( /** @type {Object} */ assignment ) =>
			{
				let url = URL;
				if ( assignment.href.startsWith( 'https://', 0 ) || assignment.href.startsWith( 'http://', 0 ) ) {
					url = new URL( assignment.href );
				} else {
					url = new URL( assignment.href, window.location.protocol + '//' + window.location.hostname );
				}
				if ( !usedStyleSheets.has( url.href ) ) {
					fetch( url.href, {
						method: 'HEAD',
						credentials: 'omit',
						cache: 'force-cache',
						referrerPolicy: 'no-referrer',
						redirect: 'manual',
						mode: 'cors'
					} ).then( ( /** @type {Response} */ response ) =>
					{
						if ( response.ok ) {
							return true;
						} else {
							throw 'error';
						}
					} ).then( () =>
					{
						/** @type {HTMLLinkElement} */
						const link = document.createElement( SliderFromGalericPrivate.LINK_NODE_NAME );

						link.href = url.href;
						link.rel = 'stylesheet';
						link.setAttribute( 'crossorigin', 'anonymous' );
						if ( assignment.integrity ) {
							link.integrity = assignment.integrity;
						}
						document.head.appendChild( link );
					} ).catch( () =>
					{
						resolve( false );
					} );
				}
			} );
			resolve( true );
		} );
	}

	getSlideWidth ()
	{
		console.debug( '%c SliderFromGaleric %c getSlideWidth',
			SliderFromGaleric.CONSOLE.CLASS_NAME,
			SliderFromGaleric.CONSOLE.METHOD_NAME
		);

		if ( !this.settings.singleSlideWidth ) {
			this.settings.singleSlideWidth = this.rootElement.lastElementChild.firstElementChild.clientWidth;
		}
	}

	quickRewind ()
	{
		console.debug( '%c SliderFromGaleric %c quickRewind',
			SliderFromGaleric.CONSOLE.CLASS_NAME,
			SliderFromGaleric.CONSOLE.METHOD_NAME
		);

		let increment = 0;
		[ ...this.rootElement.lastElementChild.children ].forEach( ( /** @type {HTMLElement} */ node ) =>
		{
			setTimeout( () =>
			{
				node.classList.remove( this.settings.movedCssClassName );
			}, this.settings.rewindIntervalBase * increment );
			increment++;
		} );
		this.initSlidingAutoRun();
	}

	runSliding ()
	{
		console.debug( '%c SliderFromGaleric %c runSliding',
			SliderFromGaleric.CONSOLE.CLASS_NAME,
			SliderFromGaleric.CONSOLE.METHOD_NAME
		);

		const children = this.rootElement.lastElementChild.children;
		for ( const i in children ) {
			if ( children[ i ].nodeType !== Node.ELEMENT_NODE || Number( i ) === ( children.length - 1 ) ) {
				clearInterval( this.sliderInterval );
				this.quickRewind();
				break;
			} else if ( !children[ i ].classList.contains( this.settings.movedCssClassName ) ) {
				children[ i ].classList.add( this.settings.movedCssClassName );
				break;
			}
		}
	}

	initSlidingAutoRun ()
	{
		console.debug( '%c SliderFromGaleric %c initSliding',
			SliderFromGaleric.CONSOLE.CLASS_NAME,
			SliderFromGaleric.CONSOLE.METHOD_NAME
		);

		this.sliderInterval = setInterval( this.runSliding.bind( this ), this.settings.slidingInterval );
	}

	run ()
	{
		console.groupCollapsed( '%c SliderFromGaleric %c run',
			SliderFromGaleric.CONSOLE.CLASS_NAME,
			SliderFromGaleric.CONSOLE.METHOD_NAME
		);

		this.checkRequirements();
		//this.addCSSStyleSheets();
		this.initRootElement();
		this.getSlideWidth();
		this.initSlidingAutoRun();
		this.preloadImages();

		console.groupEnd();

		return true;
	}
};

new SliderFromGaleric( document.getElementById( 'slider-from-galeric-settings' ) );
