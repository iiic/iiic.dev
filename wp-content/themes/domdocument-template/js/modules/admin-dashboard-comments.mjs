/**
* [2026-11-26] Widget „Komentáře – <služba>“ na nástěnce šablony domdocument-template (dashboard-widgets/komentare.php,
* \FUNCTIONS\DASHBOARD ve functions.php, README.md šablony – sekce „Komentáře z externí služby na nástěnce“).
*
* Nejnovější komentáře nebo vlákna stahuje prohlížeč přímo ze služby (PHP nic nestahuje – pravidlo 17), bez cookies a bez
* hlavičky Referer:
* - Giscus: GitHub REST /repos/{repo}/discussions – vlákna (diskuze) zvolené kategorie seřazená podle poslední aktivity.
*   GitHub je vrací od nejstarší a řazení nepodporuje: s víc stránkami po 100 se čtou poslední stránky (podle hlavičky Link).
* - Utterances: GitHub REST /repos/{repo}/issues/comments (nejnovější komentáře) a /issues (názvy vláken).
* - Remark42: {server}/api/v1/last/{počet}?site={id}.
* - Isso: {server}/latest?limit={počet} (jen se zapnutým latest-enabled a s adresou administrace v host – jinak CORS).
* Vlákno se páruje s článkem podle mapy z PHP (klíč vlákna → název a odkaz na úpravu). Výsledek si modul pamatuje
* v sessionStorage (GitHub bez přihlášení dovolí 60 dotazů za hodinu), „naposledy viděno“ v localStorage – položky
* novější než minulá návštěva nástěnky mají značku „nové“. Vše přes DOM (textContent), HTML ze služby se nikdy nevkládá.
*
* @version 0.1
* @since Q4 2026
*/

/** @type {String} \VARS\DASHBOARD_WIDGET::COMMENTS_SETTINGS_ID */
const SETTINGS_ELEMENT_ID = 'ddt-nastenka-komentare-nastaveni';

/** @type {Number} znaků z textu komentáře */
const EXCERPT_LENGTH = 160;

/** @type {Object} */
let settings = {};

/** @returns {String} text s doplněnými hodnotami (%s, %1$s… jako sprintf() v PHP) */
const text = function ( /** @type {String|Object} */ key, /** @type {...(String|Number)} */ ...values )
{
	let index = 0;
	return String( settings.texts?.[ key ] ?? key ).replace( /%(?:(\d+)\$)?s/g, ( match, position ) => String( values[ position ? Number( position ) - 1 : index++ ] ?? '' ) );
};

/** @returns {String} tvar podle počtu (one / few / other) */
const plural = function ( /** @type {String} */ key, /** @type {Number} */ count )
{
	const forms = settings.texts?.[ key ] ?? {};
	const form = new Intl.PluralRules( settings.locale ).select( count );
	return String( forms[ form ] ?? forms.other ?? '' ).replace( '%s', String( count ) );
};

/** @returns {HTMLElement} */
const element = function ( /** @type {String} */ tagName, /** @type {Array.<String>} */ classNames = [], /** @type {Array.<String|Node>} */ content = [] )
{
	const node = document.createElement( tagName );
	if ( classNames.length ) {
		node.className = classNames.join( ' ' );
	}
	node.append( ...content );
	return node;
};

/** @returns {HTMLAnchorElement} odkaz na jiný web (nová karta, ikona a text pro čtečky jako v administraci) */
const externalLink = function ( /** @type {String} */ url, /** @type {String} */ label )
{
	const link = element( 'a', [], [ label, element( 'span', [ settings.classes.screenReader ], [ ' ' + text( 'newTab' ) ] ) ] );
	const icon = element( 'span', settings.classes.externalIcon );
	icon.setAttribute( 'aria-hidden', 'true' );
	link.append( icon );
	link.href = url;
	link.target = '_blank';
	link.rel = 'noopener noreferrer';
	return link;
};

/** @returns {Number} čas v ms; Remark42 posílá zlomky sekundy na 9 míst, Isso sekundy jako číslo */
const timeOf = function ( /** @type {String|Number} */ value )
{
	if ( typeof value === 'number' ) {
		return value * 1000;
	}
	const time = Date.parse( String( value ?? '' ).replace( /(\.\d{3})\d+/, '$1' ) );
	return Number.isNaN( time ) ? 0 : time;
};

/** @returns {String} „před 3 hodinami“ */
const relativeTime = function ( /** @type {Number} */ time )
{
	const seconds = Math.round( ( time - Date.now() ) / 1000 );
	const units = [ [ 'year', 31536000 ], [ 'month', 2592000 ], [ 'week', 604800 ], [ 'day', 86400 ], [ 'hour', 3600 ], [ 'minute', 60 ] ];
	const format = new Intl.RelativeTimeFormat( settings.locale, { numeric: 'auto' } );
	for ( const [ unit, size ] of units ) {
		if ( Math.abs( seconds ) >= size ) {
			return format.format( Math.round( seconds / size ), unit );
		}
	}
	return format.format( 0, 'minute' );
};

/** @returns {String} prostý text z HTML nebo Markdownu, zkrácený (HTML se parsuje v neaktivním dokumentu, nic se nespustí ani nestáhne) */
const excerptOf = function ( /** @type {String} */ value, /** @type {Boolean} */ isHtml )
{
	let plain = String( value ?? '' );
	if ( isHtml ) {
		plain = new DOMParser().parseFromString( plain, 'text/html' ).body.textContent ?? '';
	} else {
		plain = plain.replace( /```[\s\S]*?```/g, ' … ' );
		for ( let pass = 0; pass < 3; pass++ ) { // odkazy a obrázky Markdownu → jen text, i vnořené [[text](adresa)](adresa)
			plain = plain.replace( /!?\[([^[\]]*)\]\([^()\s]*\)/g, '$1' );
		}
		plain = plain.replace( /^[ \t]*(?:[>#]+|[-*+][ \t])[ \t]*/gm, '' ).replace( /[*_`~]{1,3}/g, '' ); // citace, nadpisy a odrážky na začátku řádku, zvýraznění a kód
	}
	plain = plain.replace( /\s+/g, ' ' ).trim();
	return plain.length > EXCERPT_LENGTH ? plain.slice( 0, EXCERPT_LENGTH - 1 ).trimEnd() + '…' : plain;
};

/** chyba s textem pro uživatele */
class FeedError extends Error {}

/** @returns {Promise.<Response>} požadavek bez cookies a bez Referer, s časovým limitem */
const request = async function ( /** @type {String} */ url )
{
	let response;
	try {
		response = await fetch( url, {
			credentials: 'omit',
			referrerPolicy: 'no-referrer',
			cache: 'no-store',
			headers: url.startsWith( 'https://api.github.com/' ) ? { Accept: 'application/vnd.github+json' } : {},
			signal: AbortSignal.timeout( settings.timeout ),
		} );
	} catch ( error ) {
		if ( error?.name === 'TimeoutError' ) {
			throw new FeedError( text( 'timeout', Math.round( settings.timeout / 1000 ) ) );
		}
		throw new FeedError( settings.service === settings.services.isso ? text( 'issoNetwork', settings.adminOrigin ) : text( 'network' ) );
	}
	if ( response.ok ) {
		return response;
	}
	if ( url.startsWith( 'https://api.github.com/' ) ) {
		if ( [ 403, 429 ].includes( response.status ) && response.headers.get( 'X-RateLimit-Remaining' ) === '0' ) {
			const reset = Number( response.headers.get( 'X-RateLimit-Reset' ) ) * 1000;
			throw new FeedError( text( 'rateLimit', reset ? new Intl.DateTimeFormat( settings.locale, { timeStyle: 'short' } ).format( new Date( reset ) ) : '…' ) );
		}
		if ( [ 404, 410 ].includes( response.status ) ) {
			throw new FeedError( text( 'githubNotFound', settings.repository ) );
		}
	}
	if ( settings.service === settings.services.isso && response.status === 404 ) {
		throw new FeedError( text( 'issoNetwork', settings.adminOrigin ) );
	}
	throw new FeedError( text( 'http', response.status ) );
};

/** @returns {Promise.<Array>} */
const json = async function ( /** @type {String} */ url )
{
	const data = await ( await request( url ) ).json().catch( () => null );
	if ( !Array.isArray( data ) ) {
		throw new FeedError( text( 'invalid' ) );
	}
	return data;
};

/** @returns {?Object} vlákno ze stránky webu (název, odkaz na úpravu, adresa) podle klíče, který služba používá */
const threadOf = function ( /** @type {String} */ key )
{
	return Object.hasOwn( settings.threads, key ) ? settings.threads[ key ] : null;
};

/**
* Položka výpisu: { time, threadKey, threadTitle (služba), count (jen vlákna), author, excerpt, url (na službě / webu) }
* @returns {Promise.<{ items: Array, notice: String }>}
*/
const loaders = {
	async giscus ()
	{
		const first = await request( settings.urls.discussions );
		let discussions = await first.json().catch( () => null );
		if ( !Array.isArray( discussions ) ) {
			throw new FeedError( text( 'invalid' ) );
		}
		let notice = '';
		const last = Number( /[?&]page=(\d+)>;\s*rel="last"/.exec( first.headers.get( 'Link' ) ?? '' )?.[ 1 ] ?? 1 );
		if ( last > 1 ) {
			const pages = [];
			for ( let page = Math.max( 2, last - settings.githubPages + 1 ); page <= last; page++ ) {
				pages.push( page );
			}
			if ( pages[ 0 ] > 2 ) {
				discussions = []; // nejstarší stránka nepatří k souvislým posledním stránkám
				notice = text( 'partial', settings.githubPages * 100 );
			}
			for ( const page of await Promise.all( pages.map( ( page ) => json( settings.urls.discussions + '&page=' + page ) ) ) ) {
				discussions.push( ...page );
			}
		}
		const { id, name } = settings.category;
		const items = discussions
			.filter( ( discussion ) => ( id && discussion.category?.node_id === id ) || ( !id && discussion.category?.name === name ) )
			.map( ( discussion ) => ( {
				time: timeOf( discussion.updated_at ),
				threadKey: String( discussion.title ?? '' ),
				count: Number( discussion.comments ?? 0 ),
				url: String( discussion.html_url ?? '' ),
			} ) )
			.filter( ( item ) => item.count > 0 );
		return { items, notice };
	},

	async utterances ()
	{
		const [ comments, issues ] = await Promise.all( [ json( settings.urls.comments ), json( settings.urls.issues ).catch( () => [] ) ] );
		const titles = new Map( issues.map( ( issue ) => [ String( issue.url ?? '' ), String( issue.title ?? '' ) ] ) );
		return {
			items: comments.map( ( comment ) => ( {
				time: timeOf( comment.created_at ),
				threadKey: titles.get( String( comment.issue_url ?? '' ) ) ?? '#' + String( comment.issue_url ?? '' ).split( '/' ).pop(), // název issue = klíč vlákna (pathname); issue mimo 50 naposledy změněných jen číslem
				author: String( comment.user?.login ?? '' ),
				excerpt: excerptOf( comment.body, false ),
				url: String( comment.html_url ?? '' ),
			} ) ),
			notice: '',
		};
	},

	async remark42 ()
	{
		const comments = await json( settings.urls.last );
		return {
			items: comments.map( ( comment ) => ( {
				time: timeOf( comment.time ),
				threadKey: String( comment.locator?.url ?? '' ),
				threadTitle: String( comment.title ?? '' ),
				author: String( comment.user?.name ?? '' ),
				excerpt: excerptOf( comment.text, true ),
				url: String( comment.locator?.url ?? '' ),
			} ) ),
			notice: '',
		};
	},

	async isso ()
	{
		const comments = await json( settings.urls.latest );
		return {
			items: comments.map( ( comment ) => ( {
				time: timeOf( Number( comment.created ) ),
				threadKey: String( comment.uri ?? '' ),
				author: String( comment.author ?? '' ),
				excerpt: excerptOf( comment.text, true ),
				url: threadOf( String( comment.uri ?? '' ) )?.url ?? new URL( String( comment.uri ?? '/' ).replace( /^\/+/, '' ), settings.siteUrl ).href,
			} ) ),
			notice: '',
		};
	},
};

/** @returns {Promise.<{ items: Array, notice: String, savedAt: Number, previousSeen: Number, cached: Boolean }>} výsledek z paměti, nebo nově stažený */
const load = async function ( /** @type {Boolean} */ fresh )
{
	const cacheKey = settings.cacheKey;
	if ( !fresh ) {
		try {
			const cached = JSON.parse( sessionStorage.getItem( cacheKey ) ?? 'null' );
			if ( cached && Date.now() - cached.savedAt < settings.cacheSeconds * 1000 ) {
				return { ...cached, cached: true };
			}
		} catch {}
	}
	const loader = Object.entries( settings.services ).find( ( [ , id ] ) => id === settings.service )?.[ 0 ];
	const { items, notice } = await loaders[ loader ]();
	items.sort( ( a, b ) => b.time - a.time );
	const result = { items: items.slice( 0, settings.limit ), notice, savedAt: Date.now(), previousSeen: 0 };
	let previousSeen = 0;
	try {
		previousSeen = Number( localStorage.getItem( cacheKey + ':seen' ) ?? 0 );
		const newest = Math.max( previousSeen, ...items.map( ( item ) => item.time ) );
		localStorage.setItem( cacheKey + ':seen', String( newest ) );
		result.previousSeen = previousSeen;
		sessionStorage.setItem( cacheKey, JSON.stringify( result ) );
	} catch {} // úložiště vypnuté – bez paměti a bez značek „nové“
	return { ...result, cached: false };
};

/**
* Jeden výpis ve widgetu.
*/
class CommentFeed
{
	/** @type {HTMLElement} */
	#status;

	/** @type {HTMLElement} */
	#list;

	/** @type {?HTMLButtonElement} */
	#reload;

	constructor ( /** @type {HTMLElement} */ root )
	{
		this.#status = root.querySelector( '[' + settings.attribute + '-status]' );
		this.#list = root.querySelector( '[' + settings.attribute + '-list]' );
		this.#reload = root.querySelector( '[' + settings.attribute + '-reload]' );
		this.#reload?.addEventListener( 'click', () => this.#show( true ) );
		this.#show( false );
	}

	async #show ( /** @type {Boolean} */ fresh )
	{
		if ( this.#reload ) {
			this.#reload.disabled = true;
		}
		this.#status.classList.remove( ...settings.classes.notice );
		this.#status.replaceChildren( text( 'loading' ) );
		try {
			const result = await load( fresh );
			this.#render( result );
		} catch ( error ) {
			const message = error instanceof FeedError ? error.message : String( error?.message ?? error );
			this.#list.replaceChildren();
			this.#status.classList.add( ...settings.classes.notice ); // žluté oznámení administrace
			this.#status.replaceChildren( text( 'error', message ) );
			if ( !( error instanceof FeedError ) ) {
				console.error( 'Komentáře na nástěnce:', error );
			}
		} finally {
			if ( this.#reload ) {
				this.#reload.disabled = false;
			}
		}
	}

	#render ( /** @type {Object} */ result )
	{
		const isThreads = settings.service === settings.services.giscus;
		const fresh = result.previousSeen > 0 ? result.items.filter( ( item ) => item.time > result.previousSeen ) : [];
		const loadedAt = new Intl.DateTimeFormat( settings.locale, { timeStyle: 'short' } ).format( new Date( result.savedAt ) );
		const summary = [];
		if ( result.items.length ) {
			summary.push( result.previousSeen > 0 ? ( fresh.length ? plural( isThreads ? 'newThreads' : 'newComments', fresh.length ) : text( 'nothingNew' ) ) + ' ' : '' );
		} else {
			summary.push( text( isThreads ? 'emptyThreads' : 'empty' ) + ' ' );
		}
		summary.push( text( result.cached ? 'cached' : 'loaded', loadedAt ) );
		if ( result.notice ) {
			summary.push( ' ' + result.notice );
		}
		this.#status.replaceChildren( ...summary );
		this.#list.replaceChildren( ...result.items.map( ( item ) => this.#item( item, result.previousSeen > 0 && item.time > result.previousSeen ) ) );
	}

	/** @returns {HTMLLIElement} */
	#item ( /** @type {Object} */ item, /** @type {Boolean} */ isNew )
	{
		const thread = threadOf( item.threadKey );
		const titleText = thread?.title ?? ( item.threadTitle || text( 'unknownThread', item.threadKey ) ); // článek z webu, jinak název stránky ze služby (Remark42), jinak klíč vlákna
		const title = thread?.edit ? element( 'a', [], [ titleText ] ) : element( 'strong', [], [ titleText ] );
		if ( thread?.edit ) {
			title.href = thread.edit;
		}
		const time = element( 'time', [], [ relativeTime( item.time ) ] );
		time.dateTime = new Date( item.time ).toISOString();
		time.title = new Intl.DateTimeFormat( settings.locale, { dateStyle: 'medium', timeStyle: 'short' } ).format( new Date( item.time ) );
		const meta = [];
		if ( item.count !== undefined ) {
			meta.push( plural( 'comments', item.count ), ' · ' );
		} else {
			meta.push( element( 'strong', [], [ item.author || text( 'anonymous' ) ] ), ' · ' );
		}
		meta.push( time );
		if ( item.url ) {
			meta.push( ' · ', externalLink( item.url, text( 'open' ) ) );
		}
		const content = [ title, ' ' ];
		if ( isNew ) {
			content.push( element( 'span', [ settings.classes.badge ], [ text( 'badge' ) ] ) );
		}
		content.push( element( 'div', [ settings.classes.meta ], meta ) );
		if ( item.excerpt ) {
			content.push( element( 'div', [ settings.classes.excerpt ], [ item.excerpt ] ) );
		}
		return element( 'li', isNew ? [ settings.classes.new ] : [], content );
	}
}

const settingsElement = document.getElementById( SETTINGS_ELEMENT_ID );
if ( settingsElement ) {
	settings = JSON.parse( settingsElement.textContent ?? '{}' );
	const root = document.querySelector( '[' + settings.attribute + '="' + CSS.escape( settings.service ) + '"]' );
	if ( root ) {
		new CommentFeed( root );
	}
}
