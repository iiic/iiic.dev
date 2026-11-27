/*
	[2026-11-27] Ukazatel délky titulku stránky (prvek <title>) v administraci (README „Délka titulku v administraci“,
	\FUNCTIONS\TITLE_LENGTH ve functions.php, styly css/admin-title-length.css). Jezdec na stupnici ukazuje, kolik znaků bude
	mít titulek stránky příspěvku, svislá značka je doporučené maximum (\VARS\DASHBOARD_WIDGET::TITLE_MAX_LENGTH, 70 znaků –
	pravidlo long-title v html-validate, stejná hranice jako ve widgetu „Kontrola obsahu před exportem“). Delší titulek
	ukazatel dovolí, jen zčervená. Text je jen v atributu title (a pro čtečky v aria-valuetext).
	Místa:
	- blokový editor, pravý panel Příspěvek / Stránka: pod názvem nahoře (.editor-post-card-panel), podle upravovaného názvu
	  (wp.data, mění se už při psaní),
	- okno „Přejmenovat“ (tlačítko … vedle názvu v tom panelu): pod polem Název, podle textu v poli,
	- výpis příspěvků (edit.php), Rychlé úpravy: pod polem Název, podle textu v poli,
	- [2026-11-27] klasický editor (produkty, organizace – typy bez podpory 'editor'): pod polem s názvem nahoře.
	Části titulku kolem názvu (oddělovač, název webu), titulek bez názvu a titulek úvodní stránky dává PHP stejnými filtry jako
	wp_get_document_title(). Z úprav, které WordPress s názvem dělá (wptexturize(), strip_tags(), trim při uložení), tu jsou
	jen ty, které mění délku. Délka je String.length jako v html-validate (znak mimo BMP = 2).
	Panel i okno vykresluje React a při překreslení je zahodí i s ukazatelem, řádek Rychlých úprav vzniká až po kliknutí –
	ukazatele proto doplňuje MutationObserver (nejvýš jednou za snímek).
	Modul nic neimportuje, v editoru používá globální wp.data (klasické skripty jádra).
*/

const SETTINGS_ID = 'ddt-delka-titulku-nastaveni'; // \VARS\TITLE_LENGTH::SETTINGS_ID
const METER_CLASS = 'ddt-title-length'; // třídy a vlastnosti ze css/admin-title-length.css
const THUMB_CLASS = METER_CLASS + '__thumb';
const PLACE_ATTRIBUTE = 'data-place';
const OVER_ATTRIBUTE = 'data-over';
const POSITION_PROPERTY = '--ddt-title-length-position';
const LIMIT_PROPERTY = '--ddt-title-length-limit';
const PLACES = {
	PANEL: 'panel',
	RENAME: 'rename',
	QUICK_EDIT: 'quick-edit',
	CLASSIC: 'classic',
};
const EDITOR_STORE = 'core/editor';
const PANEL_HEADER = '.editor-post-card-panel__header'; // první řádek panelu: ikona, název, tlačítko …
const RENAME_INPUT = '.editor-action-modal__rename-post input[type="text"]'; // okno akce rename-post (overlayClassName editor-action-modal__<id akce>)
const QUICK_EDIT_INPUT = '#the-list .quick-edit-row input[name="post_title"]'; // řádek Rychlých úprav (kopie #inline-edit, id edit-<ID>)
const QUICK_EDIT_ROW_ID = /^edit-(\d+)$/;
const CLASSIC_INPUT = '#titlewrap > input#title'; // klasický editor (wp-admin/edit-form-advanced.php), ukazatel jde za #titlewrap
const CLASSIC_POST_ID = 'post_ID'; // skryté pole s ID příspěvku v klasickém editoru
const TEXTURIZE = [ // wptexturize() – jen náhrady, které mění délku (uvozovky, apostrofy a pomlčka mezi mezerami ji nemění)
	[ /\.\.\./g, '…' ],
	[ /``/g, '“' ],
	[ /''/g, '”' ],
	[ / \(tm\)/g, ' ™' ],
	[ /---/g, '—' ],
	[ /(?<!xn)--/g, '–' ],
];
const TAG = /<\/?[a-z!][^>]*>/gi; // strip_tags()

const settings = readSettings();

if ( settings ) {
	if ( window._wpLoadBlockEditor && window.wp?.data ) {
		window._wpLoadBlockEditor.then( () => watch( window.wp.data ) ); // promise z wp-admin/edit-form-blocks.php: editor je inicializovaný
	} else {
		watch( null );
	}
}

function readSettings()
{
	try {
		const data = JSON.parse( document.getElementById( SETTINGS_ID )?.textContent ?? 'null' );
		return Number.isInteger( data?.max ) && Number.isInteger( data?.scale ) && data?.texts ? data : null;
	} catch {
		return null;
	}
}

function watch( data )
{
	const shown = new WeakMap(); // ukazatel → titulek, který ukazuje (beze změny se atributy nepřepisují)
	let frame = 0;
	let lastTitle = null;

	const schedule = () => {
		if ( !frame ) {
			frame = window.requestAnimationFrame( sync );
		}
	};

	if ( data ) {
		data.subscribe( () => { // subscribe() volá při každé změně ve stores – dál jen při změně názvu
			const title = data.select( EDITOR_STORE ).getEditedPostAttribute( 'title' );
			if ( title !== lastTitle ) {
				lastTitle = title;
				schedule();
			}
		} );
	}
	document.addEventListener( 'input', ( event ) => {
		if ( event.target instanceof HTMLInputElement && event.target.matches( [ RENAME_INPUT, QUICK_EDIT_INPUT, CLASSIC_INPUT ].join( ', ' ) ) ) {
			schedule();
		}
	}, true );
	new MutationObserver( schedule ).observe( document.body, { childList: true, subtree: true } );
	schedule();

	function sync()
	{
		frame = 0;
		const postId = data ? data.select( EDITOR_STORE ).getCurrentPostId() : null;
		if ( data ) {
			const title = data.select( EDITOR_STORE ).getEditedPostAttribute( 'title' ) ?? '';
			for ( const header of document.querySelectorAll( PANEL_HEADER ) ) {
				place( header, PLACES.PANEL, title, postId );
			}
		}
		for ( const input of document.querySelectorAll( RENAME_INPUT ) ) {
			place( input, PLACES.RENAME, input.value, postId );
		}
		for ( const input of document.querySelectorAll( QUICK_EDIT_INPUT ) ) {
			const rowId = QUICK_EDIT_ROW_ID.exec( input.closest( 'tr' )?.id ?? '' );
			place( input.closest( 'label' ) ?? input, PLACES.QUICK_EDIT, input.value, rowId ? Number( rowId[ 1 ] ) : null ); // za <label>: uvnitř by aria-valuetext ukazatele byl součástí názvu pole
		}
		for ( const input of document.querySelectorAll( CLASSIC_INPUT ) ) {
			const classicPostId = Number( document.getElementById( CLASSIC_POST_ID )?.value );
			place( input.parentElement, PLACES.CLASSIC, input.value, Number.isInteger( classicPostId ) && classicPostId > 0 ? classicPostId : null ); // za #titlewrap, před odkaz na příspěvek
		}
	}

	function place( anchor, where, postTitle, postId ) // ukazatel hned za prvek anchor (vytvoří ho, když tam není)
	{
		let meter = anchor.nextElementSibling;
		const title = documentTitle( postTitle, postId );
		if ( meter?.classList.contains( METER_CLASS ) ) {
			if ( shown.get( meter ) !== title ) {
				update( meter, title, postId );
			}
			return;
		}
		meter = createMeter( where );
		update( meter, title, postId ); // poloha ještě před vložením – jezdec pak nepřejíždí od nuly
		anchor.after( meter );
	}

	function update( meter, title, postId )
	{
		shown.set( meter, title );
		const length = title.length;
		const over = length > settings.max;
		meter.style.setProperty( POSITION_PROPERTY, ( Math.min( length / settings.scale, 1 ) * 100 ) + '%' );
		meter.toggleAttribute( OVER_ATTRIBUTE, over );
		meter.setAttribute( 'aria-valuenow', String( length ) );
		meter.setAttribute( 'aria-valuemax', String( Math.max( settings.scale, length ) ) );
		meter.setAttribute( 'aria-valuetext', format( settings.texts.value, length, settings.max ) );
		meter.title = [
			isFrontPage( postId ) ? settings.texts.frontPage : null,
			format( over ? settings.texts.over : settings.texts.within, length, settings.max, length - settings.max ),
			format( settings.texts.title, title ),
		].filter( Boolean ).join( '\n' );
	}
}

function createMeter( where )
{
	const meter = document.createElement( 'div' );
	meter.className = METER_CLASS;
	meter.setAttribute( PLACE_ATTRIBUTE, where );
	meter.setAttribute( 'role', 'meter' );
	meter.setAttribute( 'aria-label', settings.texts.label );
	meter.setAttribute( 'aria-valuemin', '0' );
	meter.style.setProperty( LIMIT_PROPERTY, ( Math.min( settings.max / settings.scale, 1 ) * 100 ) + '%' );
	const thumb = document.createElement( 'span' );
	thumb.className = THUMB_CLASS;
	meter.append( thumb );
	return meter;
}

function documentTitle( postTitle, postId ) // text <title> stránky příspěvku s tímto názvem (\FUNCTIONS\DASHBOARD\documentTitleOf())
{
	if ( isFrontPage( postId ) ) {
		return settings.frontPage.title; // název a popis webu, název stránky v něm není
	}
	let title = String( postTitle ?? '' ).trim(); // WordPress název při uložení ořízne (title_save_pre)
	for ( const [ pattern, replacement ] of TEXTURIZE ) {
		title = title.replace( pattern, replacement );
	}
	title = title.replace( TAG, '' );
	return title === '' ? settings.untitled : settings.before + title + settings.after; // prázdný název WordPress vynechá i s oddělovačem
}

function isFrontPage( postId )
{
	return postId !== null && settings.frontPage?.id === postId;
}

function format( text, ...values ) // %1$s, %2$s… jako sprintf() v PHP
{
	return String( text ).replace( /%(\d+)\$s/g, ( match, index ) => String( values[ index - 1 ] ?? match ) );
}
