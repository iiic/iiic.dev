/**
* [2026-11-26] Přehledy šablony domdocument-template na nástěnce – widget „Statický web“ (\FUNCTIONS\DASHBOARD ve functions.php,
* dashboard-widgets/staticky-web.php, README.md šablony – sekce „Přehledy na nástěnce“).
*
* - Tlačítko „Vygenerovat statické soubory“ ve widgetu předá kliknutí tlačítku v horní liště (js/modules/admin-static-export.mjs).
*   Export se tak spustí stejně jako odtamtud: s oknem pro zprávu commitu a se sledováním stavu v horní liště. Kliknutí
*   s klávesou (nová karta, okno) a stránka bez tohoto modulu jdou na odkaz tlačítka – spuštění bez okna.
* - Podle třídy tlačítka v horní liště (běžící export) ukazuje oznámení „Právě běží export“ a schová tlačítko ve widgetu.
*   Když export skončí, ukáže oznámení s odkazem na nové načtení nástěnky (údaje widgetů jsou z doby načtení stránky).
*
* @version 0.1
* @since Q4 2026
*/

/** @type {String} \VARS\DASHBOARD_WIDGET::SETTINGS_ID */
const SETTINGS_ELEMENT_ID = 'ddt-nastenka-nastaveni';

/** @type {HTMLElement|null} */
const settingsElement = document.getElementById( SETTINGS_ELEMENT_ID );

/** @type {Object|null} */
const settings = settingsElement ? JSON.parse( settingsElement.textContent ?? '' ) : null;

if ( settings ) {
	/** @type {Element|null} položka horní lišty (<li>), třídu běžícího exportu jí mění modul horní lišty */
	const adminBarItem = document.querySelector( settings.adminBarItem );

	/** @type {Element|null} */
	const adminBarLink = document.querySelector( settings.adminBarLink );

	/** @type {Array.<HTMLElement>} */
	const startButtons = [ ...document.querySelectorAll( '[' + settings.attributes.start + ']' ) ];

	/** @type {Array.<HTMLElement>} */
	const runningNotices = [ ...document.querySelectorAll( '[' + settings.attributes.running + ']' ) ];

	/** @type {Array.<HTMLElement>} */
	const finishedNotices = [ ...document.querySelectorAll( '[' + settings.attributes.finished + ']' ) ];

	if ( adminBarLink instanceof HTMLAnchorElement ) {
		for ( const button of startButtons ) {
			button.addEventListener( 'click', ( /** @type {MouseEvent} */ event ) =>
			{
				if ( event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ) {
					return; // jako běžný odkaz
				}
				event.preventDefault();
				adminBarLink.click(); // horní lišta otevře okno se zprávou commitu a spustí export
			} );
		}
	}

	if ( adminBarItem ) {
		/** @type {Boolean} */
		let running = adminBarItem.classList.contains( settings.runningClass );

		const render = function ()
		{
			for ( const notice of runningNotices ) {
				notice.hidden = !running;
			}
			for ( const button of startButtons ) {
				button.hidden = running;
			}
		};

		new MutationObserver( () =>
		{
			const now = adminBarItem.classList.contains( settings.runningClass );
			if ( now === running ) {
				return;
			}
			running = now;
			render();
			if ( !running ) {
				for ( const notice of finishedNotices ) {
					notice.hidden = false;
				}
			}
		} ).observe( adminBarItem, { attributes: true, attributeFilter: [ 'class' ] } );
		render();
	}
}
