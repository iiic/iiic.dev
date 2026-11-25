/**
* [2026-11-22] Widget „Hledání na webu“ (\WIDGET\SiteSearch ve functions.php): formulář posílá dotaz přímo vyhledávači
* (Google, Bing, Seznam…), takže hledání funguje i na statickém webu bez PHP. Vyhledávače bez parametru pro omezení
* hledání na jeden web (\POSSIBILITIES\SITE_SEARCH_SERVICES bez klíče 'site') dostanou do dotazu operátor site:.
* Pole dotazu má atribut data-site-operator (např. „site:example.cz“) a skript ho při odeslání formuláře připojí
* za text, který návštěvník napsal („dotaz site:example.cz“).
*
* Formulář se odesílá běžně, bez preventDefault(): událost `formdata` nastane, když prohlížeč sestavuje odesílaná data,
* a změna v `event.formData` se odešle. Text v poli zůstane beze změny (po návratu zpět v něm operátor není).
* Bez JavaScriptu odejde jen text dotazu a vyhledávač hledá na celém internetu.
*/

/** @type {String} */
const OPERATOR_ATTRIBUTE = 'data-site-operator'; // \WIDGET\SiteSearch::SITE_OPERATOR_ATTRIBUTE ve functions.php

for ( const field of document.querySelectorAll( `input[${ OPERATOR_ATTRIBUTE }]` ) ) {
	field.form?.addEventListener( 'formdata', ( /** @type {FormDataEvent} */ event ) => {

		/** @type {String} */
		const query = String( event.formData.get( field.name ) ?? '' ).trim();

		event.formData.set( field.name, `${ query } ${ field.getAttribute( OPERATOR_ATTRIBUTE ) }`.trim() );
	} );
}
