/**
* [2026-11-27] Nastavení zóny Cloudflare z WordPressu – nástroj „Nastavení Cloudflare“ (Nástroje → Nastavení Cloudflare,
* šablona domdocument-template: admin-tools/nastaveni-cloudflare.php, js/modules/admin-tool-cloudflare-settings.mjs).
* Trasa /api/zone-settings je functions/api/zone-settings.js, logika je tady (kvůli testům v .site-checks/zone-settings.test.mjs).
*
*   GET   stav vybraných voleb (SETTINGS) ve všech zónách vlastních domén projektu Pages,
*   POST  jedna změna. CO změnit, říká jen token WordPressu – údaj change = { zone, setting, value }; tělo požadavku se
*         nečte. WordPress token vydá jen administrátorovi a jen pro volbu a hodnotu ze svého seznamu, tady se obojí ověří
*         znovu (SETTINGS) a zóna musí patřit vlastní doméně projektu (stejně jako u /api/dashboard/traffic).
*
* Proč přes Pages Function: WordPress (PHP) během požadavku nic nestahuje a API Cloudflare z prohlížeče volat nejde (nemá
* CORS, token by byl ve stránce). Tajný API token s právem zápisu zná jen Cloudflare – tajná proměnná API_TOKEN_SECRET,
* záměrně jiná než DASHBOARD_API_TOKEN (ten smí jen číst). Bez ní nástroj nic neukáže ani nezmění. Oprávnění tokenu:
* functions/README.md, „Nastavení zóny z WordPressu“.
*
* Token WordPressu: stejný klíč, tvar a ověření jako u /api/dashboard (functions/_lib/dashboard.js), jen scope = TOKEN_SCOPE
* (token pro nástěnku tu neplatí a naopak). Token pro změnu má navíc change a jti (id záznamu v historii změn ve WordPressu)
* a platí nejvýš CHANGE_TOKEN_MAX_TTL (WordPress dává 2 minuty). Během platnosti by šel poslat znovu – provede jen tutéž
* změnu, kterou administrátor potvrdil.
*
* Pingbacky Cloudflare jako volbu nemá. Nástroj je filtruje vlastními pravidly WAF (CUSTOM_RULES) ve fázi
* http_request_firewall_custom zóny: pravidlo pozná podle ref, při prvním zapnutí ho založí, pak ho jen zapíná a vypíná
* (vypnuté zůstane v zóně, jde ho upravit i v administraci Cloudflare – úpravu výrazu nástroj nepřepíše). Bezplatný tarif
* má 5 vlastních pravidel na zónu, každé z nich jedno zabere.
*
* Úroveň zabezpečení (security_level): Cloudflare od března 2025 hodnoty low / medium / high nepoužívá (skóre hrozby je vždy
* 0), volba slouží už jen k zapnutí režimu „Pod útokem“ (under_attack). Vypnutí = jiná hodnota; off je jen pro Enterprise,
* proto ji SETTINGS nepovolují. Kterou hodnotu vrátit, posílá WordPress (podle historie změn, jinak medium).
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/functions/), export ho kopíruje do repozitáře
* statického webu – upravovat ho ve šabloně.
*/

import {
	ERRORS,
	HttpError,
	SectionError,
	cloudflareApi,
	isoTime,
	json,
	section,
	shortText,
	stringOf,
	verifySignedToken,
	wordpressClaims,
} from './dashboard.js';
import { zoneSummary, zonesFromDomains } from './dashboard-traffic.js';

/** @type {String} \VARS\CLOUDFLARE_SETTINGS::TOKEN_SCOPE */
export const TOKEN_SCOPE = 'ddt-zone-settings';

/** @type {Number} s – nejdelší platnost tokenu pro změnu (WordPress dává \VARS\CLOUDFLARE_SETTINGS::CHANGE_TOKEN_TTL) */
export const CHANGE_TOKEN_MAX_TTL = 300;

/** @type {String} \VARS\CLOUDFLARE_SETTINGS::API_TOKEN_SECRET – tajná proměnná projektu Pages */
export const API_TOKEN_SECRET = 'ZONE_SETTINGS_API_TOKEN';

/** @type {String} fáze vlastních pravidel WAF zóny */
export const CUSTOM_RULES_PHASE = 'http_request_firewall_custom';

/** @type {String} */
export const ON = 'on';

/** @type {String} */
export const OFF = 'off';

/** @type {String[]} */
const ON_OFF = Object.freeze( [ ON, OFF ] );

/** @type {Object<String, String>} kódy chyb navíc k ERRORS z dashboard.js (texty: \FUNCTIONS\CLOUDFLARE_SETTINGS\getTexts()) */
export const ZONE_ERRORS = Object.freeze( {
	TOKEN_MISSING: 'zone-token-missing', // chybí tajná proměnná API_TOKEN_SECRET
	NO_CHANGE: 'no-change', // POST s tokenem bez platného údaje change
	NOT_ALLOWED: 'not-allowed', // volba nebo hodnota, kterou SETTINGS nedovolují
	FOREIGN_ZONE: 'foreign-zone', // zóna nepatří žádné vlastní doméně projektu
	UNAVAILABLE: 'unavailable', // zóna volbu nevrátila (tarif ji nemá, Cloudflare ji zrušil)
} );

/** @type {Object<String, String>} jak se volba čte a mění */
export const KINDS = Object.freeze( {
	ZONE_SETTING: 'zone-setting', // GET /zones/{zóna}/settings, PATCH /zones/{zóna}/settings/{id} { value } – oprávnění Zone Settings
	BOT_MANAGEMENT: 'bot-management', // GET a PUT /zones/{zóna}/bot_management – oprávnění Bot Management
	CUSTOM_RULE: 'custom-rule', // vlastní pravidlo WAF (CUSTOM_RULES) – oprávnění Zone WAF
	PURGE: 'purge', // POST /zones/{zóna}/purge_cache { purge_everything } – oprávnění Cache Purge
} );

/**
* Pravidla WAF, která nástroj spravuje (klíč = volba v SETTINGS). Výrazy v jazyce pravidel Cloudflare, funkce dostupné
* na všech tarifech (contains).
*
* @type {Object<String, Object>}
*/
export const CUSTOM_RULES = Object.freeze( {
	// Pingback DDoS: útočník pošle tisícům webů s WordPressem pingback s adresou oběti a každý z nich pak adresu stáhne,
	// aby odkaz ověřil – s hlavičkou User-Agent „WordPress/…; …; verifying pingback from <IP>“ (wp-includes/class-wp-xmlrpc-server.php).
	block_pingback_verification: Object.freeze( {
		ref: 'ddt-block-pingback-verification',
		description: 'DDT: blokovat ověřování pingbacků (pingback DDoS) – Nástroje → Nastavení Cloudflare ve WordPressu',
		expression: '(http.user_agent contains "verifying pingback from")',
		action: 'block',
	} ),
	// Příjem pingbacků (XML-RPC pingback.ping) a trackbacků; xmlrpc.php je i cíl hádání hesel (system.multicall).
	block_xmlrpc: Object.freeze( {
		ref: 'ddt-block-xmlrpc',
		description: 'DDT: blokovat xmlrpc.php a wp-trackback.php (příjem pingbacků a trackbacků) – Nástroje → Nastavení Cloudflare ve WordPressu',
		expression: '(http.request.uri.path contains "/xmlrpc.php") or (http.request.uri.path contains "/wp-trackback.php")',
		action: 'block',
	} ),
} );

/**
* Volby, které nástroj čte a mění: id → { kind, values (povolené hodnoty změny – prázdné = jen ke čtení), field (bot
* management), number (hodnota je v API číslo), boolean (v API true / false, tady on / off) }. Stejný seznam s popisky má
* WordPress (\FUNCTIONS\CLOUDFLARE_SETTINGS\getDefinitions()) – při změně upravit oba. Hodnoty podle API Cloudflare
* (Zone settings, Bot Management), ověřeno 27. 11. 2026.
*
* @type {Object<String, Object>}
*/
export const SETTINGS = Object.freeze( {
	security_level: Object.freeze( { kind: KINDS.ZONE_SETTING, values: Object.freeze( [ 'essentially_off', 'low', 'medium', 'high', 'under_attack' ] ) } ),
	browser_check: Object.freeze( { kind: KINDS.ZONE_SETTING, values: ON_OFF } ),
	challenge_ttl: Object.freeze( { kind: KINDS.ZONE_SETTING, values: Object.freeze( [ '300', '900', '1800', '2700', '3600', '7200', '10800', '14400', '28800', '57600', '86400', '604800', '2592000', '31536000' ] ), number: true } ),
	bot_fight_mode: Object.freeze( { kind: KINDS.BOT_MANAGEMENT, field: 'fight_mode', values: ON_OFF, boolean: true } ),
	ai_bots_protection: Object.freeze( { kind: KINDS.BOT_MANAGEMENT, field: 'ai_bots_protection', values: Object.freeze( [ 'block', 'disabled', 'only_on_ad_pages' ] ) } ),
	crawler_protection: Object.freeze( { kind: KINDS.BOT_MANAGEMENT, field: 'crawler_protection', values: Object.freeze( [ 'enabled', 'disabled' ] ) } ),
	block_pingback_verification: Object.freeze( { kind: KINDS.CUSTOM_RULE, values: ON_OFF } ),
	block_xmlrpc: Object.freeze( { kind: KINDS.CUSTOM_RULE, values: ON_OFF } ),
	development_mode: Object.freeze( { kind: KINDS.ZONE_SETTING, values: ON_OFF } ),
	always_online: Object.freeze( { kind: KINDS.ZONE_SETTING, values: ON_OFF } ),
	purge_cache: Object.freeze( { kind: KINDS.PURGE, values: Object.freeze( [ 'everything' ] ) } ),
	ssl: Object.freeze( { kind: KINDS.ZONE_SETTING, values: Object.freeze( [] ) } ), // jen ke čtení – špatná hodnota web shodí (chyba 525 / 526, nekonečné přesměrování)
	always_use_https: Object.freeze( { kind: KINDS.ZONE_SETTING, values: ON_OFF } ),
	automatic_https_rewrites: Object.freeze( { kind: KINDS.ZONE_SETTING, values: ON_OFF } ),
	min_tls_version: Object.freeze( { kind: KINDS.ZONE_SETTING, values: Object.freeze( [ '1.0', '1.1', '1.2', '1.3' ] ) } ),
	email_obfuscation: Object.freeze( { kind: KINDS.ZONE_SETTING, values: ON_OFF } ),
	rocket_loader: Object.freeze( { kind: KINDS.ZONE_SETTING, values: ON_OFF } ),
	hotlink_protection: Object.freeze( { kind: KINDS.ZONE_SETTING, values: ON_OFF } ),
} );

/** @type {String[]} pole nastavení bot managementu na bezplatném tarifu (Bot Fight Mode), která se při změně pošlou se stávající hodnotou */
export const BOT_MANAGEMENT_FIELDS = Object.freeze( [ 'fight_mode', 'enable_js', 'ai_bots_protection', 'crawler_protection', 'is_robots_txt_managed', 'cf_robots_variant' ] );

/** @type {RegExp} ID zóny */
const ZONE_PATTERN = /^[0-9a-f]{32}$/;

/** @type {RegExp} id záznamu v historii změn ve WordPressu */
const JTI_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** @type {Function} */
const now = function ()
{
	return Math.floor( Date.now() / 1000 );
};

/** @returns {Boolean} */
const hasSetting = ( /** @type {String} */ id ) => Object.hasOwn( SETTINGS, id );

/** @returns {Object} volby fetch() pro požadavek s tělem JSON */
const jsonRequest = function ( /** @type {String} */ method, /** @type {Object} */ body )
{
	return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( body ) };
};

/** @returns {String} hodnota z API → hodnota nástroje (on / off, číslo jako text) */
export const valueOf = function ( /** @type {Object} */ definition, /** @type {*} */ raw )
{
	if ( definition.boolean ) {
		return raw === true ? ON : OFF;
	}
	return typeof raw === 'string' || typeof raw === 'number' ? String( raw ) : '';
};

/** @returns {*} hodnota nástroje → hodnota pro API */
export const apiValueOf = function ( /** @type {Object} */ definition, /** @type {String} */ value )
{
	if ( definition.boolean ) {
		return value === ON;
	}
	return definition.number ? Number( value ) : value;
};

/** @returns {Object} volba zóny z REST /zones/{zóna}/settings → stav pro nástroj */
const settingState = function ( /** @type {Object} */ definition, /** @type {*} */ item )
{
	return {
		value: valueOf( definition, item?.value ),
		editable: item?.editable !== false && definition.values.length > 0,
		modifiedOn: stringOf( item?.modified_on ) || null,
		timeRemaining: Number.isFinite( item?.time_remaining ) ? item.time_remaining : null, // development_mode: s do automatického vypnutí
	};
};

/** @returns {Object} { error } – zóna volbu nevrátila */
const unavailable = ( /** @type {String} */ id ) => ( { error: { code: ZONE_ERRORS.UNAVAILABLE, message: `Zóna volbu ${ id } nevrátila – tarif zóny ji nemá, nebo ji Cloudflare zrušil.` } } );

/**
* Vstupní sada pravidel fáze CUSTOM_RULES_PHASE zóny. Zóna bez vlastních pravidel ji nemá (404) – pak { id: '', rules: [] }.
*
* @returns {Promise<Object>} { id, rules }
*/
export const readCustomRules = async function ( /** @type {String} */ token, /** @type {String} */ zone )
{
	try {

		/** @type {*} */
		const ruleset = await cloudflareApi( token, `/zones/${ zone }/rulesets/phases/${ CUSTOM_RULES_PHASE }/entrypoint` );

		return { id: stringOf( ruleset?.id ), rules: Array.isArray( ruleset?.rules ) ? ruleset.rules : [] };
	} catch ( error ) {
		if ( error instanceof SectionError && error.details?.status === 404 ) {
			return { id: '', rules: [] };
		}
		throw error;
	}
};

/**
* Stav voleb jedné zóny z odpovědí API (každá část může být { error }). Vyčleněné kvůli testům.
*
* @returns {Object<String, Object>} id volby → { value, editable, modifiedOn, timeRemaining, … }, nebo { error }
*/
export const shapeValues = function ( /** @type {Object} */ parts )
{
	const { settings, bots, rules } = parts;

	/** @type {Map<String, Object>} */
	const settingsById = new Map( ( Array.isArray( settings?.items ) ? settings.items : [] ).map( ( item ) => [ stringOf( item?.id ), item ] ) );

	/** @type {Object<String, Object>} */
	const values = {};

	for ( const [ id, definition ] of Object.entries( SETTINGS ) ) {
		switch ( definition.kind ) {
			case KINDS.ZONE_SETTING:
				values[ id ] = settings.error ? { error: settings.error } : ( settingsById.has( id ) ? settingState( definition, settingsById.get( id ) ) : unavailable( id ) );
				break;
			case KINDS.BOT_MANAGEMENT:
				if ( bots.error ) {
					values[ id ] = { error: bots.error };
				} else if ( bots.config?.[ definition.field ] === undefined ) {
					values[ id ] = unavailable( id );
				} else {
					values[ id ] = { value: valueOf( definition, bots.config[ definition.field ] ), editable: true, modifiedOn: null, timeRemaining: null };
				}
				break;
			case KINDS.CUSTOM_RULE: {
				if ( rules.error ) {
					values[ id ] = { error: rules.error };
					break;
				}

				/** @type {Object|undefined} */
				const rule = rules.rules.find( ( item ) => item?.ref === CUSTOM_RULES[ id ].ref );

				values[ id ] = {
					value: rule && rule.enabled !== false ? ON : OFF,
					editable: true,
					modifiedOn: stringOf( rule?.last_updated ) || null,
					timeRemaining: null,
					exists: Boolean( rule ), // pravidlo v zóně je (zapnuté nebo vypnuté); bez něj ho zapnutí založí
					customized: Boolean( rule ) && rule.expression !== CUSTOM_RULES[ id ].expression, // výraz někdo upravil v administraci Cloudflare
				};
				break;
			}
			case KINDS.PURGE:
				values[ id ] = { value: '', editable: true, modifiedOn: null, timeRemaining: null }; // akce, ne stav
				break;
		}
	}
	return values;
};

/** @returns {Promise<Object>} zóna se stavem voleb */
const readZone = async function ( /** @type {String} */ token, /** @type {Object} */ zone )
{
	const [ details, settings, bots, rules ] = await Promise.all( [
		section( async () => zoneSummary( await cloudflareApi( token, `/zones/${ zone.id }` ) ) ),
		section( async () => ( { items: await cloudflareApi( token, `/zones/${ zone.id }/settings` ) } ) ),
		section( async () => ( { config: await cloudflareApi( token, `/zones/${ zone.id }/bot_management` ) } ) ),
		section( () => readCustomRules( token, zone.id ) ),
	] );

	return {
		id: zone.id,
		domains: zone.domains,
		...( details.error ? { name: null, status: null, paused: false, plan: null, detailsError: details.error } : details ),
		values: shapeValues( { settings, bots, rules } ),
		customRules: rules.error ? { error: rules.error } : { total: rules.rules.length }, // bezplatný tarif: 5 pravidel na zónu
	};
};

/** @returns {Promise<Object>} { zones: [{ id, domains }], external, skipped } – vlastní domény projektu Pages a jejich zóny */
const findZones = function ( /** @type {String} */ token, /** @type {Object} */ claims )
{
	return cloudflareApi( token, `/accounts/${ claims.account }/pages/projects/${ claims.project }/domains` ).then( zonesFromDomains );
};

/**
* GET: stav voleb ve všech zónách vlastních domén projektu. Žádná paměť – nástroj má ukazovat stav po poslední změně.
*
* @returns {Promise<Object>} { version, generatedAt, target, settings: { apiToken }, cloudflare: { zones: { items, external, skipped } } | { error } }
*/
export const buildZoneSettingsReport = async function ( /** @type {Object} */ env, /** @type {Object} */ claims, /** @type {Number} */ time = now() )
{

	/** @type {String} */
	const token = String( env[ API_TOKEN_SECRET ] ?? '' ).trim();

	/** @type {Object} */
	const report = {
		version: 1,
		generatedAt: isoTime( time ),
		target: { account: claims.account, project: claims.project },
		settings: { apiToken: token !== '' },
	};

	if ( token === '' ) {
		report.cloudflare = { error: { code: ZONE_ERRORS.TOKEN_MISSING, message: `Chybí tajná proměnná ${ API_TOKEN_SECRET } (API token s právem měnit nastavení zóny).` } };
		return report;
	}
	if ( claims.account === '' || claims.project === '' ) {
		report.cloudflare = { error: { code: ERRORS.NOT_CONFIGURED, message: 'WordPress nemá vyplněné ID účtu Cloudflare nebo název projektu Pages – zónu API hledá podle vlastních domén projektu.' } };
		return report;
	}

	/** @type {Object} */
	const found = await section( () => findZones( token, claims ) );

	if ( found.error ) {
		report.cloudflare = { error: found.error };
		return report;
	}
	if ( !found.zones.length ) {
		report.cloudflare = { error: { code: ERRORS.NO_ZONE, message: 'Projekt nemá vlastní doménu v zóně Cloudflare.', domains: found.external } };
		return report;
	}
	report.cloudflare = {
		zones: {
			items: await Promise.all( found.zones.map( ( zone ) => readZone( token, zone ) ) ),
			external: found.external,
			skipped: found.skipped,
		},
	};
	return report;
};

/**
* Údaj change z tokenu WordPressu: { zone, setting, value } a jti.
*
* @returns {Object} { zone, setting, value, jti }
*/
export const changeOf = function ( /** @type {Object} */ payload )
{

	/** @type {*} */
	const change = payload?.change;

	if ( !change || typeof change !== 'object' || Array.isArray( change ) || !ZONE_PATTERN.test( stringOf( change.zone ) ) || stringOf( change.setting ) === '' || typeof change.value !== 'string' ) {
		throw new HttpError( 400, ZONE_ERRORS.NO_CHANGE, 'Token WordPressu neříká, co změnit (údaj change).' );
	}
	if ( !Number.isInteger( payload.iat ) || !Number.isInteger( payload.exp ) || payload.exp - payload.iat > CHANGE_TOKEN_MAX_TTL ) {
		throw new HttpError( 401, ERRORS.INVALID_TOKEN, 'Token WordPressu pro změnu má příliš dlouhou platnost.' );
	}
	return {
		zone: change.zone,
		setting: change.setting,
		value: change.value,
		jti: JTI_PATTERN.test( stringOf( payload.jti ) ) ? payload.jti : '',
	};
};

/**
* Provede změnu jedné volby (už ověřené) a vrátí hodnotu před ní a po ní.
*
* @returns {Promise<Object>} { before, after, modifiedOn, timeRemaining, created }
*/
export const applySetting = async function ( /** @type {String} */ token, /** @type {String} */ zone, /** @type {String} */ id, /** @type {String} */ value )
{

	/** @type {Object} */
	const definition = SETTINGS[ id ];

	/** @type {Object} */
	const result = { before: '', after: '', modifiedOn: null, timeRemaining: null, created: false };

	switch ( definition.kind ) {
		case KINDS.ZONE_SETTING: {

			/** @type {String} */
			const path = `/zones/${ zone }/settings/${ id }`;

			/** @type {*} */
			const current = await cloudflareApi( token, path );

			/** @type {*} */
			const updated = await cloudflareApi( token, path, jsonRequest( 'PATCH', { value: apiValueOf( definition, value ) } ) );

			return {
				...result,
				before: valueOf( definition, current?.value ),
				after: valueOf( definition, updated?.value ),
				modifiedOn: stringOf( updated?.modified_on ) || null,
				timeRemaining: Number.isFinite( updated?.time_remaining ) ? updated.time_remaining : null,
			};
		}
		case KINDS.BOT_MANAGEMENT: {

			/** @type {String} */
			const path = `/zones/${ zone }/bot_management`;

			/** @type {*} */
			const current = await cloudflareApi( token, path );

			/** @type {Object} PUT bez polí, která tu nejsou, by je mohl vrátit na výchozí hodnotu – pošlou se stávající */
			const body = {};

			for ( const field of BOT_MANAGEMENT_FIELDS ) {
				if ( current && [ 'boolean', 'string', 'number' ].includes( typeof current[ field ] ) ) {
					body[ field ] = current[ field ];
				}
			}
			body[ definition.field ] = apiValueOf( definition, value );

			/** @type {*} */
			const updated = await cloudflareApi( token, path, jsonRequest( 'PUT', body ) );

			return {
				...result,
				before: valueOf( definition, current?.[ definition.field ] ),
				after: valueOf( definition, updated?.[ definition.field ] ?? body[ definition.field ] ),
			};
		}
		case KINDS.CUSTOM_RULE: {

			/** @type {Object} */
			const rule = CUSTOM_RULES[ id ];

			/** @type {Object} */
			const ruleset = await readCustomRules( token, zone );

			/** @type {Object|undefined} */
			const existing = ruleset.rules.find( ( item ) => item?.ref === rule.ref );

			/** @type {Boolean} */
			const enabled = value === ON;

			/** @type {String} */
			const before = existing && existing.enabled !== false ? ON : OFF;

			if ( existing ) {
				if ( before !== value ) { // úprava pravidla potřebuje celé pravidlo – výraz a akce zůstanou, jak jsou v zóně (i upravené v administraci Cloudflare)

					/** @type {Object} */
					const body = { enabled };

					for ( const field of [ 'action', 'expression', 'description', 'ref', 'action_parameters', 'logging' ] ) {
						if ( existing[ field ] !== undefined ) {
							body[ field ] = existing[ field ];
						}
					}
					await cloudflareApi( token, `/zones/${ zone }/rulesets/${ ruleset.id }/rules/${ stringOf( existing.id ) }`, jsonRequest( 'PATCH', body ) );
				}
				return { ...result, before, after: value };
			}
			if ( !enabled ) { // pravidlo neexistuje – není co vypnout
				return { ...result, before, after: OFF };
			}
			if ( ruleset.id !== '' ) {
				await cloudflareApi( token, `/zones/${ zone }/rulesets/${ ruleset.id }/rules`, jsonRequest( 'POST', { ...rule, enabled: true } ) ); // přidá se na konec, ostatní pravidla zůstanou
			} else {
				await cloudflareApi( token, `/zones/${ zone }/rulesets/phases/${ CUSTOM_RULES_PHASE }/entrypoint`, jsonRequest( 'PUT', { rules: [ { ...rule, enabled: true } ] } ) ); // zóna vlastní pravidla ještě nemá – sada vznikne s tímto jediným
			}
			return { ...result, before, after: ON, created: true };
		}
		case KINDS.PURGE:
			await cloudflareApi( token, `/zones/${ zone }/purge_cache`, jsonRequest( 'POST', { purge_everything: true } ) );
			return { ...result, after: value };
	}
	throw new HttpError( 400, ZONE_ERRORS.NOT_ALLOWED, `Volbu ${ id } nástroj neumí změnit.` );
};

/**
* POST: ověří změnu z tokenu (SETTINGS, zóna projektu) a provede ji.
*
* @returns {Promise<Object>} { version, generatedAt, change: { zone, setting, value, jti }, result: { before, after, … } }
*/
export const applyChange = async function ( /** @type {Object} */ env, /** @type {Object} */ claims, /** @type {Object} */ change, /** @type {Number} */ time = now() )
{
	if ( !hasSetting( change.setting ) || !SETTINGS[ change.setting ].values.includes( change.value ) ) {
		throw new HttpError( 400, ZONE_ERRORS.NOT_ALLOWED, `Volbu ${ shortText( change.setting ) } na hodnotu ${ shortText( change.value ) } nástroj měnit nesmí.` );
	}

	/** @type {String} */
	const token = String( env[ API_TOKEN_SECRET ] ?? '' ).trim();

	if ( token === '' ) {
		throw new HttpError( 500, ZONE_ERRORS.TOKEN_MISSING, `Chybí tajná proměnná ${ API_TOKEN_SECRET } (API token s právem měnit nastavení zóny).` );
	}
	if ( claims.account === '' || claims.project === '' ) {
		throw new HttpError( 400, ERRORS.NOT_CONFIGURED, 'WordPress nemá vyplněné ID účtu Cloudflare nebo název projektu Pages.' );
	}
	try {

		/** @type {Object} */
		const found = await findZones( token, claims );

		if ( !found.zones.some( ( zone ) => zone.id === change.zone ) ) {
			throw new HttpError( 403, ZONE_ERRORS.FOREIGN_ZONE, 'Zóna nepatří žádné vlastní doméně projektu Pages – nástroj mění jen zóny webu.' );
		}
		return {
			version: 1,
			generatedAt: isoTime( time ),
			change,
			result: await applySetting( token, change.zone, change.setting, change.value ),
		};
	} catch ( error ) {
		if ( error instanceof SectionError ) { // API Cloudflare změnu odmítlo (oprávnění tokenu, limit pravidel, tarif…)
			throw new HttpError( 502, error.code, error.message );
		}
		throw error;
	}
};

/**
* Pages Function pro /api/zone-settings (functions/api/zone-settings.js): předběžný dotaz CORS, GET (stav) a POST (změna),
* token WordPressu se scope TOKEN_SCOPE v hlavičce Authorization. CORS pro všechny – bez cookies, bez platného tokenu nic.
*
* @returns {Promise<Response>}
*/
export const handleZoneSettingsRequest = async function ( /** @type {EventContext} */ context )
{

	/** @type {Request} */
	const request = context.request;

	try {
		if ( request.method === 'OPTIONS' ) {
			return new Response( null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST',
					'Access-Control-Allow-Headers': 'Authorization',
					'Access-Control-Max-Age': '600',
				},
			} );
		}
		if ( request.method !== 'GET' && request.method !== 'POST' ) {
			throw new HttpError( 405, ERRORS.METHOD_NOT_ALLOWED, 'Metoda není povolená.', { Allow: 'GET, POST, OPTIONS' } );
		}

		/** @type {RegExpExecArray|null} */
		const match = /^Bearer\s+([A-Za-z0-9_.-]+)$/.exec( request.headers.get( 'Authorization' ) ?? '' );

		if ( !match ) {
			throw new HttpError( 401, ERRORS.UNAUTHENTICATED, 'Chybí token WordPressu (hlavička Authorization).' );
		}

		/** @type {Number} */
		const time = now();

		/** @type {Object} */
		const payload = await verifySignedToken( match[ 1 ], context.env.WORDPRESS_PUBLIC_KEY, new URL( request.url ).origin, time, TOKEN_SCOPE );

		/** @type {Object} */
		const claims = wordpressClaims( payload );

		if ( request.method === 'GET' ) {
			return json( await buildZoneSettingsReport( context.env, claims, time ) );
		}
		return json( await applyChange( context.env, claims, changeOf( payload ), time ) );
	} catch ( error ) {
		if ( error instanceof HttpError ) {
			return json( { error: error.code, message: error.message }, error.status, error.headers );
		}
		console.error( error );
		return json( { error: ERRORS.SERVER_ERROR, message: 'Chyba serveru.' }, 500 );
	}
};
