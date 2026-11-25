/**
* [2026-11-25] Nový klíč Ed25519 pro přihlášení do WordPressu účtem z D1 (functions/_lib/sso-token.js). Vypíše soukromý klíč
* (tajná proměnná SSO_PRIVATE_KEY na Cloudflare a v .dev.vars) a veřejný klíč (nastavení WordPressu). Klíč vznikne jen
* v tomto procesu, nikam se neukládá ani neposílá.
*
*   node .site-checks/sso-keygen.mjs
*
* Nový klíč = staré tokeny přestanou platit (platí jen 2 minuty) a do WordPressu je potřeba vložit nový veřejný klíč.
* Soubor pochází ze šablony domdocument-template (static-export/repository/.site-checks/), upravovat ho ve šabloně.
*/

/** @type {CryptoKeyPair} */
const keys = await crypto.subtle.generateKey( { name: 'Ed25519' }, true, [ 'sign', 'verify' ] );

/** @type {Object} */
const privateJwk = await crypto.subtle.exportKey( 'jwk', keys.privateKey );

/** @type {String} */
const privateKey = JSON.stringify( { kty: privateJwk.kty, crv: privateJwk.crv, d: privateJwk.d, x: privateJwk.x } );

console.log( 'Soukromý klíč – tajná proměnná SSO_PRIVATE_KEY (npx wrangler pages secret put SSO_PRIVATE_KEY, vložit tento řádek):' );
console.log( privateKey );
console.log( '\nLokálně: řádek do souboru .dev.vars v kořeni repozitáře (git ho ignoruje):' );
console.log( `SSO_PRIVATE_KEY='${ privateKey }'` );
console.log( '\nVeřejný klíč – WordPress, Nastavení → Standalone template parts & options → „Přihlášení přístupovým klíčem: veřejný klíč API (JWK)“:' );
console.log( JSON.stringify( { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x } ) );
