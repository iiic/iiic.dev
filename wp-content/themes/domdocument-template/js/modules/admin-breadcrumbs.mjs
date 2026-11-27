/**
* [2026-11-26] Stránka Drobečková navigace (hlavní položka menu administrace) šablony domdocument-template: stránku skládá
* \FUNCTIONS\BREADCRUMBS\renderAdminPage() ve functions.php, konstanty \VARS\BREADCRUMBS, popis v README.md šablony –
* sekce „Správa drobečkové navigace“.
*
* Formulář funguje i bez JavaScriptu: pořadí se píše číslem, nová položka do prázdného řádku, odebírá se zaškrtávátkem.
* Modul k tomu přidává:
* - šipky pro přesun řádku nahoru a dolů (čísla pořadí přepisuje sám, pole jsou skrytá třídou hide-if-js),
* - tlačítko „Přidat vlastní položku“: kopie prázdného řádku (modul ho při spuštění vyjme ze stránky a použije jako
*   šablonu, s novým indexem v name polí),
* - tlačítko „Odebrat“ u vlastní položky (řádek zmizí, po uložení není ve volbě),
* - pole vlastní adresy jen u odkazu „Vlastní adresa“ (jinak skryté a vypnuté, takže se neodešle),
* - po uložení zůstanou rozbalené typy stránek, které byly rozbalené (sessionStorage).
* Žádná vyskakovací okna (pravidlo 19), texty popisků jsou z PHP v atributech prvků.
*
* @version 0.1
* @since Q4 2026
*/

/** @type {Object.<string, string>} \VARS\BREADCRUMBS::ATTRIBUTE_* */
const ATTRIBUTES = Object.freeze( {
	ITEMS: 'data-ddt-breadcrumbs-items',
	INDEX: 'data-ddt-breadcrumbs-index',
	FIELD: 'data-ddt-breadcrumbs-field',
	ACTION: 'data-ddt-breadcrumbs-action',
	LABEL: 'data-ddt-breadcrumbs-label',
} );

/** @type {Object.<string, string>} \VARS\BREADCRUMBS::ACTION_* */
const ACTIONS = Object.freeze( { UP: 'up', DOWN: 'down', REMOVE: 'remove', ADD: 'add' } );

/** @type {Object.<string, string>} \VARS\BREADCRUMBS\KEY (hodnoty ATTRIBUTES.FIELD) */
const FIELDS = Object.freeze( { ORDER: 'order', LINK: 'link', URL: 'url', TEXT: 'text' } );

/** @type {String} \VARS\BREADCRUMBS\LINK::URL */
const LINK_URL = 'url';

/** @type {Object.<string, string>} \CSS\CLASS_NAMES\BREADCRUMBS_ADMIN, \WP\ADMIN_CLASS_NAMES */
const CLASS_NAMES = Object.freeze( {
	PAGE: 'ddt-breadcrumbs',
	CONTEXT: 'ddt-breadcrumbs-context',
	ROW_NEW: 'is-new',
	HIDE_IF_JS: 'hide-if-js',
	HIDDEN: 'hidden',
} );

/** @type {Number} pořadí první přesouvatelné položky (1 = výchozí položka) */
const FIRST_ORDER = 2;

/** @type {String} rozbalené typy stránek (id prvků <details>) mezi uložením formuláře a návratem na stránku */
const STORAGE_KEY = 'ddt-breadcrumbs-open';

/** @type {WeakMap.<HTMLTableSectionElement, HTMLTableRowElement>} šablona nového řádku každé tabulky */
const templates = new WeakMap();

/** @type {WeakMap.<HTMLTableSectionElement, Number>} další volný index řádku (name polí) */
const nextIndexes = new WeakMap();

const fieldOf = function ( /** @type {Element} */ parent, /** @type {String} */ field )
{
	return parent.querySelector( `[${ ATTRIBUTES.FIELD }="${ field }"]` );
};

const buttonOf = function ( /** @type {Element} */ parent, /** @type {String} */ action )
{
	return parent.querySelector( `button[${ ATTRIBUTES.ACTION }="${ action }"]` );
};

/** pole vlastní adresy jen u odkazu „Vlastní adresa“ */
const updateUrlField = function ( /** @type {HTMLSelectElement} */ select, /** @type {Boolean} */ focus = false )
{
	const url = fieldOf( select.parentElement, FIELDS.URL );
	if ( !url ) {
		return;
	}
	const isUrl = select.value === LINK_URL;
	url.classList.toggle( CLASS_NAMES.HIDDEN, !isUrl );
	url.disabled = !isUrl;
	if ( isUrl && focus ) {
		url.focus();
	}
};

/** čísla pořadí podle pořadí řádků, krajní šipky vypnuté */
const renumber = function ( /** @type {HTMLTableSectionElement} */ body )
{
	const rows = [ ...body.rows ];
	rows.forEach( ( row, index ) => {
		const order = fieldOf( row, FIELDS.ORDER );
		if ( order ) {
			order.value = String( FIRST_ORDER + index );
		}
		const up = buttonOf( row, ACTIONS.UP );
		const down = buttonOf( row, ACTIONS.DOWN );
		if ( up ) {
			up.disabled = index === 0;
		}
		if ( down ) {
			down.disabled = index === rows.length - 1;
		}
	} );
};

const moveRow = function ( /** @type {HTMLTableRowElement} */ row, /** @type {String} */ action )
{
	const sibling = action === ACTIONS.UP ? row.previousElementSibling : row.nextElementSibling;
	if ( !sibling ) {
		return;
	}
	if ( action === ACTIONS.UP ) {
		sibling.before( row );
	} else {
		sibling.after( row );
	}
	renumber( row.parentElement );
	// přesunutím řádku tlačítko ztratí fokus; u krajní pozice je vypnuté, fokus pak dostane druhá šipka
	const same = buttonOf( row, action );
	( same && !same.disabled ? same : buttonOf( row, action === ACTIONS.UP ? ACTIONS.DOWN : ACTIONS.UP ) )?.focus();
};

const removeRow = function ( /** @type {HTMLTableRowElement} */ row )
{
	const body = row.parentElement;
	const next = row.nextElementSibling ?? row.previousElementSibling;
	row.remove();
	renumber( body );
	// fokus na sousední řádek (jeho Odebrat, jinak šipku), a když žádný není, na „Přidat vlastní položku“
	const focusTarget = next
		? [ ACTIONS.REMOVE, ACTIONS.UP, ACTIONS.DOWN ].map( ( action ) => buttonOf( next, action ) ).find( ( button ) => button && !button.disabled )
		: null;
	( focusTarget ?? buttonOf( body.closest( `.${ CLASS_NAMES.CONTEXT }` ), ACTIONS.ADD ) )?.focus();
};

const addRow = function ( /** @type {HTMLTableSectionElement} */ body )
{
	const template = templates.get( body );
	if ( !template ) {
		return;
	}
	const index = nextIndexes.get( body );
	nextIndexes.set( body, index + 1 );
	const prefix = body.getAttribute( ATTRIBUTES.ITEMS );
	const from = `${ prefix }[${ template.getAttribute( ATTRIBUTES.INDEX ) }]`;
	const row = template.cloneNode( true );
	row.setAttribute( ATTRIBUTES.INDEX, String( index ) );
	row.classList.remove( CLASS_NAMES.ROW_NEW, CLASS_NAMES.HIDE_IF_JS );
	for ( const field of row.querySelectorAll( '[name]' ) ) {
		if ( field.name.startsWith( from ) ) {
			field.name = `${ prefix }[${ index }]` + field.name.slice( from.length );
		}
	}
	body.append( row );
	const select = fieldOf( row, FIELDS.LINK );
	if ( select ) {
		updateUrlField( select );
	}
	renumber( body );
	fieldOf( row, FIELDS.TEXT )?.focus();
};

const rememberOpen = function ( /** @type {Element} */ page )
{
	const open = [ ...page.querySelectorAll( `details.${ CLASS_NAMES.CONTEXT }[open]` ) ].map( ( details ) => details.id );
	try {
		sessionStorage.setItem( STORAGE_KEY, JSON.stringify( open ) );
	} catch {
		// úložiště vypnuté – rozbalení se nezapamatuje
	}
};

const restoreOpen = function ()
{
	let open = [];
	try {
		open = JSON.parse( sessionStorage.getItem( STORAGE_KEY ) ?? '[]' );
	} catch {
		open = [];
	}
	if ( location.hash.length > 1 ) {
		open.push( decodeURIComponent( location.hash.slice( 1 ) ) );
	}
	for ( const id of Array.isArray( open ) ? open : [] ) {
		const details = typeof id === 'string' ? document.getElementById( id ) : null;
		if ( details instanceof HTMLDetailsElement ) {
			details.open = true;
		}
	}
};

const init = function ()
{
	const page = document.querySelector( `.${ CLASS_NAMES.PAGE }` );
	if ( !page ) {
		return;
	}
	for ( const body of page.querySelectorAll( `tbody[${ ATTRIBUTES.ITEMS }]` ) ) {
		const template = body.querySelector( `tr.${ CLASS_NAMES.ROW_NEW }` );
		let maxIndex = -1;
		for ( const row of body.rows ) {
			maxIndex = Math.max( maxIndex, Number( row.getAttribute( ATTRIBUTES.INDEX ) ) || 0 );
		}
		if ( template ) {
			template.remove(); // s JavaScriptem se nová položka přidává tlačítkem, prázdný řádek se neodešle
			templates.set( body, template );
		}
		nextIndexes.set( body, maxIndex + 1 );
		renumber( body );
	}
	for ( const select of page.querySelectorAll( `select[${ ATTRIBUTES.FIELD }="${ FIELDS.LINK }"]` ) ) {
		updateUrlField( select );
	}
	page.addEventListener( 'change', ( /** @type {Event} */ event ) => {
		if ( event.target instanceof HTMLSelectElement && event.target.getAttribute( ATTRIBUTES.FIELD ) === FIELDS.LINK ) {
			updateUrlField( event.target, true );
		}
	} );
	page.addEventListener( 'click', ( /** @type {MouseEvent} */ event ) => {
		const button = event.target instanceof Element ? event.target.closest( `button[${ ATTRIBUTES.ACTION }]` ) : null;
		if ( !button || !page.contains( button ) ) {
			return;
		}
		const action = button.getAttribute( ATTRIBUTES.ACTION );
		if ( action === ACTIONS.ADD ) {
			const body = button.closest( `.${ CLASS_NAMES.CONTEXT }` )?.querySelector( `tbody[${ ATTRIBUTES.ITEMS }]` );
			if ( body ) {
				addRow( body );
			}
			return;
		}
		const row = button.closest( 'tr' );
		if ( !row ) {
			return;
		}
		if ( action === ACTIONS.REMOVE ) {
			removeRow( row );
		} else if ( action === ACTIONS.UP || action === ACTIONS.DOWN ) {
			moveRow( row, action );
		}
	} );
	restoreOpen();
	page.addEventListener( 'toggle', () => rememberOpen( page ), true ); // toggle nebublá, proto ve fázi zachycení
};

init();
