/**
* @private
* @module EPubFromElementPrivate
* @classdesc Creates ePub export for e-readers from selected html element(s) - private part
* @author ic < ic.czech@gmail.com >
* @see https://iiic.dev/epub-from-element
* @license https://creativecommons.org/licenses/by-sa/4.0/legalcode.cs CC BY-SA 4.0
* @since Q3 2021
* @version 0.3.1
* @readonly
*
* [2026-11-22] v0.3: ePub se umí vytvořit přímo v prohlížeči (createEPubInBrowser()) – výchozí chování, pokud nejsou
* zadané ePubServerSideEndpoints. Dříve ho vždy skládal server (PHP + TPEpubCreator + rozšíření zip) a obrázky si
* stahoval přes HTTP, takže jediný proces php-cgi čekal na síť (případně sám na sebe). Teď se obsah převede na platné
* XHTML (XMLSerializer), obrázky se vezmou z prohlížeče (většinou z cache) a vše se zabalí do ZIPu (EPUB 3 + toc.ncx
* pro starší čtečky). Funguje i na statickém webu bez PHP.
*/
const EPubFromElementPrivate = class
{

	static ANCHOR_NODE_NAME = 'A';
	static LINK_NODE_NAME = 'LINK';
	static B_NODE_NAME = 'B';
	static BR_NODE_NAME = 'BR';
	static BUTTON_NODE_NAME = 'BUTTON';
	static DIALOG_NODE_NAME = 'DIALOG';
	static DIV_NODE_NAME = 'DIV';
	static P_NODE_NAME = 'P';
	static STRONG_NODE_NAME = 'STRONG';
	static H1_NODE_NAME = 'H1';

	static MINUS = '-';
	static NBSP = ' ';
	static DOT = '.';
	static KEYCODE_ESC = 27;

	static CLICK_EVENT_NAME = 'click';
	static KEYUP_EVENT_NAME = 'keyup';

	static CONTENT_TYPE = 'application/json; charset=utf-8';

	// [2026-11-22] tvorba ePubu v prohlížeči (createEPubInBrowser())
	static EPUB_MIME_TYPE = 'application/epub+zip';
	static XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
	static SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
	static XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
	static XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>\n';
	static PAGE_FILE_NAME = 'page1.xhtml';
	static STYLE_FILE_NAME = 'style.css';

	/**
	* @description prvky, které do ePubu nepatří nikdy: skripty, vložený cizí obsah a ovládací prvky (v čtečce nefungují,
	* vložená videa a rámy by navíc byly vzdálené zdroje, které EPUB nedovoluje), skryté prvky a metadata
	*/
	static ALWAYS_REMOVED = [
		'script', 'noscript', 'style', 'link', 'meta', 'template', 'iframe', 'object', 'embed', 'video', 'audio', 'canvas',
		'form', 'button', 'input', 'select', 'textarea', 'dialog', '[hidden]',
	];

	/**
	* @description typy obrázků, které EPUB podporuje (core media types) → přípona souboru; ostatní (WebP, AVIF…) se
	* převedou na JPEG, nebo PNG, pokud mají průhlednost
	*/
	static CORE_IMAGE_TYPES = {
		'image/jpeg': 'jpg',
		'image/png': 'png',
		'image/gif': 'gif',
		'image/svg+xml': 'svg',
	};

	static IMAGE_ATTRIBUTES_TO_REMOVE = [ 'srcset', 'sizes', 'loading', 'decoding', 'fetchpriority' ];

	static XML_ATTRIBUTE_NAME = /^[A-Za-z_][\w.\-]*(:[A-Za-z_][\w.\-]*)?$/;

	static CRC32_TABLE = ( () =>
	{

		/** @type {Uint32Array} */
		const table = new Uint32Array( 256 );

		for ( let n = 0; n < 256; n++ ) {
			let c = n;
			for ( let k = 0; k < 8; k++ ) {
				c = c & 1 ? 0xEDB88320 ^ ( c >>> 1 ) : c >>> 1;
			}
			table[ n ] = c >>> 0;
		}
		return table;
	} )();

	static ATTRIBUTES = {
		DIALOG_ROLE: {
			NAME: 'role',
			VALUE: 'alertdialog',
		},
		ARIA_LABELLEDBY: {
			NAME: 'aria-labelledby',
			VALUE_SUFFIX: '-label',
		},
		ARIA_DESCRIBEDBY: {
			NAME: 'aria-describedby',
			VALUE_SUFFIX: '-description',
		},
		CONTENT_ROLE: {
			NAME: 'role',
			VALUE: 'document',
		},
		CONTENT_TABINDEX: {
			NAME: 'tabindex',
			VALUE: 0,
		},
		TOGGLER_ATTRIBUTE: {
			NAME: 'data-on',
			VALUE_PREFIX: 'tap:',
			CLOSE_SUFFIX: 'close',
		}
	};

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

	/**
	 * @public
	 * @type {Object}
	 * @description default settings… can be overwritten
	 */
	settings = {
		exportElementQuerySelectors: [ '[itemtype="https://schema.org/Article"]' ],
		toggleEPubElementId: 'epub',
		togglePrintElementId: 'print',
		resultsElementId: 'epub-response',
		ePubServerSideEndpoints: [], // [2026-11-22] dříve [ '/epub-print-script.php' ]; prázdné = ePub vytvoří prohlížeč (createEPubInBrowser())
		ePubTempPathPrefix: '',
		ePubStyleSheet: { href: '', integrity: '' }, // [2026-11-22] CSS vložené do ePubu (OEBPS/style.css), jen při tvorbě v prohlížeči
		removeFromExportQuerySelectors: [], // [2026-11-22] prvky webu, které do ePubu nepatří (sdílení, komentáře…); skripty, formuláře a podobné se vyřazují vždy (EPubFromElementPrivate.ALWAYS_REMOVED)
		ePub: {
			fileName: '',
			title: '',
			author: '',
			language: '',
			license: '',
			publisher: '',
		},
		structure: [
			'title',
			'br',
			'fileName',
			'fileSize',
			'br',
			'download',
			'nbsp',
			'share',
			'nbsp',
			'inlineCloseButton',
			'closeButton',
		],
		resultSnippetBehaviour: {
			allowLineBreak: true,
			makeResultElementSemantic: true,
		},
		serverSideHeaders: {
			fileName: 'X-Article-File-Name',
			title: 'X-Article-Title',
			author: 'X-Article-Author',
			language: 'X-Article-Language',
			license: 'X-Article-License',
			publisher: 'X-Article-Publisher',
		},
		texts: {
			title: 'Your article in ePub format is ready',
			fileName: 'File name',
			fileSize: 'File size',
			download: 'Download ePub',
			downloadTitle: 'Download ePub file into this device',
			share: 'Share link to ePub file',
			shareTitle: 'Share link to ePub file for another device',
			closeButton: 'x',
			closeButtonTitle: 'Close popup',
			inlineCloseButton: 'Close',
			textValueDelimiter: ': ',
			ePubAvailableOnUrl: 'Your article in ePub forma is available on: '
		},
		resultSnippetElements: {
			title: EPubFromElementPrivate.STRONG_NODE_NAME,
			fileName: EPubFromElementPrivate.P_NODE_NAME,
			fileSize: EPubFromElementPrivate.P_NODE_NAME,
			download: EPubFromElementPrivate.ANCHOR_NODE_NAME,
			share: EPubFromElementPrivate.BUTTON_NODE_NAME,
			inlineCloseButton: EPubFromElementPrivate.BUTTON_NODE_NAME,
			closeButton: EPubFromElementPrivate.BUTTON_NODE_NAME,
		},
		CSSStyleSheets: [
			{ href: '/epub-from-element.css', integrity: 'sha256-3dujCJSgkpcb6zbg2ZUAG6wT3b9AOQe/QqHgqWP6Jzo=' }
		],
		modulesImportPath: 'https://iiic.dev/js/modules',
		autoRun: true,
	};

	/**
	 * @public
	 * @type {HTMLElement}
	 */
	resultsElement = HTMLElement;

	/**
	 * @public
	 * @type {Function}
	 */
	importWithIntegrity;

	async initImportWithIntegrity ( /** @type {Object} */ settings = null )
	{

		console.groupCollapsed( '%c EPubFromElementPrivate %c initImportWithIntegrity %c(' + ( settings === null ? 'without settings' : 'with settings' ) + ')',
			EPubFromElement.CONSOLE.CLASS_NAME,
			EPubFromElement.CONSOLE.METHOD_NAME,
			EPubFromElement.CONSOLE.INTEREST_PARAMETER
		);
		console.debug( { arguments } );
		console.groupEnd();

		return new Promise( ( /** @type { Function } */ resolve ) =>
		{

			/** @type {Object} */
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
					console.warn( '%c EPubFromElementPrivate %c initImportWithIntegrity %c without security!',
						EPubFromElement.CONSOLE.CLASS_NAME,
						EPubFromElement.CONSOLE.METHOD_NAME,
						EPubFromElement.CONSOLE.WARNING
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

	async initBytesToSize ()
	{
		console.log( '%c EPubFromElementPrivate %c initBytesToSize',
			EPubFromElement.CONSOLE.CLASS_NAME,
			EPubFromElement.CONSOLE.METHOD_NAME
		);

		return this.importWithIntegrity(
			this.settings.modulesImportPath + '/number/bytesToSize.mjs',
			'sha256-aeAqkn2ZLpS0wCBjztGPqS2nd1f2HPbx+dCJGucIy3s='
		).then( ( /** @type {Module} */ bytesToSize ) =>
		{
			new bytesToSize.append( Number );
			return true;
		} );
	}

	async setSettings ( /** @type {Object} */ inObject )
	{
		console.groupCollapsed( '%c EPubFromElement %c setSettings',
			EPubFromElement.CONSOLE.CLASS_NAME,
			EPubFromElement.CONSOLE.METHOD_NAME
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
				this.settings = Object.deepAssign( this.settings, inObject ); // multi level assign
				resolve( true );
			} ).catch( () =>
			{
				Object.assign( this.settings, inObject ); // single level assign
				resolve( true );
			} );
		} );
	}

	static async addCSSStyleSheets ( /** @type {Array} */ CSSStyleSheets )
	{
		console.groupCollapsed( '%c EPubFromElementPrivate %c addCSSStyleSheets',
			EPubFromElement.CONSOLE.CLASS_NAME,
			EPubFromElement.CONSOLE.METHOD_NAME
		);
		console.debug( { arguments } );
		console.groupEnd();

		return new Promise( ( /** @type {Function} */ resolve ) =>
		{
			const usedStyleSheets = new Set();
			[ ...document.styleSheets ].forEach( ( /** @type {CSSStyleSheet} */ css ) =>
			{
				if ( css.disabled === false ) {
					usedStyleSheets.add( css.href );
				}
			} );
			CSSStyleSheets.forEach( ( /** @type {Object} */ assignment ) =>
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
						const link = document.createElement( EPubFromElementPrivate.LINK_NODE_NAME );

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

	async prepareFetches ( /** @type {String} */ jsonToSend )
	{
		const promises = [];

		this.settings.ePubServerSideEndpoints.forEach( ( /** @type {String} */ endpoint ) =>
		{
			promises.push(
				fetch( endpoint, {
					method: 'POST',
					headers: new Headers( {
						'Content-Type': this.CONTENT_TYPE,
						[ this.settings.serverSideHeaders.title ]: escape( this.settings.ePub.title ),
						[ this.settings.serverSideHeaders.fileName ]: escape( this.settings.ePub.fileName ),
						[ this.settings.serverSideHeaders.author ]: escape( this.settings.ePub.author ),
						[ this.settings.serverSideHeaders.language ]: escape( this.settings.ePub.language ),
						[ this.settings.serverSideHeaders.license ]: escape( this.settings.ePub.license ),
						[ this.settings.serverSideHeaders.publisher ]: escape( this.settings.ePub.publisher ),
					} ),
					body: jsonToSend,
					cache: 'no-cache',
					referrer: 'no-referrer',
					mode: 'cors',
				} ).then( ( /** @type {Response} */ response ) =>
				{
					return response.blob();
				} )
			);
		} );
		return promises;
	}

	static crc32 ( /** @type {Uint8Array} */ bytes )
	{
		let crc = 0xFFFFFFFF;
		for ( let i = 0; i < bytes.length; i++ ) {
			crc = EPubFromElementPrivate.CRC32_TABLE[ ( crc ^ bytes[ i ] ) & 0xFF ] ^ ( crc >>> 8 );
		}
		return ( crc ^ 0xFFFFFFFF ) >>> 0;
	}

	static async deflateRaw ( /** @type {Uint8Array} */ bytes )
	{
		if ( typeof CompressionStream === 'undefined' ) {
			return null; // starší prohlížeč – soubor se uloží bez komprese
		}
		try {

			/** @type {ReadableStream} */
			const stream = new Blob( [ bytes ] ).stream().pipeThrough( new CompressionStream( 'deflate-raw' ) );

			return new Uint8Array( await new Response( stream ).arrayBuffer() );
		} catch ( error ) {
			return null;
		}
	}

	/**
	* @description ZIP (bez ZIP64) ze souborů { name, data: Uint8Array, compress: Boolean } v zadaném pořadí. Soubor
	* `mimetype` musí být v ePubu první a bez komprese.
	*/
	static async createZip ( /** @type {Array} */ files, /** @type {String} */ mimeType )
	{

		/** @type {TextEncoder} */
		const encoder = new TextEncoder();

		/** @type {Date} */
		const now = new Date();

		/** @type {Number} */
		const dosTime = ( now.getHours() << 11 ) | ( now.getMinutes() << 5 ) | ( now.getSeconds() >> 1 );

		/** @type {Number} */
		const dosDate = ( ( now.getFullYear() - 1980 ) << 9 ) | ( ( now.getMonth() + 1 ) << 5 ) | now.getDate();

		/** @type {Array} */
		const localParts = [];

		/** @type {Array} */
		const centralParts = [];

		let offset = 0;
		let centralSize = 0;

		for ( const file of files ) {

			/** @type {Uint8Array} */
			const name = encoder.encode( file.name );

			/** @type {Number} */
			const flags = /^[\x20-\x7E]*$/.test( file.name ) ? 0 : 0x0800; // 0x0800 = název v UTF-8

			/** @type {Number} */
			const crc = EPubFromElementPrivate.crc32( file.data );

			let data = file.data;
			let method = 0; // 0 = bez komprese, 8 = deflate
			if ( file.compress ) {

				/** @type {Uint8Array|null} */
				const deflated = await EPubFromElementPrivate.deflateRaw( file.data );

				if ( deflated && deflated.length < file.data.length ) {
					data = deflated;
					method = 8;
				}
			}

			/** @type {DataView} */
			const local = new DataView( new ArrayBuffer( 30 ) );

			local.setUint32( 0, 0x04034B50, true );
			local.setUint16( 4, 20, true );
			local.setUint16( 6, flags, true );
			local.setUint16( 8, method, true );
			local.setUint16( 10, dosTime, true );
			local.setUint16( 12, dosDate, true );
			local.setUint32( 14, crc, true );
			local.setUint32( 18, data.length, true );
			local.setUint32( 22, file.data.length, true );
			local.setUint16( 26, name.length, true );
			local.setUint16( 28, 0, true ); // žádné extra pole (u `mimetype` ho EPUB zakazuje)
			localParts.push( local, name, data );

			/** @type {DataView} */
			const central = new DataView( new ArrayBuffer( 46 ) );

			central.setUint32( 0, 0x02014B50, true );
			central.setUint16( 4, 20, true );
			central.setUint16( 6, 20, true );
			central.setUint16( 8, flags, true );
			central.setUint16( 10, method, true );
			central.setUint16( 12, dosTime, true );
			central.setUint16( 14, dosDate, true );
			central.setUint32( 16, crc, true );
			central.setUint32( 20, data.length, true );
			central.setUint32( 24, file.data.length, true );
			central.setUint16( 28, name.length, true );
			central.setUint32( 42, offset, true );
			centralParts.push( central, name );

			offset += 30 + name.length + data.length;
			centralSize += 46 + name.length;
		}

		/** @type {DataView} */
		const end = new DataView( new ArrayBuffer( 22 ) );

		end.setUint32( 0, 0x06054B50, true );
		end.setUint16( 8, files.length, true );
		end.setUint16( 10, files.length, true );
		end.setUint32( 12, centralSize, true );
		end.setUint32( 16, offset, true );

		return new Blob( [ ...localParts, ...centralParts, end ], { type: mimeType } );
	}

	static escapeXml ( /** @type {String} */ text )
	{
		return String( text ).replace( /[<>&"']/g, ( /** @type {String} */ character ) =>
		{
			return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', '\'': '&apos;' }[ character ];
		} );
	}

	static createUuid ()
	{
		// crypto.randomUUID() existuje jen v zabezpečeném kontextu (https), getRandomValues() všude

		/** @type {Uint8Array} */
		const bytes = crypto.getRandomValues( new Uint8Array( 16 ) );

		bytes[ 6 ] = ( bytes[ 6 ] & 0x0F ) | 0x40;
		bytes[ 8 ] = ( bytes[ 8 ] & 0x3F ) | 0x80;

		/** @type {String} */
		const hex = [ ...bytes ].map( ( /** @type {Number} */ byte ) => byte.toString( 16 ).padStart( 2, '0' ) ).join( '' );

		return hex.slice( 0, 8 ) + '-' + hex.slice( 8, 12 ) + '-' + hex.slice( 12, 16 ) + '-' + hex.slice( 16, 20 ) + '-' + hex.slice( 20 );
	}

	static async toCoreImage ( /** @type {Blob} */ blob )
	{

		/** @type {String} */
		const type = blob.type.split( ';' )[ 0 ].trim().toLowerCase();

		if ( type in EPubFromElementPrivate.CORE_IMAGE_TYPES ) {
			return type === blob.type ? blob : new Blob( [ blob ], { type: type } );
		}
		if ( typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined' ) {
			return null;
		}

		/** @type {ImageBitmap} */
		const bitmap = await createImageBitmap( blob );

		/** @type {OffscreenCanvas} */
		const canvas = new OffscreenCanvas( bitmap.width, bitmap.height );

		/** @type {OffscreenCanvasRenderingContext2D} */
		const context = canvas.getContext( '2d' );

		context.drawImage( bitmap, 0, 0 );
		bitmap.close();

		/** @type {Uint8ClampedArray} */
		const pixels = context.getImageData( 0, 0, canvas.width, canvas.height ).data;

		let opaque = true;
		for ( let i = 3; i < pixels.length; i += 4 ) {
			if ( pixels[ i ] < 255 ) {
				opaque = false;
				break;
			}
		}
		return canvas.convertToBlob( opaque ? { type: 'image/jpeg', quality: 0.9 } : { type: 'image/png' } );
	}

	/**
	* @description stáhne obrázek (většinou z cache prohlížeče), přidá ho do `images` a vrátí jeho cestu v ePubu, nebo
	* null (chyba sítě, obrázek z cizí domény bez CORS, nepodporovaný formát)
	*/
	static async addImage ( /** @type {String} */ url, /** @type {Array} */ images )
	{
		try {

			/** @type {Response} */
			const response = await fetch( url, {
				credentials: 'same-origin',
				cache: 'force-cache',
				referrerPolicy: 'no-referrer',
			} );

			if ( !response.ok ) {
				return null;
			}

			/** @type {Blob|null} */
			const image = await EPubFromElementPrivate.toCoreImage( await response.blob() );

			if ( !image ) {
				return null;
			}

			/** @type {String} */
			const path = 'images/img' + ( images.length + 1 ) + '.' + EPubFromElementPrivate.CORE_IMAGE_TYPES[ image.type ];

			images.push( {
				path: path,
				type: image.type,
				data: new Uint8Array( await image.arrayBuffer() ),
			} );
			return path;
		} catch ( error ) {
			console.warn( '%c EPubFromElementPrivate %c addImage %c' + url,
				EPubFromElement.CONSOLE.CLASS_NAME,
				EPubFromElement.CONSOLE.METHOD_NAME,
				EPubFromElement.CONSOLE.WARNING,
				error
			);
			return null;
		}
	}

	/**
	* @description kopie exportovaného prvku upravená pro ePub: obrázky přesně ty, které prohlížeč zobrazil (currentSrc),
	* bez nepovolených prvků a atributů, odkazy jako celé adresy
	*/
	prepareExportClone ( /** @type {HTMLElement} */ element )
	{

		/** @type {HTMLElement} */
		const clone = element.cloneNode( true );

		/** @type {NodeList} */
		const liveImages = element.querySelectorAll( 'img' );

		clone.querySelectorAll( 'img' ).forEach( ( /** @type {HTMLImageElement} */ image, /** @type {Number} */ index ) =>
		{

			/** @type {HTMLImageElement|undefined} */
			const live = liveImages[ index ];

			image.setAttribute( 'src', live && live.currentSrc ? live.currentSrc : image.src );
			EPubFromElementPrivate.IMAGE_ATTRIBUTES_TO_REMOVE.forEach( ( /** @type {String} */ name ) =>
			{
				image.removeAttribute( name );
			} );
		} );
		clone.querySelectorAll( 'picture' ).forEach( ( /** @type {HTMLPictureElement} */ picture ) =>
		{
			picture.querySelectorAll( 'source' ).forEach( ( /** @type {HTMLSourceElement} */ source ) =>
			{
				source.remove();
			} );
			picture.replaceWith( ...picture.childNodes );
		} );
		clone.querySelectorAll( [ ...EPubFromElementPrivate.ALWAYS_REMOVED, ...this.settings.removeFromExportQuerySelectors ].join( ',' ) ).forEach( ( /** @type {HTMLElement} */ removed ) =>
		{
			removed.remove();
		} );

		/** @type {URL} */
		const page = new URL( window.location.href );

		page.hash = '';
		clone.querySelectorAll( 'a[href]' ).forEach( ( /** @type {HTMLAnchorElement} */ anchor ) =>
		{
			try {

				/** @type {URL} */
				const target = new URL( anchor.getAttribute( 'href' ), document.baseURI );

				/** @type {String} */
				const hash = target.hash;

				target.hash = '';
				anchor.setAttribute( 'href', hash && target.href === page.href ? hash : target.href + hash ); // odkaz na místo v článku zůstane v ePubu
			} catch ( error ) {
				anchor.removeAttribute( 'href' );
			}
		} );
		[ clone, ...clone.querySelectorAll( '*' ) ].forEach( ( /** @type {Element} */ node ) =>
		{
			[ ...node.attributes ].forEach( ( /** @type {Attr} */ attribute ) =>
			{
				if (
					/^on/i.test( attribute.name )
					|| !EPubFromElementPrivate.XML_ATTRIBUTE_NAME.test( attribute.name )
					|| ( attribute.name === 'style' && /url\s*\(/i.test( attribute.value ) ) // obrázek na pozadí by byl vzdálený zdroj
				) {
					node.removeAttribute( attribute.name );
				}
			} );
		} );
		return clone;
	}

	async fetchEPubStyleSheet ()
	{

		/** @type {Object} */
		const styleSheet = this.settings.ePubStyleSheet;

		if ( !styleSheet || !styleSheet.href ) {
			return '';
		}
		try {

			/** @type {Response} */
			const response = await fetch( new URL( styleSheet.href, document.baseURI ).href, {
				credentials: 'same-origin',
				cache: 'force-cache',
				integrity: styleSheet.integrity || '',
			} );

			return response.ok ? await response.text() : '';
		} catch ( error ) {
			return ''; // ePub bude i bez stylu
		}
	}

	/**
	* @description EPUB 3 (s toc.ncx pro čtečky EPUB 2) z prvků exportElementQuerySelectors – celý v prohlížeči
	*/
	async createEPubInBrowser ()
	{
		console.groupCollapsed( '%c EPubFromElementPrivate %c createEPubInBrowser',
			EPubFromElement.CONSOLE.CLASS_NAME,
			EPubFromElement.CONSOLE.METHOD_NAME
		);
		console.groupEnd();

		/** @type {Object} */
		const ePub = this.settings.ePub;

		/** @type {String} */
		const language = ePub.language || 'und';

		/** @type {String} */
		const title = ePub.title || document.title || window.location.href;

		/** @type {String} */
		const identifier = 'urn:uuid:' + EPubFromElementPrivate.createUuid();

		/** @type {Function} */
		const x = EPubFromElementPrivate.escapeXml;

		/** @type {XMLDocument} */
		const xhtml = document.implementation.createDocument( EPubFromElementPrivate.XHTML_NAMESPACE, 'html', null );

		/** @type {HTMLElement} */
		const body = xhtml.createElementNS( EPubFromElementPrivate.XHTML_NAMESPACE, 'body' );

		/** @type {Array} */
		const images = [];

		/** @type {Map} */
		const imagePaths = new Map(); // adresa → cesta v ePubu (stejný obrázek jen jednou)

		for ( const selector of this.settings.exportElementQuerySelectors ) {

			/** @type {HTMLElement|null} */
			const element = document.querySelector( selector );

			if ( !element ) {
				continue;
			}

			/** @type {HTMLElement} */
			const clone = this.prepareExportClone( element );

			for ( const image of [ ...clone.querySelectorAll( 'img' ) ] ) {

				/** @type {String} */
				const url = image.getAttribute( 'src' ) || '';

				if ( !imagePaths.has( url ) ) {
					imagePaths.set( url, url ? await EPubFromElementPrivate.addImage( url, images ) : null );
				}

				/** @type {String|null} */
				const path = imagePaths.get( url );

				if ( path ) {
					image.setAttribute( 'src', path );
				} else if ( image.alt ) {
					image.replaceWith( document.createTextNode( image.alt ) ); // obrázek nejde vložit – zůstane jeho popis
				} else {
					image.remove();
				}
			}
			[ ...clone.childNodes ].forEach( ( /** @type {Node} */ node ) =>
			{
				body.appendChild( xhtml.importNode( node, true ) );
			} );
		}
		if ( !body.hasChildNodes() ) {
			throw new Error( 'Nothing to export into ePub (exportElementQuerySelectors match no element)' );
		}

		/** @type {Element} */
		const html = xhtml.documentElement;

		/** @type {Element} */
		const head = xhtml.createElementNS( EPubFromElementPrivate.XHTML_NAMESPACE, 'head' );

		/** @type {Element} */
		const titleElement = xhtml.createElementNS( EPubFromElementPrivate.XHTML_NAMESPACE, 'title' );

		/** @type {Element} */
		const link = xhtml.createElementNS( EPubFromElementPrivate.XHTML_NAMESPACE, 'link' );

		html.setAttribute( 'lang', language );
		html.setAttributeNS( EPubFromElementPrivate.XML_NAMESPACE, 'xml:lang', language );
		titleElement.appendChild( xhtml.createTextNode( title ) );
		link.setAttribute( 'rel', 'stylesheet' );
		link.setAttribute( 'type', 'text/css' );
		link.setAttribute( 'href', EPubFromElementPrivate.STYLE_FILE_NAME );
		head.append( titleElement, link );
		html.append( head, body );

		/** @type {String} */
		const page = EPubFromElementPrivate.XML_PROLOG + '<!DOCTYPE html>\n' + new XMLSerializer().serializeToString( xhtml );

		/** @type {Boolean} */
		const hasSvg = body.getElementsByTagNameNS( EPubFromElementPrivate.SVG_NAMESPACE, 'svg' ).length > 0;

		/** @type {String} */
		const modified = new Date().toISOString().replace( /\.\d+Z$/, 'Z' );

		/** @type {String} */
		const container = EPubFromElementPrivate.XML_PROLOG
			+ '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
			+ '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n'
			+ '</container>\n';

		/** @type {String} */
		const opf = EPubFromElementPrivate.XML_PROLOG
			+ '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookID" xml:lang="' + x( language ) + '">\n'
			+ '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
			+ '<dc:identifier id="BookID">' + identifier + '</dc:identifier>\n'
			+ '<dc:title>' + x( title ) + '</dc:title>\n'
			+ '<dc:language>' + x( language ) + '</dc:language>\n'
			+ ( ePub.author ? '<dc:creator>' + x( ePub.author ) + '</dc:creator>\n' : '' )
			+ ( ePub.publisher ? '<dc:publisher>' + x( ePub.publisher ) + '</dc:publisher>\n' : '' )
			+ ( ePub.license ? '<dc:rights>' + x( ePub.license ) + '</dc:rights>\n' : '' )
			+ '<dc:source>' + x( window.location.href ) + '</dc:source>\n'
			+ '<meta property="dcterms:modified">' + modified + '</meta>\n'
			+ '</metadata>\n'
			+ '<manifest>\n'
			+ '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n'
			+ '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n'
			+ '<item id="style" href="' + EPubFromElementPrivate.STYLE_FILE_NAME + '" media-type="text/css"/>\n'
			+ '<item id="page1" href="' + EPubFromElementPrivate.PAGE_FILE_NAME + '" media-type="application/xhtml+xml"' + ( hasSvg ? ' properties="svg"' : '' ) + '/>\n'
			+ images.map( ( /** @type {Object} */ image, /** @type {Number} */ index ) =>
			{
				return '<item id="img' + ( index + 1 ) + '" href="' + image.path + '" media-type="' + image.type + '"/>\n';
			} ).join( '' )
			+ '</manifest>\n'
			+ '<spine toc="ncx"><itemref idref="page1"/></spine>\n'
			+ '</package>\n';

		/** @type {String} */
		const nav = EPubFromElementPrivate.XML_PROLOG + '<!DOCTYPE html>\n'
			+ '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="' + x( language ) + '" xml:lang="' + x( language ) + '">\n'
			+ '<head><title>' + x( title ) + '</title></head>\n'
			+ '<body><nav epub:type="toc" id="toc"><ol><li><a href="' + EPubFromElementPrivate.PAGE_FILE_NAME + '">' + x( title ) + '</a></li></ol></nav></body>\n'
			+ '</html>\n';

		/** @type {String} */
		const ncx = EPubFromElementPrivate.XML_PROLOG
			+ '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
			+ '<head><meta name="dtb:uid" content="' + identifier + '"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n'
			+ '<docTitle><text>' + x( title ) + '</text></docTitle>\n'
			+ '<navMap><navPoint id="navpoint-1" playOrder="1"><navLabel><text>' + x( title ) + '</text></navLabel><content src="' + EPubFromElementPrivate.PAGE_FILE_NAME + '"/></navPoint></navMap>\n'
			+ '</ncx>\n';

		/** @type {TextEncoder} */
		const encoder = new TextEncoder();

		return EPubFromElementPrivate.createZip( [
			{ name: 'mimetype', data: encoder.encode( EPubFromElementPrivate.EPUB_MIME_TYPE ), compress: false },
			{ name: 'META-INF/container.xml', data: encoder.encode( container ), compress: true },
			{ name: 'OEBPS/content.opf', data: encoder.encode( opf ), compress: true },
			{ name: 'OEBPS/nav.xhtml', data: encoder.encode( nav ), compress: true },
			{ name: 'OEBPS/toc.ncx', data: encoder.encode( ncx ), compress: true },
			{ name: 'OEBPS/' + EPubFromElementPrivate.STYLE_FILE_NAME, data: encoder.encode( await this.fetchEPubStyleSheet() ), compress: true },
			{ name: 'OEBPS/' + EPubFromElementPrivate.PAGE_FILE_NAME, data: encoder.encode( page ), compress: true },
			...images.map( ( /** @type {Object} */ image ) =>
			{
				return { name: 'OEBPS/' + image.path, data: image.data, compress: image.type === 'image/svg+xml' }; // JPEG, PNG a GIF už komprimované jsou
			} ),
		], EPubFromElementPrivate.EPUB_MIME_TYPE );
	}

	initOpenClosePopupFunctionality ()
	{
		console.debug( '%c EPubFromElementPrivate %c initOpenClosePopupFunctionality',
			EPubFromElement.CONSOLE.CLASS_NAME,
			EPubFromElement.CONSOLE.METHOD_NAME
		);

		if ( this.resultsElement.nodeName === EPubFromElement.DIALOG_NODE_NAME ) {
			document.querySelectorAll( '[' + EPubFromElementPrivate.ATTRIBUTES.TOGGLER_ATTRIBUTE.NAME + ']' ).forEach( (/** @type {HTMLElement} */ element ) =>
			{
				if ( element.getAttribute( EPubFromElementPrivate.ATTRIBUTES.TOGGLER_ATTRIBUTE.NAME ).substr( 0, EPubFromElementPrivate.ATTRIBUTES.TOGGLER_ATTRIBUTE.VALUE_PREFIX.length ) === EPubFromElementPrivate.ATTRIBUTES.TOGGLER_ATTRIBUTE.VALUE_PREFIX ) {
					const tapAction = element.getAttribute( EPubFromElementPrivate.ATTRIBUTES.TOGGLER_ATTRIBUTE.NAME ).substr( EPubFromElementPrivate.ATTRIBUTES.TOGGLER_ATTRIBUTE.VALUE_PREFIX.length ).split( EPubFromElementPrivate.DOT );

					/** @type {HTMLDialogElement} */
					let dialog = ( document.getElementById( tapAction[ 0 ] ) );

					if ( !dialog ) {

						/** @type {HTMLDialogElement} */
						dialog = ( element.parentElement );

					}

					if ( tapAction[ 1 ] && tapAction[ 1 ] === EPubFromElementPrivate.ATTRIBUTES.TOGGLER_ATTRIBUTE.CLOSE_SUFFIX ) {
						element.addEventListener( EPubFromElementPrivate.CLICK_EVENT_NAME, ( /** @type {MouseEvent} */ ) =>
						{
							dialog.close();
						}, {
							capture: false,
							once: false,
							passive: true,
						} );
					} else {
						element.addEventListener( EPubFromElementPrivate.CLICK_EVENT_NAME, ( /** @type {MouseEvent} */ ) =>
						{
							dialog.show();
						}, {
							capture: false,
							once: false,
							passive: true,
						} );
					}
				}
			} );
			document.querySelectorAll( EPubFromElementPrivate.DIALOG_NODE_NAME ).forEach( ( /** @type {HTMLDialogElement} */ dialog ) =>
			{
				dialog.addEventListener( EPubFromElementPrivate.KEYUP_EVENT_NAME, ( /** @type {KeyboardEvent} */ event ) =>
				{
					if ( event.keyCode === EPubFromElementPrivate.KEYCODE_ESC ) {
						dialog.close();
					}
				}, {
					capture: false,
					once: false,
					passive: true,
				} );
			} );
		}
	}

	elCreator = {
		br: ( /** @type {String} */ name ) =>
		{
			return new Promise( ( /** @type {Function} */ resolve ) =>
			{
				if ( this.settings.resultSnippetBehaviour.allowLineBreak ) {
					this.resultsElement.lastElementChild.appendChild( document.createElement( EPubFromElementPrivate.BR_NODE_NAME ) );
				}
				resolve( true );
			} );
		},
		nbsp: ( /** @type {String} */ name ) =>
		{
			return new Promise( ( /** @type {Function} */ resolve ) =>
			{
				this.resultsElement.lastElementChild.appendChild( document.createTextNode( EPubFromElementPrivate.NBSP ) );
				resolve( true );
			} );
		},
		title: ( /** @type {String} */ name ) =>
		{
			return new Promise( ( /** @type {Function} */ resolve ) =>
			{

				/** @type {String} */
				const tag = this.settings.resultSnippetElements[ name ];

				if ( tag ) {

					/** @type {HTMLElement} */
					const el = document.createElement( tag );

					el.appendChild( document.createTextNode( this.settings.texts.title ) );
					el.id = this.resultsElement.id + EPubFromElementPrivate.ATTRIBUTES.ARIA_LABELLEDBY.VALUE_SUFFIX;
					this.resultsElement.lastElementChild.appendChild( el );
				}
				resolve( true );
			} );
		},
		fileName: ( /** @type {String} */ name ) =>
		{
			return new Promise( ( /** @type {Function} */ resolve ) =>
			{

				/** @type {String} */
				const tag = this.settings.resultSnippetElements[ name ];

				if ( tag ) {

					/** @type {HTMLElement} */
					const el = document.createElement( tag );

					el.appendChild( document.createTextNode(
						this.settings.texts.fileName
						+ this.settings.texts.textValueDelimiter
						+ this.settings.ePub.fileName
					) );
					this.resultsElement.lastElementChild.appendChild( el );
				}
				resolve( true );
			} );
		},
		fileSize: ( /** @type {String} */ name, { size: size } ) =>
		{
			return new Promise( ( /** @type {Function} */ resolve ) =>
			{

				/** @type {String} */
				const tag = this.settings.resultSnippetElements[ name ];

				if ( tag ) {

					/** @type {HTMLElement} */
					const el = document.createElement( tag );

					this.initBytesToSize().then( () =>
					{
						el.appendChild( document.createTextNode(
							this.settings.texts.fileSize
							+ this.settings.texts.textValueDelimiter
							+ Number( size ).bytesToSize()
						) );
					} );

					this.resultsElement.lastElementChild.appendChild( el );
				}
				resolve( true );
			} );
		},
		download: ( /** @type {String} */ name, /** @type {Blob} */ ePubFile ) =>
		{
			return new Promise( ( /** @type {Function} */ resolve ) =>
			{

				/** @type {String} */
				const tag = this.settings.resultSnippetElements[ name ];

				if ( tag ) {

					/** @type {HTMLElement} */
					const el = document.createElement( tag );

					if ( el.nodeName === EPubFromElementPrivate.ANCHOR_NODE_NAME ) {
						el.href = window.URL.createObjectURL( ePubFile );
						el.rel = 'alternate';
						el.type = ePubFile.type;
						el.download = this.settings.ePub.fileName;
						el.title = this.settings.texts.downloadTitle;
						if ( this.settings.ePub.language ) {
							el.hreflang = this.settings.ePub.language;
						}
						const content = document.createElement( EPubFromElementPrivate.B_NODE_NAME );
						content.appendChild( document.createTextNode( this.settings.texts.download ) );
						el.appendChild( content );
						this.resultsElement.lastElementChild.appendChild( el );
					} else {
						// @feature request
					}
				}
				resolve( true );
			} );
		},
		share: ( /** @type {String} */ name, /** @type {Blob} */ ePubFile ) =>
		{
			return new Promise( ( /** @type {Function} */ resolve ) =>
			{

				/** @type {String} */
				const tag = this.settings.resultSnippetElements[ name ];

				if ( tag ) {

					/** @type {HTMLElement} */
					const el = document.createElement( tag );

					if ( el.nodeName === EPubFromElementPrivate.BUTTON_NODE_NAME ) {
						// sharing .epub file currently not working in Chrome :(

						// const filesArray = [ new File(
						// 	[ ePubFile ],
						// 	this.settings.ePub.fileName,
						// 	{ type: ePubFile.type }
						// ) ];
						// if ( navigator.canShare && navigator.canShare( { files: filesArray } ) ) {
						// 	el.addEventListener( 'click', function ( /** @type {MouseEvent} */ event )
						// 	{
						// 		navigator.share( {
						// 			text: '…',
						// 			files: filesArray,
						// 			title: '…',
						// 			url: '…'
						// 		} );
						// 	}, false );
						// }

						if ( navigator.canShare && this.settings.ePubTempPathPrefix ) {
							el.appendChild( document.createTextNode( this.settings.texts.share ) );
							el.title = this.settings.texts.shareTitle;
							el.addEventListener( EPubFromElementPrivate.CLICK_EVENT_NAME, ( /** @type {MouseEvent} */ event ) =>
							{

								/** @type {String} */
								const path = this.settings.ePubTempPathPrefix + this.settings.ePub.fileName;

								navigator.share( {
									title: this.settings.ePub.title,
									text: this.settings.texts.ePubAvailableOnUrl + path,
									url: path,
								} );
							}, {
								capture: false,
								once: false,
								passive: true,
							} );
							this.resultsElement.lastElementChild.appendChild( el );
						}
					} else {
						// @feature request
					}
				}
				resolve( true );
			} );
		},
		inlineCloseButton: ( /** @type {String} */ name ) =>
		{
			return new Promise( ( /** @type {Function} */ resolve ) =>
			{

				/** @type {String} */
				const tag = this.settings.resultSnippetElements[ name ];

				if ( tag ) {

					/** @type {HTMLElement} */
					const el = document.createElement( tag );

					el.appendChild( document.createTextNode( this.settings.texts.inlineCloseButton ) );
					el.title = this.settings.texts.closeButtonTitle;
					el.setAttribute( EPubFromElementPrivate.ATTRIBUTES.TOGGLER_ATTRIBUTE.NAME, EPubFromElementPrivate.ATTRIBUTES.TOGGLER_ATTRIBUTE.VALUE_PREFIX
						+ this.resultsElement.id
						+ EPubFromElementPrivate.DOT
						+ EPubFromElementPrivate.ATTRIBUTES.TOGGLER_ATTRIBUTE.CLOSE_SUFFIX
					);

					this.resultsElement.lastElementChild.appendChild( el );
				}
				resolve( true );
			} );
		},
		closeButton: ( /** @type {String} */ name ) =>
		{
			return new Promise( ( /** @type {Function} */ resolve ) =>
			{

				/** @type {String} */
				const tag = this.settings.resultSnippetElements[ name ];

				if ( tag ) {

					/** @type {HTMLElement} */
					const el = document.createElement( tag );

					el.appendChild( document.createTextNode( this.settings.texts.closeButton ) );
					el.title = this.settings.texts.closeButtonTitle;
					el.setAttribute( EPubFromElementPrivate.ATTRIBUTES.TOGGLER_ATTRIBUTE.NAME, EPubFromElementPrivate.ATTRIBUTES.TOGGLER_ATTRIBUTE.VALUE_PREFIX
						+ this.resultsElement.id
						+ EPubFromElementPrivate.DOT
						+ EPubFromElementPrivate.ATTRIBUTES.TOGGLER_ATTRIBUTE.CLOSE_SUFFIX
					);

					this.resultsElement.appendChild( el );
				}
				resolve( true );
			} );
		},
	}

};

/**
* @public
* @module EPubFromElement
* @classdesc Creates ePub export for e-readers from selected html element(s)
* @author ic < ic.czech@gmail.com >
* @see https://iiic.dev/epub-from-element
* @license https://creativecommons.org/licenses/by-sa/4.0/legalcode.cs CC BY-SA 4.0
* @since Q3 2021
* @version 0.3.1
*/
export class EPubFromElement extends EPubFromElementPrivate
{
	#private;

	constructor ( /** @type {HTMLScriptElement | null} */ settingsElement = null )
	{
		console.groupCollapsed( '%c EPubFromElement',
			EPubFromElement.CONSOLE.CLASS_NAME
		);
		console.debug( '%c' + 'constructor',
			EPubFromElement.CONSOLE.METHOD_NAME,
			[ { arguments } ]
		);

		const parent = super();
		this.#private = parent;

		/** @type {Object} */
		const settings = settingsElement ? JSON.parse( settingsElement.text ) : null;

		parent.initImportWithIntegrity( settings ).then( () =>
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

	async getEPub ()
	{
		if ( !this.settings.ePubServerSideEndpoints || !this.settings.ePubServerSideEndpoints.length ) {
			return this.createEPubInBrowser(); // [2026-11-22] bez serveru
		}

		let htmlForPrint = '';
		this.settings.exportElementQuerySelectors.forEach( function ( /** @type {String} */ selector )
		{
			const element = document.querySelector( selector );
			if ( element ) {
				htmlForPrint += element.innerHTML;
			}
		} );

		/** @type {Array} */
		const promises = await this.prepareFetches( JSON.stringify( htmlForPrint ) );

		return Promise.any( promises ).then( ( /** @type {Blob} */ firstFile ) =>
		{
			return firstFile;
		} );
	}

	checkRequirements ()
	{
		console.debug( '%c EPubFromElement %c checkRequirements',
			EPubFromElement.CONSOLE.CLASS_NAME,
			EPubFromElement.CONSOLE.METHOD_NAME
		);

		if ( !this.settings.resultsElementId ) {
			throw new Error( 'Result\'s element id is missing' );
		}
		// [2026-11-22] odstraněna povinnost ePubServerSideEndpoints – bez nich ePub vytvoří prohlížeč (createEPubInBrowser())
		if ( !this.settings.exportElementQuerySelectors || !this.settings.exportElementQuerySelectors.length ) {
			throw new Error( 'Element(s) for export into epub is missing' );
		}
	}

	async makeResultsElementSemantic ()
	{
		console.debug( '%c EPubFromElement %c makeResultsElementSemantic',
			EPubFromElement.CONSOLE.CLASS_NAME,
			EPubFromElement.CONSOLE.METHOD_NAME
		);

		return new Promise( ( /** @type {Function} */ resolve ) =>
		{
			if ( this.settings.resultSnippetBehaviour.makeResultElementSemantic ) {
				this.resultsElement.setAttribute(
					EPubFromElement.ATTRIBUTES.DIALOG_ROLE.NAME,
					EPubFromElement.ATTRIBUTES.DIALOG_ROLE.VALUE
				);
				this.resultsElement.setAttribute(
					EPubFromElement.ATTRIBUTES.ARIA_LABELLEDBY.NAME,
					this.resultsElement.id + EPubFromElement.ATTRIBUTES.ARIA_LABELLEDBY.VALUE_SUFFIX
				);
				this.resultsElement.setAttribute(
					EPubFromElement.ATTRIBUTES.ARIA_DESCRIBEDBY.NAME,
					this.resultsElement.id + EPubFromElement.ATTRIBUTES.ARIA_DESCRIBEDBY.VALUE_SUFFIX
				);
			}
			resolve( true );
		} );
	}

	async preparePopupWith ( /** @type {Blob} */ epub )
	{
		console.debug( '%c EPubFromElement %c preparePopupWith',
			EPubFromElement.CONSOLE.CLASS_NAME,
			EPubFromElement.CONSOLE.METHOD_NAME
		);

		return new Promise( ( /** @type {Function} */ resolve ) =>
		{
			this.settings.structure.forEach( ( /** @type {String} */ method ) =>
			{
				if ( method in this.elCreator ) {
					this.elCreator[ method ]( method, epub );
				}
			} );
			resolve( true );
		} );
	}

	initResultsElement ()
	{
		console.debug( '%c EPubFromElement %c initresultsElement',
			EPubFromElement.CONSOLE.CLASS_NAME,
			EPubFromElement.CONSOLE.METHOD_NAME
		);

		this.resultsElement = document.getElementById( this.settings.resultsElementId );
		const contentElement = document.createElement( EPubFromElement.DIV_NODE_NAME );
		if ( this.settings.resultSnippetBehaviour.makeResultElementSemantic ) {
			contentElement.setAttribute( EPubFromElement.ATTRIBUTES.CONTENT_ROLE.NAME, EPubFromElement.ATTRIBUTES.CONTENT_ROLE.VALUE );
			contentElement.setAttribute( EPubFromElement.ATTRIBUTES.CONTENT_TABINDEX.NAME, EPubFromElement.ATTRIBUTES.CONTENT_TABINDEX.VALUE );
		}
		this.resultsElement.appendChild( contentElement );
	}

	showResult ()
	{
		console.debug( '%c EPubFromElement %c showResult',
			EPubFromElement.CONSOLE.CLASS_NAME,
			EPubFromElement.CONSOLE.METHOD_NAME,
		);

		if ( this.resultsElement.nodeName === EPubFromElement.DIALOG_NODE_NAME ) {
			this.resultsElement.show();
			return;
		}

		this.resultsElement.hidden = false;
	}

	setEPubMetadata ()
	{
		console.debug( '%c EPubFromElement %c setEPubMetadata',
			EPubFromElement.CONSOLE.CLASS_NAME,
			EPubFromElement.CONSOLE.METHOD_NAME,
		);

		Object.keys( this.settings.ePub ).forEach( ( /** @type {String} */ key ) =>
		{
			if ( !this.settings.ePub[ key ] ) {
				let result = '';
				switch ( key ) {
					case 'fileName':
						result = window.location.href.replace( window.location.origin, '' );
						result = result.replaceAll( '/', '-' )
							.replaceAll( EPubFromElement.DOT, '-' )
							.replaceAll( '?', '-' )
							.replaceAll( '&', '-' )
							.replaceAll( '#', '-' );
						if ( result[ 0 ] === EPubFromElement.MINUS ) {
							result = window.location.hostname + result;
						}
						result += '.epub';
						break;
					case 'title':
						result = document.title;
						if ( !result ) {
							const title = document.querySelector( EPubFromElement.H1_NODE_NAME );
							if ( title ) {
								result = title.textContent;
							}
						}
						break;
					case 'author':
						const author = document.querySelector( 'article [itemprop="author"]' );
						if ( author ) {
							result = author.textContent;
						}
						break;
					case 'language':
						result = document.lastElementChild.lang;
						break;
					case 'license':
						const licence = document.querySelector( 'article .license' );
						if ( licence ) {
							result = licence.textContent;
						}
						break;
					case 'publisher':
						// [2026-11-25] v0.3.1: název webu z odkazu na úvodní stránku v hlavičce (text odkazu, nebo alt loga).
						// Dříve textContent prvku [role="banner"] – ten šablona už nemá (banner je <header>, viz
						// \CSS\CLASS_NAMES\HEADER::BANNER ve functions.php) a obsahoval i popis webu.
						const publisher = document.querySelector( 'header .banner a[rel~="home"]' );
						if ( publisher ) {
							result = publisher.textContent.trim() || publisher.querySelector( 'img' )?.alt || '';
						}
						break;
				}
				this.settings.ePub[ key ] = result;
			}
		} );
	}

	initPrint ()
	{
		console.debug( '%c EPubFromElement %c initPrint',
			EPubFromElement.CONSOLE.CLASS_NAME,
			EPubFromElement.CONSOLE.METHOD_NAME,
		);

		if ( this.settings.togglePrintElementId ) {

			/** @type {HTMLElement} */
			const printAction = document.getElementById( this.settings.togglePrintElementId );

			if ( printAction ) {
				printAction.addEventListener( EPubFromElement.CLICK_EVENT_NAME, function ()
				{
					window.print();
				}, {
					capture: false,
					once: false,
					passive: true,
				} );
				printAction.disabled = false;
				printAction.hidden = false;
			}
		}
	}

	initGetEPub ()
	{
		console.debug( '%c EPubFromElement %c initGetEPub',
			EPubFromElement.CONSOLE.CLASS_NAME,
			EPubFromElement.CONSOLE.METHOD_NAME,
		);

		if ( this.settings.toggleEPubElementId ) {

			/** @type {HTMLElement} */
			const getEPubAction = document.getElementById( this.settings.toggleEPubElementId );

			if ( getEPubAction ) {
				getEPubAction.addEventListener( EPubFromElement.CLICK_EVENT_NAME, () =>
				{
					getEPubAction.setAttribute(
						EPubFromElement.ATTRIBUTES.TOGGLER_ATTRIBUTE.NAME,
						EPubFromElement.ATTRIBUTES.TOGGLER_ATTRIBUTE.VALUE_PREFIX + this.resultsElement.id
					);
					getEPubAction.disabled = true; // [2026-11-22] během tvorby ePubu (stahování obrázků) nejde kliknout znovu
					this.getEPub().then( ( /** @type {Blob} */ epub ) =>
					{
						this.preparePopupWith( epub );
						this.showResult();
						this.initOpenClosePopupFunctionality();
					} ).catch( ( /** @type {Error} */ error ) =>
					{
						console.error( '%c EPubFromElement %c getEPub',
							EPubFromElement.CONSOLE.CLASS_NAME,
							EPubFromElement.CONSOLE.METHOD_NAME,
							error
						); // [2026-11-22] dříve chyba zanikla bez výpisu
					} ).finally( () =>
					{
						getEPubAction.disabled = false;
					} );
				}, {
					capture: false,
					once: true,
					passive: true,
				} );
				getEPubAction.disabled = false;
				getEPubAction.hidden = false;
			}
		}
	}

	run ()
	{
		console.groupCollapsed( '%c EPubFromElement %c run',
			EPubFromElement.CONSOLE.CLASS_NAME,
			EPubFromElement.CONSOLE.METHOD_NAME
		);

		this.checkRequirements();
		this.setEPubMetadata();
		this.initPrint();
		this.initResultsElement();
		this.initGetEPub();
		this.makeResultsElementSemantic();
		EPubFromElement.addCSSStyleSheets( this.settings.CSSStyleSheets );

		console.groupEnd();

		return this;
	}
};

new EPubFromElement( document.getElementById( 'epub-from-element-settings' ) );
