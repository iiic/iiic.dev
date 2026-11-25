/**
* [2026-11-22] Výpis příspěvků (wp-admin/edit.php): tlačítko „IndexNow“ v akcích řádku pošle adresu příspěvku do IndexNow
* přímo z prohlížeče, stránka se neobnovuje. Dříve to dělalo PHP (\FUNCTIONS\ADMIN\indexnow() přes wp_remote_get())
* a jediný proces php-cgi po dobu čekání na vyhledávač (až 10 s) nic jiného nevyřídil.
*
* Nastavení (klíč, adresy API, texty) je v <script type="text/json" id="varsAdminIndexNowSettings">, vypisuje ho
* \FUNCTIONS\ADMIN\admin_enqueue_scripts(). Tlačítka vytváří \FUNCTIONS\ADMIN\common_row_actions(), adresa příspěvku
* je v atributu `value` – s vyplněnou „Adresou statického webu“ adresa na statickém webu a v nastavení je navíc
* `keyLocation` (soubor s klíčem, který do statického webu přidává export) [2026-11-22].
*
* Požadavek jde v režimu `no-cors`: API IndexNow nemusí posílat CORS hlavičky, prohlížeč ho ale i tak odešle. Odpověď
* (stavový kód) je pak pro skript nečitelná – jde jen poznat, jestli server odpověděl, nebo nastala chyba sítě. Při chybě
* sítě se zkusí další adresa API (stačí jedna, vyhledávače si adresy navzájem předávají).
*/

/** @type {String} */
const SETTINGS_ELEMENT_ID = 'varsAdminIndexNowSettings'; // \VARS\ADMIN::INDEXNOW_SETTINGS ve functions.php

/** @type {HTMLScriptElement|null} */
const settingsElement = document.getElementById( SETTINGS_ELEMENT_ID );

if ( settingsElement ) {

	/** @type {Object} */
	const settings = JSON.parse( settingsElement.textContent );

	/** @type {Function} */
	const shuffled = function ( /** @type {Array} */ items )
	{

		/** @type {Array} */
		const result = [ ...items ];

		for ( let i = result.length - 1; i > 0; i-- ) {

			/** @type {Number} */
			const j = Math.floor( Math.random() * ( i + 1 ) );

			[ result[ i ], result[ j ] ] = [ result[ j ], result[ i ] ];
		}
		return result;
	};

	/** @type {Function} */
	const submit = async function ( /** @type {String} */ pageUrl )
	{
		for ( const endpoint of shuffled( settings.endpoints ) ) {

			/** @type {URL} */
			const url = new URL( endpoint );

			url.searchParams.set( 'url', pageUrl );
			url.searchParams.set( 'key', settings.key );
			if ( settings.keyLocation ) {
				url.searchParams.set( 'keyLocation', settings.keyLocation ); // [2026-11-22] adresy statického webu – soubor s klíčem je v jeho kořeni
			}
			try {
				await fetch( url.href, {
					method: 'GET',
					mode: 'no-cors',
					credentials: 'omit',
					cache: 'no-store',
					referrerPolicy: 'no-referrer',
				} );
				return url.origin;
			} catch ( error ) {
				// chyba sítě (DNS, spojení, zablokováno rozšířením prohlížeče) – zkusí se další adresa API
			}
		}
		return null;
	};

	document.addEventListener( 'click', function ( /** @type {MouseEvent} */ event )
	{

		/** @type {HTMLButtonElement|null} */
		const button = event.target instanceof Element ? event.target.closest( 'button.' + settings.buttonClass ) : null;

		if ( !button || button.disabled || !button.value ) {
			return;
		}
		button.disabled = true;
		button.textContent = settings.texts.sending;
		submit( button.value ).then( function ( /** @type {String|null} */ origin )
		{
			if ( origin ) {
				button.textContent = settings.texts.sent;
				button.title = settings.texts.sentTitle.replace( '%s', origin );
			} else {
				button.textContent = settings.texts.failed;
				button.disabled = false;
			}
		} );
	} );
}
