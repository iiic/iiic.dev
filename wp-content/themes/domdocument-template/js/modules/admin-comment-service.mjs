/**
* [2026-11-24] Nastavení → Komentáře (wp-admin/options-discussion.php): výběr „Typ komentářové služby“.
*
* - Přesune řádek s výběrem na začátek tabulky „Nastavení komentářů“ a hned pod něj řádky s poli cizích služeb
*   (WordPress pole šablon vypisuje až na konci tabulky, do_settings_fields( 'discussion', 'default' )).
* - Podle zvolené služby ukazuje jen její pole a popis (atribut data-comment-services s ID služeb oddělenými mezerou)
*   a z voleb WordPressu jen ty, které služba používá: <option> výběru má v atributu data-wp-options názvy voleb
*   jádra (= id polí formuláře). Volby, které neuvádí žádná služba (povolení komentářů, zpětné odkazy, uzavírání
*   komentářů u starých příspěvků, upozornění na poznámky, avatary…), zůstávají vidět vždy.
* - Skrývá jednotlivé volby, ne jen celé řádky: v jádře je víc voleb v jednom řádku (např. „Další nastavení
*   komentářů“). Řádek, ve kterém nezůstane žádné viditelné pole, se skryje celý.
*
* Skryté prvky dostanou style="display: none" – atribut hidden ani třída hidden na <label> nestačí, forms.css mu
* nastavuje display: inline-block se silnějším selektorem. Pole zůstávají ve formuláři a odesílají se: options.php
* by volbu, která v odeslaném formuláři chybí, přepsal prázdnou hodnotou.
*
* Bez JavaScriptu: výběr je na konci tabulky, vidět jsou pole uložené služby (řádky ostatních mají od PHP třídu
* hidden) a všechny volby WordPressu. Popis a pole vypisuje \FUNCTIONS\ADMIN\commentServiceSelectField()
* a commentServiceTextField() ve functions.php.
*/

/** @type {String} */
const SELECT_ID = 'varsOptionCommentService'; // \VARS\OPTION::COMMENT_SERVICE

/** @type {String} */
const SERVICES_ATTRIBUTE = 'data-comment-services'; // \VARS\COMMENT_SERVICE::SERVICES_ATTRIBUTE

/** @type {String} */
const WP_OPTIONS_ATTRIBUTE = 'data-wp-options'; // \VARS\COMMENT_SERVICE::WP_OPTIONS_ATTRIBUTE

/** @type {String} */
const HIDDEN_CLASS = 'hidden'; // \WP\ADMIN_CLASS_NAMES::HIDDEN

/** @type {String} */
const FORM_CONTROLS = 'input:not([type="hidden"]), select, textarea';

/** @type {HTMLElement|null} */
const select = document.getElementById( SELECT_ID );

/** @type {Function} */
const namesOf = ( /** @type {String|null} */ list ) => ( list ?? '' ).split( ' ' ).filter( Boolean );

/** @type {Function} */
const setShown = function ( /** @type {HTMLElement} */ element, /** @type {Boolean} */ shown )
{
	element.classList.remove( HIDDEN_CLASS );
	element.style.display = shown ? '' : 'none';
};

/** @type {Function} */
const isShown = ( /** @type {Element} */ element ) => element.getClientRects().length > 0; // false i uvnitř skrytého předka

/**
* Prvky, které tvoří jednu volbu jádra: pole a jeho popisek, případně položka seznamu nebo odstavec, ve kterém jsou,
* a zalomení řádku <br> za nimi (jinak by po skryté volbě zůstal prázdný řádek).
* @type {Function}
*/
const partsOf = function ( /** @type {String} */ name )
{

	/** @type {HTMLElement|null} */
	const control = document.getElementById( name );

	if ( !control || !control.closest( 'td' ) ) {
		return [];
	}

	/** @type {Set<Element>} */
	const parts = new Set();

	for ( const element of [ control, ...document.querySelectorAll( `label[for="${ CSS.escape( name ) }"]` ) ] ) {
		parts.add( element.closest( 'li, p' ) ?? element.closest( 'label' ) ?? element );
	}
	for ( const part of [ ...parts ] ) {
		if ( part.nextElementSibling?.tagName === 'BR' ) {
			parts.add( part.nextElementSibling );
		}
	}
	return [ ...parts ];
};

if ( select instanceof HTMLSelectElement ) {

	/** @type {HTMLTableRowElement|null} */
	const selectRow = select.closest( 'tr' );

	/** @type {Array<HTMLElement>} */
	const serviceElements = [ ...document.querySelectorAll( `[${ SERVICES_ATTRIBUTE }]` ) ];

	/** @type {Array<HTMLTableRowElement>} */
	const serviceRows = [ ...new Set( serviceElements.filter( ( element ) => element.matches( FORM_CONTROLS ) ).map( ( element ) => element.closest( 'tr' ) ).filter( Boolean ) ) ];

	if ( selectRow?.parentElement ) {
		selectRow.parentElement.prepend( selectRow );
		selectRow.after( ...serviceRows ); // ve stejném pořadí, v jakém je vypsalo PHP
	}

	/** @type {Array<String>} */
	const managedOptions = [ ...new Set( [ ...select.options ].flatMap( ( option ) => namesOf( option.getAttribute( WP_OPTIONS_ATTRIBUTE ) ) ) ) ];

	/** @type {Map<String, Array<Element>>} */
	const optionParts = new Map( managedOptions.map( ( name ) => [ name, partsOf( name ) ] ) );

	/** @type {Array<HTMLTableRowElement>} */
	const managedRows = [ ...new Set( [ ...optionParts.values() ].flat().map( ( part ) => part.closest( 'tr' ) ).filter( Boolean ) ) ];

	/** @type {Function} */
	const apply = function ()
	{

		/** @type {String} */
		const service = select.value;

		/** @type {Set<String>} */
		const usedOptions = new Set( namesOf( select.selectedOptions[ 0 ]?.getAttribute( WP_OPTIONS_ATTRIBUTE ) ) );

		/** @type {Set<Element>} */
		const shownParts = new Set( managedOptions.filter( ( name ) => usedOptions.has( name ) ).flatMap( ( name ) => optionParts.get( name ) ) );

		for ( const element of serviceElements ) {
			setShown( element.matches( FORM_CONTROLS ) ? element.closest( 'tr' ) ?? element : element, namesOf( element.getAttribute( SERVICES_ATTRIBUTE ) ).includes( service ) );
		}

		for ( const row of managedRows ) { // nejdřív vše ukázat, ať jde níže u polí poznat, jestli jsou vidět
			setShown( row, true );
			for ( const list of row.querySelectorAll( 'ul' ) ) {
				setShown( list, true );
			}
		}
		for ( const part of [ ...optionParts.values() ].flat() ) {
			setShown( part, shownParts.has( part ) ); // část sdílená s používanou volbou zůstane vidět
		}
		for ( const row of managedRows ) {
			for ( const list of row.querySelectorAll( 'ul' ) ) { // seznam podřízených voleb bez jediné viditelné položky
				setShown( list, [ ...list.children ].some( isShown ) );
			}
			setShown( row, [ ...row.querySelectorAll( FORM_CONTROLS ) ].some( isShown ) );
		}
	};

	select.addEventListener( 'change', apply );
	apply();
}
