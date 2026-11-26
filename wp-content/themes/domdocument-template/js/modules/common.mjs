const scrollButtonElement = document.getElementById( 'scroll-to-top' );
if ( scrollButtonElement ) {
	window.addEventListener( 'scroll', function ()
	{
		scrollButtonElement.hidden = ( this.scrollY < 400 ) ? true : false;
	} );
}

// [2026-11-26] Tlačítko Tisk (components/print-and-epub.php, id \CSS\ELEMENT_IDS::PRINT_BUTTON). Tlačítka tisku a ePubu se
// zapínají každé zvlášť a modul epub-from-element.mjs se načítá jen s tlačítkem ePub, proto tisk obsluhuje tento modul
// (načítá se na každé stránce). V nastavení ePub modulu je togglePrintElementId prázdné, jinak by se tisk otevřel dvakrát.
const printButtonElement = document.getElementById( 'print' );
if ( printButtonElement ) {
	printButtonElement.addEventListener( 'click', function ()
	{
		window.print();
	}, {
		capture: false,
		once: false,
		passive: true,
	} );
	printButtonElement.disabled = false;
}

const headerInnerElement = document.querySelector( 'body>header .★' );
const mq = window.matchMedia( '(min-width: 992px)' );
if ( headerInnerElement && mq.matches
	&& ( !navigator.userAgentData || ( navigator.userAgentData && !navigator.userAgentData.mobile ) )
) {
	const RESIZE_SQUARE_SIZE = 16;
	const BOTTOM_BORDER_SIZE = RESIZE_SQUARE_SIZE;
	const RESIZE_POSSIBLE_CLASS_NAME = 'resize';
	const RESIZING_CLASS_NAME = 'resizing';
	const MIN_LAYOUT_HEIGHT = 800; // int in px
	const COOKIE_SUFFIX = '; path=/; SameSite=Strict'; // 'path=/; SameSite=Strict; secure';

	const menuElement = document.getElementById( 'menu' );
	if ( menuElement ) {
		menuElement.addEventListener( 'mouseenter', function ()
		{
			menuElement.parentNode.style.overflow = 'visible';
		} );
		menuElement.addEventListener( 'mouseleave', function ()
		{
			menuElement.parentNode.style.overflow = 'hidden';
		} );
	}

	const widthCssRules = [];
	[ ...document.styleSheets ].forEach( function ( /** @type {CSSStyleSheet} */ cssss )
	{
		let rules = [];
		try {
			rules = cssss.cssRules;
		} catch { } // after accessing crossdomain css this trigger a error and go into catch section
		[ ...rules ].filter(
			( { selectorText } ) => selectorText === '.★'
		).forEach( ( /** @type {CSSStyleRule} */ rule ) =>
		{
			widthCssRules.push( rule );
		} );
	} );

	const removeResizeVisualization = () =>
	{
		document.body.classList.remove( RESIZING_CLASS_NAME );
	}

	headerInnerElement.parentElement.classList.add( RESIZE_POSSIBLE_CLASS_NAME );
	widthCssRules.forEach( function ( { style: cssStyleDeclaration } )
	{
		cssStyleDeclaration.setProperty( 'min-width', MIN_LAYOUT_HEIGHT + 'px' );
	} );

	headerInnerElement.addEventListener( 'mousedown', function ( /** @type {MouseEvent} */ event )
	{
		if (
			event.offsetX > event.target.offsetWidth - RESIZE_SQUARE_SIZE
			&& (
				event.offsetY < event.target.offsetHeight - BOTTOM_BORDER_SIZE
				&& event.offsetY + BOTTOM_BORDER_SIZE + RESIZE_SQUARE_SIZE > event.target.offsetHeight
			)
		) {
			document.body.classList.add( RESIZING_CLASS_NAME );
		}
	} ); // @todo : ověřit, jestli je event správně zavěšen, tedy jestli se neopakuje a nevykonává zbytečně
	document.body.addEventListener( 'mouseup', removeResizeVisualization ); // @todo : ověřit, jestli je event správně zavěšen, tedy jestli se neopakuje a nevykonává zbytečně
	window.addEventListener( 'blur', removeResizeVisualization ); // @todo : ověřit, jestli je event správně zavěšen, tedy jestli se neopakuje a nevykonává zbytečně
	const observer = new MutationObserver( function ( /** @type {Array} */ mutations )
	{
		mutations.filter(
			( { /** @type {String} */ attributeName } ) => attributeName === 'style'
		).forEach( function ( { target: htmlElement } )
		{

			/** @type {String} */
			const width = htmlElement.style.width;

			if ( parseInt( width ) > MIN_LAYOUT_HEIGHT ) {
				widthCssRules.forEach( function ( { style: cssStyleDeclaration } )
				{
					cssStyleDeclaration.setProperty( 'max-width', width );

					const cookieDate = new Date;
					cookieDate.setFullYear( cookieDate.getFullYear() + 2 );
					document.cookie = 'width=' + width + '; expires=' + cookieDate.toUTCString() + ';domain=' + window.location.hostname + COOKIE_SUFFIX;
				} );
			}
		} );
	} ); // @todo : ověřit, jestli je event správně zavěšen, tedy jestli se neopakuje a nevykonává zbytečně
	observer.observe( headerInnerElement, {
		attributes: true
	} );
}

const replaceOnDocument = ( /** @type {Object} */ instructions, /** @type {HTMLElement} */ target = document.body ) =>
{
	target.querySelectorAll( "*:not(script):not(noscript):not(style)" ).forEach(
		function ( { childNodes: [ ...nodes ] } )
		{
			nodes.filter(
				( { /** @type {Number} */ nodeType } ) => nodeType === Node.TEXT_NODE
			).forEach( ( /** @type {Text} */ textNode ) =>
			{
				Object.keys( instructions ).forEach( function ( /** @type {String} */ key )
				{
					textNode.textContent = textNode.textContent.replace( key, instructions[ key ] );
				} );
			} );
		}
	);
};

if ( navigator.userAgent.toLowerCase().indexOf( "android" ) > -1
	|| ( navigator.userAgentData && navigator.userAgentData.mobile && navigator.userAgentData.isChrome ) ) {
	replaceOnDocument( {
		'⮝': '▲',
	} );
}

const location = window.document.location;
const article = document.querySelector( 'main :not(.tiles) article' );
if ( article && !location.search && location.pathname === '/' ) {
	const COLLAPSED_CLASS_NAME = 'collapsed';
	const CLICK_EVENT_TYPE = 'click';
	const H1_NODE_NAME = 'H1';
	const READ_MORE_ID = 'read-more';

	/**
	 * [2026-11-25] Vejde se článek do zkráceného náhledu (CSS `article.collapsed` má `max-height`) celý? Pak „číst více“
	 * nemá co odkrýt – tlačítko by jen změnilo adresu (krátký nejnovější článek, např. „demo: http auth v obrázku“).
	 */
	const isCutWhenCollapsed = function ()
	{
		article.classList.add( COLLAPSED_CLASS_NAME );
		const isCut = article.scrollHeight > article.clientHeight;
		article.classList.remove( COLLAPSED_CLASS_NAME );
		return isCut;
	};

	/**
	 * [2026-11-25] Statický web má v HTML relativní adresy platné pro úvodní stránku (`o-clanku/`, `wp-content/…`).
	 * history.replaceState() změní adresu dokumentu, a tím i základ, ke kterému je prohlížeč dopočítává: odkazy, líně
	 * načítané obrázky (`loading="lazy"`, `srcset`) ve zbytku článku a další soubory by pak mířily do složky článku
	 * (`/clanek/o-clanku/`, `/clanek/wp-content/…` → 404). Před změnou adresy je proto přepíše na adresy od kořene.
	 * Na WordPressu jsou adresy celé, tam se nic nezmění. Už načtené soubory (skripty, styly, rámce) se nepřepisují,
	 * nová hodnota atributu by je načetla znovu.
	 */
	const pinRelativeUrls = function ()
	{
		const URL_ATTRIBUTE_NAMES = [ 'href', 'src', 'srcset', 'action', 'formaction', 'poster', 'cite' ];
		const SRCSET_ATTRIBUTE_NAME = 'srcset';
		const SKIPPED_ELEMENTS_SELECTOR = 'script, iframe, frame, embed, object, link[rel~="stylesheet" i]';
		const NOT_RELATIVE_URL = /^(?:[a-z][a-z\d+.-]*:|\/|#|$)/i; // celá adresa (https:, mailto:, data:…), od kořene (/, //), jen kotva, prázdná
		const SRCSET_CANDIDATE_URL = /(?<=^|,)(\s*)([^\s,]\S*?)(,*)(?=\s|$)/g; // adresa obrázku na začátku každé položky srcset
		const baseUrl = document.baseURI;

		const pinUrl = function ( /** @type {String} */ url )
		{
			if ( NOT_RELATIVE_URL.test( url ) ) {
				return url;
			}
			const absoluteUrl = new URL( url, baseUrl );
			return absoluteUrl.origin === location.origin ? absoluteUrl.pathname + absoluteUrl.search + absoluteUrl.hash : absoluteUrl.href;
		};

		const elementsSelector = URL_ATTRIBUTE_NAMES.map( ( /** @type {String} */ name ) => '[' + name + ']' ).join( ',' );
		const roots = [ document, ...[ ...document.querySelectorAll( 'template' ) ].map( ( { content } ) => content ) ];
		roots.forEach( function ( /** @type {Document|DocumentFragment} */ root )
		{
			root.querySelectorAll( elementsSelector ).forEach( function ( /** @type {Element} */ element )
			{
				if ( element.matches( SKIPPED_ELEMENTS_SELECTOR ) ) {
					return;
				}
				URL_ATTRIBUTE_NAMES.forEach( function ( /** @type {String} */ name )
				{
					const value = element.getAttribute( name );
					if ( value === null ) {
						return;
					}
					const pinnedValue = name === SRCSET_ATTRIBUTE_NAME
						? value.replace( SRCSET_CANDIDATE_URL, ( match, space, url, commas ) => space + pinUrl( url ) + commas )
						: pinUrl( value.trim() );
					if ( pinnedValue !== value.trim() && pinnedValue !== value ) {
						element.setAttribute( name, pinnedValue );
					}
				} );
			} );
		} );
	};

	const articleCanonical = article.querySelector( '[itemprop~="url"]' );
	if ( articleCanonical && isCutWhenCollapsed() ) { // [2026-11-25] jen když náhled článek opravdu zkrátí
		const collapseElements = [];
		const eventListenerOptions = {
			capture: false,
			once: true,
			passive: false,
		};

		const removeCollapsed = function ( /** @type {PointerEvent} */ event )
		{
			event.preventDefault();
			event.stopPropagation();

			pinRelativeUrls(); // [2026-11-25] před změnou adresy dokumentu, viz výše
			window.history.replaceState( {}, document.title, articleCanonical.href );

			article.classList.remove( COLLAPSED_CLASS_NAME );

			collapseElements.forEach( function ( /** @type {HTMLElement} */ element )
			{
				element.removeEventListener( CLICK_EVENT_TYPE, removeCollapsed, eventListenerOptions );
				if ( element.nodeName === H1_NODE_NAME ) {
					const titleAnchor = element.lastElementChild;
					element.appendChild( titleAnchor.lastChild );
					titleAnchor.remove(); // [2026-11-25] dříve v nadpisu zůstal prázdný odkaz <a href="…"></a>
				} else if ( element.id === READ_MORE_ID ) {
					element.parentElement.removeChild( element );
				}
			} );
		};

		article.classList.add( COLLAPSED_CLASS_NAME );

		const title = document.querySelector( 'h1' );
		if ( title ) {
			const anchor = document.createElement( 'a' );
			anchor.href = articleCanonical.href;
			anchor.appendChild( title.lastChild );
			title.appendChild( anchor );
			title.addEventListener( CLICK_EVENT_TYPE, removeCollapsed, eventListenerOptions );
			collapseElements.push( title );
		}

		const allAnchors = article.querySelectorAll( 'a' );
		allAnchors.forEach( function ( /** @type {HTMLAnchorElement} */ anchor )
		{
			if ( anchor.href === articleCanonical.href ) {
				anchor.addEventListener( CLICK_EVENT_TYPE, removeCollapsed, eventListenerOptions );
				collapseElements.push( anchor );
			}
		} );

		const anchor = document.createElement( 'a' );
		anchor.href = articleCanonical.href;
		const bold = document.createElement( 'b' );
		bold.appendChild( document.createTextNode( 'číst více' ) );
		anchor.appendChild( bold );
		anchor.id = READ_MORE_ID;
		anchor.addEventListener( CLICK_EVENT_TYPE, removeCollapsed, eventListenerOptions );
		collapseElements.push( anchor );
		article.appendChild( anchor );

	}
}

/** @type {HTMLButtonElement} */
let shareButton = document.getElementById( 'share' );

if ( shareButton && navigator.canShare ) {
	if ( shareButton.constructor.name !== 'HTMLButtonElement' ) {
		shareButton = shareButton.lastElementChild;
	}

	shareButton.disabled = false;
	shareButton.addEventListener( 'click', function ( /** @type {MouseEvent} */ event )
	{
		const getTitle = function ()
		{
			if ( document.title ) {
				return document.title;
			}
			const h1 = document.querySelector( 'h1' );
			if ( h1 && h1.innerText ) {
				return h1.innerText;
			}
			return null;
		};

		const getDescription = function ()
		{
			const CONTENT_ATTR_NAME = 'content';
			const metaDescription = document.querySelector( 'meta[name="description"]' );
			if ( metaDescription && metaDescription.getAttribute( CONTENT_ATTR_NAME ) ) {
				return metaDescription.getAttribute( CONTENT_ATTR_NAME );
			}
			const articleDescription = document.querySelector( '[itemprop="description"]' );
			if ( articleDescription && articleDescription.textContent ) {
				return articleDescription.textContent;
			}
			return document.title;
		};

		const getURL = function ()
		{
			const canonical = document.querySelector( 'link[rel="canonical"]' );
			if ( canonical && canonical.href ) {
				return canonical.href;
			}
			return window.location.href;
		};

		navigator.share( {
			title: getTitle(),
			text: getDescription(),
			url: getURL(),
		} ).then( function ()
		{
			if ( 'Notific' in window ) {
				new Notific( 'Díky za sdílení' );
			}
		} );
	}, {
		capture: false,
		once: false,
		passive: true,
	} );
}
