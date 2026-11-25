/** @type {HTMLDivElement} */
const rootElement = document.getElementById( 'varsAdminDdtDashboardWidget' );

if ( rootElement ) {

	/** @type {Function} */
	const prepareLangFetches = async function ()
	{

		/** @type {Array} */
		const promises = [];

		// [2026-11-22] Odstraněna poslední adresa '/?fetch-proxy' (PHP endpoint šablony, který tutéž adresu stahoval
		// na serveru po sleep(2) a obsadil tím jediný proces php-cgi). Adresy níže posílají CORS hlavičku, stačí prohlížeč.
		[
			'https://iiic.dev/api/ddt-dashboard-news-and-security/',
			'https://iiic.dev/api/ddt-dashboard-news-and-security/index.php',
			'https://iiic.github.io/api/ddt-dashboard-news-and-security/',
			'https://into.parts/api/ddt-dashboard-news-and-security/',
		].forEach( function ( /** @type {String} */ endpoint )
		{
			promises.push(
				fetch( endpoint, {
					method: 'GET',
					credentials: 'omit',
					cache: 'no-cache',
					referrerPolicy: 'no-referrer',
					redirect: 'manual',
					mode: 'cors'
				} ).then( function ( /** @type {Response} */ response )
				{
					if ( response.ok ) {
						return response.json();
					}
					// [2026-11-22] Dříve se při chybě (404, přesměrování) vrátilo undefined, tedy splněný slib. Promise.any()
					// bere první SPLNĚNÝ slib, takže rychlejší 404 vyhrála nad funkční adresou a widget hlásil, že se nikam
					// nepřipojil. Teď chyba slib zamítne a Promise.any() počká na první úspěšnou adresu.
					throw new Error( endpoint + ': HTTP ' + response.status );
				} )
			);
		} );
		return promises;
	};

	/** @type {Function} */
	const fetchNews = async function ()
	{

		/** @type {Array} */
		const promises = await prepareLangFetches();

		return Promise.any( promises ).then( function ( /** @type {Object} */ json )
		{
			return json;
		} ).catch( function ()
		{
			return null; // [2026-11-22] žádná adresa neodpověděla – displayNewsDomBy() vypíše hlášku o nedostupnosti
		} );
	};

	/** @type {Function} */
	const fetchNiceUrlStatus = async function ()
	{

		/** @type {URL} */
		const fetchEndpoint = new URL( location );

		fetchEndpoint.pathname = fetchEndpoint.pathname.replace( '/wp-admin', '' );
		fetchEndpoint.searchParams.set( 'nice-urls-status', '' );
		return fetch( fetchEndpoint.href, {
			method: 'GET',
			credentials: 'omit',
			cache: 'no-cache',
			referrerPolicy: 'no-referrer',
			redirect: 'manual',
			mode: 'cors'
		} ).then( function ( /** @type {Response} */ response )
		{
			if ( response.ok ) {
				return response.text();
			}
		} )
	};

	/** @type {Function} */
	const jsonToNode = function ( /** @type {Object} */ jsonPart )
	{

		/** @type {Text|HTMLElement} */
		let node;

		switch ( jsonPart.nodeType ) {
			case Node.ELEMENT_NODE:
				node = document.createElement( jsonPart.tagName );
				if ( jsonPart.attributes ) {
					Object.keys( jsonPart.attributes ).forEach( function ( /** @type {String} */ key )
					{
						if ( Number.isInteger( Number( key ) ) ) {

							/** @type {Object} */
							const current = jsonPart.attributes[ key ];

							node.setAttribute( current.name, current.value );
						}
					} );
				}
				if ( jsonPart.childNodes ) {
					Object.keys( jsonPart.childNodes ).forEach( function ( /** @type {String} */ key )
					{
						if ( Number.isInteger( Number( key ) ) ) {

							/** @type {Text|HTMLElement} */
							const child = jsonToNode( jsonPart.childNodes[ key ] );

							node.appendChild( child );
						}
					} );
				}
				break;
			case Node.TEXT_NODE:
				node = document.createTextNode( jsonPart.textContent );
				break;
		}
		return node;
	};

	/** @type {Function} */
	const displayNewsDomBy = async function ( /** @type {Object} */ json )
	{

		/** @type {HTMLElement} */
		const root = rootElement.querySelector( '.inside' );

		root.querySelector( 'small' ).hidden = true;

		if ( json && json.status === 'ok' ) {
			if ( json.html ) {
				root.appendChild( jsonToNode( json.html ) );
			}
		} else {
			root.appendChild(
				document.createTextNode( 'nepodařilo se navázat spojení k žádnému z informačních bodů, to je zlé :(' )
			);
		}
	};

	/** @type {Function} */
	const displayNiceUrlDomBy = async function ( /** @type {String} */ text )
	{

		/** @type {HTMLElement} */
		const root = rootElement.querySelector( '.inside' );

		if ( text && root ) {

			const texts = {
				'1': 'Statické soubory jsou překopírovány do root složky webu a URL adresy tak budou hezčí',
				'0': 'Nevíme jestli je možné udělat hezčí URL adresy ke statickým souborům',
				'-1': 'Statické soubory nejsou překopírovány do root složky, URL adresy k souborům budou delší než je nezbytné.',
				'-2': 'Statické soubory se nepodařilo překopírovat do root složky webu pro hezčí URL adresy. Problém bude nejspíše způsobem nedostatečným oprávněním pro vytvoření adresáře.',
			};

			/** @type {HTMLElement} */
			const niceUrlsElement = document.createElement( 'P' );

			niceUrlsElement.appendChild( document.createTextNode( texts[ text ] ) );
			root.appendChild( niceUrlsElement );
		}
	};

	new MutationObserver( function ( /** @type {Array} */ mutationRecords )
	{
		mutationRecords.forEach( function ( { target: element } )
		{
			if ( element && element.style.display === 'block' ) {
				fetchNews().then( function ( /** @type {Object} */ json )
				{
					displayNewsDomBy( json );
				} );
				fetchNiceUrlStatus().then( function ( /** @type {String} */ text )
				{
					displayNiceUrlDomBy( text );
				} );
			}
		} );
	} ).observe( rootElement, {
		attributes: true,
		attributeFilter: [ 'style' ],
		childList: false,
		characterData: false,
	} );

	if ( !rootElement.classList.contains( 'hide-if-js' ) ) {
		fetchNews().then( function ( /** @type {Object} */ json )
		{
			displayNewsDomBy( json );
		} );
		fetchNiceUrlStatus().then( function ( /** @type {String} */ text )
		{
			displayNiceUrlDomBy( text );
		} );

		/** @type {HTMLElement} */
		const root = rootElement.querySelector( '.inside' );

		/** @type {HTMLElement} */
		const jsInfoElement = document.createElement( 'P' );

		jsInfoElement.appendChild( document.createTextNode( 'Javascript pro admin inicializován úspěšně' ) );
		root.appendChild( jsInfoElement );
		root.appendChild( document.createElement( 'BR' ) );
	}
}
