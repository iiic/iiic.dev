const scrollButtonElement = document.getElementById( 'scroll-to-top' );
if ( scrollButtonElement ) {
	window.addEventListener( 'scroll', function ()
	{
		scrollButtonElement.hidden = ( this.scrollY < 400 ) ? true : false;
	} );
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

	const articleCanonical = article.querySelector( '[itemprop~="url"]' );
	if ( articleCanonical ) {
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

			window.history.replaceState( {}, document.title, articleCanonical.href );

			article.classList.remove( COLLAPSED_CLASS_NAME );

			collapseElements.forEach( function ( /** @type {HTMLElement} */ element )
			{
				element.removeEventListener( CLICK_EVENT_TYPE, removeCollapsed, eventListenerOptions );
				if ( element.nodeName === H1_NODE_NAME ) {
					element.appendChild( element.lastElementChild.lastChild );
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
