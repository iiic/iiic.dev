/**
* [2026-11-24] Komentářové služby, které se nastavují globální proměnnou: Disqus (disqus_config) a Remark42
* (remark_config). Prvek služby vypisuje components/comment-service.php s atributem data-comment-service
* (\VARS\COMMENT_SERVICE::SERVICE_ATTRIBUTE, hodnota = ID služby) a nastavením v dalších data-* atributech – PHP tak
* nemusí skládat JavaScript a hodnoty (adresa, název článku) escapuje setAttribute().
*
* Skript služby se načte, až když se komentáře přiblíží k viditelné části stránky (IntersectionObserver): čtenář, který
* ke komentářům nedojde, nestahuje desítky až stovky kB cizího JavaScriptu (u Disqusu i s reklamou a měřením).
*
* Giscus, Utterances, Cusdis a Isso se nastavují atributy svého <script> a tento modul nepotřebují.
* Funguje i na statickém webu (modul je ve složce js/, kterou export kopíruje celou).
*/

/** @type {String} */
const SERVICE_ATTRIBUTE = 'data-comment-service'; // \VARS\COMMENT_SERVICE::SERVICE_ATTRIBUTE

/** @type {String} */
const DISQUS = 'disqus'; // \POSSIBILITIES\COMMENT_SERVICES::DISQUS

/** @type {String} */
const REMARK42 = 'remark42'; // \POSSIBILITIES\COMMENT_SERVICES::REMARK42

/** @type {String} */
const DARK_SCHEME_MEDIA = '(prefers-color-scheme: dark)'; // \CSS\COLOR_SCHEME_MEDIA::dark

/** @type {String} */
const PRELOAD_MARGIN = '800px 0px'; // jak daleko před viditelnou částí stránky se služba začne načítat

/** @type {Function} */
const appendScript = function ( /** @type {String} */ src, /** @type {Boolean} */ isModule = false )
{

	/** @type {HTMLScriptElement} */
	const script = document.createElement( 'script' );

	if ( isModule ) {
		script.type = 'module';
	}
	script.src = src;
	script.async = true;
	( document.head || document.body ).append( script );
	return script;
};

/** @type {Object<String, Function>} */
const starters = {

	[ DISQUS ]: function ( /** @type {HTMLElement} */ element ) // https://help.disqus.com/en/articles/1717112-universal-embed-code
	{

		/** @type {DOMStringMap} */
		const data = element.dataset;

		window.disqus_config = function ()
		{
			this.page.url = data.url;
			this.page.identifier = data.identifier;
			this.page.title = data.title;
		};
		appendScript( `https://${ data.shortname }.disqus.com/embed.js` ).setAttribute( 'data-timestamp', String( Date.now() ) );
	},

	[ REMARK42 ]: function ( /** @type {HTMLElement} */ element ) // https://remark42.com/docs/configuration/frontend/
	{

		/** @type {DOMStringMap} */
		const data = element.dataset;

		/** @type {Object} */
		const config = {
			host: data.host,
			site_id: data.siteId,
			url: data.url,
			page_title: data.pageTitle,
			locale: data.locale || 'en',
			theme: data.theme || ( window.matchMedia( DARK_SCHEME_MEDIA ).matches ? 'dark' : 'light' ), // '' = podle systému návštěvníka
			components: [ 'embed' ],
		};

		if ( data.maxShownComments ) {
			config.max_shown_comments = Number( data.maxShownComments );
		}
		window.remark_config = config;
		appendScript( `${ data.host }/web/embed.mjs`, true );
	},
};

for ( const element of document.querySelectorAll( `[${ SERVICE_ATTRIBUTE }]` ) ) {

	/** @type {Function|undefined} */
	const start = starters[ element.getAttribute( SERVICE_ATTRIBUTE ) ];

	if ( !start ) {
		continue;
	}
	if ( !( 'IntersectionObserver' in window ) ) {
		start( element );
		continue;
	}

	/** @type {IntersectionObserver} */
	const observer = new IntersectionObserver( function ( /** @type {Array<IntersectionObserverEntry>} */ entries )
	{
		if ( entries.some( ( entry ) => entry.isIntersecting ) ) {
			observer.disconnect();
			start( element );
		}
	}, { rootMargin: PRELOAD_MARGIN } );

	observer.observe( element );
}
