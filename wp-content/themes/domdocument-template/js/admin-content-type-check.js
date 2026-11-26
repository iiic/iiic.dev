/**
* [2026-11-26] Nástěnka, widget šablony (\FUNCTIONS\ADMIN\ddtDashboardWidgetCallback() ve functions.php): kontrola, jestli
* webový server posílá soubory .mjs, .js, .css a .json se správným typem obsahu (hlavička Content-Type). Se špatným typem
* prohlížeč moduly .mjs nespustí a skripty šablony nefungují. Nahrazuje js/is-mjs-with-correct-mime-type.js (nedokončený).
*
* Kontrolu dělá knihovna ContentTypeChecker z repozitáře Dialogic (js/content-type-checker.js beze změny,
* https://github.com/iiic/Dialogic/blob/main/content-type-checker.js). Pro každou příponu najde první soubor ve stránce
* (<script src>, <link rel=stylesheet|preload>) a zjistí jeho typ požadavkem HEAD. Nastavení knihovny (české texty,
* autoRun: false) je v <script type="application/json" id="content-type-checker-settings">, knihovna si načítá
* String.prototype.interpolate (js/modules/string/interpolate.mjs) podle <script type="importmap"> (adresa + SRI).
*
* - Soubor je záměrně .js, ne .mjs, a nic z .mjs nepoužívá: musí se spustit i tehdy, když server .mjs posílá se špatným
*   typem. Proto také výsledek neukazuje oknem knihovny Dialogic (pravidlo 19 v README.md – dialogic.mjs by se v tom případě
*   nenačetl), ani alert(), jako by to udělala knihovna, ale vypíše ho do widgetu jako oznámení administrace.
* - Modul knihovny si při načtení vytvoří vlastní instanci s výchozím id nastavení; autoRun: false ji zastaví, kontrolu
*   spustí až tento soubor (podtřída s vlastním propagateReport()).
* - Knihovnu načte prvek <script type="module" integrity> (\FUNCTIONS\TEMPLATE\verifiedModuleScript()) a tento soubor ji
*   použije až po úspěšné kontrole SRI (importVerified(), stejně jako js/modules/admin-static-export.mjs – soubor .js nesmí
*   nic importovat z .mjs).
*
* @version 0.1
* @since Q4 2026
*/

/** @type {String} */
const CHECKER_MODULE = './content-type-checker.js?v0.2'; // \VARS\CONTENT_TYPE_CHECK::CHECKER

/** @type {String} */
const LOADED_ATTRIBUTE = 'data-module-loaded'; // \VARS\VERIFIED_MODULE::LOADED_ATTRIBUTE

/** @type {String} */
const MODULE_FAILED_ATTRIBUTE = 'data-module-failed'; // \VARS\VERIFIED_MODULE::FAILED_ATTRIBUTE

/** @type {String} */
const SETTINGS_ELEMENT_ID = 'content-type-checker-settings'; // \VARS\CONTENT_TYPE_CHECK::SETTINGS_ID (výchozí id knihovny)

/** @type {String} */
const OUTPUT_ELEMENT_ID = 'ddt-content-type-check'; // \CSS\ELEMENT_IDS::CONTENT_TYPE_CHECK – oznámení ve widgetu (skryté, dokud není co hlásit)

/** @type {String} */
const NOTICE_ERROR_CLASS = 'notice-error'; // \WP\ADMIN_CLASS_NAMES::NOTICE_ERROR – špatný typ .mjs (knihovna by hlásila alert())

/** @type {String} */
const NOTICE_WARNING_CLASS = 'notice-warning'; // \WP\ADMIN_CLASS_NAMES::NOTICE_WARNING – zastaralý nebo nestandardní typ, ostatní přípony

/** @type {String} */
const FAILED_ATTRIBUTE = 'data-failed'; // \VARS\CONTENT_TYPE_CHECK::FAILED_ATTRIBUTE – text, když kontrolu nejde provést

/**
* Modul s kontrolou SRI: import() až po úspěšném načtení prvkem <script type="module" integrity> (prohlížeč ho pak vezme
* z mapy modulů bez nového stažení). Stejné jako importVerified() v js/modules/admin-static-export.mjs.
* @returns {Promise.<Object>}
*/
const importVerified = ( /** @type {String} */ path ) => new Promise( ( resolve, reject ) =>
{
	const url = new URL( path, import.meta.url ).href;
	const element = [ ...document.querySelectorAll( 'script[type="module"][integrity]' ) ].find( ( script ) => script.src === url );
	const settle = () =>
	{
		if ( element.hasAttribute( MODULE_FAILED_ATTRIBUTE ) ) {
			reject( new Error( 'knihovna kontroly neprošla kontrolou integrity (SRI) nebo se nenačetla: ' + url ) );
		} else if ( element.hasAttribute( LOADED_ATTRIBUTE ) ) {
			resolve( import( url ) );
		} else {
			return false;
		}
		return true;
	};
	if ( !element ) {
		reject( new Error( 've stránce chybí <script type="module" integrity> pro ' + url ) );
	} else if ( !settle() ) {
		element.addEventListener( 'load', settle, { once: true } );
		element.addEventListener( 'error', settle, { once: true } );
	}
} );

/** @type {HTMLElement|null} */
const output = document.getElementById( OUTPUT_ELEMENT_ID );

const show = ( /** @type {Array.<String>} */ messages, /** @type {Boolean} */ isError ) =>
{
	if ( !output || !messages.length ) {
		return;
	}
	const list = output.querySelector( 'ul' ) ?? output.appendChild( document.createElement( 'ul' ) );
	for ( const message of messages ) {
		const item = document.createElement( 'li' );
		item.textContent = message; // typ obsahu a adresa pochází z odpovědi serveru – jen jako text
		list.append( item );
	}
	output.classList.add( isError ? NOTICE_ERROR_CLASS : NOTICE_WARNING_CLASS );
	output.hidden = false;
};

const showFailure = ( /** @type {Error} */ error ) => // kontrolu nejde provést: knihovna neprošla SRI, soubor ke kontrole nejde stáhnout, chybí interpolate (import map, SRI)…
{
	console.warn( error );
	show( [ `${ output?.getAttribute( FAILED_ATTRIBUTE ) ?? '' } ${ error?.message ?? String( error ) }`.trim() ], false );
};

/** @type {?Function} */
const ContentTypeChecker = await importVerified( CHECKER_MODULE ).then( ( module ) => module.ContentTypeChecker, ( error ) =>
{
	showFailure( error );
	return null;
} );

class DashboardContentTypeChecker extends ( ContentTypeChecker ?? class {} )
{

	/** @type {Array.<{ level: String, message: String }>} nálezy (level = reportingType z nastavení: alert, warning) */
	problems = [];

	/**
	* Místo alert() a console.warn() knihovny: zpráva se uloží pro výpis do widgetu (a do konzole). Text vybírá stejně jako
	* ContentTypeCheckerInternal.propagateReport() knihovny 0.2.
	*/
	propagateReport ( /** @type {{ fileExtension: String, path: String, reportingType?: String, contentType: String }} */ testingItem, /** @type {String} */ reportResult )
	{
		const texts = this.settings.texts;
		const isJavascript = testingItem.fileExtension === 'js' || testingItem.fileExtension === 'mjs';
		let message = isJavascript ? texts.jeErrorMimeType : texts.universalErrorMimeType; // jeError… – název klíče v knihovně
		if ( reportResult === 'deprecated' ) {
			message = isJavascript ? texts.jsDeprecatedMimeType : texts.universalDeprecatedMimeType;
		} else if ( reportResult === 'nonStandard' ) {
			message = isJavascript ? texts.jsNonStandardMimeType : texts.universalNonStandardMimeType;
		}
		message = message.interpolate( {
			fileExtension: testingItem.fileExtension,
			contentType: testingItem.contentType,
			pathToFile: testingItem.path,
			properJsFileType: this.settings.contentTypes.js.supported.join( texts.properTypesSeparator ),
		} );
		this.problems.push( { level: testingItem.reportingType ?? ContentTypeChecker.REPORT_TYPE.WARNING, message } );
		console.warn( message );
	}

}

if ( ContentTypeChecker ) {
	const checker = new DashboardContentTypeChecker( SETTINGS_ELEMENT_ID );
	checker.run()
		.then( () =>
		{
			show( checker.problems.map( ( problem ) => problem.message ), checker.problems.some( ( problem ) => problem.level === ContentTypeChecker.REPORT_TYPE.ALERT ) );
		} )
		.catch( showFailure );
}
