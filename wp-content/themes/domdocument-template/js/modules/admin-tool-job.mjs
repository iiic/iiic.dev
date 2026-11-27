/**
* [2026-11-26] Úloha nástroje na pozadí (Nástroje → Kontroly statického webu, Záloha databáze) šablony domdocument-template:
* \FUNCTIONS\ADMIN_TOOL\jobSection(), ajaxStartJob(), ajaxJobStatus() ve functions.php, admin-tools/runner.php, README.md
* šablony – sekce „Nástroje v administraci“.
*
* Tlačítko pošle POST admin-ajax.php?action=ddtAdminToolJobStart (nonce, název nástroje, zaškrtávací pole z řádku
* s tlačítkem). PHP spustí úlohu jako samostatný proces php.exe a modul se pak každou sekundu ptá na stav, dokud úloha
* neskončí. Ukazuje stav (běží / hotovo / chyba), výstup programu a u zálohy databáze údaje o souboru. Na stránce načtené
* během běhu úlohy sledování naváže, po skončení ukazuje výsledek posledního běhu. Vše přes DOM (textContent).
*
* @version 0.1
* @since Q4 2026
*/

/** @type {String} \VARS\ADMIN_TOOL_JOB::SETTINGS_ID */
const SETTINGS_ELEMENT_ID = 'ddt-admin-tool-job-settings';

/** @type {String} \VARS\ADMIN_TOOL_JOB::ROOT_ATTRIBUTE (prvky uvnitř: …-start, …-status, …-result) */
const ROOT_ATTRIBUTE = 'data-tool-job';

/** @type {Object.<string, string>} \POSSIBILITIES\ADMIN_TOOL_JOB_STATES */
const STATES = Object.freeze( { IDLE: 'idle', RUNNING: 'running', DONE: 'done', FAILED: 'failed', TIMEOUT: 'timeout' } );

/** @type {Object} */
let settings = {};

/** @returns {String} text s doplněnými hodnotami (%s, %1$s… jako sprintf() v PHP) */
const text = function ( /** @type {String} */ key, /** @type {...(String|Number)} */ ...values )
{
	let index = 0;
	return String( settings.texts?.[ key ] ?? key ).replace( /%(?:(\d+)\$)?s/g, ( match, position ) => String( values[ position ? Number( position ) - 1 : index++ ] ?? '' ) );
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

/** @returns {String} */
const formatDate = function ( /** @type {Number} */ timestamp )
{
	try {
		return new Intl.DateTimeFormat( settings.locale, { dateStyle: 'medium', timeStyle: 'medium' } ).format( new Date( timestamp ) );
	} catch {
		return new Date( timestamp ).toLocaleString();
	}
};

/** @returns {Promise.<Object>} data odpovědi admin-ajax.php (wp_send_json_success / _error) */
const ajax = async function ( /** @type {String} */ action, /** @type {Object.<string, string>} */ fields, /** @type {Boolean} */ post )
{
	const body = new URLSearchParams( { action, [ settings.fields.nonce ]: settings.nonce, [ settings.fields.tool ]: settings.tool, ...fields } );
	const response = await fetch( post ? settings.ajaxUrl : settings.ajaxUrl + '?' + body, post ? { method: 'POST', body, credentials: 'same-origin' } : { credentials: 'same-origin', cache: 'no-store' } );
	const data = await response.json().catch( () => null );
	if ( !response.ok || !data?.success ) {
		throw new Error( data?.data?.message || String( response.status ) );
	}
	return data.data;
};

/**
* Jedna úloha ve stránce: tlačítko, stav a výsledek.
*/
class ToolJob
{
	/** @type {HTMLElement} */
	#root;

	/** @type {HTMLButtonElement} */
	#button;

	/** @type {HTMLElement} */
	#status;

	/** @type {HTMLElement} */
	#result;

	/** @type {?Number} */
	#timer = null;

	constructor ( /** @type {HTMLElement} */ root )
	{
		this.#root = root;
		this.#button = root.querySelector( '[' + ROOT_ATTRIBUTE + '-start]' );
		this.#status = root.querySelector( '[' + ROOT_ATTRIBUTE + '-status]' );
		this.#result = root.querySelector( '[' + ROOT_ATTRIBUTE + '-result]' );
		this.#button.addEventListener( 'click', () => this.#start() );
		this.#render( settings.status );
		if ( settings.status?.running ) {
			this.#schedule();
		}
	}

	async #start ()
	{
		this.#button.disabled = true;
		const fields = {};
		for ( const input of this.#button.parentElement.querySelectorAll( 'input[type="checkbox"][name]' ) ) {
			if ( input.checked ) {
				fields[ input.name ] = input.value;
			}
		}
		try {
			this.#render( await ajax( settings.actions.start, fields, true ) );
			this.#schedule();
		} catch ( error ) {
			this.#button.disabled = false;
			this.#status.replaceChildren( text( 'requestFailed', error.message ) );
		}
	}

	#schedule ()
	{
		clearTimeout( this.#timer );
		this.#timer = setTimeout( () => this.#poll(), settings.pollInterval );
	}

	async #poll ()
	{
		try {
			const status = await ajax( settings.actions.status, {}, false );
			this.#render( status );
			if ( status.running ) {
				this.#schedule();
			}
		} catch ( error ) {
			this.#status.replaceChildren( text( 'requestFailed', error.message ) );
			this.#timer = setTimeout( () => this.#poll(), settings.pollInterval * 3 );
		}
	}

	#render ( /** @type {Object} */ status )
	{
		if ( !status || status.state === STATES.IDLE ) {
			this.#button.disabled = false;
			return;
		}
		this.#button.disabled = status.running;
		if ( status.running ) {
			const seconds = status.startedAt ? Math.max( 0, Math.round( ( Date.now() - status.startedAt ) / 1000 ) ) : 0;
			this.#status.replaceChildren( element( 'span', [ 'spinner', 'is-active' ] ), text( 'running', seconds ) );
		} else {
			this.#status.replaceChildren( status.finishedAt ? text( 'finished', formatDate( status.finishedAt ), ( ( status.durationMs ?? 0 ) / 1000 ).toFixed( 1 ) ) : '' );
		}
		const parts = [];
		if ( !status.running ) {
			let noticeClass = 'notice-success';
			let message = text( 'success' );
			if ( status.state === STATES.TIMEOUT ) {
				noticeClass = 'notice-error';
				message = text( 'timeout' );
			} else if ( status.state === STATES.FAILED ) {
				noticeClass = 'notice-error';
				message = text( 'failed', status.message );
			} else if ( status.exitCode !== 0 ) {
				noticeClass = 'notice-error';
				message = text( 'failure' ) + ' ' + text( 'exitCode', status.exitCode );
			}
			const notice = element( 'div', [ 'notice', noticeClass, 'inline' ], [ element( 'p', [], [ message ] ) ] );
			if ( Array.isArray( status.info ) && status.info.length ) {
				notice.append( element( 'ul', [], status.info.map( ( [ label, value ] ) => element( 'li', [], [ element( 'strong', [], [ label + ': ' ] ), value ] ) ) ) );
			}
			parts.push( notice );
		}
		if ( status.command ) {
			parts.push( element( 'p', [ 'description' ], [ text( 'command', status.command ) ] ) );
		}
		const output = String( status.output ?? '' ).trimEnd();
		const errors = String( status.errors ?? '' ).trimEnd();
		parts.push( element( 'h3', [], [ text( 'output' ) ] ), element( 'pre', [ 'ddt-tool-output' ], [ output || text( 'emptyOutput' ) ] ) );
		if ( errors ) {
			parts.push( element( 'h3', [], [ text( 'errors' ) ] ), element( 'pre', [ 'ddt-tool-output', 'is-errors' ], [ errors ] ) );
		}
		this.#result.replaceChildren( ...parts );
	}
}

const settingsElement = document.getElementById( SETTINGS_ELEMENT_ID );
if ( settingsElement ) {
	settings = JSON.parse( settingsElement.textContent );
	const root = document.querySelector( '[' + ROOT_ATTRIBUTE + '="' + CSS.escape( settings.tool ) + '"]' );
	if ( root ) {
		new ToolJob( root );
	}
}
