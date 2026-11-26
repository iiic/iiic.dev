/**
* [2026-11-25] Tlačítko „Vygenerovat statické soubory“ v horní liště WordPressu (šablona domdocument-template,
* \FUNCTIONS\STATIC_EXPORT ve functions.php, README.md šablony – sekce „Statický export“).
*
* - Kliknutí spustí export přes admin-ajax.php (stránka se nepřenačte) a hned otevře okno se zprávou commitu,
*   předvyplněnou podle nastavení „Zpráva commitu“. Zatímco se statické soubory generují, jde zprávu přepsat, doplnit,
*   nebo nechat. Export ji potřebuje až před commitem: když ještě nepřišla, počká na ni (nejvýš 5 min, pak použije
*   zprávu z nastavení). Zavření okna = zpráva z nastavení.
* - Během exportu se ptá na stav a přepisuje text tlačítka (stránka se nepřenačítá, rozepsaný článek se neztratí).
*   Okno se zprávou commitu otevře i stránka, která export nespustila (např. po přechodu na jinou stránku), dokud na ni
*   export čeká.
* - Dotazy ssh při pushi (heslo ke klíči, PIN, ověření serveru, dotyk bezpečnostního klíče) ukazuje v okně a odpověď
*   pošle PHP, které ji předá procesu static-export/askpass.php (heslo se nikam neukládá).
* - Všechna okna jsou z knihovny Dialogic (pravidlo 19 v README.md šablony, \FUNCTIONS\DIALOGIC ve functions.php).
*   Obsah oken (formuláře, texty z ssh) se skládá přes DOM – žádné HTML řetězce.
*
* Nastavení (adresy, nonce, názvy polí, texty, třídy) je v <script type="application/json" id="ddt-static-export-settings">,
* vypisuje ho \FUNCTIONS\STATIC_EXPORT\printAdminBarScript(). Bez JavaScriptu vede tlačítko na
* admin.php?action=ddtStaticExportStart – export se zprávou z nastavení, bez okna.
* Dříve (od 2026-11-20) to byl skript vložený do stránky jen během exportu, okno s dotazem ssh byl vlastní <dialog>.
*
* @version 0.2
* @since Q4 2026
*/

/** @type {Array.<String>} \VARS\DIALOGIC::HASH_CODE_MODULE a ::MODULE – <script type="module" integrity> vypisuje \FUNCTIONS\DIALOGIC\appendScripts() */
const DIALOGIC_MODULES = [ './dialogic/0.2.0/modules/string/hashCode.mjs', './dialogic/0.2.0/dialogic.mjs' ];

/** @type {String} */
const SETTINGS_ELEMENT_ID = 'ddt-static-export-settings'; // \VARS\STATIC_EXPORT::SCRIPT_SETTINGS_ID

/** @type {String} */
const LOADED_ATTRIBUTE = 'data-module-loaded'; // \VARS\VERIFIED_MODULE::LOADED_ATTRIBUTE

/** @type {String} */
const FAILED_ATTRIBUTE = 'data-module-failed'; // \VARS\VERIFIED_MODULE::FAILED_ATTRIBUTE

/**
* [2026-11-26] Modul s kontrolou SRI: načte ho prvek <script type="module" integrity> ve stránce
* (\FUNCTIONS\TEMPLATE\verifiedModuleScript()), import() se zavolá až po jeho úspěšném načtení a prohlížeč modul vezme
* z mapy modulů bez nového stažení. Statický import s <link rel="modulepreload" integrity> (dříve) SRI nezaručí: po
* neúspěšném modulepreload Chrome modul pro import stáhne znovu bez integrity a spustí ho (ověřeno).
* @returns {Promise.<Object>} jmenný prostor modulu; odmítne, když prvek chybí nebo neprošel kontrolou
*/
const importVerified = ( /** @type {String} */ path ) => new Promise( ( resolve, reject ) =>
{
	const url = new URL( path, import.meta.url ).href;
	const element = [ ...document.querySelectorAll( 'script[type="module"][integrity]' ) ].find( ( script ) => script.src === url );
	const settle = () =>
	{
		if ( element.hasAttribute( FAILED_ATTRIBUTE ) ) {
			reject( new Error( 'Modul neprošel kontrolou integrity (SRI) nebo se nenačetl: ' + url ) );
		} else if ( element.hasAttribute( LOADED_ATTRIBUTE ) ) {
			resolve( import( url ) );
		} else {
			return false;
		}
		return true;
	};
	if ( !element ) {
		reject( new Error( 'Ve stránce chybí <script type="module" integrity> pro ' + url ) );
	} else if ( !settle() ) { // ještě se nenačetl (atributy nastaví onload / onerror prvku dřív, než se zavolají tyto posluchače)
		element.addEventListener( 'load', settle, { once: true } );
		element.addEventListener( 'error', settle, { once: true } );
	}
} );

/** @type {?Function} třída Dialogic – až po kontrole SRI (bez ní tlačítko funguje jako bez JavaScriptu) */
let Dialogic = null;

/** @type {Object.<string, string>} hodnoty tlačítek formulářů v oknech (event.submitter.value) */
const ACTIONS = {
	USE: 'use', // zpráva commitu z pole
	KEEP: 'keep', // zpráva commitu z nastavení
	ANSWER: 'answer', // odpověď na dotaz ssh
	CANCEL: 'cancel', // zrušit push
	HIDE: 'hide', // skrýt oznámení
};

/** @type {Number} ms – první kontrola stavu na stránce načtené během exportu (okno se zprávou nebo dotaz ssh se ukáže hned) */
const FIRST_POLL_DELAY = 100;

/** @type {Number} ms – kontrola stavu po odeslání odpovědi */
const POLL_AFTER_ANSWER = 300;

class StaticExportButton
{

	/** @type {Object} nastavení z PHP */
	#settings;

	/** @type {HTMLAnchorElement} odkaz tlačítka v horní liště */
	#item;

	#running = false;

	#starting = false;

	/** @type {Number} */
	#timer = 0;

	/** @type {?{ id: String, dialog: Dialogic, closedByScript: Boolean }} otevřený dotaz ssh */
	#question = null;

	/** @type {Set.<String>} zodpovězené nebo skryté dotazy ssh se znovu neotevřou */
	#handledQuestions = new Set();

	/** @type {Set.<String>} dotaz otevřený znovu (po zavření křížkem) už bez zvuku */
	#shownQuestions = new Set();

	/** @type {?{ exportId: ?String, exportIdPromise: Promise.<String>, dialog: Dialogic, input: HTMLInputElement, edited: Boolean, sending: Boolean, done: Boolean }} otevřené okno se zprávou commitu */
	#commit = null;

	/** @type {Set.<String>} ID exportů, u kterých tato stránka zprávu commitu odeslala nebo okno zavřela */
	#handledCommitMessages = new Set();

	constructor ( /** @type {Object} */ settings, /** @type {HTMLAnchorElement} */ item )
	{
		this.#settings = settings;
		this.#item = item;
		item.addEventListener( 'click', ( event ) => this.#onClick( event ) );
		this.#setRunning( Boolean( settings.running ) );
		if ( this.#running ) {
			this.#schedule( FIRST_POLL_DELAY );
		}
	}

	#onClick ( /** @type {MouseEvent} */ event )
	{
		if ( this.#starting ) {
			event.preventDefault(); // druhé kliknutí, než odpoví spuštění
			return;
		}
		if ( this.#running || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ) {
			return; // běžící export: odkaz na protokol; s klávesou (nová karta, okno) jako bez JavaScriptu
		}
		event.preventDefault();
		this.#start();
	}

	#start ()
	{
		const s = this.#settings;
		this.#starting = true;
		this.#item.textContent = s.texts.starting;
		const request = this.#post( s.urls.start, { [ s.nonceName ]: s.nonces.start } ).then( ( { ok, data } ) =>
		{
			if ( !ok ) {
				throw Object.assign( new Error( data?.message || s.texts.requestFailed ), { running: data?.running === true } );
			}
			return data;
		} );
		const state = this.#showCommitDialog( request.then( ( data ) => String( data.exportId ) ), s.commitMessage.value ); // okno hned, export se spouští souběžně
		request.then( ( data ) =>
		{
			state.exportId = String( data.exportId );
			if ( !state.edited && !state.done ) { // zpráva s časem spuštění exportu (předvyplněná pochází z načtení stránky)
				const input = state.input;
				const selected = input.selectionStart === 0 && input.selectionEnd === input.value.length;
				input.value = String( data.commitMessage );
				if ( selected && document.activeElement === input ) {
					input.select();
				}
			}
			this.#item.textContent = data.label;
			this.#setRunning( true );
			this.#schedule( s.interval );
		} ).catch( ( error ) =>
		{
			this.#closeCommitDialog( state );
			if ( error?.running ) { // export už běží (spuštěný v jiné kartě) – jen sledovat stav
				this.#setRunning( true );
				this.#schedule( FIRST_POLL_DELAY );
				return;
			}
			this.#item.textContent = s.texts.idle;
			this.#dialogic( s.texts.startFailed, { body: error?.message || s.texts.requestFailed, requireInteraction: true } );
		} ).finally( () =>
		{
			this.#starting = false;
		} );
	}

	#schedule ( /** @type {Number} */ delay )
	{
		clearTimeout( this.#timer );
		this.#timer = setTimeout( () => this.#poll(), delay );
	}

	#poll ()
	{
		const s = this.#settings;
		fetch( s.urls.status, { credentials: 'same-origin', cache: 'no-store' } )
			.then( ( response ) => response.ok ? response.json() : Promise.reject( response.status ) )
			.then( ( status ) =>
			{
				this.#item.textContent = status.running ? status.label : ( status.result || status.label );
				const question = status.running ? status.question : null;
				if ( !question ) {
					this.#closeQuestion();
				} else if ( question.id !== this.#question?.id && !this.#handledQuestions.has( question.id ) ) {
					this.#showQuestion( question );
				}
				this.#applyCommitMessage( status.running ? status.commitMessage : null, status );
				this.#setRunning( Boolean( status.running ) );
				if ( status.running ) {
					this.#schedule( status.interval || s.interval );
				} else if ( status.result ) {
					const resultItem = document.querySelector( s.resultSelector ); // položka podmenu s výsledkem minulého exportu
					if ( resultItem ) {
						resultItem.textContent = status.result;
					}
				}
			} )
			.catch( () => this.#schedule( s.interval * 3 ) );
	}

	#setRunning ( /** @type {Boolean} */ running )
	{
		const s = this.#settings;
		this.#running = running;
		this.#item.closest( 'li' )?.classList.toggle( s.classes.running, running ); // podle třídy styl ukazuje „Zrušit export“ (\FUNCTIONS\STATIC_EXPORT\adminBarStyles())
		this.#item.href = running ? s.urls.log : s.urls.startLink;
	}

	/* ---------- okno se zprávou commitu ---------- */

	/** @returns {{ exportId: ?String, exportIdPromise: Promise.<String>, dialog: Dialogic, input: HTMLInputElement, edited: Boolean, sending: Boolean, done: Boolean }} */
	#showCommitDialog ( /** @type {Promise.<String>} */ exportIdPromise, /** @type {String} */ value, /** @type {?String} */ exportId = null )
	{
		const s = this.#settings;
		this.#closeCommitDialog();
		exportIdPromise.catch( () => {} ); // chybu spuštění řeší #start()

		const form = this.#create( 'form' );
		const input = this.#create( 'input' );
		input.type = 'text';
		input.id = s.classes.commitMessage + '-input';
		input.name = s.fields.message;
		input.value = value;
		input.maxLength = s.commitMessage.maxLength;
		input.autocomplete = 'off';
		const label = this.#create( 'label', s.texts.commitLabel );
		label.htmlFor = input.id;
		const field = this.#create( 'p' );
		field.append( label, input );
		const hint = this.#create( 'p', s.texts.commitHint );
		hint.className = s.classes.hint;
		const buttons = this.#create( 'p' );
		buttons.className = s.classes.buttons;
		buttons.append( this.#button( s.texts.commitSubmit, ACTIONS.USE, true ), this.#button( s.texts.commitKeep, ACTIONS.KEEP ) );
		const message = this.#create( 'p' );
		message.setAttribute( 'role', 'status' );
		form.append( field, hint, buttons, message );

		const dialog = this.#openDialog( s.texts.commitTitle, s.classes.commitMessage, form, true ); // bez zvuku – uživatel právě klikl
		const state = { exportId, exportIdPromise, dialog, input, edited: false, sending: false, done: false };
		input.addEventListener( 'input', () =>
		{
			state.edited = true;
		} );
		form.addEventListener( 'submit', ( event ) =>
		{
			event.preventDefault();
			if ( state.sending ) {
				return;
			}
			const keep = event.submitter instanceof HTMLButtonElement && event.submitter.value === ACTIONS.KEEP;
			state.sending = true;
			this.#setDisabled( form, true );
			message.textContent = s.texts.sending;
			this.#sendCommitMessage( state, keep ? null : input.value )
				.then( ( { ok, data } ) =>
				{
					if ( ok ) {
						this.#closeCommitDialog( state );
						return;
					}
					message.textContent = data?.message || s.texts.failed;
				} )
				.catch( () =>
				{
					message.textContent = s.texts.failed;
				} )
				.finally( () =>
				{
					state.sending = false;
					if ( !state.done ) {
						this.#setDisabled( form, false );
					}
					if ( this.#running ) {
						this.#schedule( POLL_AFTER_ANSWER );
					}
				} );
		} );
		this.#onClosed( dialog, () =>
		{
			if ( this.#commit === state ) {
				this.#commit = null;
			}
			if ( !state.done ) { // zavřené křížkem nebo kliknutím vedle okna → zpráva z nastavení, export na ni nemusí čekat
				state.done = true;
				this.#sendCommitMessage( state, null ).catch( () => {} );
			}
		} );
		this.#commit = state;
		input.focus( { preventScroll: true } ); // stejný důvod jako obnovení posunu v #dialogic()
		input.select(); // psaní zprávu přepíše, End / šipka ji doplní
		return state;
	}

	#sendCommitMessage ( state, /** @type {?String} */ text )
	{
		const s = this.#settings;
		return state.exportIdPromise.then( ( exportId ) =>
		{
			this.#handledCommitMessages.add( exportId ); // okno pro tento export se znovu neotevře
			return this.#post( s.urls.commitMessage, {
				[ s.nonceName ]: s.nonces.commitMessage,
				[ s.fields.exportId ]: exportId,
				[ s.fields.message ]: text,
				[ s.fields.useDefault ]: text === null ? '1' : null,
			} );
		} );
	}

	#applyCommitMessage ( /** @type {?{ exportId: String, value: String }} */ wanted, /** @type {Object} */ status )
	{
		const s = this.#settings;
		if ( wanted ) {
			if ( !this.#handledCommitMessages.has( wanted.exportId ) && this.#commit?.exportId !== wanted.exportId ) {
				this.#showCommitDialog( Promise.resolve( wanted.exportId ), wanted.value, wanted.exportId ); // export spuštěný jinde, nebo stránka načtená během exportu
			}
		} else if ( this.#commit && this.#commit.exportId !== null && !this.#commit.sending ) {
			this.#closeCommitDialog(); // export zprávu přestal chtít: commit bez změn, vypršel čas, chyba, zrušení, odpověď z jiné stránky
			this.#dialogic( s.texts.commitNotNeeded, { body: status.running ? status.label : ( status.result || status.label ), silent: true } ); // bez requireInteraction – zavře se sám
		}
	}

	#closeCommitDialog ( state = this.#commit )
	{
		if ( state ) {
			if ( this.#commit === state ) {
				this.#commit = null;
			}
			state.done = true; // zavírá skript – nic se neodesílá
			this.#closeDialog( state.dialog );
		}
	}

	/* ---------- okno s dotazem ssh při pushi ---------- */

	#showQuestion ( /** @type {{ id: String, type: String, title: String, prompt: String }} */ question )
	{
		const s = this.#settings;
		this.#closeQuestion();
		const isNotice = question.type === s.types.notice;
		const isSecret = question.type === s.types.secret;
		const hasInput = isSecret || question.type === s.types.text;

		const form = this.#create( 'form' );
		const prompt = this.#create( 'p' );
		prompt.append( this.#create( 'code', question.prompt ) ); // text od ssh, např. „Enter passphrase for key …“
		form.append( prompt );
		/** @type {?HTMLInputElement} */
		let input = null;
		if ( hasInput ) {
			input = this.#create( 'input' );
			input.type = isSecret ? 'password' : 'text';
			input.autocomplete = isSecret ? 'new-password' : 'off'; // new-password: prohlížeč nenabízí uložení hesla ani vyplnění uloženého
			input.required = true;
			input.name = s.fields.answer;
			input.setAttribute( 'aria-label', question.title );
			const row = this.#create( 'p' );
			row.append( input );
			form.append( row );
		}
		for ( const text of [ isNotice ? s.texts.notice : ( isSecret ? s.texts.secret : '' ), isNotice ? '' : s.texts.reopen ] ) {
			if ( text ) {
				const note = this.#create( 'p', text );
				note.className = s.classes.hint;
				form.append( note );
			}
		}
		const buttons = this.#create( 'p' );
		buttons.className = s.classes.buttons;
		if ( isNotice ) {
			buttons.append( this.#button( s.texts.hide, ACTIONS.HIDE ) );
		} else {
			const cancel = this.#button( s.texts.cancel, ACTIONS.CANCEL );
			cancel.formNoValidate = true;
			buttons.append( this.#button( hasInput ? s.texts.submit : s.texts.confirm, ACTIONS.ANSWER, true ), cancel );
		}
		const message = this.#create( 'p' );
		message.setAttribute( 'role', 'status' );
		form.append( buttons, message );

		const silent = this.#shownQuestions.has( question.id );
		this.#shownQuestions.add( question.id );
		const dialog = this.#openDialog( question.title, s.classes.question, form, silent );
		const state = { id: question.id, dialog, closedByScript: false };
		form.addEventListener( 'submit', ( event ) =>
		{
			event.preventDefault();
			const action = event.submitter instanceof HTMLButtonElement ? event.submitter.value : ACTIONS.ANSWER;
			if ( action === ACTIONS.HIDE ) {
				this.#handledQuestions.add( question.id );
				this.#closeQuestion();
				return;
			}
			const fields = { [ s.nonceName ]: s.nonces.answer, [ s.fields.question ]: question.id };
			if ( action === ACTIONS.CANCEL ) {
				fields[ s.fields.cancel ] = '1';
			} else if ( input ) {
				fields[ s.fields.answer ] = input.value;
			}
			if ( input ) {
				input.value = '';
			}
			this.#setDisabled( form, true );
			message.textContent = s.texts.sending;
			this.#post( s.urls.answer, fields )
				.then( ( { ok, data } ) =>
				{
					if ( ok ) {
						this.#handledQuestions.add( question.id );
						this.#closeQuestion();
						return;
					}
					message.textContent = data?.message || s.texts.failed;
					this.#setDisabled( form, false );
				} )
				.catch( () =>
				{
					message.textContent = s.texts.failed;
					this.#setDisabled( form, false );
				} )
				.finally( () => this.#schedule( POLL_AFTER_ANSWER ) );
		} );
		this.#onClosed( dialog, () =>
		{
			if ( this.#question === state ) {
				this.#question = null;
			}
			if ( isNotice && !state.closedByScript ) {
				this.#handledQuestions.add( question.id ); // oznámení zavřené křížkem se znovu neotevře; otázka ano – při další kontrole stavu, bez zvuku
			}
		} );
		this.#question = state;
		input?.focus( { preventScroll: true } ); // viz #showCommitDialog()
	}

	#closeQuestion ()
	{
		const state = this.#question;
		if ( state ) {
			this.#question = null;
			state.closedByScript = true;
			this.#closeDialog( state.dialog );
		}
	}

	/* ---------- pomocné ---------- */

	/**
	* Okno Dialogic, které zůstane otevřené až do odpovědi. Obsah se vloží do prvku popisu okna (aria-describedby) přes DOM,
	* ne jako htmlBody (HTML řetězec). Vzhled: výchozí styly knihovny + css/dialogic-theme.css (nastavení oken
	* \FUNCTIONS\DIALOGIC\getSettings()).
	* @returns {Dialogic}
	*/
	#openDialog ( /** @type {String} */ title, /** @type {String} */ className, /** @type {Node} */ content, /** @type {Boolean} */ silent = false )
	{
		const dialog = this.#dialogic( title, { requireInteraction: true, silent } );
		dialog.classList.add( className );
		const description = document.getElementById( dialog.getAttribute( 'aria-describedby' ) ?? '' );
		( description ?? dialog ).append( content );
		return dialog;
	}

	/**
	* new Dialogic() s nastavením oken šablony (třetí parametr). vibrate: 0 – Dialogic 0.2.0 jinak volá navigator.vibrate( [] )
	* i bez vibrací a Chrome u okna otevřeného bez kliknutí (dotaz ssh, kontrola stavu) hlásí v konzoli chybu „Blocked call
	* to navigator.vibrate“.
	* Posun stránky se obnoví: první okno na stránce ještě nemá styly knihovny (Dialogic je přidá do <head> až teď), je
	* tedy na konci stránky (position: absolute) a nativní show() ho zaměří – prohlížeč by stránku posunul na konec.
	* Obnovení proběhne dřív, než se cokoli vykreslí, a styly jsou použité už v prvním snímku (ověřeno).
	* @returns {Dialogic}
	*/
	#dialogic ( /** @type {String} */ title, /** @type {Object} */ options )
	{
		const { scrollX, scrollY } = window;
		const dialog = new Dialogic( title, { vibrate: 0, ...options }, this.#settings.dialogicSettingsId );
		if ( window.scrollX !== scrollX || window.scrollY !== scrollY ) {
			window.scrollTo( scrollX, scrollY );
		}
		return dialog;
	}

	#closeDialog ( /** @type {Dialogic} */ dialog )
	{
		if ( dialog.open ) {
			dialog.close(); // Dialogic: událost close, okno se odebere ze stránky
		} else if ( dialog.isConnected ) {
			Dialogic.removeDialogFromList( dialog );
			dialog.remove();
		}
	}

	#onClosed ( /** @type {Dialogic} */ dialog, /** @type {Function} */ callback ) // Dialogic.close() vyvolá událost close sám a pak ještě prohlížeč – callback jen jednou
	{
		let called = false;
		dialog.addEventListener( 'close', () =>
		{
			if ( !called ) {
				called = true;
				callback();
			}
		} );
	}

	/** @returns {Promise.<{ ok: Boolean, data: any }>} odpověď wp_send_json_success() / wp_send_json_error() */
	#post ( /** @type {String} */ url, /** @type {Object.<string, ?String>} */ fields )
	{
		const data = new FormData();
		for ( const [ name, value ] of Object.entries( fields ) ) {
			if ( value !== null && value !== undefined ) {
				data.append( name, String( value ) );
			}
		}
		return fetch( url, { method: 'POST', body: data, credentials: 'same-origin', cache: 'no-store' } )
			.then( ( response ) => response.json().catch( () => ( {} ) ).then( ( result ) => ( { ok: response.ok && result?.success === true, data: result?.data ?? null } ) ) );
	}

	#create ( /** @type {String} */ name, /** @type {String} */ text = '' )
	{
		const element = document.createElement( name );
		if ( text ) {
			element.textContent = text;
		}
		return element;
	}

	#button ( /** @type {String} */ text, /** @type {String} */ value, /** @type {Boolean} */ primary = false )
	{
		const s = this.#settings;
		const button = this.#create( 'button', text );
		button.type = 'submit';
		button.value = value;
		button.className = primary ? s.classes.button + ' ' + s.classes.buttonPrimary : s.classes.button;
		return button;
	}

	#setDisabled ( /** @type {HTMLFormElement} */ form, /** @type {Boolean} */ disabled )
	{
		form.querySelectorAll( 'button, input' ).forEach( ( element ) =>
		{
			element.disabled = disabled;
		} );
	}

}

/** @type {HTMLElement|null} */
const settingsElement = document.getElementById( SETTINGS_ELEMENT_ID );

/** @type {Object|null} */
const settings = settingsElement ? JSON.parse( settingsElement.textContent ?? '' ) : null;

/** @type {Element|null} */
const item = settings ? document.querySelector( settings.selector ) : null;

if ( settings && item instanceof HTMLAnchorElement ) {
	Promise.all( DIALOGIC_MODULES.map( importVerified ) )
		.then( ( modules ) =>
		{
			Dialogic = modules[ 1 ].Dialogic;
			new StaticExportButton( settings, item );
		} )
		.catch( ( error ) => console.error( 'Tlačítko statického exportu funguje bez oken (jako bez JavaScriptu):', error ) );
}
