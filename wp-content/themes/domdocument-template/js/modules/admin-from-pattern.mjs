/*
	[2026-11-26] Meta box „Ze Vzoru“ v blokovém editoru (\FUNCTIONS\ADMIN\fromPatternMetaBoxCallback() ve functions.php,
	README „Ze Vzoru“). Výběr se vzory vypisuje PHP, tento modul:
	- doplní do výběru vzory, které zná jen editor (adresář vzorů WordPress.org jádro načítá jen v REST API) a uloženému
	  vzoru, který PHP nezná, doplní jeho název,
	- u obsahu, který byl při otevření editoru prázdný a nemá uložený vzor, vybere vzor, kterým autor začal: okno
	  „Vyberte vzor“, vložení z panelu bloků i přetažením. Editor si název vzoru u bloků pamatuje jen u vzoru s jediným
	  blokem nejvyšší úrovně (metadata.patternName), proto se nově přidané bloky porovnávají se serializovanými bloky vzorů.
	  Když bloky vzoru z obsahu zase zmizí (Zpět, smazání), výběr se vyprázdní a hledá se dál.
	Hodnota se uloží s formulářem meta boxů při uložení příspěvku. Jakmile autor výběr změní sám, modul už ho nemění.
	Modul nic neimportuje, používá globální wp.data a wp.blocks editoru (klasické skripty jádra).
*/

const SELECT_ID = 'varsMetaFromPattern'; // \VARS\META::FROM_PATTERN
const EDITOR_GROUP_ATTRIBUTE = 'data-editor-patterns-label'; // \VARS\FROM_PATTERN::EDITOR_GROUP_ATTRIBUTE
const UNKNOWN_ATTRIBUTE = 'data-unknown-pattern'; // \VARS\FROM_PATTERN::UNKNOWN_ATTRIBUTE
const BLOCK_EDITOR_STORE = 'core/block-editor';
const EDITOR_STORE = 'core/editor';
const USER_PATTERN_BLOCK = 'core/block'; // synchronizovaný vlastní vzor se vkládá jako tento blok s atributem ref = ID vzoru
const USER_PATTERN_PREFIX = USER_PATTERN_BLOCK + '/'; // \WP\BLOCK_PATTERN::USER_NAME_PREFIX
const POST_CONTENT_BLOCK = 'core/post-content';
const POST_ONLY_MODE = 'post-only';
const CHECK_DELAY = 150; // ms: změny obsahu se zpracují nejvýš jednou za tuto dobu (subscribe() volá při každé změně ve stores)

const select = document.getElementById( SELECT_ID );
const wp = window.wp;

if ( select instanceof HTMLSelectElement && wp?.data && wp?.blocks && window._wpLoadBlockEditor ) {
	window._wpLoadBlockEditor.then( () => watch( wp.data, wp.blocks, select ) ); // promise z wp-admin/edit-form-blocks.php: editor je inicializovaný
}

function watch( data, blocksApi, select )
{
	const blockEditor = () => data.select( BLOCK_EDITOR_STORE );
	const editor = () => data.select( EDITOR_STORE );
	const signatures = new WeakMap(); // vzor → bloky nejvyšší úrovně serializované po jednom
	const names = new WeakMap(); // vzor → názvy bloků nejvyšší úrovně
	let manual = false;
	let detecting = null; // null = editor se ještě načítá, pak true / false
	let knownIds = new Set();
	let lastOrder = null;
	let lastPatterns = null;
	let detected = null; // { name, clientIds } vzoru, který je teď ve výběru
	let timer = 0;

	select.addEventListener( 'change', () => {
		manual = true; // změnil ho autor (programová změna value událost change nevyvolá)
	} );

	data.subscribe( () => {
		if ( !timer ) {
			timer = window.setTimeout( check, CHECK_DELAY );
		}
	} );

	function check()
	{
		timer = 0;
		if ( !editor().__unstableIsEditorReady() ) {
			return;
		}
		syncEditorPatterns();
		if ( detecting === null ) {
			detecting = select.value === '' && editor().isEditedPostEmpty();
			lastOrder = rootOrder();
			knownIds = new Set( lastOrder );
			return;
		}
		if ( detecting && !manual ) {
			detect();
		}
	}

	function patterns() // vzory, které editor nabízí (vlastní vzory jako core/block/ID)
	{
		return blockEditor().__experimentalGetAllowedPatterns() ?? [];
	}

	function rootOrder() // bloky nejvyšší úrovně obsahu (u šablony s blokem Obsah příspěvku bloky uvnitř něj, jako useStartPatterns() v editoru)
	{
		const rootClientId = editor().getRenderingMode?.() === POST_ONLY_MODE || !editor().getRenderingMode
			? ''
			: blockEditor().getBlocksByName( POST_CONTENT_BLOCK )?.[0] ?? '';
		return blockEditor().getBlockOrder( rootClientId );
	}

	function detect()
	{
		const order = rootOrder();
		if ( order === lastOrder ) {
			return;
		}
		lastOrder = order;
		if ( detected ) {
			if ( detected.clientIds.some( ( clientId ) => order.includes( clientId ) ) ) {
				remember( order );
				return;
			}
			detected.clientIds.forEach( ( clientId ) => knownIds.delete( clientId ) ); // po „Znovu“ se stejné bloky najdou znovu
			detected = null;
			select.value = '';
		}
		for ( const run of newRuns( order ) ) {
			detected = findPattern( run );
			if ( detected ) {
				choose( detected.name );
				break;
			}
		}
		remember( order );
	}

	function remember( order )
	{
		order.forEach( ( clientId ) => knownIds.add( clientId ) );
	}

	function newRuns( order ) // souvislé řady bloků, které při minulé kontrole v obsahu nebyly
	{
		const runs = [];
		let run = [];
		for ( const clientId of order ) {
			if ( knownIds.has( clientId ) ) {
				if ( run.length ) {
					runs.push( run );
					run = [];
				}
			} else {
				run.push( clientId );
			}
		}
		if ( run.length ) {
			runs.push( run );
		}
		return runs;
	}

	function findPattern( clientIds ) // { name, clientIds } vzoru, ze kterého řada bloků je, nebo null
	{
		const blocks = clientIds.map( ( clientId ) => blockEditor().getBlock( clientId ) );
		for ( const [ index, block ] of blocks.entries() ) {
			if ( block?.name === USER_PATTERN_BLOCK && block.attributes?.ref ) {
				return { name: USER_PATTERN_PREFIX + block.attributes.ref, clientIds: [ clientIds[ index ] ] };
			}
			if ( block?.attributes?.metadata?.patternName ) { // vzor s jediným blokem nejvyšší úrovně
				return { name: block.attributes.metadata.patternName, clientIds: [ clientIds[ index ] ] };
			}
		}
		// kandidáti podle názvů bloků (levné), celé bloky se porovnají jen u nich
		const runNames = blocks.map( ( block ) => block?.name );
		const candidates = [];
		for ( const pattern of patterns() ) {
			const names = namesOf( pattern );
			for ( let start = 0; names.length && start + names.length <= runNames.length; start++ ) {
				if ( names.every( ( name, offset ) => name === runNames[ start + offset ] ) ) {
					candidates.push( { pattern, start, length: names.length } );
				}
			}
		}
		candidates.sort( ( a, b ) => b.length - a.length ); // delší vzor dřív (kratší může být jeho začátkem)
		let serialized = null;
		for ( const { pattern, start, length } of candidates ) {
			serialized ??= blocks.map( ( block ) => block ? blocksApi.serialize( block ) : '' );
			const signature = signatureOf( pattern );
			if ( signature.length === length && signature.every( ( part, offset ) => part === serialized[ start + offset ] ) ) {
				return { name: pattern.name, clientIds: clientIds.slice( start, start + length ) };
			}
		}
		return null;
	}

	function namesOf( pattern ) // názvy bloků nejvyšší úrovně vzoru; z obsahu bez ověřování bloků (wp.blocks.parse() u vadného vzoru z adresáře WordPress.org píše do konzole chyby)
	{
		if ( !names.has( pattern ) ) {
			let list;
			try {
				list = window.wp.blockSerializationDefaultParser
					? window.wp.blockSerializationDefaultParser.parse( pattern.content ?? '' )
						.filter( ( block ) => block.blockName !== null || block.innerHTML.trim() !== '' ) // prázdné místo mezi bloky
						.map( ( block ) => block.blockName ?? blocksApi.getFreeformContentHandlerName() )
					: ( pattern.blocks ?? [] ).map( ( block ) => block.name );
			} catch {
				list = [];
			}
			names.set( pattern, list );
		}
		return names.get( pattern );
	}

	function signatureOf( pattern )
	{
		if ( !signatures.has( pattern ) ) {
			let signature = [];
			try {
				signature = ( pattern.blocks ?? [] ).map( ( block ) => blocksApi.serialize( block ) ); // pattern.blocks rozparsuje editor až při prvním čtení
			} catch {
				signature = [];
			}
			signatures.set( pattern, signature );
		}
		return signatures.get( pattern );
	}

	function choose( name )
	{
		const hasOption = () => [ ...select.options ].some( ( option ) => option.value === name );
		if ( !hasOption() ) {
			syncEditorPatterns( true );
		}
		if ( !hasOption() ) { // vzor, který editor nenabízí (metadata.patternName u zkopírovaného bloku…): aspoň pod názvem
			const option = document.createElement( 'option' );
			option.value = name;
			option.textContent = name;
			editorGroup().append( option );
		}
		select.value = name;
	}

	function editorGroup() // skupina „Další vzory v editoru“, vytvoří se při prvním použití
	{
		const label = select.getAttribute( EDITOR_GROUP_ATTRIBUTE ) ?? '';
		let group = [ ...select.querySelectorAll( 'optgroup' ) ].find( ( optgroup ) => optgroup.label === label );
		if ( !group ) {
			group = document.createElement( 'optgroup' );
			group.label = label;
			select.append( group );
		}
		return group;
	}

	function syncEditorPatterns( force = false ) // vzory z editoru, které ve výběru chybí, a názvy neznámých uložených vzorů
	{
		const editorPatterns = patterns();
		if ( !editorPatterns.length || ( editorPatterns === lastPatterns && !force ) ) {
			return;
		}
		lastPatterns = editorPatterns;
		const values = new Set( [ ...select.options ].map( ( option ) => option.value ) );
		for ( const pattern of editorPatterns ) {
			const title = pattern.title || pattern.name;
			if ( values.has( pattern.name ) ) {
				const unknown = [ ...select.options ].find( ( option ) => option.value === pattern.name && option.hasAttribute( UNKNOWN_ATTRIBUTE ) );
				if ( unknown ) {
					unknown.textContent = title;
					unknown.removeAttribute( UNKNOWN_ATTRIBUTE );
				}
				continue;
			}
			const option = document.createElement( 'option' );
			option.value = pattern.name;
			option.textContent = title;
			editorGroup().append( option );
			values.add( pattern.name );
		}
	}
}
