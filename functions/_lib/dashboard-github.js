/**
* [2026-11-27] Provoz repozitáře statického webu na GitHubu pro stránku Analytická data ve WordPressu (šablona
* domdocument-template: admin-pages/analyticka-data.php, js/modules/analytics-data.mjs). Trasa GET /api/dashboard/github
* je functions/api/dashboard/github.js, logika je tady (kvůli testům v .site-checks/dashboard-github.test.mjs). Token
* WordPressu a CORS má společné s /api/dashboard (functions/_lib/dashboard.js), repozitář ("uživatel/název") bere z tokenu.
*
* Proč přes Pages Function: API GitHubu pro provoz repozitáře (REST /repos/{r}/traffic/…) chce token s oprávněním
* „Administration: Read“ (fine-grained token jen pro tento repozitář). V prohlížeči ani v databázi WordPressu (ta jde do
* gitu) být nemá – zná ho jen Cloudflare jako tajnou proměnnou DASHBOARD_GITHUB_TOKEN.
*
* GitHub drží provoz jen za posledních 14 dní (zobrazení a klonování po dnech, 10 nejčastějších odkazujících webů
* a stránek repozitáře). Delší historii skládá WordPress z uložených odpovědí. Pozor: jde o návštěvy repozitáře na
* github.com, ne webu na GitHub Pages – ten GitHub nepočítá (návštěvnost webu je z Cloudflare, /api/dashboard/traffic).
*
* Odpověď (JSON, CORS pro všechny – bez cookies, bez platného tokenu nic nevydá):
*   settings  { githubToken } – jestli je nastavená tajná proměnná DASHBOARD_GITHUB_TOKEN
*   github    { window, repository, views, clones, referrers, paths }, nebo { error } (chybí token, repozitář):
*     window      celé dny podle UTC { since, until, days } – posledních TRAFFIC_DAYS dní (dny bez návštěv = 0)
*     repository  { fullName, url, description, private, stars, forks, watchers, openIssues, defaultBranch, pushedAt, homepage, hasPages }
*     views       { count, uniques, days: [{ date, count, uniques }] } – zobrazení stránek repozitáře, od nejnovějšího dne
*     clones      { count, uniques, days: [{ date, count, uniques }] } – klonování repozitáře
*     referrers   { items: [{ referrer, count, uniques }] } – odkud lidé na repozitář přišli (14 dní dohromady)
*     paths       { items: [{ path, title, count, uniques }] } – nejnavštěvovanější stránky repozitáře
* Část, která selže, má místo dat { error: { code, message, status } }.
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/functions/), export ho kopíruje do repozitáře
* statického webu – upravovat ho ve šabloně. Popis: functions/README.md, „Údaje pro nástěnku WordPressu“.
*/

import { ERRORS, SectionError, handleRequest, isoTime, numberOf, section, shortText, stringOf, utcDayStart } from './dashboard.js';

/** @type {Number} dní provozu, které GitHub drží */
export const TRAFFIC_DAYS = 14;

/** @type {Number} s – jak dlouho si instance funkce pamatuje odpověď (GitHub provoz přepočítává zhruba po hodině) */
export const CACHE_SECONDS = 300;

/** @type {String} */
export const API_BASE = 'https://api.github.com';

/** @type {String} verze REST API GitHubu (hlavička X-GitHub-Api-Version) */
export const API_VERSION = '2022-11-28';

/** @type {String} GitHub požadavek bez hlavičky User-Agent odmítne */
const USER_AGENT = 'ddt-dashboard (domdocument-template)';

/** @type {Number} ms */
const REQUEST_TIMEOUT = 10000;

/** @type {Number} znaků popisu repozitáře */
const DESCRIPTION_LENGTH = 300;

/** @type {Function} */
const now = function ()
{
	return Math.floor( Date.now() / 1000 );
};

/** @returns {Promise<*>} odpověď JSON REST API GitHubu, nebo SectionError GITHUB_API s textem chyby od GitHubu */
export const githubApi = async function ( /** @type {String} */ token, /** @type {String} */ path )
{

	/** @type {Response} */
	let response;

	try {
		response = await fetch( API_BASE + path, {
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${ token }`,
				'X-GitHub-Api-Version': API_VERSION,
				'User-Agent': USER_AGENT,
			},
			signal: AbortSignal.timeout( REQUEST_TIMEOUT ),
		} );
	} catch ( error ) {
		if ( error?.name === 'TimeoutError' ) {
			throw new SectionError( ERRORS.TIMEOUT, `API GitHubu neodpovědělo do ${ REQUEST_TIMEOUT / 1000 } s.` );
		}
		throw new SectionError( ERRORS.GITHUB_API, shortText( error?.message ?? error ) );
	}

	/** @type {*} */
	let data = null;

	try {
		data = await response.json();
	} catch {
		data = null;
	}
	if ( !response.ok ) {
		throw new SectionError( ERRORS.GITHUB_API, shortText( data?.message || `HTTP ${ response.status }` ), { status: response.status } );
	}
	return data;
};

/** @returns {Object} { since, until, days } – posledních TRAFFIC_DAYS dní podle UTC včetně dneška */
export const githubWindow = function ( /** @type {Number} */ time )
{

	/** @type {Number} */
	const today = utcDayStart( time );

	return { since: isoTime( today - ( TRAFFIC_DAYS - 1 ) * 86400 ).slice( 0, 10 ), until: isoTime( today ).slice( 0, 10 ), days: TRAFFIC_DAYS };
};

/** @returns {Object} repozitář zkrácený na to, co stránka ukazuje */
export const repositorySummary = function ( /** @type {*} */ repository )
{
	return {
		fullName: shortText( repository?.full_name ),
		url: stringOf( repository?.html_url ) || null,
		description: shortText( repository?.description ).slice( 0, DESCRIPTION_LENGTH ) || null,
		private: repository?.private === true,
		stars: numberOf( repository?.stargazers_count ),
		forks: numberOf( repository?.forks_count ),
		watchers: numberOf( repository?.subscribers_count ), // watchers_count je kvůli zpětné kompatibilitě počet hvězd
		openIssues: numberOf( repository?.open_issues_count ),
		defaultBranch: stringOf( repository?.default_branch ) || null,
		pushedAt: stringOf( repository?.pushed_at ) || null,
		homepage: stringOf( repository?.homepage ) || null,
		hasPages: repository?.has_pages === true,
	};
};

/**
* Zobrazení nebo klonování po dnech (REST /traffic/views, /traffic/clones) – dny bez záznamu doplní nulou, od nejnovějšího.
*
* @returns {Object} { count, uniques, days: [{ date, count, uniques }] }
*/
export const dailySummary = function ( /** @type {*} */ data, /** @type {String} */ field, /** @type {Object} */ window )
{

	/** @type {Map<String, Object>} */
	const days = new Map();

	for ( let day = Date.parse( window.since + 'T00:00:00Z' ) / 1000; isoTime( day ).slice( 0, 10 ) <= window.until; day += 86400 ) {
		const date = isoTime( day ).slice( 0, 10 );
		days.set( date, { date, count: 0, uniques: 0 } );
	}
	for ( const item of Array.isArray( data?.[ field ] ) ? data[ field ] : [] ) {
		const date = stringOf( item?.timestamp ).slice( 0, 10 );
		const day = days.get( date );
		if ( day ) {
			day.count += numberOf( item?.count );
			day.uniques += numberOf( item?.uniques );
		}
	}
	return { count: numberOf( data?.count ), uniques: numberOf( data?.uniques ), days: [ ...days.values() ].reverse() };
};

/** @type {Map<String, Object>} repozitář → { expires, cachedAt, github } */
const reportCache = new Map();

/**
* Celá odpověď pro stránku Analytická data (část „Repozitář na GitHubu“ a odkazy na repozitář).
*
* @returns {Promise<Object>}
*/
export const buildGithubReport = async function ( /** @type {Object} */ env, /** @type {Object} */ claims, /** @type {Number} */ time = now() )
{

	/** @type {String} */
	const token = String( env.DASHBOARD_GITHUB_TOKEN ?? '' ).trim();

	/** @type {String} */
	const repository = stringOf( claims.repository );

	/** @type {Object} */
	const report = {
		version: 1,
		generatedAt: isoTime( time ),
		target: { repository },
		settings: { githubToken: token !== '' },
	};

	if ( token === '' ) {
		report.github = { error: { code: ERRORS.GITHUB_TOKEN_MISSING, message: 'Chybí tajná proměnná DASHBOARD_GITHUB_TOKEN (token GitHubu s oprávněním Administration: Read pro repozitář statického webu).' } };
		return report;
	}
	if ( repository === '' ) {
		report.github = { error: { code: ERRORS.NO_REPOSITORY, message: 'WordPress neposlal repozitář statického webu na GitHubu (adresa vzdáleného repozitáře v nastavení exportu není na github.com).' } };
		return report;
	}

	/** @type {Object|undefined} */
	const cached = reportCache.get( repository );

	if ( cached && cached.expires > time ) {
		report.github = { ...cached.github, cachedAt: cached.cachedAt };
		return report;
	}

	/** @type {String} */
	const base = `/repos/${ repository.split( '/' ).map( encodeURIComponent ).join( '/' ) }`;

	/** @type {Object} */
	const window = githubWindow( time );

	const [ details, views, clones, referrers, paths ] = await Promise.all( [
		section( async () => repositorySummary( await githubApi( token, base ) ) ),
		section( async () => dailySummary( await githubApi( token, `${ base }/traffic/views?per=day` ), 'views', window ) ),
		section( async () => dailySummary( await githubApi( token, `${ base }/traffic/clones?per=day` ), 'clones', window ) ),
		section( async () => {

			/** @type {*} */
			const list = await githubApi( token, `${ base }/traffic/popular/referrers` );

			return { items: ( Array.isArray( list ) ? list : [] ).map( ( item ) => ( { referrer: shortText( item?.referrer ), count: numberOf( item?.count ), uniques: numberOf( item?.uniques ) } ) ).filter( ( item ) => item.referrer !== '' ) };
		} ),
		section( async () => {

			/** @type {*} */
			const list = await githubApi( token, `${ base }/traffic/popular/paths` );

			return { items: ( Array.isArray( list ) ? list : [] ).map( ( item ) => ( { path: shortText( item?.path ), title: shortText( item?.title ), count: numberOf( item?.count ), uniques: numberOf( item?.uniques ) } ) ).filter( ( item ) => item.path !== '' ) };
		} ),
	] );

	/** @type {Object} */
	const github = { window, repository: details, views, clones, referrers, paths };

	if ( [ details, views, clones, referrers, paths ].every( ( part ) => part.error ) ) { // nic se nepovedlo (špatný token…) – do paměti instance ne
		report.github = github;
		return report;
	}
	reportCache.set( repository, { expires: time + CACHE_SECONDS, cachedAt: isoTime( time ), github } );
	report.github = github;
	return report;
};

/** Vyprázdní paměť instance (testy). */
export const clearGithubCaches = function ()
{
	reportCache.clear();
};

/**
* Pages Function pro /api/dashboard/github (functions/api/dashboard/github.js).
*/
export const handleGithubRequest = function ( /** @type {EventContext} */ context )
{
	return handleRequest( context, buildGithubReport );
};
